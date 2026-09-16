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
// THE BAND  (corrected 2026-09-16 — Acumatica allocates on open orders)
//   band_high = qty ON HAND  at WHI900/RMSTOR-LM  — the books; does not
//               move until a unit completes
//   band_low  = qty AVAILABLE at WHI900/RMSTOR-LM — books minus what is
//               already allocated to open orders; floored at 0
//   allocated = band_high - band_low
// A physical count inside [band_low, band_high] is OK. Below band_low is
// a real SHORT. Above band_high is OVER.
//
// The earlier shape had this inverted (Available as the high end, with
// the BOM explosion subtracted to reach the low end). That double-counted
// consumption: Acumatica's allocation ALREADY removes what open orders
// have claimed, so subtracting the BOM float from it again pushed the low
// end far too low and no count could ever read SHORT.
//
// THE BOM EXPLOSION IS NOW A CROSS-CHECK, NOT THE BAND SOURCE
//   released_float = sum over models(units on line x qty_per_unit)
//   check_delta    = (on_hand - available) - released_float
//                  = what Acumatica says is allocated, minus what the BOM
//                    says those open units should have consumed
// Near zero means the two independent views agree. Materially nonzero
// means missing BOM lines, partial allocation, or a stale sync — flagged
// per row rather than folded into the band.
//
// INPUTS  (all existing; this function ingests nothing itself)
//   bom_links              flat parent->child edges, written daily at
//                          06:00 UTC by acumatica-bom-sync.js
//   production_orders      hourly from acumatica-production-orders-sync.js.
//                          "On the line" = status Released OR In Process
//                          (Dylan, 2026-09-16), all FG SKUs including
//                          UT1010xx frames — frame builds also consume
//                          RMSTOR-LM. Units per model = SUM(qty_remaining).
//   part_locations         per-location rows from acumatica-sync.js.
//                          qty = QtyOnHandinLocation is band_high;
//                          qty_available = QtyAvailableinLocation is
//                          band_low. Both are stored, and the gap between
//                          them IS the allocation.
//   audit                  latest acumatica-bom-sync row, for bom_pulled_at
//
// The manual units_on_line table is OBSOLETE — units now come from real
// production orders. Do not populate it; nothing reads it.
//
// OUTPUTS
//   line_float             one row per part:
//                            band_high / onhand_at_line  (books)
//                            band_low  / avail_at_line   (books - alloc)
//                            allocated_at_line           (high - low)
//                            released_float              (BOM cross-check)
//                            check_delta, check_flag     (the disagreement)
//                            avail_known                 (false => band is
//                                                         a single point;
//                                                         Available missing)
//                            qty_per_unit by FG model
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
//     ADD COLUMN IF NOT EXISTS avail_at_line     numeric,
//     ADD COLUMN IF NOT EXISTS onhand_at_line    numeric,
//     ADD COLUMN IF NOT EXISTS allocated_at_line numeric,
//     ADD COLUMN IF NOT EXISTS released_float    numeric NOT NULL DEFAULT 0,
//     ADD COLUMN IF NOT EXISTS check_delta       numeric NOT NULL DEFAULT 0,
//     ADD COLUMN IF NOT EXISTS check_flag        boolean NOT NULL DEFAULT false,
//     ADD COLUMN IF NOT EXISTS avail_known       boolean NOT NULL DEFAULT true,
//     ADD COLUMN IF NOT EXISTS band_low          numeric NOT NULL DEFAULT 0,
//     ADD COLUMN IF NOT EXISTS band_high         numeric NOT NULL DEFAULT 0,
//     -- r3: does the part have a row at the line AT ALL? Distinguishes
//     -- "not stocked / feed dropped it" from "row present, availability
//     -- column missing" — the two used to be one flag.
//     ADD COLUMN IF NOT EXISTS at_line           boolean NOT NULL DEFAULT false;
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
//   -- ---- r2 MIGRATION (count sessions, recount confirmation) --------
//   -- The band a count was graded against, frozen onto the count row
//   -- itself; `miss` is the signed distance OUTSIDE the band (0 when
//   -- the count landed inside). Whether a given miss is material is a
//   -- render-time policy (LC_NOISE_* in js/27-page-line-count.js), so
//   -- it is deliberately NOT stored -- retuning the noise floor
//   -- re-grades history consistently instead of leaving a mix of rows
//   -- judged under different thresholds.
//   ALTER TABLE public.shelf_counts
//     ADD COLUMN IF NOT EXISTS band_low     numeric,
//     ADD COLUMN IF NOT EXISTS band_high    numeric,
//     ADD COLUMN IF NOT EXISTS miss         numeric,
//     ADD COLUMN IF NOT EXISTS session_id   uuid,
//     ADD COLUMN IF NOT EXISTS confirmed    boolean NOT NULL DEFAULT false,
//     ADD COLUMN IF NOT EXISTS confirmed_by text,
//     ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
//   CREATE INDEX IF NOT EXISTS shelf_counts_session_idx
//     ON public.shelf_counts (session_id);
//   -- Chronic-leak lookup: confirmed shorts per part.
//   CREATE INDEX IF NOT EXISTS shelf_counts_confirmed_idx
//     ON public.shelf_counts (pn) WHERE confirmed;
//
//   -- A counting walk. snapshot.parts freezes {pn, band_low, band_high,
//   -- allocated, bom_float} for every part as of the moment the walk
//   -- began, so a count taken at 09:05 and one taken at 09:40 are
//   -- graded against the SAME line, even if a sync moved the band in
//   -- between. snapshot.feeds carries the four as-of stamps.
//   CREATE TABLE IF NOT EXISTS public.count_sessions (
//     id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
//     started_at  timestamptz NOT NULL DEFAULT now(),
//     started_by  text        NOT NULL,
//     finished_at timestamptz,
//     finished_by text,
//     note        text,
//     snapshot    jsonb       NOT NULL DEFAULT '{}'::jsonb,
//     summary     jsonb
//   );
//   -- At most one open session: grading is ambiguous if two walks with
//   -- different frozen bands are live at once.
//   CREATE UNIQUE INDEX IF NOT EXISTS count_sessions_one_open_idx
//     ON public.count_sessions ((finished_at IS NULL)) WHERE finished_at IS NULL;
//   CREATE INDEX IF NOT EXISTS count_sessions_started_idx
//     ON public.count_sessions (started_at DESC);
//   ALTER TABLE public.count_sessions ENABLE ROW LEVEL SECURITY;
//   DROP POLICY IF EXISTS count_sessions_anon_select ON public.count_sessions;
//   CREATE POLICY count_sessions_anon_select ON public.count_sessions FOR SELECT TO anon USING (true);
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

// Paged read of an entire table.
//
// `orderBy` IS NOT OPTIONAL, and the columns given must form a TOTAL
// order (i.e. be unique together). Offset pagination over an UNORDERED
// query is silently lossy: each .range() call is its own query with its
// own snapshot, Postgres makes no promise about row order without an
// ORDER BY, and acumatica-sync DELETEs and re-INSERTs every
// part_locations row every two minutes — which rewrites the heap and so
// changes physical order wholesale. A compute paging through that
// straddles the rewrite and gets some rows twice and others never. That
// is exactly how part 18051's RMSTOR-LM row could exist in Acumatica and
// in part_locations and still be missing from the band, and why the
// "no QtyAvailable" count wandered between runs with no data change.
//
// Ordering fixes the ordering half. The remaining hazard is that the
// table is genuinely INCOMPLETE mid-rewrite (rows deleted, not yet
// re-inserted), so the caller also gets a count check below.
async function _fetchAll(supa, table, cols, orderBy, filter) {
  const order = Array.isArray(orderBy) ? orderBy : [orderBy];
  if (order.length === 0 || order.some(c => !c)) {
    throw new Error(`_fetchAll(${table}) needs an explicit, unique orderBy — offset paging without one drops rows`);
  }
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    let q = supa.from(table).select(cols);
    for (const c of order) q = q.order(c, { ascending: true });
    q = q.range(from, from + PAGE - 1);
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

// Fetch a whole table and prove we got all of it.
//
// Reads the exact row count first, pages, then compares. A short read
// means the table was being rewritten underneath us (acumatica-sync
// runs every 2 minutes and rebuilds part_locations by delete+insert);
// one retry almost always lands in a quiet window. If it still does not
// match, the caller is TOLD rather than silently handed a partial band —
// a band computed from a partial location table understates on-hand and
// invents shortages, which is worse than no band at all.
async function _fetchAllVerified(supa, table, cols, orderBy, log) {
  let expected = null;
  try {
    const { count, error } = await supa.from(table).select(orderBy[0] || "*", { count: "exact", head: true });
    if (!error && Number.isFinite(count)) expected = count;
  } catch (_) { /* count is a nicety; pagination still runs */ }

  let rows = await _fetchAll(supa, table, cols, orderBy);
  if (expected !== null && rows.length < expected) {
    log(`[FETCH] ${table}: read ${rows.length} of ${expected} row(s) — the table was being rewritten mid-read; retrying once`);
    rows = await _fetchAll(supa, table, cols, orderBy);
    const { count: after } = await supa.from(table).select(orderBy[0] || "*", { count: "exact", head: true });
    if (Number.isFinite(after) && rows.length < after) {
      throw new Error(
        `${table} read short twice (${rows.length} of ${after}) — refusing to compute a band from a partial location table. ` +
        `This is usually a long-running acumatica-sync rewrite; re-run in a minute.`
      );
    }
  }
  return rows;
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

  let bomRows, prodRows, locRows;
  try {
    // Every one of these is ordered by a UNIQUE key. See _fetchAll —
    // offset paging without a total order silently drops rows, which is
    // how a part with real line stock showed up as a 0-0 band.
    [bomRows, prodRows, locRows] = await Promise.all([
      _fetchAll(supa, "bom_links", "id, data", ["id"]),
      _fetchAll(supa, "production_orders", "id, data", ["id"]),
      // warehouse is nullable on rows written before the v-line-count
      // schema addition, so the warehouse test is applied in JS rather
      // than as a .eq() that would drop them. (pn, location) is unique:
      // acumatica-sync builds each pn's rows from a Map keyed by
      // warehouse|location, and prefixes the warehouse into `location`
      // whenever a pn spans more than one.
      _fetchAllVerified(supa, "part_locations",
        "pn, location, location_raw, warehouse, qty, qty_available, synced_at",
        ["pn", "location"], log),
    ]);
  } catch (err) {
    log("input fetch failed: " + err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "input fetch failed", detail: err.message }) };
  }

  /* ----------------------------------------------------------------
     AS-OF STAMPS — best effort, never fatal.

     These were previously fetched inside the Promise.all above, which
     made the whole compute fail if either query was slow or errored.
     They are display-only timestamps for the tab header; the band does
     not depend on them, so a failure here must degrade to "unknown"
     rather than take the run down.

     They are also the slowest queries in the function: `audit` has no
     index on data->>type or data->>ts, so each one is an unindexed
     jsonb scan-and-sort over the full audit history. Bounded now with
     an explicit single-row select instead of the paginating _fetchAll,
     and each wrapped so a timeout is survivable.
     ---------------------------------------------------------------- */
  // ONE bounded query on the PRIMARY KEY, then filter in JS. The previous
  // shape used .eq("data->>type", …).order("data->>ts", …), which is an
  // unindexed jsonb filter AND an unindexed jsonb sort over the entire
  // audit history — slow at best, and it returned nothing here (both
  // stamps came back null in the live run even though the type strings
  // are correct). Audit ids are `audit_<something>_<epochMillis>_<rand>`,
  // so descending id order is descending time order for same-length
  // epochs; taking the newest slice and scanning it in JS needs no jsonb
  // operators at all. Still fully non-fatal: these are display-only.
  let bomPulledAtRaw = null, prodSyncedAtRaw = null;
  try {
    const { data, error } = await supa
      .from("audit")
      .select("id, data")
      .order("id", { ascending: false })
      .limit(750);
    if (error) {
      log(`as-of stamps unavailable (non-fatal): ${error.message}`);
    } else {
      const newestOfType = (type) => {
        let best = null;
        for (const r of (data || [])) {
          const d = r && r.data;
          if (!d || d.type !== type) continue;
          const ts = d.ts || null;
          if (ts && (!best || ts > best)) best = ts;
        }
        return best;
      };
      bomPulledAtRaw = newestOfType("acumatica-bom-sync");
      prodSyncedAtRaw = newestOfType("acumatica-production-orders-sync");
      const typesSeen = [...new Set((data || []).map(r => r && r.data && r.data.type).filter(Boolean))];
      if (!bomPulledAtRaw || !prodSyncedAtRaw) {
        log(`as-of stamp missing (bom=${bomPulledAtRaw || "null"}, prodOrders=${prodSyncedAtRaw || "null"}). Types present in the newest ${data ? data.length : 0} audit rows: [${typesSeen.join(", ")}]`);
      }
    }
  } catch (err) {
    log(`as-of stamps threw (non-fatal): ${err && err.message}`);
  }

  const bomPulledAt = bomPulledAtRaw;
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
  // "On the line" = Released OR In Process (Dylan, 2026-09-16). Compared
  // case- and separator-insensitively so "In Process", "InProcess" and
  // "IN PROCESS" all match one entry. A status Acumatica renames drops
  // out of this set silently, which is why the distinct-status counts are
  // logged every run.
  const ON_LINE_STATUSES = new Set(["released", "inprocess"]);
  const normStatus = (s) => String(s || "").toLowerCase().replace(/[\s_-]+/g, "");
  const statusCounts = Object.create(null);
  const byModel = new Map();   // sku -> { units, orders, desc }
  let releasedOrders = 0;
  // production_orders stores SNAKE_CASE keys (fg_sku, qty_remaining,
  // fg_description) — see the `const data = {...}` block in
  // acumatica-production-orders-sync.js. Reading camelCase here silently
  // yielded undefined for every field EXCEPT status, whose key happens to
  // match both ways: the status counter looked healthy while every row
  // was dropped at the sku check. Accept both spellings so neither a
  // future rename nor this mistake can repeat silently, and COUNT the
  // drops so a mismatch is loud instead of reading as "nothing on line".
  let droppedNoSku = 0;
  const sampleKeys = new Set();
  for (const r of (prodRows || [])) {
    const d = r && r.data ? r.data : r;
    if (!d) continue;
    if (sampleKeys.size === 0) for (const k of Object.keys(d)) sampleKeys.add(k);
    const st = String(d.status || "").trim();
    statusCounts[st || "<empty>"] = (statusCounts[st || "<empty>"] || 0) + 1;
    if (!ON_LINE_STATUSES.has(normStatus(st))) continue;
    const sku = String(d.fg_sku || d.fgSku || "").trim();
    if (!sku) { droppedNoSku++; continue; }
    const remRaw = (d.qty_remaining !== undefined) ? d.qty_remaining : d.qtyRemaining;
    const rem = Number(remRaw);
    const n = Number.isFinite(rem) ? rem : 0;
    let rec = byModel.get(sku);
    if (!rec) { rec = { units: 0, orders: 0, desc: d.fg_description || d.fgDesc || "" }; byModel.set(sku, rec); }
    rec.units += n;
    rec.orders += 1;
    releasedOrders++;
  }
  if (droppedNoSku > 0) {
    log(`[LINE] WARNING: ${droppedNoSku} on-line order(s) dropped for having no FG SKU. Keys present on a production_orders row: [${[...sampleKeys].join(", ")}] — if fg_sku is absent or null there, the production-orders GI field mapping is the problem, not this function.`);
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
  if (!Object.keys(statusCounts).some(s => ON_LINE_STATUSES.has(normStatus(s)))) {
    log(`[LINE] WARNING: no production order carries an on-line status (${[...ON_LINE_STATUSES].join(" / ")}). Either nothing is on the line, or Acumatica renamed a status — check the distinct list above. The BOM cross-check reads 0 for every part while this holds; the BAND itself is unaffected (it comes from Acumatica on-hand/available).`);
  }

  // ---- availability at the line location ---------------------------
  const LINE_LOCATION = "RMSTOR-LM";
  const LINE_WAREHOUSE = "WHI900";
  const availByPn = new Map();     // pn -> { avail, onhand, availIsFallback }
  const locSeen = new Set();
  let locRowsAtLine = 0, availFallbacks = 0;
  // Duplicate guard. availByPn ACCUMULATES across rows (a pn can legitimately
  // hold stock in several bins), so a row counted twice silently inflates
  // on-hand. Paging used to be able to hand back the same row twice; it no
  // longer can, and this makes sure of it instead of trusting it.
  const seenRowKeys = new Set();
  let dupeRows = 0;
  for (const r of (locRows || [])) {
    if (!r || !r.pn) continue;
    const rowKey = r.pn + " " + String(r.location || "");
    if (seenRowKeys.has(rowKey)) { dupeRows++; continue; }
    seenRowKeys.add(rowKey);
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
  if (dupeRows > 0) {
    log(`[LINE] WARNING: ${dupeRows} duplicate (pn, location) row(s) came back from part_locations and were ignored — paging or the sync is emitting the same bin twice`);
  }
  log(`[LINE] ${LINE_WAREHOUSE}/${LINE_LOCATION}: ${locRowsAtLine} part row(s); ${availFallbacks} fell back to OnHand for lack of qty_available (of ${(locRows || []).length} part_locations row(s) read across ${locSeen.size} location(s))`);
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
  // band_high = ON HAND at the line (books). band_low = AVAILABLE at the
  // line (books minus allocation), floored at 0. Both come straight from
  // Acumatica; the BOM explosion no longer touches the band.
  //
  // The BOM result becomes an independent cross-check:
  //   check_delta = allocated - released_float
  //               = (on_hand - available) - (units on line x qty/unit)
  // Flagged when |check_delta| > max(1, 5% of on_hand): that size of
  // disagreement between Acumatica's allocation and the BOM's own
  // arithmetic means missing BOM lines, partial allocation, or a stale
  // sync — worth surfacing, never worth quietly folding into the band.
  //
  // Row set is the UNION of "has stock at the line" and "has nonzero
  // float": a part in either set alone still needs a row.
  const CHECK_ABS_FLOOR = 1;
  const CHECK_PCT = 0.05;
  const allPns = new Set([...perPart.keys(), ...availByPn.keys()]);
  const bandRows = [];
  let floatNoStock = 0, checkFlagged = 0, availMissing = 0;
  for (const pn of allPns) {
    const rec = perPart.get(pn);
    const av = availByPn.get(pn);
    const releasedFloat = rec ? rec.total : 0;
    const onHand = av ? av.onhand : 0;
    // Available is the low end. When the column is absent we cannot know
    // the allocation, so the band degrades to a single point at on-hand
    // and the row is marked — better a visibly unusable band than a
    // confidently wrong one.
    const availKnown = !!(av && !av.availIsFallback);
    const available = av ? av.avail : 0;
    if (av && !availKnown) availMissing++;
    const bandHigh = onHand;
    const bandLow = Math.max(0, Math.min(available, bandHigh));
    const allocated = Math.max(0, bandHigh - bandLow);
    const checkDelta = allocated - releasedFloat;
    const checkThreshold = Math.max(CHECK_ABS_FLOOR, Math.abs(onHand) * CHECK_PCT);
    const checkFlag = availKnown && Math.abs(checkDelta) > checkThreshold;
    if (checkFlag) checkFlagged++;

    if (releasedFloat > 0 && (!av || onHand === 0)) {
      floatNoStock++;
      anomalies.push({
        kind: "float-no-line-stock", parent: pn,
        detail: `${pn} is consumed by open orders (BOM float ${Math.round(releasedFloat * 100) / 100}) but has ${av ? "zero" : "no"} on-hand at ${LINE_WAREHOUSE}/${LINE_LOCATION} — band is 0-0. Either it is issued from a different location or the location feed is incomplete for it; do NOT read a count of 0 here as agreement`,
      });
    }
    bandRows.push({
      pn,
      // line_float retained under its original name for any existing
      // reader; released_float is the name the tab uses.
      line_float: Math.round(releasedFloat * 10000) / 10000,
      released_float: Math.round(releasedFloat * 10000) / 10000,
      onhand_at_line: Math.round(onHand * 10000) / 10000,
      avail_at_line: Math.round(available * 10000) / 10000,
      allocated_at_line: Math.round(allocated * 10000) / 10000,
      check_delta: Math.round(checkDelta * 10000) / 10000,
      check_flag: checkFlag,
      avail_known: availKnown,
      // TWO DIFFERENT FAILURES, previously indistinguishable downstream.
      //   at_line=false  -> the part has NO row at WHI900/RMSTOR-LM at all.
      //                     Either it is genuinely not stocked there, or the
      //                     location feed dropped it. Everything reads 0.
      //   at_line=true, avail_known=false
      //                  -> the row exists, but QtyAvailableinLocation did
      //                     not parse, so there is no low end.
      // Collapsing both into avail_known is what let a truncated read of
      // part_locations look like a column-parsing problem.
      at_line: !!av,
      band_low: Math.round(bandLow * 10000) / 10000,
      band_high: Math.round(bandHigh * 10000) / 10000,
      qty_per_unit: rec ? rec.byModel : {},
      computed_at: new Date().toISOString(),
    });
  }
  // Sorted by the size of the cross-check disagreement — the rows most
  // worth a human look sit at the top.
  bandRows.sort((a, b) => Math.abs(b.check_delta) - Math.abs(a.check_delta));
  log(`[LINE] band: ${bandRows.length} part row(s); ${floatNoStock} consumed but absent at the line; ${checkFlagged} cross-check flagged (|delta| > max(${CHECK_ABS_FLOOR}, ${CHECK_PCT * 100}% of on-hand)); ${availMissing} missing Available`);
  log(`[LINE] top 20 by |check_delta| (allocated vs BOM float):`);
  for (const r of bandRows.slice(0, 20)) {
    log(`[LINE]   ${r.pn.padEnd(14)} band ${r.band_low}-${r.band_high}  alloc ${String(r.allocated_at_line).padStart(8)}  bomFloat ${String(r.released_float).padStart(8)}  delta ${String(r.check_delta).padStart(9)}${r.check_flag ? "  << FLAG" : ""}`);
  }
  log(`[LINE] top 20 by released_float:`);
  const byFloat = [...bandRows].sort((a, b) => b.released_float - a.released_float);
  for (const r of byFloat.slice(0, 20)) {
    log(`[LINE]   ${r.pn.padEnd(14)} float ${String(r.released_float).padStart(9)}  onhand ${String(r.onhand_at_line).padStart(9)}  avail ${String(r.avail_at_line).padStart(9)}  band ${r.band_low}-${r.band_high}`);
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
    prod_orders_synced_at: prodSyncedAtRaw,
    locations_synced_at: (locRows || []).reduce((m, r) => (r.synced_at && (!m || r.synced_at > m)) ? r.synced_at : m, null),
    line_warehouse: LINE_WAREHOUSE,
    line_location: LINE_LOCATION,
    on_line_statuses: [...ON_LINE_STATUSES],
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
