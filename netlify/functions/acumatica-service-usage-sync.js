// Netlify Scheduled Function — computes a 180-day rolling daily-usage rate
// per LMCOMPO service part from the Acumatica "LM Planner Service Usage" GI
// and merge-safely writes it to parts.data.daily.
//
// Schedule: 06:00 UTC daily (see netlify.toml).
//
// This REPLACES the monthly-manual Excel "Service Usage Import" chain
// (js/13-page-settings.js handleSalesOrderImportFile → commitSalesOrderImport
// → js/40-demand.js computeDemand → js/19-page-usage.js bulkApplyComputedDaily)
// as the daily-rate source. The Service Queue reads part.daily via
// chainDisplayDaily / daysUntilStockout / suggestedQty (all in js/03-calc.js);
// none of those change. Only the number they read gets refreshed once a day.
//
// Formula match (mirrors js/40-demand.js computeDemand exactly):
//   daily = Math.round((units_shipped_in_last_180_days / 180) * 1000) / 1000
//
// Scope: only rows where existing.itemType === "service" are touched. base_bom
// and options parts get their daily from elsewhere and are ignored here — even
// if the GI accidentally leaks a non-LMCOMPO row.
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
// Divergence between the two files would be a latent bug: any future getter
// fix (e.g. the underscore/prefix work for _BlanketExpires) must land here
// too. Boundary is enforced by the trailing `(?:\s[^>]*)?>` group so
// "InventoryID" never partial-matches "InventoryIDExt" and vice versa.
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

// First-hit-wins over a candidate list — same shape as the PO Type /
// Blanket-linkage lookups in acumatica-sync.js runPOSync.
function getFirstHit(getFn, candidates) {
  for (const f of candidates) {
    const v = getFn(f);
    if (v != null && String(v).trim() !== "") return { field: f, value: String(v).trim() };
  }
  return { field: null, value: "" };
}

// Robust date parse — handles ISO ("2026-06-15T00:00:00") AND M/D/YYYY
// ("6/15/2026"). The blanket-expiration work already proved that Acumatica
// GI date columns arrive in either shape depending on the column's DAC/
// display setting, so support both. Returns UTC epoch ms at 12:00 UTC on
// the parsed date (matching parseSalesOrderWorkbook's noon-UTC convention
// so a same-date shipment lands at the same ms whether it came via the
// Excel importer or via this sync). NaN when unparseable.
function parseFeedDate(v) {
  if (!v) return NaN;
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return Date.UTC(+iso[1], +iso[2] - 1, +iso[3], 12, 0, 0);
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (us) return Date.UTC(+us[3], +us[1] - 1, +us[2], 12, 0, 0);
  const d = new Date(s);
  return d.getTime();
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

  // ── Paginated fetch ─────────────────────────────────────────────────
  // Mirrors runPOSync's $top/$skip loop. This GI is ~10k rows so a
  // single-shot fetch WILL truncate at 1000. MAX_PAGES caps at 30 (30k
  // rows) with a WARNING log if we hit the ceiling on full pages —
  // headroom over the current 10k with room to grow.
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
    log("No entries — bailing without touching parts");
    return { statusCode: 200, body: JSON.stringify({ updated: 0, note: "No entries" }) };
  }

  // ── Field discovery ────────────────────────────────────────────────
  // Same first-hit-wins pattern as the blanket-linkage work. Real OData
  // tag names occasionally have a leading underscore (see _BlanketExpires)
  // or slightly different casing, so log which candidate won for each
  // field. If any critical field can't be resolved we short-circuit
  // with a 500 rather than write zeros to every service part.
  const PN_CANDIDATES     = ["InventoryID", "Inventory_ID", "InventoryID_"];
  const QTY_CANDIDATES    = ["Quantity", "Qty", "OrderQty"];
  const DATE_CANDIDATES   = ["SOLine_orderDate", "SOLineorderDate", "OrderDate"];
  const STATUS_CANDIDATES = ["Status", "OrderStatus", "SOStatus"];   // optional — cancel guard

  let detectedPnField     = null;
  let detectedQtyField    = null;
  let detectedDateField   = null;
  let detectedStatusField = null;
  let pnHits = 0, qtyHits = 0, dateHits = 0, statusHits = 0;
  const dateSamples = [];   // first 5 (raw → iso) so we can eyeball parse correctness

  // ── 180-day window accumulation ────────────────────────────────────
  // Formula (identical to js/40-demand.js:35 computeDemand):
  //   daily = Math.round((units_in_last_180_days / 180) * 1000) / 1000
  // Boundary: `t > cutoff` — strictly after, matches computeDemand's
  // `t > cutoff` predicate at line 30.
  const WINDOW_DAYS  = 180;
  const nowMs        = Date.now();
  const cutoffMs     = nowMs - WINDOW_DAYS * 86400000;
  const CANCELED     = new Set([
    "canceled", "cancelled", "voided", "void", "rejected", "hold", "on hold",
  ]);

  const unitsByPn    = new Map();   // pn → in-window units (only if > 0)
  const lastSaleByPn = new Map();   // pn → epoch ms of latest sale (any date)

  let skippedCanceled = 0;
  let skippedOutOfWindow = 0;
  let skippedNoPn = 0;
  let skippedNoQty = 0;
  let skippedNoDate = 0;

  for (const raw of entries) {
    const { get } = makeFieldGetters(raw);

    const pnHit = getFirstHit(get, PN_CANDIDATES);
    if (pnHit.field && !detectedPnField) detectedPnField = pnHit.field;
    if (!pnHit.value) { skippedNoPn++; continue; }
    pnHits++;
    const pn = pnHit.value;

    // Defensive cancel guard. The GI is supposed to filter these
    // server-side, but a designer change upstream that broke the filter
    // shouldn't silently poison every daily rate. Only fires if the GI
    // exposes a Status column at all.
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
    const tsMs = parseFeedDate(dateHit.value);
    if (!isFinite(tsMs)) { skippedNoDate++; continue; }
    if (dateSamples.length < 5) {
      dateSamples.push({ raw: dateHit.value, iso: new Date(tsMs).toISOString().slice(0, 10) });
    }

    // Track latest sale regardless of window — needed for the
    // "part was in feed at some point" vs "never in feed" distinction
    // that matches manual-import behavior for the drop-off decision.
    if (!lastSaleByPn.has(pn) || tsMs > lastSaleByPn.get(pn)) {
      lastSaleByPn.set(pn, tsMs);
    }

    if (tsMs <= cutoffMs) { skippedOutOfWindow++; continue; }
    unitsByPn.set(pn, (unitsByPn.get(pn) || 0) + qty);
  }

  log(`Parsed: ${entries.length} entries → ${unitsByPn.size} pns with in-window units, ${lastSaleByPn.size} pns with any sale`);
  log(`Skipped: noPn=${skippedNoPn}, noQty=${skippedNoQty}, noDate=${skippedNoDate}, canceled=${skippedCanceled}, outOfWindow=${skippedOutOfWindow}`);

  // ── Field-discovery report ─────────────────────────────────────────
  if (detectedPnField) log(`InventoryID field detected: "${detectedPnField}" (${pnHits} non-empty)`);
  else                 log(`WARNING: no InventoryID field resolved from [${PN_CANDIDATES.join(", ")}] — everything was skipped for missing pn`);

  if (detectedQtyField) log(`Quantity field detected: "${detectedQtyField}" (${qtyHits} non-empty)`);
  else                  log(`WARNING: no Quantity field resolved from [${QTY_CANDIDATES.join(", ")}] — everything was skipped for missing qty`);

  if (detectedDateField) log(`Order-date field detected: "${detectedDateField}" (${dateHits} non-empty)`);
  else                   log(`WARNING: no order-date field resolved from [${DATE_CANDIDATES.join(", ")}] — everything was skipped for missing date`);

  if (dateSamples.length) log("Date samples (raw → iso):", dateSamples);

  if (detectedStatusField) log(`Status field detected: "${detectedStatusField}" (${statusHits} non-empty) — used for canceled-row guard`);
  else                     log(`Status field not present in GI — GI-side filter is the only defense against canceled rows`);

  // Bail early if a critical field never resolved. Better to no-op than
  // to write zeros across every service part because the parser missed.
  if (!detectedPnField || !detectedQtyField || !detectedDateField) {
    return { statusCode: 500, body: JSON.stringify({
      error: "Critical GI field(s) missing — verify candidate lists against the GI header",
      pnField: detectedPnField, qtyField: detectedQtyField, dateField: detectedDateField,
    }) };
  }

  // ── Supabase setup + tombstone fetch ───────────────────────────────
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // deleted_parts is {id TEXT PK, data JSONB}, pn goes in `id`. Same as
  // the tombstone fetch in acumatica-sync.js. Non-fatal on error: log
  // loudly and proceed WITHOUT the filter so a Supabase blip doesn't
  // skip the whole day's rate refresh.
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

  // Fetch every parts row. We filter by itemType === "service" in
  // memory rather than server-side because the jsonb key isn't
  // guaranteed to have an index; the parts table is well under 10k
  // rows total so this is trivially fast. Paginated at 1000-row cap.
  log("Fetching existing parts from Supabase");
  const existingMap = new Map();   // pn → data jsonb
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supa
        .from("parts")
        .select("pn, data")
        .range(from, from + PAGE - 1);
      if (error) {
        log("Supabase parts select failed", error);
        return { statusCode: 500, body: JSON.stringify({ error: "parts fetch failed", detail: error.message }) };
      }
      if (!data || data.length === 0) break;
      for (const row of data) existingMap.set(row.pn, row.data || {});
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  log(`Loaded ${existingMap.size} existing parts`);

  // ── Merge-safe write ───────────────────────────────────────────────
  // Match bulkApplyComputedDaily's semantics (js/19-page-usage.js:1320)
  // exactly:
  //   - iterate over service parts
  //   - if pn appears in feed (lastSaleByPn.has(pn)):
  //       compute daily = round(units/180, 3) and write if different
  //     else:
  //       part is not in the feed at all → skip (preserve hand-set daily)
  // A part IN the feed with 0 in-window units gets daily=0 (drop-off),
  // matching manual behavior when a part's demand.map entry has
  // appliedDaily=0 after old sales aged out.
  //
  // Non-service parts are never touched — their daily comes from the
  // Base BOM Usage / Options Usage editors.
  const rows = [];
  let consideredService = 0;
  let refreshedRate = 0;      // had oldDaily, has new nonzero daily, differ
  let newlyRated = 0;         // oldDaily === 0, has new nonzero daily
  let zeroedDropOff = 0;      // in feed, 0 in-window units, oldDaily > 0 → zero
  let unchanged = 0;          // new === old (nonzero or both zero)
  let neverInFeedPreserved = 0;  // not in feed at all → skip; hand-set daily kept
  let skippedNonService = 0;  // itemType !== "service"
  let skippedTombstoned = 0;

  for (const [pn, existing] of existingMap.entries()) {
    if (tombstoned.has(pn)) { skippedTombstoned++; continue; }
    if (existing.itemType !== "service") { skippedNonService++; continue; }
    consideredService++;

    const inFeed  = lastSaleByPn.has(pn);
    const oldDaily = Number(existing.daily) || 0;

    if (!inFeed) {
      // Never appeared in the feed. bulkApplyComputedDaily would skip
      // (its `demand.get(pn)` returns undefined for a pn absent from
      // DB.usage). Preserve whatever daily this part had.
      neverInFeedPreserved++;
      continue;
    }

    const units    = unitsByPn.get(pn) || 0;   // 0 if all sales fell out of window
    const rawDaily = units / WINDOW_DAYS;
    const newDaily = Math.round(rawDaily * 1000) / 1000;

    if (newDaily === oldDaily) { unchanged++; continue; }

    // Merge: preserve every other field on data, override ONLY daily.
    // Never write {daily: N} alone — that would drop everything the
    // primary acumatica-sync writes to the same row (onHand, notes,
    // audit fields, itemType, and any client-added fields).
    const merged = { ...existing, daily: newDaily };
    rows.push({ pn, data: merged });

    if (newDaily === 0) zeroedDropOff++;
    else if (oldDaily === 0) newlyRated++;
    else refreshedRate++;
  }

  // Also count feed pns not in DB.parts — informative only, we never
  // create parts from this sync.
  let feedPnsNotInCatalog = 0;
  for (const pn of lastSaleByPn.keys()) {
    if (!existingMap.has(pn)) feedPnsNotInCatalog++;
  }
  if (feedPnsNotInCatalog > 0) {
    log(`Feed contains ${feedPnsNotInCatalog} pn(s) not in DB.parts (never created — add via catalog)`);
  }

  log(`Considered ${consideredService} service parts: ${refreshedRate} refreshed, ${newlyRated} newly rated, ${zeroedDropOff} zeroed drop-off, ${unchanged} unchanged, ${neverInFeedPreserved} never-in-feed preserved, ${skippedNonService} non-service (untouched), ${skippedTombstoned} tombstoned`);

  if (rows.length === 0) {
    log("No parts needed update");
    return { statusCode: 200, body: JSON.stringify({
      updated: 0, consideredService, unchanged, neverInFeedPreserved,
      note: "No changes",
    }) };
  }

  // Batch upsert — 500-row batches, same as acumatica-sync's parts path.
  const BATCH = 500;
  let totalUpserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supa.from("parts").upsert(batch);
    if (error) {
      log(`Batch ${i}-${i + batch.length - 1} upsert failed`, error);
      return { statusCode: 500, body: JSON.stringify({
        error: "parts upsert failed", detail: error.message, upsertedBefore: totalUpserted,
      }) };
    }
    totalUpserted += batch.length;
  }
  log(`Upserted ${totalUpserted} parts row(s) with refreshed daily`);

  const elapsedMs = Date.now() - t0;
  log(`Done in ${elapsedMs}ms`);

  // Structured audit — best-effort insert into the `audit` table if it
  // exists in this environment. Same shape acumatica-sync uses.
  try {
    await supa.from("audit").insert({
      ts: new Date().toISOString(),
      type: "service-usage-sync",
      msg: `Refreshed daily on ${totalUpserted}/${consideredService} service parts (${zeroedDropOff} zeroed drop-offs, ${unchanged} unchanged) in ${elapsedMs}ms`,
      detail: {
        entries: entries.length,
        pagesFetched: pageCount,
        distinctPnsWithUnits: unitsByPn.size,
        distinctPnsAnySale: lastSaleByPn.size,
        consideredService,
        refreshedRate,
        newlyRated,
        zeroedDropOff,
        unchanged,
        neverInFeedPreserved,
        skippedNonService,
        skippedTombstoned,
        feedPnsNotInCatalog,
        detectedFields: {
          pn: detectedPnField,
          qty: detectedQtyField,
          date: detectedDateField,
          status: detectedStatusField,
        },
        formula: `Math.round((units / ${WINDOW_DAYS}) * 1000) / 1000`,
      },
    });
  } catch (e) {
    log("Audit insert threw (non-fatal)", e.message);
  }

  return { statusCode: 200, body: JSON.stringify({
    updated: totalUpserted,
    consideredService,
    refreshedRate,
    newlyRated,
    zeroedDropOff,
    unchanged,
    neverInFeedPreserved,
    entries: entries.length,
    pagesFetched: pageCount,
    distinctPnsWithUnits: unitsByPn.size,
    detectedFields: {
      pn: detectedPnField,
      qty: detectedQtyField,
      date: detectedDateField,
      status: detectedStatusField,
    },
  }) };
};
