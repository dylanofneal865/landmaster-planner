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

  // ── Parent-item-type field discovery ──────────────────────────────────────
  // The GI now exposes the parent's ItemType. The GI-designer column name
  // isn't known to this code by hand, so we try a small list of likely
  // spellings on each row and use whichever one has a value. If NONE of them
  // ever produces a value, we log a warning and skip the Component-Part
  // filter entirely — safer than a wrong guess silently dropping thousands
  // of rows. (Any real field name we missed can be added here after one
  // manual run shows it in the tag-sample log below.)
  const PARENT_TYPE_FIELD_CANDIDATES = [
    "ParentType",
    "ParentItemType",
    "ParentItemClass",
    "ParentClass",
    "ParentInventoryType",
  ];
  function getParentType(getFn) {
    for (const f of PARENT_TYPE_FIELD_CANDIDATES) {
      const v = getFn(f);
      if (v != null && String(v).trim() !== "") return { field: f, value: String(v).trim() };
    }
    return { field: null, value: "" };
  }

  // Discovery aid: dump the first entry's <d:...> tag names once, so a
  // manual run reveals the actual column name if none of the candidates
  // above hit. Bounded so a large first entry doesn't flood the log.
  if (entries.length > 0) {
    const tagNames = Array.from(new Set(
      (entries[0].match(/<d:([A-Za-z0-9_]+)[\s>]/g) || []).map(s => s.replace(/^<d:/, "").replace(/[\s>]$/, ""))
    ));
    log(`Sample entry[0] tag names (${tagNames.length}):`, tagNames.slice(0, 80).join(", "));
  }

  // Parse each entry into a normalized link record. Dedupe by composite id
  // (BOMID::Parent::Child) so a row listed twice in the GI never produces
  // duplicates — first-wins, matching the on-hand pass in acumatica-sync.js.
  //
  // Rows whose parent is a "Component Part" are dropped: those items are
  // purchased whole and their children must NOT flow into per-child demand.
  // The filter runs in code because the GI condition approach didn't hold
  // reliably. Filter uses exact match against the value returned by the
  // GI ("Component Part") — we log any unexpected variants so we can react
  // if the naming drifts.
  const feedById = new Map();
  const parentBoms = new Set();
  const parentTypeCounts = Object.create(null);   // "Component Part": N, "Subassembly": N, "": N
  const parentTypeByParent = new Map();           // parent → detected type (last non-empty wins)
  let detectedFieldName = null;
  let droppedComponentPartRows = 0;
  const droppedParentsSet = new Set();
  const droppedByParent = new Map();              // parent → rows dropped
  for (const raw of entries) {
    const { get } = makeFieldGetters(raw);

    const bomId  = sanitizeIdPart(get("BOMID"));
    const parent = sanitizeIdPart(get("ParentID"));
    const child  = sanitizeIdPart(get("ChildID"));
    if (!bomId || !parent || !child) continue;

    const { field: pField, value: pType } = getParentType(get);
    if (pField && !detectedFieldName) detectedFieldName = pField;
    parentTypeCounts[pType || "<empty>"] = (parentTypeCounts[pType || "<empty>"] || 0) + 1;
    if (pType) parentTypeByParent.set(parent, pType);

    if (pType === "Component Part") {
      droppedComponentPartRows++;
      droppedParentsSet.add(parent);
      droppedByParent.set(parent, (droppedByParent.get(parent) || 0) + 1);
      continue;
    }

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

  // Fail-safe: if we never resolved any parent-type value from any candidate
  // field, none of the candidates matched the GI. Log loudly, and (because
  // the drop loop above short-circuits on empty string) no rows were
  // dropped — the reconcile proceeds as if the filter didn't exist.
  if (!detectedFieldName) {
    log("WARNING: no parent-type field resolved — Component-Part filter is INACTIVE. " +
      "Check the tag-sample log above and add the correct field name to " +
      "PARENT_TYPE_FIELD_CANDIDATES.");
  } else {
    log(`Parent-type field detected: "${detectedFieldName}"`);
  }
  log("Parent-type value counts:", parentTypeCounts);
  log(`Dropped ${droppedComponentPartRows} rows across ${droppedParentsSet.size} Component-Part parents`);

  // User-requested spot-checks for the review — these show up in the
  // Netlify function log alongside the counts so a single manual run
  // answers the "17984 dropped? 17985 kept?" question without a Supabase
  // query.
  const SPOT_CHECK_DROP = "17984";
  const SPOT_CHECK_KEEP = "17985";
  const spotDropDetected = parentTypeByParent.get(SPOT_CHECK_DROP) || "<never seen>";
  const spotKeepDetected = parentTypeByParent.get(SPOT_CHECK_KEEP) || "<never seen>";
  const spotDropCount = droppedByParent.get(SPOT_CHECK_DROP) || 0;
  const spotKeepInFeed = parentBoms.has(SPOT_CHECK_KEEP);
  log(`Spot-check ${SPOT_CHECK_DROP}: detected type="${spotDropDetected}", dropped ${spotDropCount} row(s)`);
  log(`Spot-check ${SPOT_CHECK_KEEP}: detected type="${spotKeepDetected}", in-feed after filter=${spotKeepInFeed}`);

  log(`Parsed ${feedById.size} BOM links across ${parentBoms.size} parent BOMs (raw entries: ${entries.length}, dropped: ${droppedComponentPartRows})`);

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
          rawEntries: entries.length,
          componentPartRowsDropped: droppedComponentPartRows,
          componentPartParentsDropped: droppedParentsSet.size,
          parentTypeField: detectedFieldName,
          parentTypeCounts,
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
      rawEntries: entries.length,
      componentPartRowsDropped: droppedComponentPartRows,
      componentPartParentsDropped: droppedParentsSet.size,
      parentTypeField: detectedFieldName,
      parentTypeCounts,
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
