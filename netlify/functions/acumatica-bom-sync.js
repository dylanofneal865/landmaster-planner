// Netlify Scheduled Function — pulls BOM parent→child links from the
// Acumatica OData generic inquiry "LM Planner BOM" and reconciles the
// Supabase `bom_links` table.
//
// Schedule: once daily at 06:00 UTC (configured in netlify.toml). BOMs are
// slow-moving reference data, so we explicitly don't share the 2-minute
// on-hand / PO cadence in acumatica-sync.js.
//
// Required environment variables:
//   ACUMATICA_BASE_URL        e.g. https://mdcarts.acumatica.com
//   ACUMATICA_COMPANY         e.g. LIVE
//   ACUMATICA_BOM_GI_NAME     e.g. LM Planner BOM     (default: "LM Planner BOM")
//   ACUMATICA_USERNAME        the Acumatica login username
//   ACUMATICA_PASSWORD        the Acumatica login password
//   SUPABASE_URL              e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY      the service-role key from Supabase API settings

const { createClient } = require("@supabase/supabase-js");

// Shared field extractors for an Acumatica OData Atom-XML <entry>.
// Mirrors makeFieldGetters() in acumatica-sync.js — kept inline rather than
// extracted so this function stays self-contained for esbuild bundling.
function makeFieldGetters(raw) {
  const get = (field) => {
    // Exact field-name match: allow attributes (m:type, etc.) but NOT numbered
    // siblings like <d:CreatedBy_2> — the optional group requires whitespace
    // after the name, so "_2"/"_3" suffixes can't slip through.
    const re = new RegExp(`<d:${field}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/d:${field}>`, "i");
    const m = raw.match(re);
    return m ? m[1].trim() : null;
  };
  const isNull = (field) => {
    const re = new RegExp(`<d:${field}[^>]*m:null="true"`, "i");
    return re.test(raw);
  };
  return { get, isNull };
}

// Sanitize a string for use as part of a composite row id. Acumatica part
// numbers can contain "/", ".", spaces — keep them readable but strip the
// "::" separator (we use it to delimit composite-key parts) so a child PN
// containing "::" can't collide with a different (parent, child) pair.
function sanitizeIdPart(s) {
  return String(s || "").replace(/::/g, "_").trim();
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[acumatica-bom-sync] ${msg}`, data || "");

  const {
    ACUMATICA_BASE_URL,
    ACUMATICA_COMPANY,
    ACUMATICA_BOM_GI_NAME,
    ACUMATICA_USERNAME,
    ACUMATICA_PASSWORD,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
  } = process.env;

  if (!ACUMATICA_BASE_URL || !ACUMATICA_USERNAME || !ACUMATICA_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing required environment variables");
    return { statusCode: 500, body: JSON.stringify({ error: "Missing env vars" }) };
  }

  const giEncoded = encodeURIComponent(ACUMATICA_BOM_GI_NAME || "LM Planner BOM");
  const company = ACUMATICA_COMPANY || "LIVE";
  const url = `${ACUMATICA_BASE_URL}/OData/${company}/${giEncoded}`;
  log("Fetching", url);

  let xml;
  try {
    const auth = Buffer.from(`${ACUMATICA_USERNAME}:${ACUMATICA_PASSWORD}`).toString("base64");
    const resp = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/atom+xml",
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      log("Acumatica returned non-OK status", { status: resp.status, body: body.slice(0, 200) });
      return { statusCode: 502, body: JSON.stringify({ error: "Acumatica auth/fetch failed", status: resp.status }) };
    }
    xml = await resp.text();
  } catch (err) {
    log("Fetch threw", err.message);
    return { statusCode: 502, body: JSON.stringify({ error: "Acumatica fetch error", detail: err.message }) };
  }

  const entries = xml.split(/<entry[^>]*>/i).slice(1);
  log(`Found ${entries.length} <entry> elements`);

  // Parse each entry into a normalized link record. Dedupe by composite id
  // (BOMID::Parent::Child) so a row listed twice in the GI never produces
  // duplicates — first-wins, matching the on-hand pass in acumatica-sync.js.
  const feedById = new Map();
  const parentBoms = new Set();
  for (const raw of entries) {
    const { get } = makeFieldGetters(raw);

    const bomId  = sanitizeIdPart(get("BOMID"));
    const parent = sanitizeIdPart(get("ParentID"));
    const child  = sanitizeIdPart(get("ChildID"));
    if (!bomId || !parent || !child) continue;

    const qtyRaw = get("QtyRequired");
    const qty = parseFloat(qtyRaw);
    const uom = (get("UOM") || "").trim();

    const id = `bomlink_${bomId}::${parent}::${child}`;
    const data = {
      id,
      bomId,
      parent,
      child,
      qty: isFinite(qty) ? qty : 0,
      uom,
    };

    if (!feedById.has(id)) {
      feedById.set(id, data);
      parentBoms.add(parent);
    }
  }

  log(`Parsed ${feedById.size} BOM links across ${parentBoms.size} parent BOMs`);

  // Guard against a feed that parsed to zero — we never want to wipe the
  // table on a transient schema/auth glitch. The on-hand pass uses the same
  // bail-out shape.
  if (feedById.size === 0) {
    log("No BOM links parsed from feed — possible schema change or empty GI; bailing without touching the table");
    return { statusCode: 200, body: JSON.stringify({ upserted: 0, removed: 0, note: "No links parsed" }) };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Page through every existing row — needed both for the diff (skip rows
  // whose payload hasn't changed) and for reconciliation (delete rows the
  // feed no longer contains). Same paged-range pattern as runPOSync().
  const existing = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa.from("bom_links").select("id, data").range(from, from + PAGE - 1);
    if (error) {
      log("bom_links select error", error);
      return { statusCode: 500, body: JSON.stringify({ error: "bom_links select failed", detail: error.message }) };
    }
    if (!data || data.length === 0) break;
    existing.push(...data);
    if (data.length < PAGE) break;
  }
  const existingById = new Map(existing.map((r) => [r.id, r.data || {}]));
  log(`Loaded ${existing.length} existing bom_links rows`);

  // Diff:
  //   - upsert rows that are new OR whose qty/uom/bomId changed
  //   - collect rows in Supabase but absent from the feed for DELETE
  // Reconciling deletions (vs. additive-only like the PO pass) is correct
  // here because BOM links are reference data: an engineering change that
  // removes a link must propagate or downstream demand math will be wrong.
  // The earlier zero-row guard above stops a bad feed from triggering a
  // table-wide wipe.
  const rowsToUpsert = [];
  let unchanged = 0;
  for (const [id, data] of feedById.entries()) {
    const prev = existingById.get(id);
    if (
      prev &&
      Number(prev.qty) === Number(data.qty) &&
      prev.uom === data.uom &&
      prev.bomId === data.bomId &&
      prev.parent === data.parent &&
      prev.child === data.child
    ) {
      unchanged++;
      continue;
    }
    rowsToUpsert.push({ id, data });
  }

  const idsToDelete = [];
  for (const r of existing) {
    if (!feedById.has(r.id)) idsToDelete.push(r.id);
  }

  log(`Will upsert ${rowsToUpsert.length} (${unchanged} unchanged) and delete ${idsToDelete.length} stale links`);

  // Batched upsert — 500 rows per request. Upsert payloads travel in the JSON
  // body, so 500 is comfortable. If a chunk fails, retry it once, then log its
  // ids and continue instead of aborting the whole reconcile with a partial
  // state (the next run will retry the same rows since diff/delete are both
  // computed against the current feed).
  const UPSERT_BATCH = 500;
  let totalUpserted = 0;
  const failedUpsertIds = [];
  for (let i = 0; i < rowsToUpsert.length; i += UPSERT_BATCH) {
    const batch = rowsToUpsert.slice(i, i + UPSERT_BATCH);
    let { error } = await supa.from("bom_links").upsert(batch);
    if (error) {
      log(`upsert chunk ${i}-${i + batch.length - 1} failed, retrying once`, error.message);
      ({ error } = await supa.from("bom_links").upsert(batch));
    }
    if (error) {
      log(`upsert chunk ${i}-${i + batch.length - 1} failed after retry — skipping`, {
        detail: error.message,
        count: batch.length,
        ids: batch.map((r) => r.id),
      });
      failedUpsertIds.push(...batch.map((r) => r.id));
      continue;
    }
    totalUpserted += batch.length;
  }

  // Batched delete — 200 ids per request. The delete filter is sent in the URL
  // as `id=in.(id1,id2,...)`, which is capped by PostgREST/nginx around 16 KB.
  // At ~30–60 chars per url-encoded composite id, 200 keeps us safely under
  // that ceiling; 500 (the prior value) blew past it and returned 400 Bad
  // Request when the filtered GI produced ~3.1k stale rows in one run.
  const DELETE_BATCH = 200;
  let totalDeleted = 0;
  const failedDeleteIds = [];
  for (let i = 0; i < idsToDelete.length; i += DELETE_BATCH) {
    const batch = idsToDelete.slice(i, i + DELETE_BATCH);
    let { error } = await supa.from("bom_links").delete().in("id", batch);
    if (error) {
      log(`delete chunk ${i}-${i + batch.length - 1} failed, retrying once`, error.message);
      ({ error } = await supa.from("bom_links").delete().in("id", batch));
    }
    if (error) {
      log(`delete chunk ${i}-${i + batch.length - 1} failed after retry — skipping`, {
        detail: error.message,
        count: batch.length,
        ids: batch,
      });
      failedDeleteIds.push(...batch);
      continue;
    }
    totalDeleted += batch.length;
  }

  const upsertFailed = failedUpsertIds.length;
  const deleteFailed = failedDeleteIds.length;
  const anyChunkFailed = upsertFailed > 0 || deleteFailed > 0;

  // Audit row — same shape and conventions as the on-hand / PO passes.
  const auditId = `audit_acumatica_bom_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await supa.from("audit").upsert([
    {
      id: auditId,
      data: {
        id: auditId,
        ts: new Date().toISOString(),
        type: "acumatica-bom-sync",
        msg:
          `Acumatica BOM sync: ${totalUpserted} links upserted (${unchanged} unchanged), ` +
          `${totalDeleted} removed across ${parentBoms.size} parent BOMs` +
          (anyChunkFailed ? ` — ${upsertFailed} upsert / ${deleteFailed} delete ids failed after retry` : ""),
        detail: {
          source: "netlify-scheduled-function",
          linksInFeed: feedById.size,
          linksExisting: existing.length,
          parentBoms: parentBoms.size,
          upserted: totalUpserted,
          unchanged,
          removed: totalDeleted,
          upsertFailed,
          deleteFailed,
          durationMs: Date.now() - t0,
        },
      },
    },
  ]);

  log(
    `Done. ${totalUpserted} upserted, ${totalDeleted} removed across ${parentBoms.size} parent BOMs in ${Date.now() - t0}ms` +
      (anyChunkFailed ? ` (skipped ${upsertFailed} upsert / ${deleteFailed} delete ids)` : "")
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      durationMs: Date.now() - t0,
      linksInFeed: feedById.size,
      parentBoms: parentBoms.size,
      upserted: totalUpserted,
      unchanged,
      removed: totalDeleted,
      upsertFailed,
      deleteFailed,
    }),
  };
};
