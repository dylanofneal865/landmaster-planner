/* =====================================================
   24-page-build-plan.js
   Sections: STATE, MIRROR + INPUT HANDLERS, COMPUTATION, RENDER

   Build Plan — what-if daily usage. Users enter a target
   units/week for each of the 91 buildable finished goods
   (FINISHED_GOODS). The tab explodes those targets through
   DB.bomLinks via explodeBOM and shows, per component part:
     plannedDaily = Σ over FGs (targetWeekly × qtyPerUnit) ÷ wpw
   alongside chainDisplayDaily (the app's canonical "current
   rate") and the delta.

   ISOLATION CONTRACT (view-only for parts math):
     - NEVER writes to DB.usage, part.daily, part.onHand,
       part.status, any DB.parts[i].* assignment, DB.bomLinks
       (reassign), or _dirtyParts.
     - Does NOT call partsWithStatus(), queueParts(),
       partStatus(), computeDemand(), or bumpStatusCache().
     - Reads only: FINISHED_GOODS (constant), DB.parts (for
       description + chainDisplayDaily), DB.bomLinks (via
       explodeBOM — pure function), DB.buildPlanTargets
       (this feature's own sidecar mirror), DB.settings
       (via effectiveWorkdaysPerWeek).
     - Only writes are to public.build_plan_targets via the
       cloud-scoped setBuildPlanTargetCloud /
       clearBuildPlanTargetCloud helpers in js/30-supabase.js.
       No local blob writes, no _dirty* additions.
   ===================================================== */

/* ============================================================
   STATE
   ============================================================ */
const BUILD_PLAN_STATE = {
  search: "",
  sortBy: "delta",     // delta | plannedDaily | currentDaily | pn
  sortDir: "desc",
  showZeroTargets: true,   // true = show every FG in the form; false = only ones with a target
  minPlannedDaily: 0,      // hide component rows below this threshold (0 = show all)
  ROW_LIMIT: 200,          // impact-table default cap; toggleable via "Show all"
  showAll: false,
};

/* ============================================================
   MIRROR + INPUT HANDLERS
   ============================================================ */

// Read helper — returns 0 for unset. Mirror is populated by
// js/30-supabase.js on cloudInit + reconnect. Never mutated
// from here except through the write helpers below.
function _bpGetTarget(fgSku) {
  if (!(DB.buildPlanTargets instanceof Map)) return 0;
  const t = DB.buildPlanTargets.get(fgSku);
  return t && Number.isFinite(Number(t.weeklyQty)) ? Number(t.weeklyQty) : 0;
}

// Number of FGs with a non-zero target.
function _bpTargetsCount() {
  if (!(DB.buildPlanTargets instanceof Map)) return 0;
  let n = 0;
  for (const t of DB.buildPlanTargets.values()) {
    if (Number(t && t.weeklyQty) > 0) n++;
  }
  return n;
}

// Wired to input onchange — fires on blur/Enter, not on every
// keystroke, so no debounce needed and we don't push a write per
// digit typed. Blank input → 0 → clear. Otherwise upsert.
// Refresh so the impact table + totals recompute against the new
// target. Optimistic mirror update happens inside the cloud
// helper; if the write fails, that helper reverts the mirror and
// toasts.
async function bpHandleTargetInput(fgSku, rawValue) {
  const trimmed = String(rawValue == null ? "" : rawValue).trim();
  const n = trimmed === "" ? 0 : Number(trimmed);
  if (!Number.isFinite(n) || n < 0) {
    // Non-numeric or negative — leave state alone, just re-render
    // so the input reverts to the last stored value.
    refresh();
    return;
  }
  const rounded = Math.round(n);   // step=1 in the input, but paranoia
  if (rounded === 0) {
    if (typeof clearBuildPlanTargetCloud === "function") {
      await clearBuildPlanTargetCloud(fgSku);
    }
  } else {
    if (typeof setBuildPlanTargetCloud === "function") {
      await setBuildPlanTargetCloud(fgSku, rounded);
    }
  }
  refresh();
}

// "Clear all targets" — bulk delete. Behind gateDelete because
// it wipes shared cloud state that other users may have entered.
async function bpClearAll() {
  if (typeof gateDelete === "function" && !gateDelete()) return;
  if (!(DB.buildPlanTargets instanceof Map)) return;
  const skus = [...DB.buildPlanTargets.keys()];
  if (!skus.length) { refresh(); return; }
  for (const fgSku of skus) {
    if (typeof clearBuildPlanTargetCloud === "function") {
      await clearBuildPlanTargetCloud(fgSku);
    }
  }
  refresh();
}

function bpSetSort(key) {
  if (BUILD_PLAN_STATE.sortBy === key) {
    BUILD_PLAN_STATE.sortDir = BUILD_PLAN_STATE.sortDir === "asc" ? "desc" : "asc";
  } else {
    BUILD_PLAN_STATE.sortBy = key;
    BUILD_PLAN_STATE.sortDir = key === "pn" ? "asc" : "desc";
  }
  refresh();
}

function bpToggleShowAll()      { BUILD_PLAN_STATE.showAll = !BUILD_PLAN_STATE.showAll; refresh(); }
function bpToggleShowZeros()    { BUILD_PLAN_STATE.showZeroTargets = !BUILD_PLAN_STATE.showZeroTargets; refresh(); }
function bpSetSearch(v)         { BUILD_PLAN_STATE.search = String(v || "").trim().toLowerCase(); refresh(); }

/* ============================================================
   COMPUTATION

   For each FG with target > 0:
     explode fgSku (memoized per FG within one computation pass)
     for each leaf:
       plannedWeekly[leaf.pn] += leaf.qtyPerUnit × targetWeekly

   Then per part:
     plannedDaily = plannedWeekly / workdaysPerWeek
     currentDaily = chainDisplayDaily(part)         (falls back
                    to part.daily; matches Base BOM Queue /
                    Model Year / Parts Catalog display)
     delta        = plannedDaily − currentDaily
     deltaPct     = delta / currentDaily            (Infinity when
                    currentDaily is 0 and planned > 0)

   Pure function of the mirror + explodeBOM + settings. Zero
   writes anywhere. Grep-auditable: no "= " assignment against
   any DB.parts[i] / part.daily / DB.usage.
   ============================================================ */
function computeBuildPlanDemand() {
  const wpw = (typeof effectiveWorkdaysPerWeek === "function") ? effectiveWorkdaysPerWeek() : 5;
  const targets = new Map();   // fg_sku → weeklyQty
  if (DB.buildPlanTargets instanceof Map) {
    for (const [fgSku, t] of DB.buildPlanTargets.entries()) {
      const q = Number(t && t.weeklyQty) || 0;
      if (q > 0) targets.set(fgSku, q);
    }
  }
  const explodeCache = new Map();
  const byPart = new Map();
  const partsByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  let totalWeeklyUnits = 0;
  const emptyBomFgs = [];

  for (const [fgSku, weeklyQty] of targets) {
    totalWeeklyUnits += weeklyQty;
    let expl = explodeCache.get(fgSku);
    if (!expl) {
      expl = (typeof explodeBOM === "function")
        ? explodeBOM(fgSku)
        : { leaves: [], distinctLeafCount: 0, totalPieces: 0, warnings: [] };
      explodeCache.set(fgSku, expl);
    }
    if (!expl.leaves || expl.leaves.length === 0) {
      emptyBomFgs.push(fgSku);
      continue;
    }
    for (const leaf of expl.leaves) {
      if (!leaf || !leaf.pn) continue;
      const per = Number(leaf.qtyPerUnit) || 0;
      if (per === 0) continue;
      const weeklyContrib = per * weeklyQty;
      let rec = byPart.get(leaf.pn);
      if (!rec) {
        const p = partsByPn.get(leaf.pn);
        const currentDaily = (typeof chainDisplayDaily === "function" && p)
          ? (Number(chainDisplayDaily(p)) || 0)
          : (p ? (Number(p.daily) || 0) : 0);
        rec = {
          plannedWeekly: 0,
          plannedDaily: 0,
          currentDaily,
          delta: 0,
          deltaPct: 0,
          contributors: [],
          desc: (p && p.desc) || "",
          inCatalog: !!p,
        };
        byPart.set(leaf.pn, rec);
      }
      rec.plannedWeekly += weeklyContrib;
      rec.contributors.push({ fgSku, weeklyContrib, dailyContrib: weeklyContrib / wpw });
    }
  }

  for (const rec of byPart.values()) {
    rec.plannedDaily = wpw > 0 ? rec.plannedWeekly / wpw : 0;
    rec.delta = rec.plannedDaily - rec.currentDaily;
    if (rec.currentDaily > 0) {
      rec.deltaPct = rec.delta / rec.currentDaily;
    } else if (rec.plannedDaily > 0) {
      rec.deltaPct = Infinity;
    } else {
      rec.deltaPct = 0;
    }
  }

  return {
    byPart,
    totalWeeklyUnits,
    targetsUsed: targets.size,
    workdaysPerWeek: wpw,
    explodeCacheSize: explodeCache.size,
    emptyBomFgs,
  };
}

/* ============================================================
   RENDER
   ============================================================ */

// Variable-precision daily formatter — same convention as
// _buwDailyFmt in js/23-bom-usage-weekly.js: up to 3 decimals,
// no forced trailing zeros. 0.123/d, 1.4/d, 2/d.
function _bpDailyFmt(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

// Chassis-group key derived from the FG description's leading
// token. FINISHED_GOODS is already ordered by chassis pair
// (N6/T6, N7/U7, AMP/E7, base chassis), so grouping by
// first-token gives natural section headers without adding a
// tag field to the constant. Base chassis SKUs (JA27004+)
// use e.g. "N7-U7" — kept intact as their own group.
function _bpChassisOf(fg) {
  const d = String((fg && fg.desc) || "").trim();
  const tok = d.split(/\s+/)[0] || "OTHER";
  return tok.toUpperCase();
}

function renderBuildPlan() {
  const fgs = (typeof FINISHED_GOODS !== "undefined" && Array.isArray(FINISHED_GOODS)) ? FINISHED_GOODS : [];
  const result = computeBuildPlanDemand();
  const { byPart, totalWeeklyUnits, targetsUsed, workdaysPerWeek: wpw, explodeCacheSize, emptyBomFgs } = result;

  // ---- Form rows, grouped by chassis token, with mirror-primed
  //      values so a fresh render reflects the current cloud state.
  const formHtml = (() => {
    if (!fgs.length) return `<div class="empty"><div class="empty-msg">FINISHED_GOODS is empty — nothing to plan against.</div></div>`;
    let currentGroup = null;
    const parts = [];
    for (const fg of fgs) {
      const grp = _bpChassisOf(fg);
      if (grp !== currentGroup) {
        if (currentGroup !== null) parts.push(`</div>`);
        parts.push(`<div class="bp-fg-group"><div class="bp-fg-grouphead mono muted tiny">${esc(grp)}</div>`);
        currentGroup = grp;
      }
      const cur = _bpGetTarget(fg.pn);
      if (!BUILD_PLAN_STATE.showZeroTargets && cur === 0) continue;
      const desc = fg.desc || "";
      parts.push(`
        <div class="bp-fg-row">
          <div class="bp-fg-pn mono">${esc(fg.pn)}</div>
          <div class="bp-fg-desc muted tiny">${esc(desc.slice(0, 46))}</div>
          <input class="input bp-fg-input mono" type="number" step="1" min="0" inputmode="numeric"
                 placeholder="0" value="${cur > 0 ? cur : ""}"
                 onchange="bpHandleTargetInput('${esc(fg.pn)}', this.value)"
                 title="Weekly units of ${esc(fg.pn)} to plan for. Blank or 0 clears the target.">
        </div>`);
    }
    if (currentGroup !== null) parts.push(`</div>`);
    return parts.join("");
  })();

  // ---- Impact table rows.
  const partRowsAll = [...byPart.entries()]
    .map(([pn, rec]) => ({ pn, ...rec }))
    .filter(r => r.plannedDaily >= (Number(BUILD_PLAN_STATE.minPlannedDaily) || 0));

  const q = BUILD_PLAN_STATE.search;
  const filtered = q
    ? partRowsAll.filter(r =>
        r.pn.toLowerCase().includes(q) || (r.desc || "").toLowerCase().includes(q))
    : partRowsAll;

  const sortBy = BUILD_PLAN_STATE.sortBy;
  const dir = BUILD_PLAN_STATE.sortDir === "desc" ? -1 : 1;
  filtered.sort((a, b) => {
    let cmp;
    switch (sortBy) {
      case "pn":            cmp = a.pn.localeCompare(b.pn); break;
      case "plannedDaily":  cmp = a.plannedDaily - b.plannedDaily; break;
      case "currentDaily":  cmp = a.currentDaily - b.currentDaily; break;
      case "delta":
      default:              cmp = Math.abs(a.delta) - Math.abs(b.delta); break;
    }
    return cmp * dir;
  });

  const totalMatched = filtered.length;
  const shownRows = BUILD_PLAN_STATE.showAll ? filtered : filtered.slice(0, BUILD_PLAN_STATE.ROW_LIMIT);
  const truncated = totalMatched - shownRows.length;

  const sortArrow = (k) => BUILD_PLAN_STATE.sortBy === k ? (BUILD_PLAN_STATE.sortDir === "asc" ? " ▲" : " ▼") : "";

  const partsBody = shownRows.map(r => {
    const deltaCls = r.delta > 0 ? "text-warn" : (r.delta < 0 ? "muted" : "dim");
    const contribTip = r.contributors
      .slice()
      .sort((a, b) => b.weeklyContrib - a.weeklyContrib)
      .slice(0, 8)
      .map(c => `${c.fgSku}: ${_bpDailyFmt(c.dailyContrib)}/d`)
      .join("\n");
    return `
      <tr>
        <td class="pn mono clickable" onclick="openPartDetail('${esc(r.pn)}')">${esc(r.pn)}${r.inCatalog ? "" : ' <span class="pill muted tiny">not in catalog</span>'}</td>
        <td class="muted tiny">${esc((r.desc || "").slice(0, 48))}</td>
        <td class="right num mono">${_bpDailyFmt(r.currentDaily)}/d</td>
        <td class="right num mono bold" title="${esc(contribTip)}">${_bpDailyFmt(r.plannedDaily)}/d</td>
        <td class="right num mono ${deltaCls}">${r.delta > 0 ? "+" : ""}${_bpDailyFmt(r.delta)}/d</td>
        <td class="right num muted tiny">${r.contributors.length} FG${r.contributors.length === 1 ? "" : "s"}</td>
      </tr>`;
  }).join("");

  const emptyBomWarning = emptyBomFgs.length > 0
    ? `<div class="muted tiny" style="margin-top:6px">${emptyBomFgs.length} FG${emptyBomFgs.length === 1 ? "" : "s"} in the plan explode to zero leaves (BOM missing): <span class="mono">${esc(emptyBomFgs.slice(0, 6).join(", "))}${emptyBomFgs.length > 6 ? ` +${emptyBomFgs.length - 6} more` : ""}</span></div>`
    : "";

  $("#main").innerHTML = `
    <style>
      .bp-basis { padding: 8px 12px; background: var(--bg-1); border-radius: 6px; margin-bottom: 12px; font-size: 12px; line-height: 1.5; color: var(--t2); }
      .bp-basis strong { color: var(--t1); }
      .bp-layout { display: grid; grid-template-columns: minmax(320px, 380px) 1fr; gap: 14px; align-items: start; }
      @media (max-width: 1100px) { .bp-layout { grid-template-columns: 1fr; } }
      .bp-form-panel { max-height: calc(100vh - 340px); overflow-y: auto; }
      .bp-fg-group { border-bottom: 1px solid var(--line-soft); padding-bottom: 6px; margin-bottom: 6px; }
      .bp-fg-grouphead { padding: 8px 12px 4px; letter-spacing: 0.08em; text-transform: uppercase; }
      .bp-fg-row { display: grid; grid-template-columns: 82px 1fr 84px; gap: 8px; align-items: center; padding: 4px 12px; }
      .bp-fg-row:hover { background: var(--bg-hover); }
      .bp-fg-pn { font-weight: 500; color: var(--t1); }
      .bp-fg-desc { line-height: 1.2; }
      .bp-fg-input { padding: 4px 6px; text-align: right; font-variant-numeric: tabular-nums; }
      .bp-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
      .bp-toolbar .search-input { flex: 0 0 240px; }
      .bp-toolbar .grow { flex: 1; }
    </style>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Build Plan</div>
          <div class="page-sub mono">${targetsUsed} FG TARGET${targetsUsed === 1 ? "" : "S"} · ${fmtNum(Math.round(totalWeeklyUnits))} UNITS/WK PLANNED · ${byPart.size} COMPONENT PART${byPart.size === 1 ? "" : "S"} IMPACTED · WPW ${wpw}</div>
        </div>
        <div class="page-actions">
          ${targetsUsed > 0 ? `<button class="btn danger" onclick="bpClearAll()">Clear all targets</button>` : ""}
        </div>
      </div>

      <div class="bp-basis">
        <strong>Basis:</strong> Enter target units/week per finished good. Component demand explodes through <em>DB.bomLinks</em> (daily Acumatica BOM sync). Planned daily = <em>Σ(target × qty/unit) ÷ ${wpw}</em>. Current daily = <em>chainDisplayDaily(part)</em> — the same rate the Base BOM Queue and Parts Catalog show. This tab is <strong>view-only for parts math</strong> — targets persist to the shared build_plan_targets sidecar, but nothing here writes to part.daily or triggers a queue re-computation.
        ${emptyBomWarning}
      </div>

      <div class="bp-layout">

        <div class="panel bp-form-panel">
          <div class="panel-head">
            <div class="panel-title">Targets · units per week</div>
            <div class="panel-sub">${fgs.length} finished goods${targetsUsed > 0 ? ` · ${targetsUsed} set` : ""}</div>
          </div>
          <div class="panel-body flush">
            <div style="padding:8px 12px;display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--line)">
              <label class="muted tiny" style="display:flex;gap:6px;align-items:center;cursor:pointer">
                <input type="checkbox" ${BUILD_PLAN_STATE.showZeroTargets ? "checked" : ""} onchange="bpToggleShowZeros()">
                Show all 91 FGs
              </label>
            </div>
            ${formHtml}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Component demand</div>
            <div class="panel-sub">${totalMatched} of ${byPart.size} impacted parts${q ? ` · matching "${esc(q)}"` : ""}${truncated > 0 ? ` · showing top ${shownRows.length}` : ""}</div>
          </div>
          <div class="bp-toolbar" style="padding:8px 12px">
            <div class="search-input">
              <input class="input" placeholder="Search part # or description…" value="${esc(BUILD_PLAN_STATE.search)}"
                     onchange="bpSetSearch(this.value)" onkeydown="if(event.key==='Enter'){ bpSetSearch(this.value); }">
            </div>
            <div class="grow"></div>
            ${truncated > 0 ? `<button class="btn" onclick="bpToggleShowAll()">Show all ${totalMatched}</button>` : ""}
            ${BUILD_PLAN_STATE.showAll && byPart.size > BUILD_PLAN_STATE.ROW_LIMIT ? `<button class="btn" onclick="bpToggleShowAll()">Back to top ${BUILD_PLAN_STATE.ROW_LIMIT}</button>` : ""}
          </div>
          <div class="panel-body flush">
            <div class="tbl-wrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th class="clickable sortable" onclick="bpSetSort('pn')">Part #${sortArrow("pn")}</th>
                    <th>Description</th>
                    <th class="right clickable sortable" onclick="bpSetSort('currentDaily')">Current /d${sortArrow("currentDaily")}</th>
                    <th class="right clickable sortable" onclick="bpSetSort('plannedDaily')">Planned /d${sortArrow("plannedDaily")}</th>
                    <th class="right clickable sortable" onclick="bpSetSort('delta')">Δ (planned − current)${sortArrow("delta")}</th>
                    <th class="right">Contributors</th>
                  </tr>
                </thead>
                <tbody>
                  ${byPart.size === 0
                    ? `<tr><td colspan="6"><div class="empty"><div class="empty-title">No targets yet</div><div class="empty-msg">Enter weekly units for one or more finished goods on the left. Component demand rolls up here as the numbers explode through their BOMs.</div></div></td></tr>`
                    : (shownRows.length === 0
                        ? `<tr><td colspan="6" class="muted tiny" style="padding:12px;text-align:center">No parts match the current filter.</td></tr>`
                        : partsBody)}
                </tbody>
              </table>
            </div>
          </div>
        </div>

      </div>
    </div>`;

  // Loaded token for live check — set on every successful render.
  // A page refresh replaces innerHTML but re-runs this line, so the
  // token stays present as long as the tab is the active route.
  // Consumers: `String(window.BUILD_PLAN_LOADED)` or the more
  // specific check in this ticket.
  window.BUILD_PLAN_LOADED = "build-plan-v1-loaded";
}

registerRoute("build-plan", renderBuildPlan);
