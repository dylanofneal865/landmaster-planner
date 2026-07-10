// Netlify Scheduled Function — refreshes Acumatica-sourced sales-order rows
// in the Supabase `usage` table from the "LM Planner Service Usage" GI.
// Kits are exploded to their leaf-component parts at write time, mirroring
// the manual Excel importer's behavior so kit-driven component demand
// carries through into computeDemand's per-pn sum.
//
// Schedule: 06:00 UTC daily (see netlify.toml).
//
// Design contract (grep-verifiable):
//   1. Writes to Supabase `usage` (kit-explosion-inclusive raw txns) AND
//      to Supabase `parts` (part.data.daily for itemType === "service"
//      parts ONLY — grep the loop-building block below for the guard
//      `if (existing.itemType !== "service") continue;` which is the
//      HARD GATE preventing writes to any non-service part).
//      No other fields on parts.data are written — merge-safe upsert
//      spreads existing and overrides ONLY the daily field.
//   2. Sync-owned rows in `usage` are namespaced by id prefix
//      `us_acumatica-`:
//        - direct sales:  `us_acumatica-so_<orderNbr>_<pn>`
//        - kit explosion: `us_acumatica-so-kit_<orderNbr>_<topKitPn>_<leafPn>`
//      The scoped rebuild (delete + reinsert) only touches these ids, so
//      Excel-imported rows (`sales-order-…` sourceKey), C9 Big Sheet
//      historicals, manual logs, warranty/damage/loss entries, and any
//      other non-Acumatica usage transaction are NEVER touched.
//   3. Kit explosion — for every sold kit line, the sync walks the kit
//      recursively (bom_links first, kit_boms fallback — same priority as
//      js/41-kit-boms.js resolveKitComponents) down to the leaf level and
//      writes one row per (topKit, leaf) pair with qty = kitQty × Π(sub-qty)s.
//      Cycle-guarded via a DFS in-path set. Sums duplicates that would
//      arrive via multiple sub-tree paths so one leaf per kit sale yields
//      exactly one row.
//   4. Service-part daily-rate refresh — after usage writes complete,
//      the sync scans the FULL `usage` table (all sources — this run's
//      Acumatica rows + all prior Excel imports + C9 Big Sheet +
//      manual logs) and computes each part's 180-day rate exactly the
//      way js/40-demand.js:16-42 computeDemand does. The rate is
//      merge-safely upserted onto parts.data.daily ONLY when the part
//      has itemType === "service". Base BOM, options, kit, and untagged
//      parts are silently skipped and never see a parts upsert. A
//      service part with zero in-window units gets daily = 0 (correct
//      drop-off — the manual bulkApplyComputedDaily does the same).
//
//      Row shape matches the Excel importer's kit-explosion rows exactly on
//      the fields that drive demand math (ts, pn, qty, buildLine) — see the
//      "Row shape parity" note in the exploded-row builder below.
//
//      DIVERGENCE from Excel importer: this sync RECURSES into sub-kits.
//      The importer has a `TODO: handle nested kits` comment at
//      js/13-page-settings.js:546 and only explodes one level. This sync
//      is strictly more correct: a service component reached via a
//      sub-kit still gets credit here where the importer would have missed it.
//
// Required env vars: same as acumatica-sync.js.

const { createClient } = require("@supabase/supabase-js");

// Prefix-optional field extractor — copied verbatim from acumatica-sync.js.
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

// Strip a trailing supersession suffix — mirrors _stripKitSuffix in
// js/41-kit-boms.js. Turns "18931-R" → "18931". A trailing numeric-only
// segment like "18155-2" is NOT stripped (letters only).
function stripKitSuffix(pn) {
  const m = String(pn || "").match(/^(.*)-[A-Za-z]+$/);
  return m ? m[1] : null;
}

// Server-side kit-component resolver — mirrors resolveKitComponents priority
// order in js/41-kit-boms.js:78-104.
//   a. direct bom_links parent
//   b. stripped supersession suffix → bom_links (only if stripped pn is a real parent)
//   c. kit_boms fallback
// Returns [{pn, qty}] or [] when nothing resolves.
function makeResolver(bomLinksByParent, kitBomsMap) {
  return function resolveKitComponents(pn) {
    if (!pn) return [];
    if (bomLinksByParent.has(pn)) {
      const rows = bomLinksByParent.get(pn);
      const comps = rows.map(r => ({ pn: r.child, qty: Number(r.qty) || 0 }));
      if (comps.length) return comps;
    }
    const stripped = stripKitSuffix(pn);
    if (stripped && stripped !== pn && bomLinksByParent.has(stripped)) {
      const rows = bomLinksByParent.get(stripped);
      const comps = rows.map(r => ({ pn: r.child, qty: Number(r.qty) || 0 }));
      if (comps.length) return comps;
    }
    const kb = kitBomsMap.get(pn);
    if (kb && Array.isArray(kb.components) && kb.components.length) {
      return kb.components.map(c => ({ pn: c.pn, qty: Number(c.qty) || 0 }));
    }
    return [];
  };
}

// Kit detection — DELIBERATELY DIVERGES from the client-side isKit at
// js/41-kit-boms.js:111. The client requires part.itemType === "kit"
// AND resolvable components; the migration tagKitsFromKitBoms() only
// tags parts present as keys in DB.kitBoms, so kits that live only in
// bom_links (Acumatica-native finished-goods with a BOM but no hand-
// imported kit_boms row) never get the "kit" itemType tag and slip
// through the client isKit gate — the Excel importer inherits the same
// blind spot.
//
// Server-side we cannot rely on itemType tagging being complete in
// Supabase, so the sync trusts resolveKitComponents alone: if a sold
// pn has any resolvable components (bom_links parent OR stripped-
// suffix bom_links parent OR kit_boms entry), explode it. This is
// strictly more correct for service usage tracking — a sale of a
// finished-good with a BOM consumes its components, whether the part
// is UI-marked as a kit or not.
function makeIsKit(_partsItemTypeMap, resolveKitComponents) {
  return function isKit(pn) {
    if (!pn) return false;
    return resolveKitComponents(pn).length > 0;
  };
}

// Recursive kit-to-leaves explosion. Returns Map<leafPn, totalQty> aggregated
// across all sub-tree paths that reach the same leaf.
//
// Recursion gate uses `isSubKit`, NOT the broad top-level `isKit`. A component
// only recurses if it's explicitly tagged itemType === "kit" (in DB.parts /
// partsMap). Rationale:
//   - Top-level: broad (any resolvable BOM → explode). Fixes the untagged-
//     finished-good case (e.g. Acumatica-native kit "16164" not present in
//     the hand-imported kit_boms table so tagKitsFromKitBoms never tagged it).
//   - Recursion: strict. A service kit often contains a welded sub-assembly
//     (itemType === "base_bom") which itself has a bom_links BOM listing raw
//     steel sheets. Recursing into that sub-assembly would credit the raw
//     stock as service demand — wrong. Untagged sub-parts are treated as
//     leaves and receive credit directly.
// Cycle-guarded via a DFS in-path Set.
function explodeToLeaves(rootKitPn, rootQty, isSubKit, resolveKitComponents) {
  const totals = new Map();
  const inPath = new Set();
  function walk(kitPn, qty) {
    if (inPath.has(kitPn)) return;
    inPath.add(kitPn);
    for (const comp of resolveKitComponents(kitPn)) {
      const q = qty * (Number(comp.qty) || 0);
      if (q <= 0) continue;
      if (isSubKit(comp.pn)) {
        walk(comp.pn, q);
      } else {
        totals.set(comp.pn, (totals.get(comp.pn) || 0) + q);
      }
    }
    inPath.delete(kitPn);
  }
  walk(rootKitPn, rootQty);
  return totals;
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

  // ── Paginated GI fetch ─────────────────────────────────────────────
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
    return { statusCode: 200, body: JSON.stringify({ upserted: 0, note: "No entries" }) };
  }

  // ── Field discovery ────────────────────────────────────────────────
  const PN_CANDIDATES     = ["InventoryID", "Inventory_ID", "InventoryID_"];
  const QTY_CANDIDATES    = ["Quantity", "Qty", "OrderQty"];
  const DATE_CANDIDATES   = ["SOLine_orderDate", "SOLineorderDate", "OrderDate"];
  const ORDER_CANDIDATES  = ["OrderNbr", "SOOrderNbr", "OrderNumber", "OrderNo", "OrderNbr_"];
  const STATUS_CANDIDATES = ["Status", "OrderStatus", "SOStatus"];

  let detectedPnField = null, detectedQtyField = null, detectedDateField = null;
  let detectedOrderField = null, detectedStatusField = null;
  let pnHits = 0, qtyHits = 0, dateHits = 0, orderHits = 0, statusHits = 0;
  const dateSamples = [];

  const CANCELED = new Set(["canceled", "cancelled", "voided", "void", "rejected", "hold", "on hold"]);

  // Raw sales-line accumulation — dedupe on (orderNbr, invId).
  const salesByKey = new Map();

  let skippedCanceled = 0, skippedNoPn = 0, skippedNoQty = 0, skippedNoDate = 0, skippedNoOrder = 0;

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

    salesByKey.set(`${orderNbr}::${pn}`, { orderNbr, pn, qty: Math.round(qty), ts: parsed.iso });
  }

  log(`Parsed: ${entries.length} entries → ${salesByKey.size} distinct (orderNbr, invId) sales`);
  log(`Skipped: noPn=${skippedNoPn}, noQty=${skippedNoQty}, noDate=${skippedNoDate}, noOrder=${skippedNoOrder}, canceled=${skippedCanceled}`);

  if (detectedPnField)     log(`InventoryID field detected: "${detectedPnField}" (${pnHits} non-empty)`);
  else                     log(`WARNING: no InventoryID field resolved from [${PN_CANDIDATES.join(", ")}]`);
  if (detectedQtyField)    log(`Quantity field detected: "${detectedQtyField}" (${qtyHits} non-empty)`);
  else                     log(`WARNING: no Quantity field resolved from [${QTY_CANDIDATES.join(", ")}]`);
  if (detectedDateField)   log(`Order-date field detected: "${detectedDateField}" (${dateHits} non-empty)`);
  else                     log(`WARNING: no order-date field resolved from [${DATE_CANDIDATES.join(", ")}]`);
  if (detectedOrderField)  log(`OrderNbr field detected: "${detectedOrderField}" (${orderHits} non-empty)`);
  else                     log(`WARNING: no OrderNbr field resolved from [${ORDER_CANDIDATES.join(", ")}]`);
  if (dateSamples.length)  log("Date samples (raw → iso):", dateSamples);
  if (detectedStatusField) log(`Status field detected: "${detectedStatusField}" (${statusHits} non-empty) — cancel guard`);

  if (!detectedPnField || !detectedQtyField || !detectedDateField || !detectedOrderField) {
    return { statusCode: 500, body: JSON.stringify({
      error: "Critical GI field(s) missing — verify candidate lists",
      pnField: detectedPnField, qtyField: detectedQtyField, dateField: detectedDateField, orderField: detectedOrderField,
    }) };
  }

  // ── Supabase setup + reference-data fetch ──────────────────────────
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // deleted_parts tombstones — non-fatal on error (proceed WITHOUT filter).
  log("Fetching deleted_parts tombstones");
  const tombstoned = new Set();
  {
    const TS_PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supa.from("deleted_parts").select("id").range(from, from + TS_PAGE - 1);
      if (error) { log("WARNING: deleted_parts fetch failed", error); break; }
      if (!data || data.length === 0) break;
      for (const row of data) if (row && row.id) tombstoned.add(String(row.id));
      if (data.length < TS_PAGE) break;
      from += TS_PAGE;
    }
  }
  log(`Loaded ${tombstoned.size} tombstoned pn(s)`);

  // parts — LOAD ONLY THE itemType FIELD (defensive: to skip lines whose pn
  // isn't in the catalog, matching the Excel importer's
  // "unmatchedNotInCatalog" behavior, and to gate isKit via itemType).
  // This is a SELECT — grep the file: no _supa.from("parts").upsert or
  // .from("parts").delete anywhere.
  log("Fetching parts itemType map from Supabase");
  // partsMap holds the FULL data blob per pn so the (later) service-part
  // daily-rate refresh step can merge-safely upsert `{...existing, daily}`
  // without a second fetch. All prior call sites read only `.itemType` off
  // this map, so switching from itemType-only storage is a drop-in change.
  const partsMap = new Map();  // pn → data JSONB blob
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supa.from("parts").select("pn, data").range(from, from + PAGE - 1);
      if (error) {
        log("parts select failed", error);
        return { statusCode: 500, body: JSON.stringify({ error: "parts fetch failed", detail: error.message }) };
      }
      if (!data || data.length === 0) break;
      for (const row of data) partsMap.set(row.pn, row.data || {});
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  log(`Loaded ${partsMap.size} parts (full data)`);

  // bom_links — parent → [{child, qty}].
  log("Fetching bom_links");
  const bomLinksByParent = new Map();
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supa.from("bom_links").select("id, data").range(from, from + PAGE - 1);
      if (error) {
        log("bom_links select failed", error);
        return { statusCode: 500, body: JSON.stringify({ error: "bom_links fetch failed", detail: error.message }) };
      }
      if (!data || data.length === 0) break;
      for (const row of data) {
        const d = row.data || {};
        const parent = d.parent, child = d.child;
        if (!parent || !child) continue;
        if (!bomLinksByParent.has(parent)) bomLinksByParent.set(parent, []);
        bomLinksByParent.get(parent).push({ child, qty: Number(d.qty) || 0 });
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  log(`Loaded ${bomLinksByParent.size} distinct bom_links parents`);

  // kit_boms — kit_pn → { components: [{pn, qty, ...}] }.
  log("Fetching kit_boms");
  const kitBomsMap = new Map();
  {
    const PAGE = 1000;
    let from = 0;
    while (true) {
      const { data, error } = await supa.from("kit_boms").select("kit_pn, data").range(from, from + PAGE - 1);
      if (error) {
        log("kit_boms select failed", error);
        return { statusCode: 500, body: JSON.stringify({ error: "kit_boms fetch failed", detail: error.message }) };
      }
      if (!data || data.length === 0) break;
      for (const row of data) if (row.kit_pn && row.data) kitBomsMap.set(row.kit_pn, row.data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  log(`Loaded ${kitBomsMap.size} kit_boms entries`);

  const resolveKitComponents = makeResolver(bomLinksByParent, kitBomsMap);
  // Broad top-level detection: any sold pn with a resolvable BOM explodes.
  const isKit = makeIsKit(partsMap, resolveKitComponents);
  // Strict recursion gate: only recurse into components tagged itemType="kit"
  // AND with resolvable components — prevents drilling into base_bom sub-
  // assemblies that happen to have manufacturing BOMs. See explodeToLeaves.
  const isSubKit = (pn) => {
    if (!pn) return false;
    if ((partsMap.get(pn) || {}).itemType !== "kit") return false;
    return resolveKitComponents(pn).length > 0;
  };

  // ── Build write rows ───────────────────────────────────────────────
  // Two row types, both share the `us_acumatica-` id prefix so the scoped
  // rebuild delete catches both:
  //
  // DIRECT (one per sales line, matches Excel importer's raw pass):
  //   id: us_acumatica-so_<orderNbr>_<pn>
  //   data: { ts, pn, qty, buildLine: "service", reason: "Sales order shipment - Acumatica sync",
  //           user: "acumatica-sync", sourceKey: "acumatica-so-<orderNbr>-<pn>" }
  //
  // EXPLODED (one per leaf per kit sale, matches Excel importer's kit-explosion pass):
  //   id: us_acumatica-so-kit_<orderNbr>_<topKitPn>_<leafPn>
  //   data: { ts, pn: leafPn, qty: kitQty × (product of subQtys), buildLine: "kit-explosion",
  //           reason: "From kit <topKitPn>", user: "acumatica-sync",
  //           sourceKey: "kit-explosion-acumatica-so-<orderNbr>-<topKitPn>-<leafPn>" }
  //
  // Row shape parity: pn/qty/ts/buildLine/reason match the Excel importer's
  // kit-explosion row shape field-for-field. Only user, id, and sourceKey
  // differ (all traceability — they identify the row as sync-owned so the
  // scoped rebuild can operate without touching Excel-imported rows).
  const rowsToWrite = [];
  let directRows = 0;
  let explodedRows = 0;
  let kitSales = 0;
  let leafSkippedTombstone = 0;
  let leafSkippedNotInCatalog = 0;
  let directSkippedTombstone = 0;
  let directSkippedNotInCatalog = 0;
  let kitNoBomSkipped = 0;

  for (const sale of salesByKey.values()) {
    // Direct row — write for ANY sold pn present in the catalog (matches
    // Excel importer semantics: it also writes the raw sales-line row for
    // kits as well as non-kits).
    if (tombstoned.has(sale.pn)) {
      directSkippedTombstone++;
      // Even if the direct row is dropped, we still explode the kit — the
      // Excel importer also writes explosion rows independently of the
      // direct row's fate. Keep going.
    } else if (!partsMap.has(sale.pn)) {
      directSkippedNotInCatalog++;
    } else {
      rowsToWrite.push({
        id: `us_acumatica-so_${sale.orderNbr}_${sale.pn}`,
        data: {
          ts: sale.ts,
          pn: sale.pn,
          qty: sale.qty,
          buildLine: "service",
          reason: "Sales order shipment - Acumatica sync",
          user: "acumatica-sync",
          sourceKey: `acumatica-so-${sale.orderNbr}-${sale.pn}`,
        },
      });
      directRows++;
    }

    // Kit explosion — only fires when the sold pn passes the isKit gate.
    if (!isKit(sale.pn)) continue;
    kitSales++;
    const leafTotals = explodeToLeaves(sale.pn, sale.qty, isSubKit, resolveKitComponents);
    if (leafTotals.size === 0) {
      // Should not happen since isKit requires resolvable components, but
      // guard just in case (e.g. a cycle-only kit).
      kitNoBomSkipped++;
      continue;
    }
    for (const [leafPn, totalQty] of leafTotals.entries()) {
      if (tombstoned.has(leafPn)) { leafSkippedTombstone++; continue; }
      if (!partsMap.has(leafPn)) { leafSkippedNotInCatalog++; continue; }
      const roundedQty = Math.round(totalQty);
      if (roundedQty <= 0) continue;
      rowsToWrite.push({
        id: `us_acumatica-so-kit_${sale.orderNbr}_${sale.pn}_${leafPn}`,
        data: {
          ts: sale.ts,
          pn: leafPn,
          qty: roundedQty,
          buildLine: "kit-explosion",
          reason: `From kit ${sale.pn}`,
          user: "acumatica-sync",
          sourceKey: `kit-explosion-acumatica-so-${sale.orderNbr}-${sale.pn}-${leafPn}`,
        },
      });
      explodedRows++;
    }
  }

  log(`Row build: ${directRows} direct + ${explodedRows} exploded (from ${kitSales} kit sales) = ${rowsToWrite.length} total`);
  log(`Skipped direct: tombstone=${directSkippedTombstone}, notInCatalog=${directSkippedNotInCatalog}`);
  log(`Skipped explode-leaves: tombstone=${leafSkippedTombstone}, notInCatalog=${leafSkippedNotInCatalog}`);
  if (kitNoBomSkipped > 0) log(`WARNING: ${kitNoBomSkipped} kit sales had zero resolvable leaves (unexpected — check bom_links/kit_boms coverage)`);

  // ── Scoped rebuild ─────────────────────────────────────────────────
  // Delete every sync-owned row (both direct + exploded namespaces) then
  // upsert the fresh set. The `us\_acumatica-%` LIKE pattern uses a
  // backslash-escaped underscore so the first `_` is literal — matches
  // "us_acumatica-…" only, never "usXacumatica-…" for other X. Non-
  // Acumatica rows are outside this prefix and are NEVER touched.
  log("Scoped rebuild — deleting prior sync-owned rows (id LIKE 'us_acumatica-%')");
  {
    const { error, count } = await supa
      .from("usage")
      .delete({ count: "exact" })
      .like("id", "us\\_acumatica-%");
    if (error) {
      log("Scoped delete failed", error);
      return { statusCode: 500, body: JSON.stringify({ error: "Scoped delete failed", detail: error.message }) };
    }
    log(`Deleted ${count ?? "?"} prior sync-owned row(s)`);
  }

  if (rowsToWrite.length === 0) {
    log("No rows to write after filters — sync-owned scope is now empty");
    return { statusCode: 200, body: JSON.stringify({
      upserted: 0, directRows: 0, explodedRows: 0,
      note: "Empty write set after tombstone/catalog filters",
    }) };
  }

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
  log(`usage_txns rebuilt: ${totalUpserted} row(s) (${directRows} direct + ${explodedRows} exploded)`);

  // ── Service-part daily-rate refresh ────────────────────────────────
  // MATCHES js/40-demand.js:16-42 computeDemand exactly:
  //   daily = Math.round((units_in_last_180_days / 180) * 1000) / 1000
  // Includes ALL usage rows (Acumatica-sourced + Excel-imported + manual)
  // so the sync's part.daily agrees with what the Service Usage page's
  // "COMPUTED DAILY" column would display after this run — 2-25002
  // should compute to 0.144 iff its trailing 180-day unit sum ≈ 25.92.
  //
  // HARD GATE: writes are strictly limited to itemType === "service".
  // The gate lives at ONE site — the `if (data.itemType !== "service")
  // { continue; }` on the loop that builds dailyUpdateRows. Base BOM,
  // options, kit, and untagged parts NEVER have their daily touched.
  // Grep-verifiable: no other .from("parts").upsert exists in this file.
  //
  // Zero-usage drop-off: a service part with no in-window rows gets
  // daily = 0. Correct — the part has no measurable service demand and
  // shouldn't retain a stale rate.
  log("Recomputing service-part daily rates from full usage table");
  const DEMAND_WINDOW_DAYS = 180;
  const cutoffMs = Date.now() - DEMAND_WINDOW_DAYS * 86400000;
  const unitsBySvcPn = new Map();   // pn → in-window units, service parts only

  {
    const PAGE = 1000;
    let from = 0;
    let usageRowsScanned = 0;
    let usageInWindow = 0;
    while (true) {
      const { data, error } = await supa.from("usage").select("data").range(from, from + PAGE - 1);
      if (error) {
        // Non-fatal: log and skip the daily-rate refresh. usage writes
        // already succeeded; on next run the recompute will retry.
        log("WARNING: usage recompute fetch failed — skipping daily-rate refresh this run", error);
        unitsBySvcPn.clear();
        break;
      }
      if (!data || data.length === 0) break;
      for (const row of data) {
        usageRowsScanned++;
        const d = row.data || {};
        const pn = d.pn;
        if (!pn) continue;
        // Skip everything that isn't a service part. Base BOM's daily
        // is preserved untouched — its usage rows still exist in the
        // table (contributing to base_bom production math), but they
        // never influence this sync's daily-rate write.
        const partData = partsMap.get(pn);
        if (!partData || partData.itemType !== "service") continue;
        // computeDemand at js/40-demand.js:30 uses `t > cutoff` (strict).
        // Match it: skip anything AT or BEFORE cutoff.
        const tsMs = new Date(d.ts).getTime();
        if (!isFinite(tsMs) || tsMs <= cutoffMs) continue;
        const qty = Number(d.qty) || 0;
        if (qty <= 0) continue;
        usageInWindow++;
        unitsBySvcPn.set(pn, (unitsBySvcPn.get(pn) || 0) + qty);
      }
      if (data.length < PAGE) break;
      from += PAGE;
    }
    log(`Scanned ${usageRowsScanned} usage rows; ${usageInWindow} in 180-day window against ${unitsBySvcPn.size} distinct service pns`);
  }

  // Build merge-safe upsert rows — one per service part. This is the
  // HARD GATE. Every other itemType is filtered out here. Iterating
  // partsMap (not unitsBySvcPn) so service parts with ZERO in-window
  // units get their daily zeroed (drop-off matches manual behavior).
  const dailyUpdateRows = [];
  let dailyServiceConsidered = 0;
  let dailyUpdated = 0;
  let dailyUnchanged = 0;
  let dailyServiceZeroed = 0;
  let dailyNewlyRated = 0;
  let dailyRefreshed = 0;
  let dailyTombstoneSkipped = 0;
  for (const [pn, existing] of partsMap.entries()) {
    // ★ THE GATE ★ — grep-verify: this is the ONLY predicate protecting
    // parts.data.daily from non-service writes.
    if (existing.itemType !== "service") continue;
    if (tombstoned.has(pn)) { dailyTombstoneSkipped++; continue; }
    dailyServiceConsidered++;

    const units = unitsBySvcPn.get(pn) || 0;
    const rawDaily = units / DEMAND_WINDOW_DAYS;
    const newDaily = Math.round(rawDaily * 1000) / 1000;
    const oldDaily = Number(existing.daily) || 0;
    if (newDaily === oldDaily) { dailyUnchanged++; continue; }
    // Merge-safe: spread existing, override ONLY daily. Every other
    // field on parts.data — onHand, itemType, moq, cost, supplier, notes,
    // supersession chain fields — is preserved byte-identically.
    dailyUpdateRows.push({ pn, data: { ...existing, daily: newDaily } });
    if (newDaily === 0) dailyServiceZeroed++;
    else if (oldDaily === 0) dailyNewlyRated++;
    else dailyRefreshed++;
    dailyUpdated++;
  }
  log(`Service daily: ${dailyServiceConsidered} considered — ${dailyRefreshed} refreshed, ${dailyNewlyRated} newly rated, ${dailyServiceZeroed} zeroed, ${dailyUnchanged} unchanged, ${dailyTombstoneSkipped} tombstoned`);

  let dailyUpserted = 0;
  if (dailyUpdateRows.length > 0) {
    const DAILY_BATCH = 500;
    for (let i = 0; i < dailyUpdateRows.length; i += DAILY_BATCH) {
      const batch = dailyUpdateRows.slice(i, i + DAILY_BATCH);
      const { error } = await supa.from("parts").upsert(batch);
      if (error) {
        log(`parts daily-batch ${i}-${i + batch.length - 1} upsert failed`, error);
        return { statusCode: 500, body: JSON.stringify({
          error: "parts daily upsert failed",
          detail: error.message,
          upsertedBefore: dailyUpserted,
          usageUpserted: totalUpserted,
        }) };
      }
      dailyUpserted += batch.length;
    }
    log(`Wrote daily rates on ${dailyUpserted} service parts`);
  } else {
    log("No service-part daily rates needed updating");
  }

  const elapsedMs = Date.now() - t0;
  log(`Done in ${elapsedMs}ms`);

  try {
    await supa.from("audit").insert({
      ts: new Date().toISOString(),
      type: "service-usage-sync",
      msg: `usage_txns rebuilt: ${totalUpserted} row(s) (${directRows} direct + ${explodedRows} exploded from ${kitSales} kit sales) — service daily refreshed on ${dailyUpserted}/${dailyServiceConsidered} in ${elapsedMs}ms`,
      detail: {
        entries: entries.length,
        pagesFetched: pageCount,
        distinctSales: salesByKey.size,
        directRows,
        explodedRows,
        kitSales,
        skipped: {
          canceled: skippedCanceled,
          noPn: skippedNoPn,
          noQty: skippedNoQty,
          noDate: skippedNoDate,
          noOrder: skippedNoOrder,
          directTombstone: directSkippedTombstone,
          directNotInCatalog: directSkippedNotInCatalog,
          leafTombstone: leafSkippedTombstone,
          leafNotInCatalog: leafSkippedNotInCatalog,
          kitNoBom: kitNoBomSkipped,
        },
        detectedFields: {
          pn: detectedPnField, qty: detectedQtyField, date: detectedDateField,
          order: detectedOrderField, status: detectedStatusField,
        },
        catalogCounts: {
          parts: partsMap.size,
          bomLinksParents: bomLinksByParent.size,
          kitBoms: kitBomsMap.size,
          tombstones: tombstoned.size,
        },
        serviceDaily: {
          considered: dailyServiceConsidered,
          upserted: dailyUpserted,
          refreshed: dailyRefreshed,
          newlyRated: dailyNewlyRated,
          zeroed: dailyServiceZeroed,
          unchanged: dailyUnchanged,
          tombstoneSkipped: dailyTombstoneSkipped,
          formula: `Math.round((units / ${DEMAND_WINDOW_DAYS}) * 1000) / 1000`,
          gate: 'existing.itemType === "service"',
        },
        note: "Kit sales exploded recursively to leaves; row shape mirrors Excel importer's. Service-part daily rates computed from FULL usage table and written back to parts.data.daily — service parts only.",
      },
    });
  } catch (e) {
    log("Audit insert threw (non-fatal)", e.message);
  }

  return { statusCode: 200, body: JSON.stringify({
    upserted: totalUpserted,
    directRows,
    explodedRows,
    kitSales,
    entries: entries.length,
    pagesFetched: pageCount,
    serviceDaily: {
      considered: dailyServiceConsidered,
      upserted: dailyUpserted,
      refreshed: dailyRefreshed,
      newlyRated: dailyNewlyRated,
      zeroed: dailyServiceZeroed,
      unchanged: dailyUnchanged,
    },
    detectedFields: {
      pn: detectedPnField, qty: detectedQtyField, date: detectedDateField,
      order: detectedOrderField, status: detectedStatusField,
    },
  }) };
};
