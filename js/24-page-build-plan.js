/* =====================================================
   24-page-build-plan.js
   Sections: STATE, INPUT HANDLERS, MIX + DISTRIBUTE COMPUTATION,
             DEMAND COMPUTATION, RENDER

   Build Plan v2 — mix-driven what-if daily usage.

   User sets a single tab-wide "target units/week". The tab derives
   each FG's implied weekly from the historical model mix
   (DB.productionOrders over a trailing window, bucketed by
   RELEASED date the same way BOM Usage Weekly does). Users can
   override any FG (pin it); pinned FGs are excluded from mix
   scaling and the remainder of the target is distributed across
   unpinned FGs by their normalized mix shares. Component daily
   demand explodes through DB.bomLinks and is compared against
   chainDisplayDaily (the app's canonical rate).

   ISOLATION CONTRACT (view-only for parts math):
     - NEVER writes to DB.usage, part.daily, part.onHand,
       part.status, DB.parts[i] fields, DB.bomLinks (reassign),
       or _dirtyParts.
     - Does NOT call partsWithStatus(), queueParts(),
       partStatus(), computeDemand(), or bumpStatusCache().
     - Reads only: FINISHED_GOODS, DB.parts (for desc +
       chainDisplayDaily), DB.bomLinks (via explodeBOM — pure),
       DB.productionOrders (for mix), DB.buildPlanTargets
       (settings + overrides), DB.settings (via
       effectiveWorkdaysPerWeek).
     - Only writes go to public.build_plan_targets via cloud-
       scoped helpers in js/30-supabase.js.
   ===================================================== */

/* ============================================================
   STATE
   ============================================================ */

// Window-size options are user-facing and finite; the picker
// snaps whatever's in the settings row to the nearest allowed
// value at read time.
const BUILD_PLAN_WINDOW_OPTIONS = [4, 8, 13, 26];

const BUILD_PLAN_STATE = {
  search: "",
  sortBy: "delta",          // delta | plannedDaily | currentDaily | pn
  sortDir: "desc",
  showZeroMixFgs: false,    // include FGs with zero units in the window (defaults hidden)
  minPlannedDaily: 0,
  ROW_LIMIT: 200,
  showAll: false,
};

/* ============================================================
   INPUT HANDLERS
   ============================================================ */

// Resolve current settings from the mirror, defaulting the window
// to 8 when nothing is stored yet. Target defaults to null (not 0)
// so the render can distinguish "not set yet" from "set to zero".
function _bpSettings() {
  const s = DB.buildPlanTargets && DB.buildPlanTargets.settings;
  return {
    targetPerWeek: s && Number.isFinite(Number(s.targetPerWeek)) ? Number(s.targetPerWeek) : null,
    windowWeeks:   s && BUILD_PLAN_WINDOW_OPTIONS.includes(Number(s.windowWeeks)) ? Number(s.windowWeeks) : 8,
  };
}

function _bpOverride(fgSku) {
  const m = DB.buildPlanTargets && DB.buildPlanTargets.overrides;
  if (!(m instanceof Map)) return null;
  const v = m.get(fgSku);
  return v && Number.isFinite(Number(v.weeklyQty)) ? Number(v.weeklyQty) : null;
}

function _bpOverrideCount() {
  const m = DB.buildPlanTargets && DB.buildPlanTargets.overrides;
  return m instanceof Map ? m.size : 0;
}

// The single tab-wide target. Fires on blur/Enter (onchange), so
// no debounce needed. Blank → 0 → still valid ("plan for zero
// production" is a legitimate what-if — set to 0 explicitly to
// see current-rate cushion). Persist current windowWeeks too so
// the row is complete either way.
async function bpHandleTargetInput(rawValue) {
  const s = _bpSettings();
  const trimmed = String(rawValue == null ? "" : rawValue).trim();
  const n = trimmed === "" ? 0 : Number(trimmed);
  if (!Number.isFinite(n) || n < 0) { refresh(); return; }
  const rounded = Math.round(n);
  if (typeof setBuildPlanSettingsCloud === "function") {
    await setBuildPlanSettingsCloud({ targetPerWeek: rounded, windowWeeks: s.windowWeeks });
  }
  refresh();
}

async function bpHandleWindowChange(rawValue) {
  const s = _bpSettings();
  const n = Number(rawValue);
  const w = BUILD_PLAN_WINDOW_OPTIONS.includes(n) ? n : 8;
  const target = s.targetPerWeek == null ? 0 : s.targetPerWeek;
  if (typeof setBuildPlanSettingsCloud === "function") {
    await setBuildPlanSettingsCloud({ targetPerWeek: target, windowWeeks: w });
  }
  refresh();
}

// "Load baseline as target" — write actual-avg-per-week into the
// target field so the user has a defensible starting point.
async function bpLoadBaselineAsTarget() {
  const s = _bpSettings();
  const mix = _bpComputeMix(s.windowWeeks);
  const baseline = Math.round(mix.actualAvgPerWeek);
  if (typeof setBuildPlanSettingsCloud === "function") {
    await setBuildPlanSettingsCloud({ targetPerWeek: baseline, windowWeeks: s.windowWeeks });
  }
  refresh();
}

async function bpHandleOverrideInput(fgSku, rawValue) {
  const trimmed = String(rawValue == null ? "" : rawValue).trim();
  if (trimmed === "") {
    if (typeof clearBuildPlanOverrideCloud === "function") {
      await clearBuildPlanOverrideCloud(fgSku);
    }
    refresh();
    return;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) { refresh(); return; }
  const rounded = Math.round(n);
  if (rounded === 0) {
    if (typeof clearBuildPlanOverrideCloud === "function") {
      await clearBuildPlanOverrideCloud(fgSku);
    }
  } else {
    if (typeof setBuildPlanOverrideCloud === "function") {
      await setBuildPlanOverrideCloud(fgSku, rounded);
    }
  }
  refresh();
}

async function bpClearAllOverrides() {
  if (typeof gateDelete === "function" && !gateDelete()) return;
  if (typeof clearAllBuildPlanOverridesCloud === "function") {
    await clearAllBuildPlanOverridesCloud();
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

function bpToggleShowAll()          { BUILD_PLAN_STATE.showAll         = !BUILD_PLAN_STATE.showAll;         refresh(); }
function bpToggleShowZeroMixFgs()   { BUILD_PLAN_STATE.showZeroMixFgs  = !BUILD_PLAN_STATE.showZeroMixFgs;  refresh(); }
function bpSetSearch(v)             { BUILD_PLAN_STATE.search = String(v || "").trim().toLowerCase();      refresh(); }

/* ============================================================
   MIX COMPUTATION

   Uses the SAME date basis as BOM Usage Weekly:
     - parseDateLocal(released_date) — TZ-safe local midnight.
     - mondayOfWeek(...) — Monday-anchored week bucket.
   Window = [nowMonday − (windowWeeks × 7), nowMonday). The current
   in-progress week is excluded — mix reflects completed weeks only,
   so a partial week's undercount doesn't distort baseline/share.
   ============================================================ */
function _bpComputeMix(windowWeeks) {
  const orders = Array.isArray(DB.productionOrders) ? DB.productionOrders : [];
  const w = BUILD_PLAN_WINDOW_OPTIONS.includes(Number(windowWeeks)) ? Number(windowWeeks) : 8;
  const now = new Date();
  const nowMonday = (typeof mondayOfWeek === "function")
    ? mondayOfWeek(now)
    : (() => { const x = new Date(now); x.setHours(0,0,0,0); const s = (x.getDay() + 6) % 7; x.setDate(x.getDate() - s); return x; })();
  const windowEnd = nowMonday.getTime();                          // exclusive
  const windowStart = windowEnd - w * 7 * 86400000;               // inclusive

  const byFg = new Map();
  let totalUnits = 0;
  let ordersConsidered = 0;
  let ordersDropped = 0;

  for (const o of orders) {
    if (!o || !o.released_date || !o.fg_sku) continue;
    const rel = (typeof parseDateLocal === "function")
      ? parseDateLocal(o.released_date)
      : new Date(o.released_date);
    if (!rel || isNaN(rel.getTime())) { ordersDropped++; continue; }
    const mon = (typeof mondayOfWeek === "function")
      ? mondayOfWeek(rel)
      : (() => { const x = new Date(rel); x.setHours(0,0,0,0); const s = (x.getDay() + 6) % 7; x.setDate(x.getDate() - s); return x; })();
    const t = mon.getTime();
    if (t < windowStart || t >= windowEnd) continue;
    const qty = Number(o.qty_to_produce) || 0;
    if (qty <= 0) continue;
    ordersConsidered++;
    totalUnits += qty;
    byFg.set(o.fg_sku, (byFg.get(o.fg_sku) || 0) + qty);
  }

  // Attach share per FG. Zero-total window → shares all 0 (render
  // will surface the "no history" state; distribute becomes a
  // "all overrides, no mix" case).
  const mix = new Map();
  for (const [fgSku, units] of byFg.entries()) {
    mix.set(fgSku, {
      units,
      share: totalUnits > 0 ? units / totalUnits : 0,
    });
  }

  return {
    byFg: mix,
    totalUnits,
    actualAvgPerWeek: w > 0 ? totalUnits / w : 0,
    weeksCovered: w,
    ordersConsidered,
    ordersDropped,
    windowStart: new Date(windowStart),
    windowEnd: new Date(windowEnd),
  };
}

/* ============================================================
   DISTRIBUTION

   Rule set:
     1. Pinned sum = Σ over overrides of the override amount.
        (Overrides for FGs not in mix STILL count as pinned —
         a user pinning an FG with no historical mix means they
         explicitly want that FG built.)
     2. Remaining = max(0, target − pinnedSum).
        - When pinned exceeds target, remaining is clamped to 0
          (never negative) AND `overridesExceedTarget` = true so
          the render can surface a warning.
     3. Unpinned share denominator = Σ (share of FGs in mix that
        are NOT pinned). If it's 0 (all mix FGs pinned, or mix
        is empty), unpinned FGs all get 0.
     4. Unpinned implied = remaining × (share / unpinnedShareSum).
     5. Pinned implied = the override amount, verbatim.
     6. FGs in FINISHED_GOODS that have neither a mix share nor an
        override get 0 (still surfaced if Show-all is checked).
   ============================================================ */
function _bpDistributeTarget(mix, target, overrides) {
  const overridesMap = overrides instanceof Map ? overrides : new Map();
  const overridesTyped = new Map();
  for (const [fgSku, v] of overridesMap.entries()) {
    const q = Number(v && v.weeklyQty);
    if (Number.isFinite(q) && q > 0) overridesTyped.set(fgSku, q);
  }

  let pinnedSum = 0;
  for (const q of overridesTyped.values()) pinnedSum += q;

  const targetNum = Math.max(0, Number(target) || 0);
  const overridesExceedTarget = pinnedSum > targetNum && targetNum > 0;
  const remaining = Math.max(0, targetNum - pinnedSum);

  let unpinnedShareSum = 0;
  for (const [fgSku, entry] of mix.entries()) {
    if (overridesTyped.has(fgSku)) continue;
    unpinnedShareSum += entry.share;
  }

  const implied = new Map();

  for (const [fgSku, q] of overridesTyped.entries()) {
    implied.set(fgSku, {
      impliedWeekly: q,
      share:         mix.get(fgSku) ? mix.get(fgSku).share : 0,
      units:         mix.get(fgSku) ? mix.get(fgSku).units : 0,
      isPinned:      true,
      overrideQty:   q,
    });
  }

  for (const [fgSku, entry] of mix.entries()) {
    if (overridesTyped.has(fgSku)) continue;
    const shareOfRemaining = unpinnedShareSum > 0 ? entry.share / unpinnedShareSum : 0;
    implied.set(fgSku, {
      impliedWeekly: remaining * shareOfRemaining,
      share:         entry.share,
      units:         entry.units,
      isPinned:      false,
      overrideQty:   null,
    });
  }

  return {
    implied,
    pinnedSum,
    remaining,
    overridesExceedTarget,
    unpinnedShareSum,
    unpinnedCount: Math.max(0, mix.size - overridesTyped.size),
    pinnedCount: overridesTyped.size,
  };
}

/* ============================================================
   COMPONENT DEMAND COMPUTATION (mix-driven)

   For each FG with impliedWeekly > 0:
     explode fgSku (memoized per FG)
     for each leaf:
       plannedWeekly[leaf.pn] += leaf.qtyPerUnit × impliedWeekly

   Then per part:
     plannedDaily = plannedWeekly ÷ wpw
     currentDaily = chainDisplayDaily(part)
     delta        = plannedDaily − currentDaily
     deltaPct     = delta / currentDaily        (Infinity when 0/planned>0)
   ============================================================ */
function computeBuildPlanDemand() {
  const wpw = (typeof effectiveWorkdaysPerWeek === "function") ? effectiveWorkdaysPerWeek() : 5;
  const settings = _bpSettings();
  const mix = _bpComputeMix(settings.windowWeeks);
  const overridesMap = (DB.buildPlanTargets && DB.buildPlanTargets.overrides) || new Map();
  const dist = _bpDistributeTarget(mix.byFg, settings.targetPerWeek == null ? 0 : settings.targetPerWeek, overridesMap);

  const explodeCache = new Map();
  const byPart = new Map();
  const partsByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  const emptyBomFgs = [];
  let totalWeeklyUnits = 0;

  for (const [fgSku, entry] of dist.implied.entries()) {
    const wq = Number(entry.impliedWeekly) || 0;
    if (wq <= 0) continue;
    totalWeeklyUnits += wq;
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
      const weeklyContrib = per * wq;
      let rec = byPart.get(leaf.pn);
      if (!rec) {
        const p = partsByPn.get(leaf.pn);
        const currentDaily = (typeof chainDisplayDaily === "function" && p)
          ? (Number(chainDisplayDaily(p)) || 0)
          : (p ? (Number(p.daily) || 0) : 0);
        rec = {
          plannedWeekly: 0,
          plannedDaily:  0,
          currentDaily,
          delta:        0,
          deltaPct:     0,
          contributors: [],
          desc:         (p && p.desc) || "",
          inCatalog:    !!p,
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
    if (rec.currentDaily > 0) rec.deltaPct = rec.delta / rec.currentDaily;
    else rec.deltaPct = rec.plannedDaily > 0 ? Infinity : 0;
  }

  return {
    byPart,
    totalWeeklyUnits,
    workdaysPerWeek: wpw,
    explodeCacheSize: explodeCache.size,
    emptyBomFgs,
    settings,
    mix,
    dist,
  };
}

/* ============================================================
   RENDER
   ============================================================ */

// Daily formatter — reuses _buwDailyFmt from js/23-bom-usage-weekly.js
// (loaded before this module per index.html script order). Max 3
// decimals, no forced trailing zeros: 0.123/d, 1.4/d, 2/d. Kept as a
// shared helper so the two tabs' daily-precision convention can't
// drift.

// Weekly formatter — variable precision up to 2 decimals with no
// forced trailing zeros: 0.31/wk, 5.7/wk, 25/wk. Was previously
// integer-rounding for values ≥ 1 (`if (x >= 1) return Math.round(x)`),
// which showed "26" for a mix-derived 25.7/wk and "5" for 5.05/wk.
// Fixed to unconditional max 2 decimals — the underlying implied
// weekly is never rounded upstream, so this is now display-only.
function _bpWeeklyFmt(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function _bpPctFmt(share) {
  if (share == null || isNaN(share)) return "—";
  const pct = share * 100;
  if (pct < 0.1 && pct > 0) return "<0.1%";
  return pct.toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%";
}

// Chassis-group key from the FG description's leading token.
// FINISHED_GOODS is Engineering-ordered by chassis pair.
function _bpChassisOf(fg) {
  const d = String((fg && fg.desc) || "").trim();
  const tok = d.split(/\s+/)[0] || "OTHER";
  return tok.toUpperCase();
}

function renderBuildPlan() {
  const fgs = (typeof FINISHED_GOODS !== "undefined" && Array.isArray(FINISHED_GOODS)) ? FINISHED_GOODS : [];
  const result = computeBuildPlanDemand();
  const { byPart, totalWeeklyUnits, workdaysPerWeek: wpw, emptyBomFgs, settings, mix, dist } = result;

  // Prefill decision: if settings row is null AND we have a mix
  // baseline, prefill the input's `value` with the rounded actual
  // avg so a first-time user sees a defensible starting number
  // (without persisting it — writes happen only when they commit
  // via blur/Enter).
  const targetDisplayed = settings.targetPerWeek != null
    ? settings.targetPerWeek
    : Math.round(mix.actualAvgPerWeek);
  const targetIsPrefill = settings.targetPerWeek == null;

  const overrideCount = dist.pinnedCount;

  // ---- Form left panel: FG rows grouped by chassis ----
  const formHtml = (() => {
    if (!fgs.length) return `<div class="empty"><div class="empty-msg">FINISHED_GOODS is empty — nothing to plan against.</div></div>`;
    let currentGroup = null;
    const parts = [];
    for (const fg of fgs) {
      const grp = _bpChassisOf(fg);
      const impl = dist.implied.get(fg.pn);
      const inMix = mix.byFg.has(fg.pn);
      const impliedWeekly = impl ? impl.impliedWeekly : 0;
      const share = impl ? impl.share : 0;
      const isPinned = impl ? impl.isPinned : false;
      const overrideVal = _bpOverride(fg.pn);
      if (!BUILD_PLAN_STATE.showZeroMixFgs && !inMix && !isPinned) continue;

      if (grp !== currentGroup) {
        if (currentGroup !== null) parts.push(`</div>`);
        parts.push(`<div class="bp-fg-group"><div class="bp-fg-grouphead mono muted tiny">${esc(grp)}</div>`);
        currentGroup = grp;
      }

      const desc = fg.desc || "";
      const impliedTxt = isPinned
        ? `<span class="pill warn tiny" title="Pinned via override">pin ${_bpWeeklyFmt(impliedWeekly)}</span>`
        : `<span class="mono tiny">${_bpWeeklyFmt(impliedWeekly)}</span>`;
      parts.push(`
        <div class="bp-fg-row ${isPinned ? "bp-pinned" : ""}" title="${esc(fg.pn)}${desc ? " — " + esc(desc) : ""}">
          <div class="bp-fg-pn mono">${esc(fg.pn)}</div>
          <div class="bp-fg-desc muted tiny">${esc(desc.slice(0, 42))}</div>
          <div class="bp-fg-share muted tiny mono right">${inMix ? _bpPctFmt(share) : "—"}</div>
          <div class="bp-fg-implied right">${impliedTxt}<span class="muted tiny mono"> /wk</span></div>
          <input class="input bp-fg-input mono" type="number" step="1" min="0" inputmode="numeric"
                 placeholder="pin"
                 value="${overrideVal != null ? overrideVal : ""}"
                 onchange="bpHandleOverrideInput('${esc(fg.pn)}', this.value)"
                 title="Pin ${esc(fg.pn)} to a specific units/week. Blank = no pin (use mix share).">
        </div>`);
    }
    if (currentGroup !== null) parts.push(`</div>`);
    return parts.join("");
  })();

  // ---- Impact table (component demand) ----
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
      .map(c => `${c.fgSku}: ${_buwDailyFmt(c.dailyContrib)}/d`)
      .join("\n");
    return `
      <tr>
        <td class="pn mono clickable" onclick="openPartDetail('${esc(r.pn)}')">${esc(r.pn)}${r.inCatalog ? "" : ' <span class="pill muted tiny">not in catalog</span>'}</td>
        <td class="muted tiny">${esc((r.desc || "").slice(0, 48))}</td>
        <td class="right num mono">${_buwDailyFmt(r.currentDaily)}/d</td>
        <td class="right num mono bold" title="${esc(contribTip)}">${_buwDailyFmt(r.plannedDaily)}/d</td>
        <td class="right num mono ${deltaCls}">${r.delta > 0 ? "+" : ""}${_buwDailyFmt(r.delta)}/d</td>
        <td class="right num muted tiny">${r.contributors.length} FG${r.contributors.length === 1 ? "" : "s"}</td>
      </tr>`;
  }).join("");

  const emptyBomWarning = emptyBomFgs.length > 0
    ? `<div class="text-warn tiny" style="margin-top:6px">${emptyBomFgs.length} FG${emptyBomFgs.length === 1 ? "" : "s"} in the plan explode to zero leaves (BOM missing): <span class="mono">${esc(emptyBomFgs.slice(0, 6).join(", "))}${emptyBomFgs.length > 6 ? ` +${emptyBomFgs.length - 6} more` : ""}</span></div>`
    : "";

  const overrideExceedsWarn = dist.overridesExceedTarget
    ? `<div class="pill crit tiny" title="Pinned Σ ${dist.pinnedSum} exceeds target ${settings.targetPerWeek}. Remaining unpinned FGs distribute against 0 — increase target or reduce pins.">overrides exceed target</div>`
    : "";

  $("#main").innerHTML = `
    <style>
      .bp-basis { padding: 8px 12px; background: var(--bg-1); border-radius: 6px; margin-bottom: 12px; font-size: 12px; line-height: 1.5; color: var(--t2); }
      .bp-basis strong { color: var(--t1); }
      .bp-header-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 12px; background: var(--bg-1); border-radius: 6px; margin-bottom: 12px; }
      .bp-header-row label { font-size: 12px; color: var(--t2); }
      .bp-target-input { width: 100px; font-size: 15px; padding: 4px 8px; text-align: right; font-variant-numeric: tabular-nums; }
      .bp-prefill { color: var(--warn); font-weight: 500; }
      .bp-baseline { font-size: 11px; color: var(--t3); font-family: var(--f-mono); }
      .bp-header-row .grow { flex: 1; }
      .bp-layout { display: grid; grid-template-columns: minmax(360px, 440px) 1fr; gap: 14px; align-items: start; }
      @media (max-width: 1180px) { .bp-layout { grid-template-columns: 1fr; } }
      .bp-form-panel { max-height: calc(100vh - 380px); overflow-y: auto; }
      .bp-fg-group { border-bottom: 1px solid var(--line-soft); padding-bottom: 6px; margin-bottom: 6px; }
      .bp-fg-grouphead { padding: 8px 12px 4px; letter-spacing: 0.08em; text-transform: uppercase; }
      .bp-fg-row { display: grid; grid-template-columns: 82px 1fr 46px 82px 68px; gap: 6px; align-items: center; padding: 4px 12px; font-size: 11.5px; }
      .bp-fg-row.bp-pinned { background: rgba(255,181,71,0.06); }
      .bp-fg-row:hover { background: var(--bg-hover); }
      .bp-fg-pn { font-weight: 500; color: var(--t1); }
      .bp-fg-desc { line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .bp-fg-share, .bp-fg-implied { text-align: right; font-variant-numeric: tabular-nums; }
      .bp-fg-input { padding: 3px 6px; text-align: right; font-variant-numeric: tabular-nums; font-size: 11.5px; }
      .bp-toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
      .bp-toolbar .search-input { flex: 0 0 240px; }
      .bp-toolbar .grow { flex: 1; }
    </style>

    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Build Plan</div>
          <div class="page-sub mono">MIX-DRIVEN WHAT-IF · ${overrideCount} PIN${overrideCount === 1 ? "" : "S"} · ${byPart.size} COMPONENT PART${byPart.size === 1 ? "" : "S"} · WPW ${wpw}</div>
        </div>
        <div class="page-actions">
          ${overrideCount > 0 ? `<button class="btn danger" onclick="bpClearAllOverrides()">Clear overrides</button>` : ""}
        </div>
      </div>

      <div class="bp-header-row">
        <label style="display:flex;flex-direction:column;gap:2px">
          <span>Target units/week</span>
          <input id="bp-target" class="input bp-target-input mono ${targetIsPrefill ? "bp-prefill" : ""}"
                 type="number" step="1" min="0" inputmode="numeric"
                 value="${targetDisplayed}"
                 title="Total units/week to plan across the finished-good mix. Blank or 0 clears the plan.${targetIsPrefill ? " (Shown value is the actual-avg prefill — not yet saved.)" : ""}"
                 onchange="bpHandleTargetInput(this.value)">
        </label>
        <div class="bp-baseline">
          Last ${settings.windowWeeks} wks actual:<br>
          <strong>${fmtNum(Math.round(mix.actualAvgPerWeek))}</strong> units/wk avg
          · ${mix.ordersConsidered} orders · ${fmtNum(Math.round(mix.totalUnits))} units total
        </div>
        <button class="btn" onclick="bpLoadBaselineAsTarget()" title="Copy the actual-avg baseline into the target input">Use baseline as target</button>
        <label style="display:flex;flex-direction:column;gap:2px">
          <span>Mix window</span>
          <select class="select" onchange="bpHandleWindowChange(this.value)">
            ${BUILD_PLAN_WINDOW_OPTIONS.map(w => `<option value="${w}" ${settings.windowWeeks === w ? "selected" : ""}>Last ${w} wks</option>`).join("")}
          </select>
        </label>
        <div class="grow"></div>
        ${overrideExceedsWarn}
      </div>

      <div class="bp-basis">
        <strong>Basis:</strong> Historical model mix from <em>DB.productionOrders</em>, bucketed by <strong>RELEASED date</strong> (Monday-anchored weeks, same as BOM Usage Weekly). Each FG's implied weekly = <em>target × (share of last ${settings.windowWeeks} weeks' units)</em>. Pinned FGs use their override amount and are excluded from mix scaling; the remainder distributes across unpinned FGs by their normalized shares. Planned daily = <em>implied weekly ÷ ${wpw}</em>. Current daily = <em>chainDisplayDaily(part)</em> — the same rate the Base BOM Queue and Parts Catalog show. <strong>View-only for parts math</strong>: nothing here writes part.daily or triggers a queue re-computation.
        ${emptyBomWarning}
      </div>

      <div class="bp-layout">

        <div class="panel bp-form-panel">
          <div class="panel-head">
            <div class="panel-title">Finished goods · mix + pins</div>
            <div class="panel-sub">${mix.byFg.size} FG${mix.byFg.size === 1 ? "" : "s"} in mix${overrideCount > 0 ? ` · ${overrideCount} pinned` : ""}</div>
          </div>
          <div class="panel-body flush">
            <div style="padding:8px 12px;display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--line);font-size:11px;color:var(--t3)">
              <label class="muted tiny" style="display:flex;gap:6px;align-items:center;cursor:pointer">
                <input type="checkbox" ${BUILD_PLAN_STATE.showZeroMixFgs ? "checked" : ""} onchange="bpToggleShowZeroMixFgs()">
                Show FGs with zero history
              </label>
              <div class="grow" style="flex:1"></div>
              <span class="mono">share · implied · pin</span>
            </div>
            ${formHtml}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Component demand</div>
            <div class="panel-sub">${totalMatched} of ${byPart.size} impacted parts${q ? ` · matching "${esc(q)}"` : ""}${truncated > 0 ? ` · showing top ${shownRows.length}` : ""}${totalWeeklyUnits > 0 ? ` · plan total ${_bpWeeklyFmt(totalWeeklyUnits)} units/wk` : ""}</div>
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
                    ? `<tr><td colspan="6"><div class="empty"><div class="empty-title">${settings.targetPerWeek == null && mix.totalUnits === 0 ? "No production history yet" : "No component demand"}</div><div class="empty-msg">${settings.targetPerWeek == null && mix.totalUnits === 0 ? "The last " + settings.windowWeeks + " weeks contain no production orders. Either the sync hasn't run or the released dates fall outside the window." : "Enter a target above and pin any FGs you want to build at a specific rate. Component demand rolls up here."}</div></div></td></tr>`
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

  // Loaded token for live check — v2 for cache-diagnosis. Set on
  // every render so a stale-cache tab is easy to spot.
  window.BUILD_PLAN_LOADED = "build-plan-v2-loaded";
}

registerRoute("build-plan", renderBuildPlan);
