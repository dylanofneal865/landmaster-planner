/* =====================================================
   21-page-model-year.js
   Sections: MODEL YEAR — part-transition timeline (old PN burns down,
   new/superseding PN phases in). Read-only; everything derived from the
   existing "superseded by" link + the shared supply accessors.
   ===================================================== */

/* ============================================================
   MODEL YEAR — supersession transition visualizer

   A transition pair = { oldPart, newPart } where newPart is the part
   oldPart.supersededBy points to (resolved by PN in DB.parts). It's a
   replacement, so the old part's daily demand carries onto the new part.

   Nothing here recomputes rates / lead time / on-hand / open-PO supply —
   it reuses the same accessors the queues and part drawer use:
     - chainDisplayDaily(part)   daily-use rate (chain-aware, falls back to part.daily)
     - leadTimeDays(part)        lead time in days (ltWeeks * 7)
     - part.onHand               on-hand
     - openPOQty(pn)             total open incoming PO qty
     - isLineOpen(po, ln)        the single "is this PO line live" gate
     - ln.expectedDate || po.expectedDate   the expected-arrival accessor used in the drawer
   ============================================================ */

const MODEL_YEAR_STATE = {
  sortBy: "urgency",   // urgency | oldpn | newpn | runout | orderby | status
  sortDir: "asc",
  showCompleted: false,
};

const MY_WINDOW_DAYS = 183;   // timeline window ≈ 6 months out from today

// Effective daily-use rate for a part, reusing the same chain-aware display
// accessor the parts catalog / Base BOM Usage page use. Defensive fallback to
// the raw stored daily if the helper isn't loaded (same module, but keeps the
// page from throwing on a load-order quirk).
function _myDaily(part) {
  if (typeof chainDisplayDaily === "function") return Number(chainDisplayDaily(part)) || 0;
  return Number(part?.daily) || 0;
}

// Open incoming PO supply for a PN: total remaining qty + earliest expected
// arrival date. Goes through isLineOpen (the shared gate) and reads the same
// ln.expectedDate || po.expectedDate field the part drawer's "Open PO lines"
// table reads, so a leaked Completed PO can't pad the numbers.
function _myOpenIncoming(pn) {
  let qty = 0;
  let earliest = null;
  for (const po of (DB.pos || [])) {
    for (const ln of (po.lines || [])) {
      if (ln.pn !== pn) continue;
      if (!isLineOpen(po, ln)) continue;
      const remaining = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
      if (remaining <= 0) continue;
      qty += remaining;
      const expRaw = ln.expectedDate || po.expectedDate;
      if (expRaw) {
        const exp = new Date(expRaw);
        if (!isNaN(exp)) {
          exp.setHours(0, 0, 0, 0);
          if (!earliest || exp.getTime() < earliest.getTime()) earliest = exp;
        }
      }
    }
  }
  return { qty, earliest };
}

// Build the full transition list (before the Completed filter / sort).
// One entry per part whose supersededBy resolves to a real, different part.
function computeTransitions() {
  const partByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  const out = [];

  for (const oldPart of (DB.parts || [])) {
    const supRaw = oldPart.supersededBy ? String(oldPart.supersededBy).trim() : "";
    if (!supRaw) continue;
    const newPart = partByPn.get(supRaw);
    if (!newPart) continue;                 // superseding PN doesn't resolve — skip
    if (newPart.pn === oldPart.pn) continue; // self-reference guard

    const dailyUse = _myDaily(oldPart);
    const oldOnHand = Number(oldPart.onHand) || 0;
    const oldIncoming = openPOQty(oldPart.pn);
    const oldSupply = oldOnHand + oldIncoming;

    const newOnHand = Number(newPart.onHand) || 0;
    const newLeadDays = leadTimeDays(newPart);
    const newOpen = _myOpenIncoming(newPart.pn);
    const newHasStock = newOnHand > 0;
    const newOnOrder = newOpen.qty > 0 && !!newOpen.earliest;

    // A transition is "completed" (done — nothing left to burn down) when the
    // old part is at zero with no incoming POs.
    const completed = oldSupply <= 0;

    // oldRunoutDate = today + cover. dailyUse is a PER-WORKDAY rate, so
    // (oldOnHand + incoming) / dailyUse is WORKDAYS of cover — convert to a
    // calendar date through the SAME shared helper the dashboard/queues/drawer
    // use, so this date matches them and shifts when workdaysPerWeek changes.
    // No rate → never runs out (no time pressure); model as +Infinity.
    let runoutDays = Infinity;
    let oldRunoutDate = null;
    if (dailyUse > 0) {
      const coverWorkdays = oldSupply / dailyUse;
      runoutDays = (typeof workdaysToCalendarDays === "function")
        ? workdaysToCalendarDays(coverWorkdays, TODAY)
        : Math.ceil(coverWorkdays);
      oldRunoutDate = addDays(TODAY, runoutDays);
    }

    // Transition start date (cut-in) on the SUPERSEDING/new part. When set, the
    // new part isn't allowed to go live before it, so the cutover anchors to
    // this date instead of old-part runout. Parts without one keep today's
    // runout-driven behavior. Parsed as a LOCAL date (no UTC off-by-one).
    const startDate = (typeof parseDateLocal === "function")
      ? parseDateLocal(newPart.transitionStartDate) : null;
    const hasStart = !!startDate;
    const newPreLaunch = (typeof isPreLaunch === "function") && isPreLaunch(newPart);

    // newAvailableDate: today if new has stock, else earliest open new-PO
    // expected date, else today + newLeadTime (must order).
    let newAvailableDate;
    if (newHasStock) newAvailableDate = new Date(TODAY);
    else if (newOnOrder) newAvailableDate = new Date(newOpen.earliest);
    else newAvailableDate = addDays(TODAY, newLeadDays);

    // cutoverDate — when we switch old → new. Anchored to the cut-in date when
    // set, else the old-part runout (today's behavior).
    const cutoverDate = hasStart ? startDate : oldRunoutDate;

    // coverageStart — when new coverage genuinely begins: the new part can't
    // cover before BOTH its supply lands AND (when set) its cut-in date.
    let coverageStart = new Date(newAvailableDate);
    if (hasStart && startDate.getTime() > coverageStart.getTime()) coverageStart = new Date(startDate);

    // Gap — the stretch where the old part is dry but new coverage hasn't begun.
    // One formula unifies BOTH risks:
    //   • stockout gap  — new supply arrives after old runs out (today's risk)
    //   • bridge gap     — old runs dry before the cut-in date is allowed to
    //                      start (the new risk the start date exposes)
    // gap days × dailyUse = units short during the uncovered window.
    let gapDays = 0, gapUnits = 0, isBridge = false;
    if (oldRunoutDate && coverageStart.getTime() > oldRunoutDate.getTime()) {
      gapDays = Math.max(0, Math.round((coverageStart.getTime() - oldRunoutDate.getTime()) / DAY_MS));
      gapUnits = Math.ceil(gapDays * dailyUse);
      // It's a BRIDGE gap when the cut-in date (not late new supply) is what
      // pushes coverage past the old runout — i.e. the new part would otherwise
      // be available by the cutover but isn't allowed to start yet.
      isBridge = hasStart && startDate.getTime() >= newAvailableDate.getTime();
    }
    const hasGap = gapDays > 0;

    // orderByDate = cutover − newLeadTime (null when there's no cutover anchor).
    const orderByDate = cutoverDate ? addDays(cutoverDate, -newLeadDays) : null;
    const needToOrder = !newHasStock && !newOnOrder;

    // Status.
    //   GREEN  — new has stock / a covering PO and there's no gap (no order needed).
    //   YELLOW — on track but an order still needs placing (order by cutover − lead).
    //   RED    — there's a gap: old runs dry before new coverage begins
    //            (stockout gap, or a bridge gap when the cut-in date is the cause).
    let status;
    if (completed) status = "done";
    else if (hasGap) status = "red";
    else if (needToOrder) status = "yellow";
    else status = "green";

    out.push({
      oldPart, newPart,
      dailyUse, oldOnHand, oldIncoming, oldSupply,
      newOnHand, newLeadDays, newOpen, newHasStock, newOnOrder,
      runoutDays, oldRunoutDate, newAvailableDate,
      startDate, hasStart, newPreLaunch, cutoverDate, coverageStart, orderByDate,
      status, gapDays, gapUnits, isBridge, completed,
    });
  }
  return out;
}

const _MY_STATUS_RANK = { red: 0, yellow: 1, green: 2, done: 3 };

function sortTransitions(rows) {
  const dir = MODEL_YEAR_STATE.sortDir === "desc" ? -1 : 1;
  const t = (d) => (d ? d.getTime() : Infinity);
  const sorted = rows.slice();
  sorted.sort((a, b) => {
    let cmp = 0;
    switch (MODEL_YEAR_STATE.sortBy) {
      case "oldpn":  cmp = a.oldPart.pn.localeCompare(b.oldPart.pn); break;
      case "newpn":  cmp = a.newPart.pn.localeCompare(b.newPart.pn); break;
      case "runout": cmp = t(a.oldRunoutDate) - t(b.oldRunoutDate); break;
      case "orderby":cmp = t(a.orderByDate) - t(b.orderByDate); break;
      case "status": cmp = _MY_STATUS_RANK[a.status] - _MY_STATUS_RANK[b.status]; break;
      case "urgency":
      default:
        // Most urgent first: RED then soonest order-by date.
        cmp = _MY_STATUS_RANK[a.status] - _MY_STATUS_RANK[b.status];
        if (cmp === 0) cmp = t(a.orderByDate) - t(b.orderByDate);
        break;
    }
    return cmp * dir;
  });
  return sorted;
}

function mySetSort(key) {
  if (MODEL_YEAR_STATE.sortBy === key) {
    MODEL_YEAR_STATE.sortDir = MODEL_YEAR_STATE.sortDir === "asc" ? "desc" : "asc";
  } else {
    MODEL_YEAR_STATE.sortBy = key;
    MODEL_YEAR_STATE.sortDir = "asc";
  }
  refresh();
}

function myToggleCompleted() {
  MODEL_YEAR_STATE.showCompleted = !MODEL_YEAR_STATE.showCompleted;
  refresh();
}

// % offset of a date along the timeline window (clamped 0..100).
function _myPct(date) {
  if (!date) return 100;
  const days = (date.getTime() - TODAY.getTime()) / DAY_MS;
  return Math.max(0, Math.min(100, (days / MY_WINDOW_DAYS) * 100));
}

const _MY_STATUS_META = {
  red:    { cls: "crit", label: "BEHIND" },
  yellow: { cls: "warn", label: "ORDER BY" },
  green:  { cls: "ok",   label: "PHASE IN" },
  done:   { cls: "muted",label: "DONE" },
};

function _myStatusPill(row) {
  const meta = _MY_STATUS_META[row.status];
  let label = meta.label;
  if (row.status === "yellow" && row.orderByDate) {
    // A pre-launch part is only "order soon" relative to its start date — when
    // the order-by date is already here, say ORDER NOW, never an overdue date.
    label = row.orderByDate.getTime() <= TODAY.getTime() ? "ORDER NOW" : `ORDER BY ${fmtDate(row.orderByDate)}`;
  }
  return `<span class="pill ${meta.cls}">${esc(label)}</span>`;
}

function _myTimelineRow(row) {
  const runoutPct  = row.oldRunoutDate ? _myPct(row.oldRunoutDate) : 100;
  const cutoverPct = row.cutoverDate ? _myPct(row.cutoverDate) : runoutPct;
  const coverPct   = _myPct(row.coverageStart);

  // Bar geometry.
  //   amber — old stock burning down, today → old runout
  //   green — new coverage, from where it genuinely begins → window end
  //   red   — the uncovered gap (stockout OR bridge), old runout → coverage start
  const amber = { left: 0, width: runoutPct };
  const green = { left: coverPct, width: Math.max(0, 100 - coverPct) };
  const redZone = row.status === "red" ? { left: runoutPct, width: Math.max(0, coverPct - runoutPct) } : null;

  // Markers — solid cutover line at the cut-in date (or runout when no start
  // date), and the order-by diamond when an order still needs placing.
  const showCutover = !!row.cutoverDate && cutoverPct < 100;
  const cutoverLabel = row.cutoverDate ? fmtDate(row.cutoverDate) : "no rate";
  const orderByPct = row.orderByDate ? _myPct(row.orderByDate) : null;
  const showOrderBy = (row.status === "yellow" || row.status === "red") && row.orderByDate &&
    row.orderByDate.getTime() >= TODAY.getTime() &&
    (row.orderByDate.getTime() - TODAY.getTime()) / DAY_MS <= MY_WINDOW_DAYS;

  const meta = _MY_STATUS_META[row.status];
  const onHandTxt = `${fmtNum(row.oldOnHand)} on hand · ${fmtNum(row.dailyUse, 2)}/day`;
  // A bridge cutover gets a distinct caption so the user can tell a cut-in date
  // from a plain runout marker.
  const cutoverCaption = row.hasStart ? `start ${cutoverLabel}` : cutoverLabel;

  return `
    <div class="my-row">
      <div class="my-label">
        <div class="pn mono clickable" onclick="openPartDetail('${esc(row.oldPart.pn)}')">${esc(row.oldPart.pn)}</div>
        <div class="muted tiny">${esc(onHandTxt)}</div>
        <div class="muted tiny">→ <span class="clickable" onclick="openPartDetail('${esc(row.newPart.pn)}')">${esc(row.newPart.pn)}</span>${row.newPreLaunch ? ' <span class="pill muted" style="font-size:9px;padding:0 4px">PRE-LAUNCH</span>' : ''}</div>
        <div style="margin-top:4px">${_myStatusPill(row)}</div>
      </div>
      <div class="my-track">
        ${redZone && redZone.width > 0 ? `<div class="my-bar red"   style="left:${redZone.left}%;width:${redZone.width}%" title="${row.isBridge ? "Bridge gap" : "Stockout gap"}: ${row.gapDays}d · ${fmtNum(row.gapUnits)} units short"></div>` : ""}
        ${amber.width > 0 ? `<div class="my-bar amber" style="left:${amber.left}%;width:${amber.width}%"></div>` : ""}
        ${green.width > 0 ? `<div class="my-bar green" style="left:${green.left}%;width:${green.width}%"></div>` : ""}
        ${showCutover ? `
          <div class="my-marker ${row.hasStart ? "start" : ""}" style="left:${cutoverPct}%"></div>
          <div class="my-marker-lbl" style="left:${cutoverPct}%">${esc(cutoverCaption)}</div>
        ` : ""}
        ${showOrderBy ? `
          <div class="my-diamond ${meta.cls}" style="left:${orderByPct}%" title="Order by ${esc(fmtDate(row.orderByDate))}"></div>
          <div class="my-diamond-lbl" style="left:${orderByPct}%">order by ${esc(fmtDate(row.orderByDate))}</div>
        ` : ""}
      </div>
    </div>
  `;
}

// Month gridlines + axis labels across the window.
function _myAxis() {
  const ticks = [];
  const start = new Date(TODAY);
  // First of next month, then walk monthly to the window edge.
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  if (cur.getTime() < start.getTime()) cur = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  while ((cur.getTime() - TODAY.getTime()) / DAY_MS <= MY_WINDOW_DAYS) {
    const pct = _myPct(cur);
    ticks.push(`<div class="my-tick" style="left:${pct}%"></div>
                <div class="my-tick-lbl" style="left:${pct}%">${cur.toLocaleDateString("en-US", { month: "short" }).toUpperCase()}</div>`);
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return ticks.join("");
}

function _mySortArrow(key) {
  if (MODEL_YEAR_STATE.sortBy !== key) return "";
  return MODEL_YEAR_STATE.sortDir === "asc" ? " ▲" : " ▼";
}

function renderModelYear() {
  const all = computeTransitions();
  const completedCount = all.filter(r => r.completed).length;

  // Active = not completed; completed shown only when the toggle is on.
  let rows = MODEL_YEAR_STATE.showCompleted ? all : all.filter(r => !r.completed);
  rows = sortTransitions(rows);

  const reds = rows.filter(r => r.status === "red").length;
  const yellows = rows.filter(r => r.status === "yellow").length;
  const greens = rows.filter(r => r.status === "green").length;

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Model Year</div>
          <div class="page-sub mono">${rows.length} ACTIVE TRANSITION${rows.length === 1 ? "" : "S"} · OLD PN BURNS DOWN → SUPERSEDING PN PHASES IN · DERIVED FROM "SUPERSEDED BY" LINKS</div>
        </div>
        <div class="page-actions">
          <button class="btn ${MODEL_YEAR_STATE.showCompleted ? "primary" : ""}" onclick="myToggleCompleted()">
            ${MODEL_YEAR_STATE.showCompleted ? "✓ " : ""}Show completed${completedCount ? ` (${completedCount})` : ""}
          </button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi ${reds > 0 ? "crit" : ""}"><div class="kpi-label">Behind</div><div class="kpi-value">${reds}</div><div class="kpi-foot">stockout gap</div></div>
        <div class="kpi ${yellows > 0 ? "warn" : ""}"><div class="kpi-label">Order Soon</div><div class="kpi-value">${yellows}</div><div class="kpi-foot">order-by pending</div></div>
        <div class="kpi ${greens > 0 ? "ok" : ""}"><div class="kpi-label">Phasing In</div><div class="kpi-value">${greens}</div><div class="kpi-foot">covered</div></div>
        <div class="kpi"><div class="kpi-label">Completed</div><div class="kpi-value">${completedCount}</div><div class="kpi-foot">old PN at zero</div></div>
      </div>

      ${rows.length === 0 ? `
        <div class="panel"><div class="panel-body">
          <div class="empty">
            <div class="empty-title">No ${MODEL_YEAR_STATE.showCompleted ? "" : "active "}transitions</div>
            <div class="empty-msg">
              A transition appears here when a part's <strong>Superseded by</strong> field points at another
              catalog part and the old part still has stock or incoming POs to burn down.
              Set it from the part detail drawer.${!MODEL_YEAR_STATE.showCompleted && completedCount ? ` ${completedCount} completed transition${completedCount === 1 ? "" : "s"} hidden — use <strong>Show completed</strong>.` : ""}
            </div>
          </div>
        </div></div>
      ` : `
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Transition timeline</div>
            <div class="panel-sub">next ~6 months · today → ${fmtDate(addDays(TODAY, MY_WINDOW_DAYS))}</div>
          </div>
          <div class="panel-body">
            <div class="my-legend">
              <span><i class="my-swatch amber"></i> old stock burning down</span>
              <span><i class="my-swatch green"></i> new-part coverage</span>
              <span><i class="my-swatch red"></i> stockout / bridge gap</span>
              <span><i class="my-swatch marker"></i> runout cutover</span>
              <span><i class="my-swatch marker-start"></i> cut-in start date</span>
              <span><i class="my-swatch diamond"></i> order-by date</span>
            </div>
            <div class="my-timeline">
              <div class="my-row my-axis-row">
                <div class="my-label my-axis-corner"><span class="muted tiny">today</span></div>
                <div class="my-track my-axis">${_myAxis()}</div>
              </div>
              ${rows.map(_myTimelineRow).join("")}
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Transitions</div>
            <div class="panel-sub">${rows.length} row${rows.length === 1 ? "" : "s"} · click a column to sort</div>
          </div>
          <div class="panel-body flush">
            <div class="tbl-wrap">
              <table class="tbl my-tbl">
                <thead><tr>
                  <th class="clickable" onclick="mySetSort('oldpn')">Old PN${_mySortArrow("oldpn")}</th>
                  <th class="clickable" onclick="mySetSort('newpn')">New PN${_mySortArrow("newpn")}</th>
                  <th class="right clickable" onclick="mySetSort('oldpn')">Old On-Hand</th>
                  <th class="right">Daily Use</th>
                  <th class="clickable" onclick="mySetSort('runout')">Old Runout${_mySortArrow("runout")}</th>
                  <th class="right">New On-Hand</th>
                  <th class="right">New Lead</th>
                  <th>Start Date</th>
                  <th class="clickable" onclick="mySetSort('orderby')">Order By${_mySortArrow("orderby")}</th>
                  <th class="clickable" onclick="mySetSort('urgency')">Status${MODEL_YEAR_STATE.sortBy === "urgency" || MODEL_YEAR_STATE.sortBy === "status" ? _mySortArrow(MODEL_YEAR_STATE.sortBy) : ""}</th>
                </tr></thead>
                <tbody>
                  ${rows.map(row => `
                    <tr>
                      <td class="pn clickable" onclick="openPartDetail('${esc(row.oldPart.pn)}')">${esc(row.oldPart.pn)}</td>
                      <td class="pn clickable" onclick="openPartDetail('${esc(row.newPart.pn)}')">${esc(row.newPart.pn)}${row.newPreLaunch ? ' <span class="pill muted" style="font-size:9px;padding:0 4px;margin-left:4px">PRE-LAUNCH</span>' : ''}</td>
                      <td class="right num">${fmtNum(row.oldOnHand)}${row.oldIncoming > 0 ? ` <span class="dim tiny">+${fmtNum(row.oldIncoming)} PO</span>` : ""}</td>
                      <td class="right num dim">${fmtNum(row.dailyUse, 2)}</td>
                      <td class="num ${row.status === "red" ? "text-crit bold" : "dim"}">${row.oldRunoutDate ? fmtDate(row.oldRunoutDate) : "—"}</td>
                      <td class="right num">${fmtNum(row.newOnHand)}${row.newOnOrder ? ` <span class="dim tiny">+${fmtNum(row.newOpen.qty)} PO</span>` : ""}</td>
                      <td class="right num dim">${row.newPart.ltWeeks || 0}w</td>
                      <td class="num ${row.hasStart ? "" : "dim"}">${row.hasStart ? fmtDate(row.startDate) : "—"}</td>
                      <td class="num ${row.status === "yellow" ? "text-warn bold" : "dim"}">${row.orderByDate ? fmtDate(row.orderByDate) : "—"}</td>
                      <td>${_myStatusPill(row)}${row.status === "red" && row.gapDays > 0 ? ` <span class="${row.isBridge ? "text-crit" : "dim"} tiny">${row.isBridge ? "bridge" : "gap"} ${row.gapDays}d · ${fmtNum(row.gapUnits)}u short</span>` : ""}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `}
    </div>`;
}

registerRoute("model-year", renderModelYear);
