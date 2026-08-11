/* =====================================================
   23-bom-usage-weekly.js
   Sections: WEEK BUCKET HELPERS, WEEKLY BOM USAGE COMPUTATION

   Phase 2 of the "BOM Usage Weekly" reporting tab: PURE COMPUTATION.
   No route, no nav entry, no rendering — Phase 3 adds those.

   ISOLATION CONTRACT (grep-auditable):
     - Read-only. NO writes anywhere.
     - Does NOT touch DB.usage, part.daily, part.onHand, part.status,
       any DB.parts[i].* assignment, DB.bomLinks (reassigned), or
       _dirtyParts.
     - Does NOT call partsWithStatus(), queueParts(), partStatus(),
       computeDemand(), or bumpStatusCache().
     - Reads only: DB.productionOrders (populated by
       js/30-supabase.js from the production_orders sidecar table),
       DB.bomLinks (via explodeBOM — pure function of the parent→
       children index built at js/03-calc.js:123), and
       DB.settings.workdaysPerWeek (via effectiveWorkdaysPerWeek).
   ===================================================== */

/* ============================================================
   WEEK BUCKET HELPERS
   ============================================================ */

// Monday-anchored week start for any Date. JS getDay() is
// Sun=0..Sat=6; the (getDay()+6)%7 shift maps Mon=0..Sun=6 so a
// subtract-N-days-from-x lands on Monday regardless of the input's
// weekday. Time is zeroed to midnight so bucket keys compare cleanly
// against ISO dates. Returns a NEW Date — never mutates the input.
function mondayOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const shift = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - shift);
  return x;
}

// Local-time ISO date YYYY-MM-DD. Used for bucket keys and for the
// diagnostic snippet output. NOT toISOString() — toISOString converts
// to UTC and would misbucket a Sunday 22:00 local as the next week.
function _bomWeeklyIsoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/* ============================================================
   WEEKLY BOM USAGE COMPUTATION

   For each production order in DB.productionOrders:
     1. Bucket by mondayOfWeek(released_date).
     2. Explode fg_sku via explodeBOM() with a per-SKU cache (513
        orders × ~91 FGs → 91 explosions, not 513).
     3. For each leaf: add (leaf.qtyPerUnit × qty_to_produce) to
        that week's total for leaf.pn.
     4. Track the Released/Closed split per week for context.
     5. Compute dailyQty = weeklyQty / workdaysPerWeek per part.

   Returns weeks sorted ascending by weekStart. Each week carries:
     {
       weekStart: Date,
       weekEnd:   Date,                           // Sunday 23:59:59 conceptually; we use Sunday midnight
       orderCount:    number,                     // total orders released that week
       releasedCount: number,                     // status === "released"
       closedCount:   number,                     // status === "closed"
       unitTotal:     number,                     // Σ qty_to_produce
       isPartial:     boolean,                    // week contains today
       byPart:        Map<pn, {weeklyQty, dailyQty}>,
     }

   Diagnostics are attached as non-numeric properties on the returned
   array (invisible to normal array iteration; discoverable via
   Object.keys or direct property access):
     ._workdaysPerWeek       number pulled from settings
     ._explodeCacheSize      distinct FG SKUs actually exploded
     ._ordersProcessed       orders that made it into a bucket
     ._droppedNoDate         [{id, released_date}] — orders skipped
                             for missing / unparseable released_date
   ============================================================ */
function computeWeeklyBomUsage() {
  const orders = Array.isArray(DB.productionOrders) ? DB.productionOrders : [];
  const wpw = (typeof effectiveWorkdaysPerWeek === "function") ? effectiveWorkdaysPerWeek() : 5;
  const explodeCache = new Map();        // fg_sku → explodeBOM result
  const buckets = new Map();             // ISO weekStart → bucket
  const droppedNoDate = [];              // orders with unparseable date

  // Anchor for the isPartial flag — the Monday of "now". Computed
  // once so every bucket compares against the same reference.
  const nowMonday = mondayOfWeek(new Date());
  const nowMondayMs = nowMonday.getTime();

  for (const o of orders) {
    if (!o || !o.released_date) {
      droppedNoDate.push({ id: o && o.id, released_date: null });
      continue;
    }
    const rel = new Date(o.released_date);
    if (isNaN(rel.getTime())) {
      droppedNoDate.push({ id: o.id, released_date: o.released_date });
      continue;
    }
    const mon = mondayOfWeek(rel);
    const key = _bomWeeklyIsoDate(mon);

    let bucket = buckets.get(key);
    if (!bucket) {
      const end = new Date(mon);
      end.setDate(end.getDate() + 6);
      bucket = {
        weekStart:     mon,
        weekEnd:       end,
        orderCount:    0,
        releasedCount: 0,
        closedCount:   0,
        unitTotal:     0,
        isPartial:     mon.getTime() === nowMondayMs,
        byPart:        new Map(),
      };
      buckets.set(key, bucket);
    }

    bucket.orderCount++;
    const statusLc = String(o.status || "").toLowerCase();
    if (statusLc === "released") bucket.releasedCount++;
    else if (statusLc === "closed") bucket.closedCount++;

    const qty = Number(o.qty_to_produce) || 0;
    bucket.unitTotal += qty;

    // No BOM contribution when qty is zero or fg_sku is missing.
    // Both are legitimate edge cases (a Closed order at 0 remaining
    // still had a qty_to_produce > 0 originally — we use the ordered
    // qty as the demand signal per spec).
    if (qty <= 0 || !o.fg_sku) continue;

    // Per-SKU explosion cache. explodeBOM itself memoizes the
    // parent→children index (js/03-calc.js:123 _bomIndex), but each
    // call still walks the tree — caching the result skips that walk.
    let expl = explodeCache.get(o.fg_sku);
    if (!expl) {
      expl = (typeof explodeBOM === "function")
        ? explodeBOM(o.fg_sku)
        : { leaves: [], distinctLeafCount: 0, totalPieces: 0, warnings: [] };
      explodeCache.set(o.fg_sku, expl);
    }

    for (const leaf of (expl.leaves || [])) {
      if (!leaf || !leaf.pn) continue;
      const perUnit = Number(leaf.qtyPerUnit) || 0;
      if (perUnit === 0) continue;
      const contrib = perUnit * qty;
      const prev = bucket.byPart.get(leaf.pn);
      if (prev) {
        prev.weeklyQty += contrib;
      } else {
        bucket.byPart.set(leaf.pn, { weeklyQty: contrib, dailyQty: 0 });
      }
    }
  }

  // Post-pass: compute dailyQty per part per week. Kept out of the
  // main loop because a part hit by N orders in one week only needs
  // one final divide, not N accumulating divides that drift with
  // float error.
  for (const b of buckets.values()) {
    for (const v of b.byPart.values()) {
      v.dailyQty = wpw > 0 ? v.weeklyQty / wpw : 0;
    }
  }

  const weeks = [...buckets.values()]
    .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime());

  // Diagnostics attached as non-enumerable properties so a caller
  // doing `for (const w of weeks)` or `weeks.forEach(...)` doesn't
  // trip over them. Numeric-index iteration ignores string keys.
  Object.defineProperty(weeks, "_workdaysPerWeek",  { value: wpw, enumerable: false });
  Object.defineProperty(weeks, "_explodeCacheSize", { value: explodeCache.size, enumerable: false });
  Object.defineProperty(weeks, "_ordersProcessed", { value: orders.length - droppedNoDate.length, enumerable: false });
  Object.defineProperty(weeks, "_droppedNoDate",   { value: droppedNoDate, enumerable: false });
  Object.defineProperty(weeks, "_ordersInput",     { value: orders.length, enumerable: false });

  return weeks;
}

// Expose to window so Phase 3's page code and the verification
// DevTools snippet can call these. mondayOfWeek is a general-purpose
// helper — worth exposing separately in case downstream code needs
// week-bucket alignment for a different purpose.
if (typeof window !== "undefined") {
  window.mondayOfWeek = mondayOfWeek;
  window.computeWeeklyBomUsage = computeWeeklyBomUsage;
}
