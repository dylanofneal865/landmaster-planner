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
    // Parse released_date as a LOCAL calendar date. new Date("YYYY-MM-DD")
    // parses as UTC midnight, which for US eastern time zones shifts back
    // a day (Jan 5 → Jan 4 19:00 EST) and mis-buckets every Monday-
    // released order into the previous week. parseDateLocal
    // (js/02-utils.js) is the same helper the rest of the codebase uses
    // for date-only strings (transitionStartDate, PO expectedDate, etc.).
    // Defensive fallback preserves the buggy path only if utils failed
    // to load — in which case the whole app is broken and this is not
    // where the pain surfaces.
    const rel = (typeof parseDateLocal === "function")
      ? parseDateLocal(o.released_date)
      : new Date(o.released_date);
    if (!rel || isNaN(rel.getTime())) {
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

/* ============================================================
   PAGE: BOM USAGE WEEKLY (Phase 3)

   Grid: parts as rows, weeks (Monday-anchored) as columns.
   Each cell shows the weekly usage and the daily rate
   (weeklyQty ÷ workdaysPerWeek). Empty cells render "—".

   Sticky first column (part #) and sticky header row so scrolling
   in either axis preserves context.

   ISOLATION: reads DB.productionOrders, DB.parts (for descriptions
   ONLY, never mutated), and computeWeeklyBomUsage(). No writes.
   ============================================================ */
const BUW_STATE = {
  search: "",
  sortBy: "total",         // "total" (desc) | "pn" (asc)
  showAll: false,          // false → top 100 by total; true → all rows
  ROW_LIMIT: 100,
};

// Format a Date as "Mon 4/12" — compact header for the week columns.
function _buwWeekHeaderLabel(d) {
  const wk = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return wk;
}

// Cell content: weekly total on top, daily rate underneath in muted
// tiny type. `title` tooltip carries the full precision so a truncated
// display still reveals the underlying number on hover.
function _buwCellHtml(weeklyQty, dailyQty) {
  if (!weeklyQty || weeklyQty === 0) {
    return `<td class="buw-cell buw-empty">—</td>`;
  }
  const wRounded = weeklyQty >= 100 ? Math.round(weeklyQty) : Math.round(weeklyQty * 10) / 10;
  const dRounded = dailyQty >= 100 ? Math.round(dailyQty) : Math.round(dailyQty * 10) / 10;
  const tip = `Weekly: ${weeklyQty}\nDaily: ${dailyQty}`;
  return `<td class="buw-cell" title="${esc(tip)}"><div class="buw-w mono">${fmtNum(wRounded)}</div><div class="buw-d mono muted tiny">${fmtNum(dRounded)}/d</div></td>`;
}

function buwSetSort(key) {
  BUW_STATE.sortBy = key;
  refresh();
}

function buwToggleShowAll() {
  BUW_STATE.showAll = !BUW_STATE.showAll;
  refresh();
}

// Live search filter — toggles per-row display via CSS instead of
// re-rendering the page. The input is NEVER destroyed, so focus and
// cursor position hold across keystrokes. Also updates the "N of M
// matching" caption and the "Show all" button visibility in place.
//
// Called from the search input's oninput. State updates on every
// call so an external refresh() (say, from a cloud sync landing
// mid-typing) picks up the current text and re-renders in the same
// filtered state — the caller doesn't lose what they typed.
//
// Rule set:
//   - When search is empty AND showAll is off: show top ROW_LIMIT by
//     current sort order (default UX).
//   - When search is non-empty: bypass the top-N cap and show every
//     match, no matter where it falls in the sort. Prevents "I know
//     that part exists, why can't I find it?".
//   - When showAll is on: show every row (subject to search match).
function buwLiveFilter(searchStr) {
  const q = String(searchStr || "").trim().toLowerCase();
  BUW_STATE.search = q;
  const tbody = document.getElementById("buw-tbody");
  if (!tbody) return;
  const rows = tbody.querySelectorAll("tr[data-pn]");
  const showAll = BUW_STATE.showAll;
  const limit = BUW_STATE.ROW_LIMIT;
  let matched = 0;
  let shown = 0;
  for (const row of rows) {
    const pn = (row.dataset.pn || "").toLowerCase();
    const desc = (row.dataset.desc || "").toLowerCase();
    const matches = !q || pn.includes(q) || desc.includes(q);
    if (matches) matched++;
    const inSlice = !!q || showAll || shown < limit;
    const show = matches && inSlice;
    row.style.display = show ? "" : "none";
    if (show) shown++;
  }
  const capEl = document.getElementById("buw-count");
  if (capEl) {
    const total = rows.length;
    const suffix = q ? ` matching "${searchStr.trim()}"` : "";
    const slice = (!q && !showAll && matched > limit) ? ` · showing top ${shown}` : "";
    capEl.textContent = `${matched} of ${total} parts${suffix}${slice}`;
  }
  // Show-all button visibility — surfaces only when there's more to
  // reveal (matched exceeds the current shown slice AND showAll is off
  // AND there's no search bypass in play).
  const showAllBtn = document.getElementById("buw-show-all-btn");
  if (showAllBtn) {
    const canExpand = !showAll && !q && matched > limit;
    showAllBtn.style.display = canExpand ? "" : "none";
  }
}

function renderBomUsageWeekly() {
  const t0 = performance.now();
  const weeks = computeWeeklyBomUsage();

  // Empty-state guard: no production orders → helpful empty message,
  // NOT a broken-looking grid.
  if (!weeks.length) {
    $("#main").innerHTML = `
      <div class="page">
        <div class="page-head">
          <div>
            <div class="page-title">BOM Usage Weekly</div>
            <div class="page-sub mono">NO PRODUCTION ORDERS LOADED</div>
          </div>
        </div>
        <div class="panel"><div class="panel-body">
          <div class="empty">
            <div class="empty-title">Waiting on production orders</div>
            <div class="empty-msg">
              DB.productionOrders is empty. The weekly Acumatica sync
              (Mondays 11:00 UTC) reconciles the "LM Planner Production
              Orders" GI into the sidecar table; once that's populated,
              this tab will render weekly component-demand rollups
              bucketed by released date.
            </div>
          </div>
        </div></div>
      </div>`;
    return;
  }

  const wpw = weeks._workdaysPerWeek;
  const droppedNoDate = weeks._droppedNoDate.length;
  const totalOrders = weeks.reduce((s, w) => s + w.orderCount, 0);
  const totalUnits  = weeks.reduce((s, w) => s + w.unitTotal,  0);
  const totalReleased = weeks.reduce((s, w) => s + w.releasedCount, 0);
  const totalClosed   = weeks.reduce((s, w) => s + w.closedCount,   0);
  const firstWk = weeks[0].weekStart;
  const lastWk  = weeks[weeks.length - 1].weekStart;

  // Union of every pn that appears in any week.
  const perPartTotals = new Map();
  for (const w of weeks) {
    for (const [pn, v] of w.byPart.entries()) {
      perPartTotals.set(pn, (perPartTotals.get(pn) || 0) + v.weeklyQty);
    }
  }
  const distinctParts = perPartTotals.size;

  // Sort all parts (no slice, no filter). The live search filters via
  // display:none on the emitted rows — no re-render on keystroke.
  const partByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  const allPartRows = [...perPartTotals.entries()].map(([pn, total]) => ({
    pn,
    total,
    desc: (partByPn.get(pn) || {}).desc || "",
  }));

  if (BUW_STATE.sortBy === "pn") {
    allPartRows.sort((a, b) => a.pn.localeCompare(b.pn));
  } else {
    allPartRows.sort((a, b) => b.total - a.total);
  }

  // Compute per-row initial visibility using the same rule set as
  // buwLiveFilter — so the first paint under BUW_STATE.search === ""
  // matches what live filtering produces on the first keystroke.
  const initialQ = BUW_STATE.search;
  const initialShowAll = BUW_STATE.showAll;
  const initialLimit = BUW_STATE.ROW_LIMIT;
  let initialMatched = 0;
  let initialShown = 0;
  const perRowVisibility = allPartRows.map(r => {
    const matches = !initialQ ||
      r.pn.toLowerCase().includes(initialQ) ||
      (r.desc || "").toLowerCase().includes(initialQ);
    if (matches) initialMatched++;
    const inSlice = !!initialQ || initialShowAll || initialShown < initialLimit;
    const visible = matches && inSlice;
    if (visible) initialShown++;
    return visible;
  });
  const totalMatched = initialMatched;
  const truncatedCount = (!initialQ && !initialShowAll) ? Math.max(0, initialMatched - initialLimit) : 0;

  // Build header row — one column per week + the sticky first "Part"
  // column. Each week header stacks three tiny lines: date, order count,
  // unit total. Partial-week marker pill so a mid-week snapshot is
  // never mistaken for a completed week.
  const headerCells = weeks.map(w => {
    const label = _buwWeekHeaderLabel(w.weekStart);
    const parts = [
      `<div class="buw-h-date mono">${esc(label)}</div>`,
      `<div class="buw-h-orders muted tiny">${w.orderCount} order${w.orderCount === 1 ? "" : "s"}</div>`,
      `<div class="buw-h-units muted tiny">${fmtNum(Math.round(w.unitTotal))} unit${w.unitTotal === 1 ? "" : "s"}</div>`,
      w.releasedCount || w.closedCount
        ? `<div class="buw-h-split muted tiny">${w.releasedCount}R · ${w.closedCount}C</div>`
        : "",
      w.isPartial ? `<div class="buw-h-partial tiny">PARTIAL</div>` : "",
    ].join("");
    return `<th class="buw-week ${w.isPartial ? "buw-partial" : ""}" title="Week of ${w.weekStart.toDateString()} — ${w.weekEnd.toDateString()}">${parts}</th>`;
  }).join("");

  // Data rows — sticky first cell shows pn + short desc + all-week
  // total. Every row is emitted; visibility is toggled via inline
  // style so the live search can flip display without re-rendering
  // the input (and therefore without losing keystroke focus).
  const bodyRows = allPartRows.map((r, i) => {
    const cells = weeks.map(w => {
      const v = w.byPart.get(r.pn);
      return _buwCellHtml(v ? v.weeklyQty : 0, v ? v.dailyQty : 0);
    }).join("");
    const dailyAvg = r.total / (weeks.length * wpw);
    const hidden = perRowVisibility[i] ? "" : ' style="display:none"';
    return `
      <tr data-pn="${esc(r.pn)}" data-desc="${esc(r.desc || "")}"${hidden}>
        <th class="buw-part-cell" title="${esc(r.pn)}${r.desc ? " — " + esc(r.desc) : ""}">
          <div class="buw-part-pn mono clickable" onclick="openPartDetail('${esc(r.pn)}')">${esc(r.pn)}</div>
          ${r.desc ? `<div class="buw-part-desc muted tiny">${esc(r.desc.slice(0, 42))}</div>` : ""}
          <div class="buw-part-total muted tiny mono">Σ ${fmtNum(Math.round(r.total))} · ${fmtNum(Math.round(dailyAvg * 10) / 10)}/d avg</div>
        </th>
        ${cells}
      </tr>`;
  }).join("");

  const paintMs = Math.round(performance.now() - t0);

  $("#main").innerHTML = `
    <style>
      /* Scoped grid styles — kept inline so the shared css/styles.css
         stays untouched. Sticky first column via position:sticky+left:0;
         sticky header via position:sticky+top:0. z-index layering:
           corner (top-left)    z:5   — must beat both edges
           thead th (top)       z:3   — beats scrolling tds vertically
           tbody th (left)      z:2   — beats scrolling tds horizontally
           td.buw-cell          z:1   — explicit so hover-bg wins over
                                        the semi-transparent alternates
                                        below (would previously bleed).
         Backgrounds use --bg (base surface) and --bg-1 (raised panels)
         — both defined in css/styles.css. An earlier revision used the
         undefined var --bg-0 → transparent → visible bleed when
         scrolling right; that's the fix. */
      .buw-scroll { overflow: auto; max-height: calc(100vh - 340px); border: 1px solid var(--line); border-radius: 6px; background: var(--bg); }
      .buw-tbl { border-collapse: separate; border-spacing: 0; font-size: 12px; }
      .buw-tbl th, .buw-tbl td { border-bottom: 1px solid var(--line-soft); padding: 6px 8px; vertical-align: top; box-sizing: border-box; }
      .buw-tbl thead th { background: var(--bg-1); position: sticky; top: 0; z-index: 3; border-bottom: 1px solid var(--line); }
      .buw-tbl thead th.buw-corner { position: sticky; left: 0; z-index: 5; background: var(--bg-1); min-width: 240px; max-width: 240px; width: 240px; text-align: left; border-right: 1px solid var(--line); }
      .buw-tbl tbody th.buw-part-cell { position: sticky; left: 0; z-index: 2; background: var(--bg); text-align: left; min-width: 240px; max-width: 240px; width: 240px; border-right: 1px solid var(--line); }
      .buw-tbl tbody td.buw-cell { position: relative; z-index: 1; background: var(--bg); }
      /* Hover: cover BOTH the sticky column AND the scrolling cells so
         hover-bg stays contiguous across the freeze line. Without the
         explicit tbody-td rule the sticky cell would stay --bg while
         the tds turned --bg-hover — visible seam at the freeze edge. */
      .buw-tbl tbody tr:hover th.buw-part-cell,
      .buw-tbl tbody tr:hover td.buw-cell { background: var(--bg-hover); }
      .buw-part-pn { font-weight: 500; color: var(--t1); cursor: pointer; }
      .buw-part-pn:hover { color: var(--accent); }
      .buw-part-desc { line-height: 1.2; margin-top: 2px; }
      .buw-part-total { margin-top: 2px; }
      /* Fixed week-column width — 100px accommodates the widest header
         line ("77 orders" @ 12px) without wrapping, keeps 10-11 weeks
         visible in a typical viewport, and tabular-nums below stops
         digit-count changes from shifting the grid. */
      .buw-week { min-width: 100px; max-width: 100px; width: 100px; text-align: right; line-height: 1.25; white-space: nowrap; }
      .buw-week.buw-partial { background: var(--bg-2); }
      .buw-h-date { font-weight: 600; color: var(--t1); }
      .buw-h-orders, .buw-h-units, .buw-h-split { text-align: right; }
      .buw-h-split { color: var(--t3); }
      .buw-h-partial { color: var(--warn, #d97706); font-weight: 600; letter-spacing: 0.06em; text-align: right; margin-top: 2px; }
      .buw-tbl td.buw-cell { min-width: 100px; max-width: 100px; width: 100px; text-align: right; font-variant-numeric: tabular-nums; }
      .buw-tbl td.buw-cell.buw-empty { color: var(--t3); text-align: center; }
      .buw-w { font-weight: 500; color: var(--t1); }
      .buw-d { line-height: 1.1; }
      .buw-basis { padding: 8px 12px; background: var(--bg-1); border-radius: 6px; margin-bottom: 12px; font-size: 12px; line-height: 1.5; color: var(--t2); }
      .buw-basis strong { color: var(--t1); }
      .buw-toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
      .buw-toolbar .search-input { flex: 0 0 260px; }
      .buw-toolbar .grow { flex: 1; }
    </style>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">BOM Usage Weekly</div>
          <div class="page-sub mono">${weeks.length} WEEKS · ${totalOrders} ORDERS (${totalReleased} RELEASED · ${totalClosed} CLOSED) · ${fmtNum(Math.round(totalUnits))} UNITS · ${distinctParts} DISTINCT PARTS · ${_buwWeekHeaderLabel(firstWk)} → ${_buwWeekHeaderLabel(lastWk)}</div>
        </div>
      </div>

      <div class="buw-basis">
        <strong>Basis:</strong> Weekly BOM usage — production orders bucketed by <strong>RELEASED date</strong> (Monday-anchored weeks), qty = <em>Qty To Produce × BOM</em>. Daily = weekly ÷ <strong>${wpw}</strong> production days. Reads production_orders (weekly Acumatica sync) + BOM links (daily sync). ${droppedNoDate > 0 ? `<span class="text-warn">${droppedNoDate} order${droppedNoDate === 1 ? "" : "s"} skipped for missing released_date.</span>` : ""}
      </div>

      <div class="buw-toolbar">
        <div class="search-input">
          <input id="buw-search" class="input" placeholder="Search part # or description…" value="${esc(BUW_STATE.search)}" oninput="buwLiveFilter(this.value)">
        </div>
        <span class="muted tiny">Sort:</span>
        <select class="select" onchange="buwSetSort(this.value)">
          <option value="total" ${BUW_STATE.sortBy === "total" ? "selected" : ""}>Total usage (desc)</option>
          <option value="pn" ${BUW_STATE.sortBy === "pn" ? "selected" : ""}>Part # (asc)</option>
        </select>
        <div class="grow"></div>
        <span id="buw-count" class="muted tiny">${totalMatched} of ${distinctParts} parts${BUW_STATE.search ? ` matching "${esc(BUW_STATE.search)}"` : ""}${truncatedCount > 0 ? ` · showing top ${initialShown}` : ""}</span>
        <button id="buw-show-all-btn" class="btn" onclick="buwToggleShowAll()"${truncatedCount > 0 ? "" : ' style="display:none"'}>Show all ${totalMatched}</button>
        ${BUW_STATE.showAll && distinctParts > BUW_STATE.ROW_LIMIT ? `<button class="btn" onclick="buwToggleShowAll()">Back to top ${BUW_STATE.ROW_LIMIT}</button>` : ""}
      </div>

      <div class="panel">
        <div class="panel-body flush">
          <div class="buw-scroll">
            <table class="buw-tbl">
              <thead>
                <tr>
                  <th class="buw-corner">
                    <div class="mono">Part / week</div>
                    <div class="muted tiny">weekly / daily</div>
                  </th>
                  ${headerCells}
                </tr>
              </thead>
              <tbody id="buw-tbody">
                ${bodyRows}
              </tbody>
            </table>
          </div>
          <div class="muted tiny" style="padding:8px 12px;border-top:1px solid var(--line)">
            Painted in ${paintMs} ms · ${initialShown} of ${allPartRows.length} rows visible × ${weeks.length} weeks = ${initialShown * weeks.length} cells shown (${allPartRows.length * weeks.length} in DOM).
          </div>
        </div>
      </div>
    </div>`;
}

registerRoute("bom-usage-weekly", renderBomUsageWeekly);
