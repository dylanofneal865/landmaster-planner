// LINE FLOAT — server-side BOM explosion.
//
// WHY THIS EXISTS
// Acumatica backflushes components only when a unit FINISHES production.
// With ~20-25 units on the assembly line at any moment, Acumatica on-hand
// overstates what is physically on the shelf by everything those in-flight
// units have already consumed. That gap is "line float". It makes shelf
// counts throw false variances and makes runway math count phantom stock.
//
// This function explodes the BOM tree once per run and turns
// (units on line) x (qty per unit) into a per-purchased-part line_float
// estimate the Line & Shelf tab reads.
//
// THE BAND
//   band_high = qty AVAILABLE at WHI900/RMSTOR-LM, straight from Acumatica
//   band_low  = band_high - released_float, floored at 0
//   released_float = sum over models(Released units x qty_per_unit)
// A physical count of the location inside [band_low, band_high] is OK.
// Below band_low is a real SHORT. Above band_high is OVER.
//
// INPUTS  (all existing; this function ingests nothing itself)
//   bom_links              flat parent->child edges, written daily at
//                          06:00 UTC by acumatica-bom-sync.js
//   production_orders      hourly from acumatica-production-orders-sync.js.
//                          "On the line" = status 'Released' EXACTLY, all
//                          FG SKUs including UT1010xx frames (Dylan,
//                          2026-09-16: frame builds also consume
//                          RMSTOR-LM). Units per model = SUM(qty_remaining).
//   part_locations         per-location rows from acumatica-sync.js.
//                          qty_available = QtyAvailableinLocation is
//                          band_high; qty = QtyOnHandinLocation is carried
//                          alongside so the UI can show both.
//   audit                  latest acumatica-bom-sync row, for bom_pulled_at
//
// The manual units_on_line table is OBSOLETE — units now come from real
// production orders. Do not populate it; nothing reads it.
//
// OUTPUTS
//   line_float             one row per part: avail_at_line (band_high),
//                          onhand_at_line, released_float, band_low, and
//                          qty_per_unit broken out by FG model
//   line_float_meta        single 'current' row: run stats + anomalies
//
// NEVER writes to Acumatica, parts, or on-hand. Counts and variances live
// on this side of the fence; Acumatica stays the system of record.
//
// HTTP
//   GET  /.netlify/functions/line-float-compute
//        ?dry=1                  compute + report, write nothing
//        ?explain=PN1,PN2,...    full explosion path (FG -> sub -> ... ->
//                                part, qty at each level) for those parts.
//                                This is the "check math" output — the
//                                thing to verify against parts you know
//                                before trusting the tab.
//
// SQL (run once in the Supabase SQL editor):
//
//   -- Computed. Wholesale-replaced on every run.
//   CREATE TABLE IF NOT EXISTS public.line_float (
//     pn           text        PRIMARY KEY,
//     line_float   numeric     NOT NULL DEFAULT 0,
//     qty_per_unit jsonb       NOT NULL DEFAULT '{}'::jsonb,
//     computed_at  timestamptz NOT NULL DEFAULT now()
//   );
//   -- v-line-count band columns (safe to re-run):
//   ALTER TABLE public.line_float
//     ADD COLUMN IF NOT EXISTS avail_at_line   numeric,
//     ADD COLUMN IF NOT EXISTS onhand_at_line  numeric,
//     ADD COLUMN IF NOT EXISTS released_float  numeric NOT NULL DEFAULT 0,
//     ADD COLUMN IF NOT EXISTS band_low        numeric NOT NULL DEFAULT 0,
//     ADD COLUMN IF NOT EXISTS band_high       numeric NOT NULL DEFAULT 0;
//
//   -- units_on_line is OBSOLETE (units now come from production_orders).
//   -- Left in place so nothing 404s mid-deploy; drop when convenient:
//   --   DROP TABLE IF EXISTS public.units_on_line;
//
//   -- Run stats + anomalies, single row id='current'.
//   CREATE TABLE IF NOT EXISTS public.line_float_meta (
//     id   text  PRIMARY KEY,
//     data jsonb NOT NULL DEFAULT '{}'::jsonb
//   );
//
//   -- Physical shelf counts. NEVER pushed to Acumatica.
//   CREATE TABLE IF NOT EXISTS public.shelf_counts (
//     id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
//     pn                  text        NOT NULL,
//     counted_qty         numeric     NOT NULL,
//     counted_at          timestamptz NOT NULL DEFAULT now(),
//     counted_by          text,
//     on_hand_at_count    numeric,
//     line_float_at_count numeric,
//     verdict             text CHECK (verdict IN ('ok','short','over')),
//     created_at          timestamptz NOT NULL DEFAULT now()
//   );
//   CREATE INDEX IF NOT EXISTS shelf_counts_pn_counted_at_idx
//     ON public.shelf_counts (pn, counted_at DESC);
//
//   ALTER TABLE public.line_float      ENABLE ROW LEVEL SECURITY;
//   ALTER TABLE public.line_float_meta ENABLE ROW LEVEL SECURITY;
//   ALTER TABLE public.shelf_counts    ENABLE ROW LEVEL SECURITY;
//   DROP POLICY IF EXISTS line_float_anon_select      ON public.line_float;
//   DROP POLICY IF EXISTS line_float_meta_anon_select ON public.line_float_meta;
//   DROP POLICY IF EXISTS shelf_counts_anon_select    ON public.shelf_counts;
//   CREATE POLICY line_float_anon_select      ON public.line_float      FOR SELECT TO anon USING (true);
//   CREATE POLICY line_float_meta_anon_select ON public.line_float_meta FOR SELECT TO anon USING (true);
//   CREATE POLICY shelf_counts_anon_select    ON public.shelf_counts    FOR SELECT TO anon USING (true);

const { createClient } = require("@supabase/supabase-js");

const MAX_DEPTH = 64;   // hard stop; real trees are <10 deep

async function _fetchAll(supa, table, cols, filter) {
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    let q = supa.from(table).select(cols).range(from, from + PAGE - 1);
    if (typeof filter === "function") q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`fetch ${table} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

/* ------------------------------------------------------------------
   EDGE DEDUPE.
   The GI can emit the same (BOM ID, Parent, Child) more than once, and a
   single Parent can carry more than one BOM ID. Summing duplicates would
   silently inflate every downstream qty, so we collapse instead:

     1. Group candidate edges by (parent, child).
     2. Prefer the row whose bomId === parent — that's the parent's own
        BOM rather than one it appears in as a component.
     3. If several survive and their quantities AGREE, take one quietly.
     4. If several survive and their quantities DISAGREE, take the
        preferred one and log it to anomalies. Never sum.
   ------------------------------------------------------------------ */
function dedupeEdges(rows, anomalies) {
  const byPair = new Map();
  for (const r of rows) {
    const d = r && r.data ? r.data : r;
    if (!d) continue;
    const parent = String(d.parent || "").trim();
    const child = String(d.child || "").trim();
    if (!parent || !child) continue;
    const qty = Number(d.qty);
    const key = parent + "\u0000" + child;   // NUL separator: cannot occur inside a pn
    let arr = byPair.get(key);
    if (!arr) { arr = []; byPair.set(key, arr); }
    arr.push({ parent, child, qty: Number.isFinite(qty) ? qty : 0, bomId: String(d.bomId || "").trim(), uom: d.uom || "" });
  }
  const edges = [];
  let dupePairs = 0;
  for (const [, arr] of byPair) {
    if (arr.length === 1) { edges.push(arr[0]); continue; }
    dupePairs++;
    const preferred = arr.filter(e => e.bomId && e.bomId === e.parent);
    const pool = preferred.length > 0 ? preferred : arr;
    const qtys = [...new Set(pool.map(e => e.qty))];
    const chosen = pool[0];
    if (qtys.length > 1) {
      anomalies.push({
        kind: "duplicate-bom",
        parent: chosen.parent, child: chosen.child,
        detail: `${arr.length} edges for this pair across BOM IDs [${[...new Set(arr.map(e => e.bomId))].join(", ")}] with DIFFERENT quantities [${qtys.join(", ")}] — took ${chosen.qty} from BOM ${chosen.bomId}, did not sum`,
      });
    }
    edges.push(chosen);
  }
  return { edges, dupePairs };
}

/* ------------------------------------------------------------------
   EXPLOSION.
   Memoized DFS. explode(node) returns Map<leafPn, qtyPerOneOfNode>.
   A leaf is any node that never appears as a parent — i.e. a purchased
   part. Cycle guard carries the active path; on re-entry we stop the
   descent, log it, and keep going rather than aborting the whole run.
   ------------------------------------------------------------------ */
function buildExploder(adjacency, isParent, anomalies) {
  const memo = new Map();
  const cyclesSeen = new Set();
  // Nodes whose subtree was cut short by the cycle guard. Their empty
  // result is explained by the cycle already logged, so they must NOT
  // also be reported as leaf-also-parent oddities — that double-counts
  // one data problem as two and buries the real signal.
  const truncated = new Set();

  function explode(node, path, depth) {
    if (memo.has(node)) return memo.get(node);
    if (depth > MAX_DEPTH) {
      anomalies.push({ kind: "max-depth", parent: node, detail: `descent exceeded ${MAX_DEPTH} levels at ${node} — stopped` });
      truncated.add(node);
      return new Map();
    }
    if (path.has(node)) {
      const sig = [...path].join(" > ") + " > " + node;
      if (!cyclesSeen.has(sig)) {
        cyclesSeen.add(sig);
        anomalies.push({ kind: "cycle", parent: node, detail: `cycle: ${sig} — stopped descent here` });
      }
      for (const p of path) truncated.add(p);
      truncated.add(node);
      return new Map();
    }
    const kids = adjacency.get(node);
    if (!kids || kids.length === 0) return new Map();   // leaf: caller records it

    path.add(node);
    const out = new Map();
    for (const { child, qty } of kids) {
      if (!Number.isFinite(qty) || qty === 0) continue;
      if (!isParent.has(child)) {
        // Purchased part — terminal.
        out.set(child, (out.get(child) || 0) + qty);
        continue;
      }
      const sub = explode(child, path, depth + 1);
      for (const [leaf, q] of sub) out.set(leaf, (out.get(leaf) || 0) + q * qty);
      // A subassembly that explodes to nothing is a real data oddity:
      // it is listed as a parent, so we never treat it as a purchased
      // part, yet it contributes no components — so its cost/float
      // vanishes silently. Skip when a cycle already explained it.
      if (sub.size === 0 && !truncated.has(child)) {
        anomalies.push({ kind: "leaf-also-parent", parent: child, detail: `${child} is a parent in bom_links but explodes to no purchased parts — it contributes 0 float through ${node}; check whether its BOM is empty or its children are themselves parents with no edges` });
      }
    }
    path.delete(node);
    memo.set(node, out);
    return out;
  }
  return explode;
}

/* ------------------------------------------------------------------
   TRACED EXPLOSION for the "check math" view. Not memoized — it needs
   every distinct path, and it only ever runs for a handful of parts.
   Returns [{ path: [{pn, qty}], qtyPerUnit }] for one FG -> one target.
   ------------------------------------------------------------------ */
function tracePaths(adjacency, isParent, fg, target, maxPaths) {
  const found = [];
  function walk(node, mult, trail, depth) {
    if (found.length >= maxPaths || depth > MAX_DEPTH) return;
    const kids = adjacency.get(node);
    if (!kids) return;
    for (const { child, qty } of kids) {
      if (!Number.isFinite(qty) || qty === 0) continue;
      if (trail.some(t => t.pn === child)) continue;   // cycle
      const step = { pn: child, qty, running: mult * qty };
      if (child === target) {
        found.push({ path: [...trail, step], qtyPerUnit: mult * qty });
        if (found.length >= maxPaths) return;
        continue;
      }
      if (isParent.has(child)) walk(child, mult * qty, [...trail, step], depth + 1);
    }
  }
  walk(fg, 1, [{ pn: fg, qty: 1, running: 1 }], 0);
  return found;
}

/* ------------------------------------------------------------------
   SHARED RUNNER. Exported so the unscheduled HTTP wrapper
   (line-float-run.js) can invoke the identical computation.

   WHY THE SPLIT: Netlify does not route HTTP requests to a function
   that carries a `schedule` in netlify.toml — it answers 403 "Access
   denied". That is why ?dry=1 on THIS function is unreachable from a
   browser no matter what the handler does. Same shape the repo already
   uses for po-receipts: acumatica-po-receipts-sync.js is an unscheduled
   shared runner with thin scheduled wrappers around it.
   ------------------------------------------------------------------ */
async function runLineFloat(event) {
  const t0 = Date.now();
  const log = (m, d) => console.log(`[line-float] ${m}`, d === undefined ? "" : d);
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "server not configured" }) };
  }
  const q = (event && event.queryStringParameters) || {};
  const dryRun = q.dry === "1" || q.dry === "true";
  const explainFor = String(q.explain || "").split(",").map(s => s.trim()).filter(Boolean);

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let bomRows, prodRows, locRows, auditRows, prodAuditRows;
  try {
    [bomRows, prodRows, locRows, auditRows, prodAuditRows] = await Promise.all([
      _fetchAll(supa, "bom_links", "id, data"),
      _fetchAll(supa, "production_orders", "id, data"),
      // Only the line location. warehouse is nullable on rows written
      // before the v-line-count schema addition, so the warehouse test
      // is applied in JS rather than as a .eq() that would drop them.
      _fetchAll(supa, "part_locations", "pn, location, location_raw, warehouse, qty, qty_available, synced_at"),
      _fetchAll(supa, "audit", "id, data", qq =>
        qq.eq("data->>type", "acumatica-bom-sync").order("data->>ts", { ascending: false }).limit(1)),
      _fetchAll(supa, "audit", "id, data", qq =>
        qq.eq("data->>type", "acumatica-production-orders-sync").order("data->>ts", { ascending: false }).limit(1)),
    ]);
  } catch (err) {
    log("input fetch failed: " + err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "input fetch failed", detail: err.message }) };
  }

  const bomPulledAt = (auditRows && auditRows[0] && auditRows[0].data && auditRows[0].data.ts) || null;
  const anomalies = [];

  // ---- edges ------------------------------------------------------
  const { edges, dupePairs } = dedupeEdges(bomRows, anomalies);
  const adjacency = new Map();
  const isParent = new Set();
  const allChildren = new Set();
  for (const e of edges) {
    let arr = adjacency.get(e.parent);
    if (!arr) { arr = []; adjacency.set(e.parent, arr); }
    arr.push({ child: e.child, qty: e.qty });
    isParent.add(e.parent);
    allChildren.add(e.child);
  }
  // A leaf (purchased part) is any child that is never a parent.
  const leaves = new Set();
  for (const c of allChildren) if (!isParent.has(c)) leaves.add(c);

  // A bad or partial pull is obvious from these two numbers.
  log(`BOM pull: ${edges.length} edges (${bomRows.length} raw rows, ${dupePairs} duplicate pairs collapsed) · ${isParent.size} parents · ${leaves.size} leaves · pulled_at ${bomPulledAt || "unknown"}`);
  if (edges.length === 0) {
    return { statusCode: 500, body: JSON.stringify({ error: "bom_links is empty — refusing to compute line float against no BOM" }) };
  }

  // ---- units on line, from REAL production orders ------------------
  // "On the line" = status 'Released' EXACTLY, case-insensitive, ALL FG
  // SKUs including UT1010xx frames (Dylan, 2026-09-16: frame builds also
  // consume RMSTOR-LM, so no SKU filter). Units per model =
  // SUM(qty_remaining) — what those open orders have left to build, which
  // is what is still sitting on the line.
  const RELEASED_STATUS = "released";
  const statusCounts = Object.create(null);
  const byModel = new Map();   // sku -> { units, orders, desc }
  let releasedOrders = 0;
  for (const r of (prodRows || [])) {
    const d = r && r.data ? r.data : r;
    if (!d) continue;
    const st = String(d.status || "").trim();
    statusCounts[st || "<empty>"] = (statusCounts[st || "<empty>"] || 0) + 1;
    if (st.toLowerCase() !== RELEASED_STATUS) continue;
    const sku = String(d.fgSku || "").trim();
    if (!sku) continue;
    const rem = Number(d.qtyRemaining);
    const n = Number.isFinite(rem) ? rem : 0;
    let rec = byModel.get(sku);
    if (!rec) { rec = { units: 0, orders: 0, desc: d.fgDesc || "" }; byModel.set(sku, rec); }
    rec.units += n;
    rec.orders += 1;
    releasedOrders++;
  }
  const units = [...byModel.entries()].map(([sku, rec]) => ({ sku, units: rec.units, orders: rec.orders, desc: rec.desc }));
  for (const u of units) {
    if (!isParent.has(u.sku)) {
      // Loud and top-level: a Released order we cannot explode means its
      // consumption is invisible, so every band for the parts it eats is
      // too wide and SHORT will never fire for them.
      anomalies.push({ kind: "missing-fg-bom", parent: u.sku, detail: `RELEASED order(s) for ${u.sku} (${u.units} unit(s) over ${u.orders} order(s)) but ${u.sku} is not a Parent ID anywhere in bom_links — its consumption is INVISIBLE, so bands for the parts it consumes are too wide` });
    }
  }
  log(`[LINE] distinct Status values seen:`, statusCounts);
  if (!Object.keys(statusCounts).some(s => s.toLowerCase() === RELEASED_STATUS)) {
    log(`[LINE] WARNING: no production order carries status '${RELEASED_STATUS}'. Either nothing is on the line, or Acumatica renamed the status. Every band collapses to band_low == band_high while this holds.`);
  }

  // ---- availability at the line location ---------------------------
  const LINE_LOCATION = "RMSTOR-LM";
  const LINE_WAREHOUSE = "WHI900";
  const availByPn = new Map();     // pn -> { avail, onhand, availIsFallback }
  const locSeen = new Set();
  let locRowsAtLine = 0, availFallbacks = 0;
  for (const r of (locRows || [])) {
    if (!r || !r.pn) continue;
    const rawLoc = String(r.location_raw || r.location || "").trim();
    if (!rawLoc || rawLoc === "__warehouse__") continue;
    locSeen.add(rawLoc);
    if (rawLoc.toUpperCase() !== LINE_LOCATION) continue;
    // warehouse is null on rows written before the schema addition —
    // accept those rather than silently dropping the whole location.
    const wh = String(r.warehouse || "").trim();
    if (wh && wh.toUpperCase() !== LINE_WAREHOUSE) continue;
    const onhand = Number(r.qty) || 0;
    const availRaw = (r.qty_available === null || r.qty_available === undefined) ? null : Number(r.qty_available);
    const availIsFallback = !(availRaw !== null && Number.isFinite(availRaw));
    // Fall back to On Hand rather than 0 when Available is absent —
    // a missing column must not silently collapse every band_high.
    const avail = availIsFallback ? onhand : availRaw;
    if (availIsFallback) availFallbacks++;
    const prev = availByPn.get(r.pn);
    if (prev) { prev.avail += avail; prev.onhand += onhand; prev.availIsFallback = prev.availIsFallback || availIsFallback; }
    else availByPn.set(r.pn, { avail, onhand, availIsFallback });
    locRowsAtLine++;
  }
  log(`[LINE] ${LINE_WAREHOUSE}/${LINE_LOCATION}: ${locRowsAtLine} part row(s); ${availFallbacks} fell back to OnHand for lack of qty_available`);
  if (locRowsAtLine > 0 && availFallbacks === locRowsAtLine) {
    log(`[LINE] WARNING: qty_available is null on EVERY ${LINE_LOCATION} row — band_high is running on On Hand, not Available. Confirm QtyAvailableinLocation is parsing in acumatica-sync (it logs coverage each run).`);
  }
  log(`[LINE] distinct locations in part_locations: ${locSeen.size}${locSeen.size > 1 && locSeen.size <= 30 ? " — " + [...locSeen].sort().join(", ") : ""}`);

  // ---- explode ----------------------------------------------------
  const explode = buildExploder(adjacency, isParent, anomalies);
  // pn -> { total, byModel: { sku: qtyPerUnit } }
  const perPart = new Map();
  const perFgLeafCount = {};
  for (const u of units) {
    if (!isParent.has(u.sku)) continue;
    const exploded = explode(u.sku, new Set(), 0);
    perFgLeafCount[u.sku] = exploded.size;
    for (const [leaf, qtyPerUnit] of exploded) {
      let rec = perPart.get(leaf);
      if (!rec) { rec = { total: 0, byModel: {} }; perPart.set(leaf, rec); }
      rec.byModel[u.sku] = (rec.byModel[u.sku] || 0) + qtyPerUnit;
      rec.total += qtyPerUnit * u.units;
    }
  }
  const totalUnits = units.reduce((s, u) => s + u.units, 0);
  log(`[LINE] ON THE LINE: ${releasedOrders} Released order(s), ${Math.round(totalUnits * 100) / 100} unit(s) across ${units.length} model(s) — expected roughly 20-25 units`);
  for (const u of [...units].sort((a, b) => b.units - a.units)) {
    log(`[LINE]   ${u.sku}  ${u.units} unit(s) / ${u.orders} order(s)${isParent.has(u.sku) ? "" : "  << NO BOM"}${u.desc ? "  — " + u.desc : ""}`);
  }
  log(`explosion: ${units.length} FG SKUs (${totalUnits} units on line) · ${perPart.size} purchased parts carry float · per-FG leaf counts ${JSON.stringify(perFgLeafCount)}`);

  // ---- band ---------------------------------------------------------
  // band_high = Available at the line location. band_low = band_high -
  // released_float, floored at 0. Union of "has stock at the line" and
  // "has nonzero float" — a part can be in either set alone and still
  // needs a row (float with no stock is exactly the anomaly below).
  const allPns = new Set([...perPart.keys(), ...availByPn.keys()]);
  const bandRows = [];
  let floatNoStock = 0;
  for (const pn of allPns) {
    const rec = perPart.get(pn);
    const av = availByPn.get(pn);
    const releasedFloat = rec ? rec.total : 0;
    const bandHigh = av ? av.avail : 0;
    const bandLow = Math.max(0, bandHigh - releasedFloat);
    if (releasedFloat > 0 && (!av || av.avail === 0)) {
      floatNoStock++;
      anomalies.push({
        kind: "float-no-line-stock", parent: pn,
        detail: `${pn} has released_float ${Math.round(releasedFloat * 100) / 100} but ${av ? "zero" : "no"} availability at ${LINE_WAREHOUSE}/${LINE_LOCATION} — band collapses to 0-0. Either it is issued from a different location or the location feed is incomplete for it; do NOT read a count of 0 here as agreement`,
      });
    }
    bandRows.push({
      pn,
      line_float: Math.round(releasedFloat * 10000) / 10000,
      released_float: Math.round(releasedFloat * 10000) / 10000,
      avail_at_line: av ? Math.round(av.avail * 10000) / 10000 : 0,
      onhand_at_line: av ? Math.round(av.onhand * 10000) / 10000 : 0,
      band_low: Math.round(bandLow * 10000) / 10000,
      band_high: Math.round(bandHigh * 10000) / 10000,
      qty_per_unit: rec ? rec.byModel : {},
      computed_at: new Date().toISOString(),
    });
  }
  bandRows.sort((a, b) => b.released_float - a.released_float);
  log(`[LINE] band: ${bandRows.length} part row(s); ${floatNoStock} have float but no stock at the line`);
  log(`[LINE] top 20 by released_float:`);
  for (const r of bandRows.slice(0, 20)) {
    log(`[LINE]   ${r.pn.padEnd(14)} float ${String(r.released_float).padStart(9)}  avail ${String(r.avail_at_line).padStart(9)}  band ${r.band_low}-${r.band_high}`);
  }
  log(`anomalies: ${anomalies.length} (${["cycle","duplicate-bom","missing-fg-bom","leaf-also-parent","max-depth","float-no-line-stock"].map(k => `${k}=${anomalies.filter(a => a.kind === k).length}`).join(", ")})`);

  // ---- check-math output ------------------------------------------
  const explain = [];
  if (explainFor.length > 0) {
    for (const pn of explainFor) {
      const rec = perPart.get(pn);
      const entry = { pn, qtyPerUnitByModel: rec ? rec.byModel : {}, lineFloat: rec ? rec.total : 0, paths: [] };
      for (const u of units) {
        if (!isParent.has(u.sku)) continue;
        const paths = tracePaths(adjacency, isParent, u.sku, pn, 12);
        for (const p of paths) {
          entry.paths.push({
            fg: u.sku, unitsOnLine: u.units, qtyPerUnit: p.qtyPerUnit,
            floatFromThisPath: p.qtyPerUnit * u.units,
            chain: p.path.map(s => `${s.pn} x${s.qty}`).join("  ->  "),
          });
        }
      }
      // Sum of traced paths should reconcile to the memoized total.
      const tracedByModel = {};
      for (const p of entry.paths) tracedByModel[p.fg] = (tracedByModel[p.fg] || 0) + p.qtyPerUnit;
      entry.reconciles = Object.keys(entry.qtyPerUnitByModel).every(
        m => Math.abs((tracedByModel[m] || 0) - entry.qtyPerUnitByModel[m]) < 1e-6
      ) && Object.keys(tracedByModel).length === Object.keys(entry.qtyPerUnitByModel).length;
      explain.push(entry);
      log(`explain ${pn}: qty/unit ${JSON.stringify(entry.qtyPerUnitByModel)} · float ${entry.lineFloat} · ${entry.paths.length} path(s) · reconciles=${entry.reconciles}`);
      for (const p of entry.paths) log(`   ${p.fg} (${p.unitsOnLine} on line) qty/unit ${p.qtyPerUnit}: ${p.chain}`);
    }
  }

  const meta = {
    computed_at: new Date().toISOString(),
    bom_pulled_at: bomPulledAt,
    prod_orders_synced_at: (prodAuditRows && prodAuditRows[0] && prodAuditRows[0].data && prodAuditRows[0].data.ts) || null,
    locations_synced_at: (locRows || []).reduce((m, r) => (r.synced_at && (!m || r.synced_at > m)) ? r.synced_at : m, null),
    line_warehouse: LINE_WAREHOUSE,
    line_location: LINE_LOCATION,
    released_status: RELEASED_STATUS,
    edges: edges.length,
    raw_rows: bomRows.length,
    duplicate_pairs: dupePairs,
    parents: isParent.size,
    leaves: leaves.size,
    fg_count: units.length,
    released_orders: releasedOrders,
    total_units_on_line: Math.round(totalUnits * 100) / 100,
    units_by_model: units.map(u => ({ sku: u.sku, desc: u.desc, units: u.units, orders: u.orders, hasBom: isParent.has(u.sku) })),
    status_counts: statusCounts,
    parts_with_float: perPart.size,
    parts_at_line: availByPn.size,
    band_rows: bandRows.length,
    avail_fallback_rows: availFallbacks,
    float_no_line_stock: floatNoStock,
    distinct_locations: locSeen.size,
    per_fg_leaf_count: perFgLeafCount,
    anomalies,
  };

  if (dryRun) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, meta, explain, elapsedMs: Date.now() - t0 }, null, 2) };
  }

  // ---- write ------------------------------------------------------
  const rows = bandRows.map(r => ({ ...r, computed_at: meta.computed_at }));
  // Wholesale replace: a part that dropped out of every BOM must not keep
  // a stale float. Delete-then-insert inside one pass; the table is small
  // (~leaf count) so this is cheap and avoids orphan rows.
  const { error: delErr } = await supa.from("line_float").delete().neq("pn", "__never_a_real_pn__");
  if (delErr) log("line_float clear failed (non-fatal): " + delErr.message);
  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const { error } = await supa.from("line_float").upsert(batch, { onConflict: "pn" });
    if (error) {
      log("line_float upsert failed: " + error.message);
      return { statusCode: 500, body: JSON.stringify({ error: "line_float upsert failed", detail: error.message, wroteBeforeFailure: written }) };
    }
    written += batch.length;
  }
  const { error: metaErr } = await supa
    .from("line_float_meta")
    .upsert([{ id: "current", data: meta }], { onConflict: "id" });
  if (metaErr) log("line_float_meta upsert failed (non-fatal): " + metaErr.message);

  log(`done: wrote ${written} line_float rows in ${Date.now() - t0}ms`);
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, written, meta, explain, elapsedMs: Date.now() - t0 }, null, 2),
  };
}

// Scheduled entry point (cron only — Netlify 403s HTTP to this).
// Browser/manual access goes through line-float-run.js.
exports.handler = async (event) => runLineFloat(event);

// Shared runner for the unscheduled HTTP wrapper.
exports.runLineFloat = runLineFloat;
