// Netlify Scheduled Function — pulls on-hand inventory from Acumatica OData
// and updates the Supabase `parts` table.
//
// Schedule: every 2 minutes (configured in netlify.toml)
//
// Required environment variables:
//   ACUMATICA_BASE_URL        e.g. https://mdcarts.acumatica.com
//   ACUMATICA_COMPANY         e.g. LIVE
//   ACUMATICA_GI_NAME         e.g. LM Planner Inventory
//   ACUMATICA_USERNAME        the Acumatica login username
//   ACUMATICA_PASSWORD        the Acumatica login password
//   SUPABASE_URL              e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY      the service-role key from Supabase API settings

const { createClient } = require("@supabase/supabase-js");

// Broadcast a data-changed ping via Supabase Realtime's HTTP endpoint.
// The browser client's landmaster-broadcast channel listens for
// { event: "data-changed", payload: { tables: [...] } } and delta-
// fetches each named table. Fire-and-forget: failures are logged but
// never fail the sync — the postgres_changes path still covers
// propagation while Phase 2 is running both models in parallel.
//
// HTTP (not SDK channel.send()) so this works from Netlify without
// opening a WebSocket per invocation and is decoupled from the
// supabase-js version pinned in the function's runtime.
async function sendBroadcast({ supabaseUrl, serviceKey, tables, log }) {
  if (!Array.isArray(tables) || tables.length === 0) return;
  try {
    const resp = await fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        messages: [{
          topic: "landmaster-broadcast",
          event: "data-changed",
          payload: { tables },
        }],
      }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      log(`broadcast send returned ${resp.status}: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    log(`broadcast send failed: ${(e && e.message) || e}`);
  }
}

// Decode the five XML entities Acumatica emits in OData text fields
// (plus numeric char refs). WITHOUT this, a supplier like
// "Briggs & Stratton" arrives as "Briggs &amp; Stratton", gets stored
// that way in Supabase, and every UI renderer that HTML-escapes on
// output produces "Briggs &amp;amp; Stratton". Wired into the
// getter below so EVERY string field from EVERY GI is decoded once
// on the way in — no per-field patching at call sites.
//
// ORDER MATTERS: &amp; MUST be replaced LAST. Decoding it first would
// turn a literal "&amp;lt;" into "&lt;", and a later rule would then
// decode that AGAIN into "<" — a double-decode. Running &amp; last
// preserves the intent: "&amp;lt;" survives as literal "&lt;".
//
// Numeric char refs use String.fromCodePoint (not fromCharCode) so
// astral-plane codepoints (>= 0x10000) are handled correctly instead
// of producing lone surrogates. Hex refs are matched BEFORE decimal
// so patterns like &#xFF; aren't misinterpreted by the decimal rule.
function decodeEntities(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, "&");   // MUST be last
}

// Shared field extractors for an Acumatica OData Atom-XML <entry>.
// The "d:" prefix is treated as OPTIONAL because Acumatica emits it for
// native DAC fields (<d:OrderNbr>) but omits it for custom-GI-added tags
// like <BlanketExpireson>. Both shapes need to resolve through the same
// getter. Boundary is still enforced: after the field name the pattern
// requires either whitespace (attributes) or the closing ">", so
// "BlanketExp" never partial-matches "BlanketExpireson" and vice versa.
function makeFieldGetters(raw) {
  const get = (field) => {
    // Exact field-name match: allow attributes (m:type, etc.) but NOT numbered
    // siblings like <d:CreatedBy_2> — the optional group requires whitespace
    // after the name, so "_2"/"_3" suffixes can't slip through.
    const re = new RegExp(`<(?:d:)?${field}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:d:)?${field}>`, "i");
    const m = raw.match(re);
    return m ? decodeEntities(m[1].trim()) : null;
  };
  const isNull = (field) => {
    // \b after the field name blocks partial-name matches (e.g. isNull("Qty")
    // must not fire on "<d:QtyReceived m:null=…").
    const re = new RegExp(`<(?:d:)?${field}\\b[^>]*m:null="true"`, "i");
    return re.test(raw);
  };
  return { get, isNull };
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[acumatica-sync] ${msg}`, data || "");

  const {
    ACUMATICA_BASE_URL,
    ACUMATICA_COMPANY,
    ACUMATICA_GI_NAME,
    ACUMATICA_USERNAME,
    ACUMATICA_PASSWORD,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
  } = process.env;

  if (!ACUMATICA_BASE_URL || !ACUMATICA_USERNAME || !ACUMATICA_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing required environment variables");
    return { statusCode: 500, body: JSON.stringify({ error: "Missing env vars" }) };
  }

  const giEncoded = encodeURIComponent(ACUMATICA_GI_NAME || "LM Planner Inventory");
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

  const dedupe = new Map();
  for (const raw of entries) {
    const { get, isNull } = makeFieldGetters(raw);

    const pn = get("InventoryID");
    if (!pn) continue;

    const qtyAvailStr = isNull("QtyAvailableinWarehouse") ? null : get("QtyAvailableinWarehouse");
    if (qtyAvailStr === null) continue;

    const qtyAvail = parseFloat(qtyAvailStr);
    if (!isFinite(qtyAvail)) continue;

    if (!dedupe.has(pn)) {
      dedupe.set(pn, qtyAvail);
    }
  }

  log(`Deduped to ${dedupe.size} distinct parts`);

  if (dedupe.size === 0) {
    log("No parts parsed from feed — possible schema change");
    return { statusCode: 200, body: JSON.stringify({ updated: 0, note: "No parts parsed" }) };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Tombstone pre-fetch ───────────────────────────────────────────
  // Every pn present as an active tombstone in `deleted_parts` must be
  // skipped by the upsert loop AND scrubbed from the `parts` table if
  // any stale row is still there. The client-side deletePart flow
  // already does the parts-row delete at delete-time, but this sync
  // is the safety net for the cases where that write failed silently.
  //
  // Table schema mirrors follow_marks / bom_links: `id` text PK + data
  // jsonb. The pn goes in the `id` column.
  log("Fetching deleted_parts tombstones");
  const tombstoned = new Set();
  {
    const TS_PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supa
        .from("deleted_parts")
        .select("id")
        .range(from, from + TS_PAGE - 1);
      if (error) {
        // Non-fatal: log and proceed WITHOUT the filter. Better to run
        // the sync and update on-hands than to bail on a tombstone
        // fetch glitch — the client's cloudInit filter is a second
        // line of defense. But surface it loudly in the log.
        log("WARNING: deleted_parts fetch failed — tombstone filter INACTIVE this run", error);
        break;
      }
      if (!data || data.length === 0) break;
      for (const row of data) if (row && row.id) tombstoned.add(String(row.id));
      if (data.length < TS_PAGE) break;
      from += TS_PAGE;
    }
  }
  log(`Loaded ${tombstoned.size} tombstoned pn(s)`);

  // Belt-and-suspenders: scrub any stale `parts` row whose pn is
  // tombstoned. Chunked delete to stay under the ~16 KB PostgREST URL
  // ceiling (`id=in.(...)` filter). Non-fatal per chunk — a single
  // failed scrub doesn't abort the sync; the client filter still
  // stops resurrection at load time.
  const tombstonedFeedPns = [];
  for (const pn of dedupe.keys()) {
    if (tombstoned.has(pn)) tombstonedFeedPns.push(pn);
  }
  if (tombstonedFeedPns.length > 0) {
    const SCRUB_BATCH = 200;
    let scrubbed = 0;
    for (let i = 0; i < tombstonedFeedPns.length; i += SCRUB_BATCH) {
      const batch = tombstonedFeedPns.slice(i, i + SCRUB_BATCH);
      const { error } = await supa.from("parts").delete().in("pn", batch);
      if (error) {
        log(`WARNING: parts-scrub chunk ${i}-${i + batch.length - 1} failed`, error.message);
        continue;
      }
      scrubbed += batch.length;
    }
    log(`Scrubbed ${scrubbed} stale parts row(s) matching tombstones`);
  }

  log("Fetching existing parts from Supabase");
  const existingPns = Array.from(dedupe.keys());
  const PAGE = 1000;
  const existingMap = new Map();
  for (let offset = 0; offset < existingPns.length; offset += PAGE) {
    const slice = existingPns.slice(offset, offset + PAGE);
    const { data, error } = await supa
      .from("parts")
      .select("pn, data")
      .in("pn", slice);
    if (error) {
      log("Supabase select error", error);
      return { statusCode: 500, body: JSON.stringify({ error: "Supabase select failed", detail: error.message }) };
    }
    for (const row of data || []) {
      existingMap.set(row.pn, row.data || {});
    }
  }
  log(`Loaded ${existingMap.size} existing parts; ${dedupe.size - existingMap.size} parts in feed are not in DB.parts (skipped)`);

  const rows = [];
  let unchanged = 0;
  let tombstoneSkipped = 0;
  for (const [pn, qtyAvail] of dedupe.entries()) {
    // PRIMARY tombstone gate: even if a stale parts row somehow survived
    // the scrub above, don't re-upsert it here. Belt AND suspenders.
    if (tombstoned.has(pn)) { tombstoneSkipped++; continue; }
    const existing = existingMap.get(pn);
    if (!existing) continue;
    if (Number(existing.onHand) === qtyAvail) {
      unchanged++;
      continue;
    }
    const merged = { ...existing, onHand: qtyAvail };
    rows.push({ pn, data: merged });
  }
  log(`Will update ${rows.length} parts (${unchanged} unchanged, ${tombstoneSkipped} tombstoned, skipped)`);

  const BATCH = 500;
  let totalUpserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supa.from("parts").upsert(batch);
    if (error) {
      log("Supabase upsert error", error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Supabase upsert failed",
          detail: error.message,
          partial: totalUpserted,
        }),
      };
    }
    totalUpserted += batch.length;
  }

  if (rows.length > 0) {
    const auditId = `audit_acumatica_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await supa.from("audit").upsert([
      {
        id: auditId,
        data: {
          id: auditId,
          ts: new Date().toISOString(),
          type: "acumatica-sync",
          msg: `Acumatica sync: ${totalUpserted} parts updated (${unchanged} unchanged, ${dedupe.size - existingMap.size} not in catalog)`,
          detail: {
            source: "netlify-scheduled-function",
            partsInFeed: dedupe.size,
            partsInPlanner: existingMap.size,
            updated: totalUpserted,
            unchanged,
            durationMs: Date.now() - t0,
          },
        },
      },
    ]);
  }

  log(`Done. ${totalUpserted} parts updated in ${Date.now() - t0}ms`);

  // Broadcast — ONLY if the delta gate actually let rows through. A
  // "0 upserted, all unchanged" run is a no-op and shouldn't wake
  // clients into a wasted delta-fetch pass.
  if (totalUpserted > 0) {
    await sendBroadcast({
      supabaseUrl: SUPABASE_URL,
      serviceKey: SUPABASE_SERVICE_KEY,
      tables: ["parts"],
      log,
    });
  }

  const onHandSummary = {
    partsInFeed: dedupe.size,
    partsInPlanner: existingMap.size,
    updated: totalUpserted,
    unchanged,
  };

  // ===== PO SYNC PASS (LMInventoryPlannerPOLines) =====
  // Runs every cycle, after the on-hand pass, sharing auth + Supabase client.
  const poSummary = await runPOSync({
    supa,
    log,
    baseUrl: ACUMATICA_BASE_URL,
    company,
    username: ACUMATICA_USERNAME,
    password: ACUMATICA_PASSWORD,
    supabaseUrl: SUPABASE_URL,
    serviceKey: SUPABASE_SERVICE_KEY,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      durationMs: Date.now() - t0,
      onHand: onHandSummary,
      pos: poSummary,
    }),
  };
};

// ---- PO status derivation (ported verbatim from the app's Excel PO parser) ----
function normalizeAcumaticaStatus(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const map = [
    [/^on\s*hold$/i, "On Hold"],
    [/^pending\s*approval$/i, "Pending Approval"],
    [/^pending\s*print(ing)?$/i, "Pending Printing"],
    [/^pending\s*e?-?mail$/i, "Pending Email"],
    [/^awaiting\s*link$/i, "Awaiting Link"],
    [/^open$/i, "Open"],
    [/^completed$/i, "Completed"],
    [/^rejected$/i, "Rejected"],
    [/^cancell?ed$/i, "Canceled"],
  ];
  for (const [re, canon] of map) if (re.test(s)) return canon;
  return s;
}

const ACUMATICA_STATUS_PRIORITY = ["On Hold", "Pending Approval", "Pending Printing", "Pending Email", "Awaiting Link", "Open", "Completed", "Rejected", "Canceled"];

function rollupAcumaticaStatus(lines) {
  let bestPri = Infinity, best = "", fallback = "";
  for (const l of (lines || [])) {
    const s = l.acumStatus || "";
    if (!s) continue;
    const pri = ACUMATICA_STATUS_PRIORITY.indexOf(s);
    if (pri >= 0) { if (pri < bestPri) { bestPri = pri; best = s; } }
    else if (!fallback) fallback = s;
  }
  return best || fallback;
}

// Placeholder values that crept into `buyer` over time from legacy browser
// pushes (e.g. "Unassigned") shouldn't block Acumatica's CreatedBy default.
function isRealBuyer(b) {
  if (!b) return false;
  const s = String(b).trim().toLowerCase();
  if (!s) return false;
  if (s === "unassigned" || s === "n/a" || s === "na" || s === "—" || s === "-" || s === "?") return false;
  return true;
}

// Fetches the LMInventoryPlannerPOLines GI, groups flat lines into nested PO
// objects (the shape the app already consumes), preserves local buyer/notes,
// upserts to the `pos` table, and reconciles POs that dropped out of the feed.
async function runPOSync(ctx) {
  const { supa, log, baseUrl, company, username, password, supabaseUrl, serviceKey } = ctx;
  const PO_GI = "LMInventoryPlannerPOLines";
  const url = `${baseUrl}/OData/${company}/${encodeURIComponent(PO_GI)}`;
  // Paginated fetch — Acumatica OData caps a single response at ~1000 rows
  // by default. The GI has grown past that (blanket lines were sitting past
  // the cap, invisible to a single-shot fetch), so walk pages via $top/$skip
  // until a short page tells us we've drained the feed. Cap the loop at
  // MAX_PAGES so a mis-configured server can't spin forever.
  //
  // NOTE: the inventory feed at the top of this file uses the same
  // single-shot pattern and may be latently truncating too — evaluate
  // separately; DO NOT expand this pass to that feed.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 20;
  log("PO sync: fetching (paginated)", url);

  let entries = [];
  let pageCount = 0;
  try {
    const auth = Buffer.from(`${username}:${password}`).toString("base64");
    for (let page = 0, skip = 0; page < MAX_PAGES; page++, skip += PAGE_SIZE) {
      const pageUrl = `${url}?$top=${PAGE_SIZE}&$skip=${skip}`;
      const resp = await fetch(pageUrl, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/atom+xml" },
      });
      if (!resp.ok) {
        const body = await resp.text();
        log("PO GI non-OK status", { status: resp.status, page, skip, body: body.slice(0, 200) });
        return { error: "PO fetch failed", status: resp.status, page };
      }
      const pageXml = await resp.text();
      const pageEntries = pageXml.split(/<entry[^>]*>/i).slice(1);
      pageCount++;
      log(`PO sync: page ${pageCount} (skip=${skip}) returned ${pageEntries.length} entries`);
      entries.push(...pageEntries);
      // A page shorter than PAGE_SIZE is the last page — stop before
      // firing a wasted round-trip for an empty page.
      if (pageEntries.length < PAGE_SIZE) break;
    }
    if (pageCount === MAX_PAGES && entries.length && entries.length % PAGE_SIZE === 0) {
      log(`WARNING: PO sync hit MAX_PAGES=${MAX_PAGES} cap without a short page — the feed may have more rows. Raise MAX_PAGES.`);
    }
  } catch (err) {
    log("PO fetch threw", err.message);
    return { error: "PO fetch error", detail: err.message };
  }

  log(`PO sync: fetched ${entries.length} entries across ${pageCount} pages`);

  const toNum = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  // Acumatica returns date fields as midnight in an unspecified timezone
  // (e.g. "2026-05-27T00:00:00"). Parsing through JS Date converts to UTC and
  // shifts US users back a day; slice the calendar portion directly instead.
  const toDateStr = (v) => (v ? String(v).slice(0, 10) : null);

  // ── PO Line Type discovery ────────────────────────────────────────
  // The GI exposes a "Type" column (Normal vs Blanket) that we need to
  // distinguish scheduled receipts from release-against placeholders.
  // Acumatica strips whitespace from GI result-column display names to
  // form the OData tag — the spelling depends on how the designer named
  // it. Try a small candidate list on each row and use whichever hits
  // first; log the winner and the distinct raw values on this run so
  // the real vocabulary is visible. Fail-safe: if NO candidate ever
  // resolves, ln.type stays "" and downstream code treats it as unknown.
  const PO_TYPE_FIELD_CANDIDATES = [
    "Type",
    "OrderType",
    "POType",
    "PoType",
    "LineType",
    "POLineType",
  ];
  function getPOLineType(getFn) {
    for (const f of PO_TYPE_FIELD_CANDIDATES) {
      const v = getFn(f);
      if (v != null && String(v).trim() !== "") return { field: f, value: String(v).trim() };
    }
    return { field: null, value: "" };
  }
  // Normalize a raw type value — trim + title-case first letter so
  // "NORMAL"/"normal"/"Normal" all collapse to "Normal". Unknown
  // spellings pass through unchanged so we can spot them in the log.
  function normalizePOLineType(raw) {
    const s = String(raw || "").trim();
    if (!s) return "";
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }
  let detectedPOTypeField = null;
  const poTypeRawCounts = Object.create(null);   // raw string → count
  const poTypeNormCounts = Object.create(null);  // normalized string → count

  // ── Blanket-linkage field discovery ────────────────────────────────
  // Two additional fields we need for the blanket workflow (kept
  // separate from the Type discovery so each field can be spotted in
  // the log independently):
  //   1. Blanket Open Qty — remaining qty on a Blanket-type line still
  //      available to release against. Only meaningful when ln.type is
  //      "Blanket"; we store the raw value regardless and the client
  //      decides when to read it.
  //   2. Blanket PO Nbr. — the parent Blanket PO's number, populated on
  //      Normal child lines that were released from a blanket.
  //
  // POLine_bLOrderNbr is DELIBERATELY NOT synced — it's a duplicate
  // Acumatica-internal field per the user's spec.
  //
  // Same first-hit-wins + discovery-log pattern as the Type field.
  const BLANKET_OPEN_QTY_CANDIDATES = [
    "BlanketOpenQty",
    "BlanketOpenQty_",
    "OpenQtyBlanket",
  ];
  const BLANKET_PO_NUM_CANDIDATES = [
    "BlanketPONbr",
    "BlanketPONumber",
    "BlanketPONbr_",
    "BlanketOrderNbr",
    "BlanketPO",
  ];
  // Blanket expiration — end-of-authorization date on a Blanket-type line.
  // Only meaningful when ln.type === "Blanket". Normalized to a YYYY-MM-DD
  // string (via toDateStr) or null. If no candidate resolves the client
  // renders "—" in the drawer instead of a wrong fallback.
  //   "_BlanketExpires" — real OData tag with LEADING UNDERSCORE (confirmed
  //   from the raw XML: <d:_BlanketExpires m:type="Edm.DateTime">…</d:_BlanketExpires>).
  //   The leading "_" is why every non-underscore guess missed even after
  //   the prefix-optional getter fix. Other entries stay as fallbacks in
  //   case the GI caption is later renamed or aliased.
  const BLANKET_EXPIRES_CANDIDATES = [
    "_BlanketExpires",
    "BlanketExpireson",
    "BlanketExp",
    "BlanketExpires",
    "BlanketExpiresOn",
    "BlanketExpDate",
    "ExpirationDate",
  ];
  function getFirstHit(getFn, candidates) {
    for (const f of candidates) {
      const v = getFn(f);
      if (v != null && String(v).trim() !== "") return { field: f, value: String(v).trim() };
    }
    return { field: null, value: "" };
  }
  let detectedBlanketOpenQtyField = null;
  let detectedBlanketPoNumField = null;
  let detectedBlanketExpiresField = null;
  let blanketOpenQtyHits = 0;
  let blanketPoNumHits = 0;
  let blanketExpiresHits = 0;
  const blanketOpenQtySamples = [];   // up to 8 non-empty (poNum, lineNbr, raw, parsed)
  const blanketPoNumSamples = [];     // up to 8 non-empty (poNum, lineNbr, raw)
  const blanketExpiresSamples = [];   // up to 8 non-empty (poNum, lineNbr, raw, iso)

  // Parse each line and group by OrderNbr.
  const byOrder = new Map();
  const headerExpectedByOrder = new Map();
  const headerBuyerByOrder = new Map();
  const headerCreatedDateByOrder = new Map();
  for (const raw of entries) {
    const { get } = makeFieldGetters(raw);
    const num = (get("OrderNbr") || "").trim();
    if (!num) continue;

    // PO header fields — same value on every line of a PO; first-wins.
    if (!headerExpectedByOrder.has(num)) {
      headerExpectedByOrder.set(num, toDateStr(get("ExpectedDate")));
    }
    if (!headerBuyerByOrder.has(num)) {
      headerBuyerByOrder.set(num, (get("CreatedBy") || "").trim());
    }
    if (!headerCreatedDateByOrder.has(num)) {
      headerCreatedDateByOrder.set(num, toDateStr(get("Date")));
    }

    const lineNbrRaw = get("LineNbr");
    const lineNbr = lineNbrRaw == null ? null
      : (Number.isFinite(parseInt(lineNbrRaw, 10)) ? parseInt(lineNbrRaw, 10) : lineNbrRaw);
    const qty = toNum(get("OrderQty"));
    const qtyReceived = toNum(get("QtyOnReceipts"));
    const acumStatus = normalizeAcumaticaStatus(get("Status"));

    let status;
    if (qty > 0 && qtyReceived >= qty) status = "received";
    else if (qtyReceived > 0) status = "partial";
    else if (acumStatus === "Rejected" || acumStatus === "Canceled") status = "cancelled";
    else if (acumStatus === "Completed") status = "received";
    else status = "open";

    // PO Line Type — first-hit-wins on the candidate list. Detected
    // field name and vocab counts are logged after the loop so a single
    // manual run reveals the real column spelling + value distribution.
    const { field: poTypeField, value: poTypeRaw } = getPOLineType(get);
    if (poTypeField && !detectedPOTypeField) detectedPOTypeField = poTypeField;
    const poTypeNorm = normalizePOLineType(poTypeRaw);
    if (poTypeRaw) poTypeRawCounts[poTypeRaw] = (poTypeRawCounts[poTypeRaw] || 0) + 1;
    if (poTypeNorm) poTypeNormCounts[poTypeNorm] = (poTypeNormCounts[poTypeNorm] || 0) + 1;

    // Blanket linkage fields — first-hit-wins, discovery logged. Store
    // the raw parsed values regardless of ln.type; the client will only
    // READ blanketOpenQty on Blanket-type lines and READ blanketPoNum on
    // Normal-type lines that link back to a parent blanket.
    const bOqHit = getFirstHit(get, BLANKET_OPEN_QTY_CANDIDATES);
    if (bOqHit.field && !detectedBlanketOpenQtyField) detectedBlanketOpenQtyField = bOqHit.field;
    const blanketOpenQty = bOqHit.value ? toNum(bOqHit.value) : 0;
    if (bOqHit.value) {
      blanketOpenQtyHits++;
      if (blanketOpenQtySamples.length < 8) {
        blanketOpenQtySamples.push({ po: num, lineNbr, raw: bOqHit.value, parsed: blanketOpenQty });
      }
    }
    const bPnHit = getFirstHit(get, BLANKET_PO_NUM_CANDIDATES);
    if (bPnHit.field && !detectedBlanketPoNumField) detectedBlanketPoNumField = bPnHit.field;
    const blanketPoNum = bPnHit.value ? bPnHit.value : null;
    if (bPnHit.value) {
      blanketPoNumHits++;
      if (blanketPoNumSamples.length < 8) {
        blanketPoNumSamples.push({ po: num, lineNbr, raw: bPnHit.value });
      }
    }
    // Blanket expiration date. Unlike Promised/Requested (which arrive as
    // ISO), this field comes through as M/D/YYYY (e.g. "7/9/2027"), so
    // toDateStr's straight slice would leave it un-ISO. Parse M/D/YYYY
    // → YYYY-MM-DD explicitly; already-ISO values also pass through. Null
    // when no candidate resolves OR the value is unrecognized.
    const bExpHit = getFirstHit(get, BLANKET_EXPIRES_CANDIDATES);
    if (bExpHit.field && !detectedBlanketExpiresField) detectedBlanketExpiresField = bExpHit.field;
    const blanketExpires = (() => {
      if (!bExpHit.value) return null;
      const s = String(bExpHit.value).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) {
        const [, mo, d, y] = m;
        return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
      return null;
    })();
    if (bExpHit.value) {
      blanketExpiresHits++;
      if (blanketExpiresSamples.length < 8) {
        blanketExpiresSamples.push({ po: num, lineNbr, raw: bExpHit.value, iso: blanketExpires });
      }
    }

    const line = {
      id: `${num}::${lineNbr}`,            // stable across syncs (dedupe key)
      pn: (get("InventoryID") || "").trim(),
      desc: get("Description") || "",
      qty,                                  // = OrderQty (app reads `qty`)
      qtyReceived,                          // = QtyOnReceipts (app reads `qtyReceived`)
      openQty: toNum(get("OpenQty")),
      cost: toNum(get("UnitCost")),         // = UnitCost (app reads `cost`)
      extCost: toNum(get("ExtCost")),
      uom: (get("UOM") || "").trim(),
      expectedDate: toDateStr(get("Promised")), // = Promised (app reads `expectedDate`)
      requestedDate: toDateStr(get("Requested")),
      warehouse: (get("Warehouse") || "").trim(),
      vendor: (get("Vendor") || "").trim(),
      vendorName: get("VendorName") || "",
      status,
      acumStatus,
      type: poTypeNorm,                     // "Normal" / "Blanket" / … / "" if unknown
      blanketOpenQty,                       // remaining qty available to release (blanket lines only)
      blanketPoNum,                         // parent blanket PO # (child lines only, else null)
      blanketExpires,                       // ISO date string when blanket authorization ends (blanket lines only, else null)
      lineNbr,
      notes: "",
    };

    if (!byOrder.has(num)) byOrder.set(num, []);
    byOrder.get(num).push(line);
  }

  log(`PO sync: grouped into ${byOrder.size} POs`);

  // ── PO line Type discovery log ─────────────────────────────────────
  // Surfaces which candidate field name won and every distinct raw
  // value seen so the true vocabulary is visible after a single run.
  // If NO candidate ever resolved, log loudly — downstream code sees
  // ln.type === "" everywhere and can't distinguish Normal vs Blanket.
  if (detectedPOTypeField) {
    log(`PO Type field detected: "${detectedPOTypeField}"`);
  } else {
    log(`WARNING: no PO Type field resolved from candidates [${PO_TYPE_FIELD_CANDIDATES.join(", ")}] — ` +
      `every ln.type set to "". Check the LM Planner PO Lines GI column names and add the correct spelling.`);
  }
  log("PO Type raw value counts:", poTypeRawCounts);
  log("PO Type normalized counts:", poTypeNormCounts);

  // ── Blanket-linkage discovery logs ────────────────────────────────
  if (detectedBlanketOpenQtyField) {
    log(`Blanket Open Qty field detected: "${detectedBlanketOpenQtyField}" (${blanketOpenQtyHits} non-empty values)`);
  } else {
    log(`WARNING: no Blanket Open Qty field resolved from candidates [${BLANKET_OPEN_QTY_CANDIDATES.join(", ")}] — ` +
      `every ln.blanketOpenQty set to 0. Check the LM Planner PO Lines GI column names.`);
  }
  if (blanketOpenQtySamples.length) log("Blanket Open Qty samples:", blanketOpenQtySamples);
  if (detectedBlanketPoNumField) {
    log(`Blanket PO Num field detected: "${detectedBlanketPoNumField}" (${blanketPoNumHits} non-empty values)`);
  } else {
    log(`WARNING: no Blanket PO Num field resolved from candidates [${BLANKET_PO_NUM_CANDIDATES.join(", ")}] — ` +
      `every ln.blanketPoNum set to null. Check the LM Planner PO Lines GI column names.`);
  }
  if (blanketPoNumSamples.length) log("Blanket PO Num samples:", blanketPoNumSamples);
  if (detectedBlanketExpiresField) {
    log(`Blanket Expires field detected: "${detectedBlanketExpiresField}" (${blanketExpiresHits} non-empty values)`);
  } else {
    log(`WARNING: no Blanket Expires field resolved from candidates [${BLANKET_EXPIRES_CANDIDATES.join(", ")}] — ` +
      `every ln.blanketExpires set to null. Check the LM Planner PO Lines GI column names.`);
  }
  if (blanketExpiresSamples.length) log("Blanket Expires samples:", blanketExpiresSamples);

  if (byOrder.size === 0) {
    return { posInFeed: 0, linesInFeed: entries.length, upserted: 0, reconciled: 0, note: "No PO entries parsed" };
  }

  // Load existing pos rows (to preserve local buyer/notes and to reconcile drop-outs).
  const existing = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa.from("pos").select("id, data").range(from, from + PAGE - 1);
    if (error) { log("pos select error", error); return { error: "pos select failed", detail: error.message }; }
    if (!data || data.length === 0) break;
    existing.push(...data);
    if (data.length < PAGE) break;
  }
  const existingById = new Map(existing.map((r) => [r.id, r.data || {}]));
  log(`PO sync: loaded ${existing.length} existing pos rows`);

  // ── Delta-detection helpers ────────────────────────────────────────
  // This is the whole realtime-quota fix. Before this guard, runPOSync
  // upserted every PO in the feed on every 2-minute run — ~700 rows ×
  // 21,600 runs/month → millions of pos-table events per month, most
  // of them for POs whose data was byte-identical.
  //
  // The comparison MUST NOT be object-identity or naive JSON.stringify:
  //   - `lines[]` is rebuilt from the feed each run, so identity always
  //     differs even when content is the same.
  //   - Object key insertion order in newly-built rows might differ
  //     from what an older writer left in Supabase, so plain stringify
  //     of the two objects wouldn't match either.
  //
  // _canonicalize sorts every object key alphabetically at every level
  // and passes primitives through unchanged. _poFingerprint additionally
  // sorts lines by lineNbr so a feed-order swap between runs doesn't
  // register as a real change. The result is a deterministic string
  // representation — any real change to any field on data or any line
  // still flips the fingerprint, but incidental rebuilds don't.
  function _canonicalize(v) {
    if (v === null || v === undefined) return v;
    if (Array.isArray(v)) return v.map(_canonicalize);
    if (typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = _canonicalize(v[k]);
      return out;
    }
    return v;
  }
  function _poFingerprint(data) {
    if (!data || typeof data !== "object") return "";
    const lines = Array.isArray(data.lines) ? [...data.lines] : [];
    // Sort by lineNbr; null/undefined land last via Infinity sentinel.
    lines.sort((a, b) => {
      const an = (a && a.lineNbr != null) ? a.lineNbr : Infinity;
      const bn = (b && b.lineNbr != null) ? b.lineNbr : Infinity;
      return an - bn;
    });
    return JSON.stringify(_canonicalize({ ...data, lines }));
  }

  // Build nested PO rows.
  const rows = [];
  let unchanged = 0;
  for (const [num, lines] of byOrder.entries()) {
    const id = "po_" + num;
    const prev = existingById.get(id) || {};

    // Preserve local annotations (PO-level buyer/notes, per-line notes).
    const prevLineNotes = new Map((prev.lines || []).map((l) => [l.id, l.notes]));
    for (const ln of lines) {
      const n = prevLineNotes.get(ln.id);
      if (n) ln.notes = n;
    }

    const first = lines[0];
    const allTerm = lines.length > 0 && lines.every((l) => l.status === "received" || l.status === "cancelled");
    const anyReceived = lines.some((l) => l.status === "received");
    const anyProgress = lines.some((l) => l.status === "partial" || l.status === "received");
    let poStatus;
    if (allTerm && anyReceived) poStatus = "received";
    else if (anyProgress) poStatus = "in_transit";
    else poStatus = "submitted";

    const data = {
      id,
      num,
      supplier: first.vendorName || "",
      vendor: first.vendor || "",
      source: "acumatica",
      buyer: isRealBuyer(prev.buyer) ? prev.buyer : (headerBuyerByOrder.get(num) || ""),
      createdBy: prev.createdBy || "",
      notes: prev.notes || "",
      createdDate: headerCreatedDateByOrder.get(num) || null,
      expectedDate: headerExpectedByOrder.get(num) || first.expectedDate || null,
      status: poStatus,
      acumStatus: rollupAcumaticaStatus(lines),
      lines,
    };

    // Delta gate — skip the upsert when the canonical fingerprint of the
    // newly-built row matches the existing row byte-for-byte. New POs
    // (no `prev` in existingById) always pass since prev's fingerprint
    // is a canonicalized empty object.
    if (existingById.has(id) && _poFingerprint(data) === _poFingerprint(prev)) {
      unchanged++;
      continue;
    }
    rows.push({ id, data });
  }

  // Reconciliation (additive, never delete): a PO previously synced from
  // Acumatica that is no longer in the feed and isn't already received is
  // marked received/Completed.
  //
  // feedIds is now sourced from byOrder.keys() (every PO seen in the
  // feed), NOT from `rows` (which only contains POs that beat the delta
  // gate). Skipped-as-unchanged POs are still IN the feed — they must
  // not be mis-classified as "no longer in feed" and reconciled to
  // received. This is the subtle correctness bug that would fire the
  // moment delta detection catches anything.
  const feedIds = new Set([...byOrder.keys()].map((num) => "po_" + num));
  let reconciled = 0;
  for (const r of existing) {
    const d = r.data || {};
    if (d.source === "acumatica" && !feedIds.has(r.id) && d.status !== "received") {
      rows.push({ id: r.id, data: { ...d, status: "received", acumStatus: "Completed" } });
      reconciled++;
    }
  }

  // Upsert.
  const BATCH = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supa.from("pos").upsert(batch);
    if (error) { log("pos upsert error", error); return { error: "pos upsert failed", detail: error.message, partial: upserted }; }
    upserted += batch.length;
  }

  // Broadcast — respects the delta gate. `upserted` counts rows that
  // ACTUALLY passed the fingerprint check upstream (see the delta gate
  // at line ~773). A "0 upserted" tick means every feed row matched
  // the stored fingerprint — no client-visible change, no ping.
  if (upserted > 0) {
    await sendBroadcast({ supabaseUrl, serviceKey, tables: ["pos"], log });
  }

  // Audit.
  const auditId = `audit_acumatica_pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await supa.from("audit").upsert([
    {
      id: auditId,
      data: {
        id: auditId,
        ts: new Date().toISOString(),
        type: "acumatica-po-sync",
        msg: `Acumatica PO sync: ${upserted} upserted, ${unchanged} unchanged (skipped), ${reconciled} reconciled closed (${byOrder.size} POs / ${entries.length} lines in feed)`,
        detail: {
          source: "netlify-scheduled-function",
          posInFeed: byOrder.size,
          linesInFeed: entries.length,
          upserted,
          unchanged,
          reconciled,
          poTypeField: detectedPOTypeField,
          poTypeRawCounts,
          poTypeNormCounts,
          blanketOpenQtyField: detectedBlanketOpenQtyField,
          blanketOpenQtyHits,
          blanketPoNumField: detectedBlanketPoNumField,
          blanketPoNumHits,
          blanketExpiresField: detectedBlanketExpiresField,
          blanketExpiresHits,
        },
      },
    },
  ]);

  log(`POs: ${upserted} upserted, ${unchanged} unchanged (skipped), ${reconciled} reconciled`);
  return {
    posInFeed: byOrder.size,
    linesInFeed: entries.length,
    upserted,
    unchanged,
    reconciled,
    poTypeField: detectedPOTypeField,
    poTypeRawCounts,
    poTypeNormCounts,
    blanketOpenQtyField: detectedBlanketOpenQtyField,
    blanketOpenQtyHits,
    blanketOpenQtySamples,
    blanketPoNumField: detectedBlanketPoNumField,
    blanketPoNumHits,
    blanketPoNumSamples,
    blanketExpiresField: detectedBlanketExpiresField,
    blanketExpiresHits,
    blanketExpiresSamples,
  };
}
