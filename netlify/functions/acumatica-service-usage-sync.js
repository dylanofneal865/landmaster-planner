// Netlify Scheduled Function — refreshes Acumatica-sourced sales-order
// rows in the Supabase `usage` table from the "LM Planner Service Usage" GI.
//
// Schedule: 06:00 UTC daily (see netlify.toml).
//
// Design contract (grep-verifiable):
//   1. Writes ONLY to Supabase `usage`. Zero calls to _supa.from("parts").
//      No daily rate is computed anywhere. part.data.daily is never read
//      or written. `parts` table is completely untouched.
//   2. Sync-owned rows are namespaced by id prefix `us_acumatica-so_` so
//      the scoped rebuild (delete + reinsert) below can never touch
//      Excel-imported rows (`sales-order-…` sourceKey), C9 Big Sheet
//      rows, manual logs, warranty/damaged/loss entries, or any other
//      non-Acumatica usage transaction.
//   3. Raw sales rows only — kits are written with pn = <kitPn>, NO
//      component explosion here. The client is expected to handle
//      kit-driven component demand.
//
//      IMPORTANT KNOWN GAP: as of this deploy, the client does NOT
//      explode kits at read time. computeDemand (js/40-demand.js:16-42)
//      is a plain per-pn sum with zero kit awareness. Kit explosion
//      historically happened at write time in the Excel import
//      (js/13-page-settings.js:543-573). This sync's raw-only writes
//      mean kit-component service parts (e.g. CP00537) will NOT receive
//      credit for NEW Acumatica-sourced kit sales until either:
//        (a) a client-side getDailyUse + kit_boms read-time explosion
//            is built, OR
//        (b) this sync is extended to explode at write time via a
//            server-side bom_links/kit_boms fetch.
//      Prior Excel-import exploded rows survive (they carry
//      `sourceKey: kit-explosion-…` and are outside this sync's
//      rebuild scope) so historical credit is intact.
//
// Required env vars:
//   ACUMATICA_BASE_URL
//   ACUMATICA_COMPANY
//   ACUMATICA_SERVICE_USAGE_GI_NAME   e.g. "LM Planner Service Usage"
//   ACUMATICA_USERNAME
//   ACUMATICA_PASSWORD
//   SUPABASE_URL
//   SUPABASE_SERVICE_KEY

const { createClient } = require("@supabase/supabase-js");

// Prefix-optional field extractor — copied verbatim from acumatica-sync.js.
// Handles both <d:Foo> (native DAC) and <_Foo> (custom GI columns like
// _BlanketExpires). Boundary-safe: the trailing (?:\s[^>]*)?> group
// forces either whitespace or > after the field name, so "InventoryID"
// won't partial-match "InventoryIDExt" or vice versa.
function makeFieldGetters(raw) {
  const get = (field) => {
    const re = new RegExp(`<(?:d:)?${field}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:d:)?${field}>`, "i");
    const m = raw.match(re);
    return m ? m[1].trim() : null;
  };
  const isNull = (field) => {
    const re = new RegExp(`<(?:d:)?${field}\\b[^>]*m:null="true"`, "i");
    return re.test(raw);
  };
  return { get, isNull };
}

function getFirstHit(getFn, candidates) {
  for (const f of candidates) {
    const v = getFn(f);
    if (v != null && String(v).trim() !== "") return { field: f, value: String(v).trim() };
  }
  return { field: null, value: "" };
}

// Robust date parse — handles ISO ("2026-06-15T00:00:00") AND M/D/YYYY
// ("6/15/2026"). Returns UTC epoch ms at 12:00 UTC on the parsed date,
// matching parseSalesOrderWorkbook's noon-UTC convention so a same-date
// sale lands at the same ms whether it came via Excel importer or this
// sync. Also returns an ISO date string for storage. NaN/null when
// unparseable.
function parseFeedDate(v) {
  if (!v) return { ms: NaN, iso: null };
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const ms = Date.UTC(+iso[1], +iso[2] - 1, +iso[3], 12, 0, 0);
    return { ms, iso: new Date(ms).toISOString() };
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) {
    const ms = Date.UTC(+us[3], +us[1] - 1, +us[2], 12, 0, 0);
    return { ms, iso: new Date(ms).toISOString() };
  }
  const d = new Date(s);
  const ms = d.getTime();
  return { ms, iso: isFinite(ms) ? new Date(ms).toISOString() : null };
}

function toNum(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

exports.handler = async () => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[acumatica-service-usage-sync] ${msg}`, data || "");

  const {
    ACUMATICA_BASE_URL,
    ACUMATICA_COMPANY,
    ACUMATICA_SERVICE_USAGE_GI_NAME,
    ACUMATICA_USERNAME,
    ACUMATICA_PASSWORD,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
  } = process.env;

  if (!ACUMATICA_BASE_URL || !ACUMATICA_USERNAME || !ACUMATICA_PASSWORD ||
      !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing required environment variables");
    return { statusCode: 500, body: JSON.stringify({ error: "Missing env vars" }) };
  }

  const giName = ACUMATICA_SERVICE_USAGE_GI_NAME || "LM Planner Service Usage";
  const giEncoded = encodeURIComponent(giName);
  const company = ACUMATICA_COMPANY || "LIVE";
  const url = `${ACUMATICA_BASE_URL}/OData/${company}/${giEncoded}`;

  // ── Paginated fetch — mirrors runPOSync in acumatica-sync.js ────────
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 30;
  log("Fetching (paginated)", url);

  const entries = [];
  let pageCount = 0;
  try {
    const auth = Buffer.from(`${ACUMATICA_USERNAME}:${ACUMATICA_PASSWORD}`).toString("base64");
    for (let page = 0, skip = 0; page < MAX_PAGES; page++, skip += PAGE_SIZE) {
      const pageUrl = `${url}?$top=${PAGE_SIZE}&$skip=${skip}`;
      const resp = await fetch(pageUrl, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/atom+xml" },
      });
      if (!resp.ok) {
        const body = await resp.text();
        log("Acumatica non-OK status", { status: resp.status, page, skip, body: body.slice(0, 200) });
        return { statusCode: 502, body: JSON.stringify({ error: "Acumatica fetch failed", status: resp.status, page }) };
      }
      const pageXml = await resp.text();
      const pageEntries = pageXml.split(/<entry[^>]*>/i).slice(1);
      pageCount++;
      log(`page ${pageCount} (skip=${skip}) returned ${pageEntries.length} entries`);
      entries.push(...pageEntries);
      if (pageEntries.length < PAGE_SIZE) break;
    }
    if (pageCount === MAX_PAGES && entries.length && entries.length % PAGE_SIZE === 0) {
      log(`WARNING: hit MAX_PAGES=${MAX_PAGES} without a short page — feed may have more rows. Raise MAX_PAGES.`);
    }
  } catch (err) {
    log("Fetch threw", err.message);
    return { statusCode: 502, body: JSON.stringify({ error: "Acumatica fetch error", detail: err.message }) };
  }
  log(`Fetched ${entries.length} entries across ${pageCount} pages`);

  if (entries.length === 0) {
    log("No entries — bailing without touching usage table");
    return { statusCode: 200, body: JSON.stringify({ upserted: 0, deleted: 0, note: "No entries" }) };
  }

  // ── Field discovery ────────────────────────────────────────────────
  // Same first-hit-wins pattern as blanket-linkage in acumatica-sync.
  // OrderNbr is added to the field set because we need it to build a
  // stable per-row id (`us_acumatica-so_<orderNbr>_<invId>`). If it
  // can't be resolved we short-circuit — a random id would break the
  // scoped-rebuild deletion contract.
  const PN_CANDIDATES     = ["InventoryID", "Inventory_ID", "InventoryID_"];
  const QTY_CANDIDATES    = ["Quantity", "Qty", "OrderQty"];
  const DATE_CANDIDATES   = ["SOLine_orderDate", "SOLineorderDate", "OrderDate"];
  const ORDER_CANDIDATES  = ["OrderNbr", "SOOrderNbr", "OrderNumber", "OrderNo", "OrderNbr_"];
  const STATUS_CANDIDATES = ["Status", "OrderStatus", "SOStatus"];   // optional cancel guard

  let detectedPnField     = null;
  let detectedQtyField    = null;
  let detectedDateField   = null;
  let detectedOrderField  = null;
  let detectedStatusField = null;
  let pnHits = 0, qtyHits = 0, dateHits = 0, orderHits = 0, statusHits = 0;
  const dateSamples = [];

  // Defensive cancel status skip. GI is expected to filter these
  // server-side; this is belt-and-suspenders.
  const CANCELED = new Set(["canceled", "cancelled", "voided", "void", "rejected", "hold", "on hold"]);

  // Row accumulation — one output row per (orderNbr, invId) combo. If
  // the same combo appears twice in the feed (rare — usually only via
  // schema quirks), we keep the LAST occurrence's values.
  const rowsByKey = new Map();   // "orderNbr::invId" → { orderNbr, pn, qty, ts, iso }

  let skippedCanceled = 0;
  let skippedNoPn = 0;
  let skippedNoQty = 0;
  let skippedNoDate = 0;
  let skippedNoOrder = 0;

  for (const raw of entries) {
    const { get } = makeFieldGetters(raw);

    const pnHit = getFirstHit(get, PN_CANDIDATES);
    if (pnHit.field && !detectedPnField) detectedPnField = pnHit.field;
    if (!pnHit.value) { skippedNoPn++; continue; }
    pnHits++;
    const pn = pnHit.value;

    const statHit = getFirstHit(get, STATUS_CANDIDATES);
    if (statHit.field && !detectedStatusField) detectedStatusField = statHit.field;
    if (statHit.value) {
      statusHits++;
      if (CANCELED.has(statHit.value.toLowerCase())) { skippedCanceled++; continue; }
    }

    const qtyHit = getFirstHit(get, QTY_CANDIDATES);
    if (qtyHit.field && !detectedQtyField) detectedQtyField = qtyHit.field;
    if (!qtyHit.value) { skippedNoQty++; continue; }
    qtyHits++;
    const qty = toNum(qtyHit.value);
    if (qty <= 0) { skippedNoQty++; continue; }

    const dateHit = getFirstHit(get, DATE_CANDIDATES);
    if (dateHit.field && !detectedDateField) detectedDateField = dateHit.field;
    if (!dateHit.value) { skippedNoDate++; continue; }
    dateHits++;
    const parsed = parseFeedDate(dateHit.value);
    if (!isFinite(parsed.ms) || !parsed.iso) { skippedNoDate++; continue; }
    if (dateSamples.length < 5) dateSamples.push({ raw: dateHit.value, iso: parsed.iso.slice(0, 10) });

    const orderHit = getFirstHit(get, ORDER_CANDIDATES);
    if (orderHit.field && !detectedOrderField) detectedOrderField = orderHit.field;
    if (!orderHit.value) { skippedNoOrder++; continue; }
    orderHits++;
    const orderNbr = orderHit.value;

    const key = `${orderNbr}::${pn}`;
    rowsByKey.set(key, {
      orderNbr,
      pn,
      qty: Math.round(qty),
      ts: parsed.iso,
    });
  }

  log(`Parsed: ${entries.length} entries → ${rowsByKey.size} distinct (orderNbr, invId) pairs`);
  log(`Skipped: noPn=${skippedNoPn}, noQty=${skippedNoQty}, noDate=${skippedNoDate}, noOrder=${skippedNoOrder}, canceled=${skippedCanceled}`);

  if (detectedPnField)     log(`InventoryID field detected: "${detectedPnField}" (${pnHits} non-empty)`);
  else                     log(`WARNING: no InventoryID field resolved from [${PN_CANDIDATES.join(", ")}]`);
  if (detectedQtyField)    log(`Quantity field detected: "${detectedQtyField}" (${qtyHits} non-empty)`);
  else                     log(`WARNING: no Quantity field resolved from [${QTY_CANDIDATES.join(", ")}]`);
  if (detectedDateField)   log(`Order-date field detected: "${detectedDateField}" (${dateHits} non-empty)`);
  else                     log(`WARNING: no order-date field resolved from [${DATE_CANDIDATES.join(", ")}]`);
  if (detectedOrderField)  log(`OrderNbr field detected: "${detectedOrderField}" (${orderHits} non-empty)`);
  else                     log(`WARNING: no OrderNbr field resolved from [${ORDER_CANDIDATES.join(", ")}] — stable ids cannot be built`);
  if (dateSamples.length)  log("Date samples (raw → iso):", dateSamples);
  if (detectedStatusField) log(`Status field detected: "${detectedStatusField}" (${statusHits} non-empty) — used for canceled guard`);
  else                     log(`Status field not present in GI — GI-side filter is the only defense against canceled rows`);

  if (!detectedPnField || !detectedQtyField || !detectedDateField || !detectedOrderField) {
    return { statusCode: 500, body: JSON.stringify({
      error: "Critical GI field(s) missing — verify candidate lists against the GI header",
      pnField: detectedPnField, qtyField: detectedQtyField, dateField: detectedDateField, orderField: detectedOrderField,
    }) };
  }

  // ── Supabase setup + tombstone fetch ───────────────────────────────
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // deleted_parts tombstones — non-fatal fetch. If the fetch fails we
  // proceed WITHOUT the filter (better than blocking the whole day's
  // sync) but log loudly.
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

  // Filter out tombstoned pns from the write set.
  let tombstoneFiltered = 0;
  for (const key of Array.from(rowsByKey.keys())) {
    const r = rowsByKey.get(key);
    if (tombstoned.has(r.pn)) {
      rowsByKey.delete(key);
      tombstoneFiltered++;
    }
  }
  if (tombstoneFiltered > 0) log(`Filtered ${tombstoneFiltered} sales rows for tombstoned pns`);

  // ── Scoped rebuild ─────────────────────────────────────────────────
  // Step 1: DELETE existing sync-owned rows whose id matches
  //   `us_acumatica-so_%`. This is the "rebuild" step — sales that
  //   Acumatica has since removed (e.g. order voided post-sync) go away.
  //   Non-sync rows (Excel import `sales-order-…`, kit-explosion rows
  //   from Excel, C9 Big Sheet historical, manual log, warranty/damage
  //   entries) are OUTSIDE the id prefix and are NEVER touched.
  //
  //   NOTE ON DELETE SEMANTICS: this deliberately deletes ALL prior
  //   sync-owned rows (including ones that STILL appear in the current
  //   feed) and re-inserts them via the upsert below. Correct because
  //   the row shape is deterministic from the feed — no local state
  //   is on these rows that a delete could destroy.
  log("Scoped rebuild — deleting prior sync-owned rows (id LIKE 'us_acumatica-so_%')");
  {
    const { error, count } = await supa
      .from("usage")
      .delete({ count: "exact" })
      .like("id", "us_acumatica-so\\_%");   // escape underscore so it's literal, not a wildcard
    if (error) {
      log("Scoped delete failed", error);
      return { statusCode: 500, body: JSON.stringify({ error: "Scoped delete failed", detail: error.message }) };
    }
    log(`Deleted ${count ?? "?"} prior sync-owned row(s)`);
  }

  // Step 2: build & upsert the new rows. Row shape mirrors the Excel
  // import as closely as possible so downstream consumers (computeDemand,
  // Service Usage page, any manual audit) see identical fields — the
  // only distinguishing marks are:
  //   - id prefix `us_acumatica-so_` (Excel uses random `us_…`)
  //   - sourceKey prefix `acumatica-so-` (Excel uses `sales-order-`)
  //   - reason "…Acumatica sync" (Excel uses "…imported")
  //   - user "acumatica-sync" (Excel uses "imported")
  // pn, qty, ts, buildLine ARE identical. computeDemand only cares
  // about ts/pn/qty so demand math is byte-equivalent to what a fresh
  // Excel import of the same GI data would produce.
  const rowsToWrite = [];
  for (const r of rowsByKey.values()) {
    rowsToWrite.push({
      id: `us_acumatica-so_${r.orderNbr}_${r.pn}`,
      data: {
        ts: r.ts,
        pn: r.pn,
        qty: r.qty,
        buildLine: "service",
        reason: "Sales order shipment - Acumatica sync",
        user: "acumatica-sync",
        sourceKey: `acumatica-so-${r.orderNbr}-${r.pn}`,
      },
    });
  }

  if (rowsToWrite.length === 0) {
    log("No rows to write after tombstone filter — sync-owned scope is now empty");
    return { statusCode: 200, body: JSON.stringify({
      upserted: 0,
      deletedPriorSyncRows: "see log",
      note: "Empty write set after tombstone filter",
    }) };
  }

  log(`Upserting ${rowsToWrite.length} row(s) into usage table`);
  const BATCH = 500;
  let totalUpserted = 0;
  for (let i = 0; i < rowsToWrite.length; i += BATCH) {
    const batch = rowsToWrite.slice(i, i + BATCH);
    const { error } = await supa.from("usage").upsert(batch);
    if (error) {
      log(`Batch ${i}-${i + batch.length - 1} upsert failed`, error);
      return { statusCode: 500, body: JSON.stringify({
        error: "usage upsert failed", detail: error.message, upsertedBefore: totalUpserted,
      }) };
    }
    totalUpserted += batch.length;
  }
  log(`usage_txns rebuilt: ${totalUpserted} row(s)`);

  const elapsedMs = Date.now() - t0;
  log(`Done in ${elapsedMs}ms`);

  // Structured audit — best-effort insert.
  try {
    await supa.from("audit").insert({
      ts: new Date().toISOString(),
      type: "service-usage-sync",
      msg: `usage_txns rebuilt: ${totalUpserted} Acumatica-sourced row(s) in ${elapsedMs}ms`,
      detail: {
        entries: entries.length,
        pagesFetched: pageCount,
        distinctRows: rowsByKey.size,
        upserted: totalUpserted,
        tombstoneFiltered,
        skipped: {
          noPn: skippedNoPn,
          noQty: skippedNoQty,
          noDate: skippedNoDate,
          noOrder: skippedNoOrder,
          canceled: skippedCanceled,
        },
        detectedFields: {
          pn: detectedPnField,
          qty: detectedQtyField,
          date: detectedDateField,
          order: detectedOrderField,
          status: detectedStatusField,
        },
        note: "raw sales rows only — kits NOT exploded by this sync",
      },
    });
  } catch (e) {
    log("Audit insert threw (non-fatal)", e.message);
  }

  return { statusCode: 200, body: JSON.stringify({
    upserted: totalUpserted,
    entries: entries.length,
    pagesFetched: pageCount,
    tombstoneFiltered,
    detectedFields: {
      pn: detectedPnField,
      qty: detectedQtyField,
      date: detectedDateField,
      order: detectedOrderField,
      status: detectedStatusField,
    },
  }) };
};
