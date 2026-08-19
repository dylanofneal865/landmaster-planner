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

   ISOLATION CONTRACT:
     Two — and only two — write paths exist in this module:
       1. DB.buildPlanTargets: cloud-scoped helpers in
          js/30-supabase.js (setBuildPlanSettingsCloud /
          setBuildPlanOverrideCloud / clearBuildPlanOverrideCloud /
          clearAllBuildPlanOverridesCloud).
       2. part.daily (+ paired part.rateStep): bpApplyRates() — the
          "Apply plan -> Base BOM rates" modal. Gated by gateEdit();
          scoped strictly to itemType === "base_bom" && !isKit(part);
          single "daily-bulk-edit" audit event; mirrors bbuApplyPaste
          (js/19-page-usage.js). When settings.startDate is in the
          future AND the row is not a zero-out, part.rateStep =
          {prevDaily, effectiveDate} is written alongside the new
          daily so the engine's stepped-rate helpers (dailyOnDate,
          hasActiveRateStep in js/03-calc.js) burn the OLD rate on
          workdays until effectiveDate, then the new rate. Otherwise
          part.rateStep is DELETED (no stale step may linger).
          Nothing else on this tab writes part.daily or
          part.rateStep.
     - NEVER writes to DB.usage, part.onHand, part.status,
       DB.parts[i] fields other than daily + rateStep,
       DB.bomLinks (reassign), or _dirtyParts.
     - Reads only: FINISHED_GOODS, DB.parts (for desc, stored
       daily, chainDisplayDaily), DB.bomLinks (via explodeBOM —
       pure; scanned once per apply-modal-open for duplicated
       parent->child pairs), DB.productionOrders (for mix),
       DB.buildPlanTargets (settings + overrides), DB.settings
       (via effectiveWorkdaysPerWeek).
     - Does NOT call partsWithStatus(), queueParts(), partStatus(),
       or computeDemand(). bumpStatusCache() IS called once at
       the tail of bpApplyRates() (mirroring bbuApplyPaste) so
       the queue picks up the newly-written daily rates.
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
// startDate is an ISO "YYYY-MM-DD" string or null (null = today's
// behavior everywhere: no annotations, no lead-time scheduling).
function _bpSettings() {
  const s = DB.buildPlanTargets && DB.buildPlanTargets.settings;
  return {
    targetPerWeek: s && Number.isFinite(Number(s.targetPerWeek)) ? Number(s.targetPerWeek) : null,
    windowWeeks:   s && BUILD_PLAN_WINDOW_OPTIONS.includes(Number(s.windowWeeks)) ? Number(s.windowWeeks) : 8,
    startDate:     s && typeof s.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.startDate) ? s.startDate : null,
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
    // Pass all three fields so this write doesn't clobber a
    // sibling's value in the sentinel row.
    await setBuildPlanSettingsCloud({ targetPerWeek: rounded, windowWeeks: s.windowWeeks, startDate: s.startDate });
  }
  refresh();
}

async function bpHandleWindowChange(rawValue) {
  const s = _bpSettings();
  const n = Number(rawValue);
  const w = BUILD_PLAN_WINDOW_OPTIONS.includes(n) ? n : 8;
  const target = s.targetPerWeek == null ? 0 : s.targetPerWeek;
  if (typeof setBuildPlanSettingsCloud === "function") {
    await setBuildPlanSettingsCloud({ targetPerWeek: target, windowWeeks: w, startDate: s.startDate });
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
    await setBuildPlanSettingsCloud({ targetPerWeek: baseline, windowWeeks: s.windowWeeks, startDate: s.startDate });
  }
  refresh();
}

// Plan-start-date handler. Blank input → null (no scheduling, no
// annotations). ISO "YYYY-MM-DD" strings only; anything else is
// ignored to keep parseDateLocal happy downstream.
async function bpHandleStartDateChange(rawValue) {
  const s = _bpSettings();
  const trimmed = String(rawValue == null ? "" : rawValue).trim();
  const next = trimmed === "" ? null
    : (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : s.startDate);
  const target = s.targetPerWeek == null ? 0 : s.targetPerWeek;
  if (typeof setBuildPlanSettingsCloud === "function") {
    await setBuildPlanSettingsCloud({ targetPerWeek: target, windowWeeks: s.windowWeeks, startDate: next });
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
  const rounded = Math.round(n * 100) / 100;
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
          <input class="input bp-fg-input mono" type="number" step="any" min="0" inputmode="decimal"
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

  // startDate clause for the basis strip. Reuses the shared
  // _bpApplyStartDateNote helper so basis-strip + modal-header
  // stay phrase-identical. Empty string unless a FUTURE start
  // date is set — matches when Apply actually writes a rateStep.
  const startDateNote = (typeof _bpApplyStartDateNote === "function")
    ? _bpApplyStartDateNote()
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
        <button class="btn" onclick="bpOpenApplyModal()" title="Review and write plan-derived daily rates onto base_bom parts">Apply plan &rarr; Base BOM rates</button>
        <label style="display:flex;flex-direction:column;gap:2px">
          <span>Mix window</span>
          <select class="select" onchange="bpHandleWindowChange(this.value)">
            ${BUILD_PLAN_WINDOW_OPTIONS.map(w => `<option value="${w}" ${settings.windowWeeks === w ? "selected" : ""}>Last ${w} wks</option>`).join("")}
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:2px">
          <span>Plan start</span>
          <input id="bp-start-date" class="input mono" type="date"
                 value="${settings.startDate || ""}"
                 title="Optional. When set, Apply writes a rateStep alongside each new daily rate so projections burn the OLD rate on workdays until this date, then step to the new rate. Blank = immediate change (no step)."
                 onchange="bpHandleStartDateChange(this.value)">
        </label>
        <div class="grow"></div>
        ${overrideExceedsWarn}
      </div>

      <div class="bp-basis">
        <strong>Basis:</strong> Historical model mix from <em>DB.productionOrders</em>, bucketed by <strong>RELEASED date</strong> (Monday-anchored weeks, same as BOM Usage Weekly). Each FG's implied weekly = <em>target × (share of last ${settings.windowWeeks} weeks' units)</em>. Pinned FGs use their override amount and are excluded from mix scaling; the remainder distributes across unpinned FGs by their normalized shares. Planned daily = <em>implied weekly ÷ ${wpw}</em>. Current daily = <em>chainDisplayDaily(part)</em> — the same rate the Base BOM Queue and Parts Catalog show. ${startDateNote ? `<br><strong>Rates ${startDateNote}.</strong> Projections burn the current rate on workdays until then, then switch. ` : ""}<strong>Writes part.daily on base_bom parts ONLY</strong> via the Apply plan &rarr; Base BOM rates modal; nothing else on this tab writes.
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

/* ============================================================
   APPLY PLAN -> BASE BOM RATES

   The ONLY path this module has for writing part.daily.
   Mirrors bbuApplyPaste (js/19-page-usage.js:1129) end-to-end:
   gate once, re-verify eligibility per part at write time,
   skip near-zero diffs, single "daily-bulk-edit" audit event,
   saveDB + bumpStatusCache + closeModal + toast + refresh.

   Eligibility (STRICT):
     part.itemType === "base_bom" && !isKit(part)

   Candidates (union of two sources):
     1. byPart entries whose catalog part passes eligibility.
     2. Every eligible catalog part with stored daily > 0 that
        is absent from byPart, or has plannedDaily == 0 in
        byPart -> ZERO-OUT rows. This is deliberate: without
        them, stale rates for parts the current plan no longer
        touches would silently survive the apply.

   CURRENT per row = Number(part.daily) || 0 — the STORED value
   being overwritten. Deliberately NOT chainDisplayDaily (which
   the grid displays); the apply diff must show what we are
   actually replacing on disk.

   Dup-guard: DB.bomLinks is scanned once per modal open for
   parent->child pairs occurring more than once. Any candidate
   whose pn is a child in such a pair is FORCED into the outlier
   bucket, default-unchecked, tagged "dup BOM" — regardless of
   delta magnitude — because their plannedWeekly may be inflated
   by the duplicate link. Guard is read-only; bomLinks is never
   mutated.
   ============================================================ */

// supplierExclude holds SUPPLIER KEYS (see _bpApplySupplierKey)
// that the user has unchecked in the filter dropdown. Empty Set
// == no filter == show everything. Filtering NEVER mutates
// _bpApply.touched — re-including a supplier restores each row's
// prior checkbox state from touched (or bucket default).
let _bpApply = { thresholdPct: 35, touched: new Map(), sortKey: "deltaAbs", sortDir: "desc", lastClicked: {}, supplierExclude: new Set() };

function _bpApplyReset() {
  _bpApply = { thresholdPct: 35, touched: new Map(), sortKey: "deltaAbs", sortDir: "desc", lastClicked: {}, supplierExclude: new Set() };
}

function _bpApplyDupChildren() {
  const seen = new Map();
  const links = (typeof DB !== "undefined" && Array.isArray(DB.bomLinks)) ? DB.bomLinks : [];
  for (const l of links) {
    if (!l || !l.parent || !l.child) continue;
    const k = l.parent + "||" + l.child;
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  const dupChildren = new Set();
  const dupParents = new Set();
  let pairCount = 0;
  for (const [k, n] of seen.entries()) {
    if (n > 1) {
      const idx = k.indexOf("||");
      dupParents.add(k.slice(0, idx));
      dupChildren.add(k.slice(idx + 2));
      pairCount++;
    }
  }
  return { dupChildren, dupParents, pairCount };
}

function _bpApplyBuildRows() {
  const demand = computeBuildPlanDemand();
  const byPart = demand.byPart;
  const dup = _bpApplyDupChildren();
  const partsByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  const rows = [];
  const seenPns = new Set();

  for (const [pn, rec] of byPart.entries()) {
    const p = partsByPn.get(pn);
    if (!p) continue;
    if (p.itemType !== "base_bom" || isKit(p)) continue;
    // CURRENT is the STORED daily, not chainDisplayDaily. The
    // grid displays chain rate for context; the apply diff must
    // show the value that is actually about to be overwritten.
    const current = Number(p.daily) || 0;
    const newDaily = Math.round((Number(rec.plannedDaily) || 0) * 1000) / 1000;
    const deltaAbs = newDaily - current;
    const deltaPct = current > 0 ? deltaAbs / current : (newDaily > 0 ? Infinity : 0);
    rows.push({
      pn,
      desc: p.desc || "",
      supplier: String(p.supplier || "").trim(),
      current,
      newDaily,
      deltaAbs,
      deltaPct,
      dup: dup.dupChildren.has(pn),
      zeroOut: newDaily === 0 && current > 0,
    });
    seenPns.add(pn);
  }

  for (const p of (DB.parts || [])) {
    if (!p || !p.pn) continue;
    if (p.itemType !== "base_bom" || isKit(p)) continue;
    if (seenPns.has(p.pn)) continue;
    const current = Number(p.daily) || 0;
    if (current <= 0) continue;
    const newDaily = 0;
    const deltaAbs = newDaily - current;
    rows.push({
      pn: p.pn,
      desc: p.desc || "",
      supplier: String(p.supplier || "").trim(),
      current,
      newDaily,
      deltaAbs,
      deltaPct: -1,
      dup: dup.dupChildren.has(p.pn),
      zeroOut: true,
    });
  }

  return { rows, dup };
}

// Bucket rows into auto / outlier / unchanged. Time-phased rollout
// is handled by the engine's stepped-rate helpers (dailyOnDate,
// hasActiveRateStep in js/03-calc.js) — applying every part
// immediately with a paired rateStep is correct for all lead times,
// because projections walk the switch on the effectiveDate. So this
// module applies every candidate together in one pass and the
// engine handles the timing; no per-row deferral logic lives here.
function _bpApplyBucketRows(rows, thresholdPct) {
  const auto = [], outlier = [], unchanged = [];
  for (const r of rows) {
    if (Math.abs(r.deltaAbs) < 0.0001) { unchanged.push(r); continue; }
    const isOutlier = r.dup
      || r.current === 0
      || r.newDaily === 0
      || (Math.abs(r.deltaPct) * 100) >= thresholdPct;
    if (isOutlier) outlier.push(r);
    else auto.push(r);
  }
  // Row order is applied downstream inside the renderer via
  // _bpApplyCompare so that sorting reflects the current
  // _bpApply.sortKey / sortDir. Bucketing itself stays stable.
  return { auto, outlier, unchanged };
}

// Comparator for the apply-modal row tables. Deliberately treats
// Δ (deltaAbs) as SIGNED when clicked directly, while the default
// sort ("deltaAbs" magnitude) sits above it so first-open users
// see biggest-changes-first regardless of sign. Δ% honors +/-Inf
// as extremes so a −100% zero-out lands at one end and a fresh
// non-zero plan (current 0 → new >0) lands at the other.
function _bpApplyCompare(a, b, key) {
  switch (key) {
    case "pn":       return String(a.pn).localeCompare(String(b.pn));
    case "current":  return (a.current  || 0) - (b.current  || 0);
    case "newDaily": return (a.newDaily || 0) - (b.newDaily || 0);
    case "delta":    return a.deltaAbs - b.deltaAbs;
    case "deltaPct": {
      const ap = a.deltaPct, bp = b.deltaPct;
      if (ap === bp) return 0;
      if (ap === Infinity)  return  1;
      if (bp === Infinity)  return -1;
      if (ap === -Infinity) return -1;
      if (bp === -Infinity) return  1;
      return ap - bp;
    }
    case "deltaAbs":
    default:         return Math.abs(a.deltaAbs) - Math.abs(b.deltaAbs);
  }
}

function bpApplySetSort(key) {
  if (_bpApply.sortKey === key) {
    _bpApply.sortDir = _bpApply.sortDir === "asc" ? "desc" : "asc";
  } else {
    _bpApply.sortKey = key;
    _bpApply.sortDir = "desc";
  }
  _bpApplyRerender();
}

function _bpApplyIsChecked(r, bucket) {
  const t = _bpApply.touched.get(r.pn);
  if (typeof t === "boolean") return t;
  // Defaults: AUTO checked, OUTLIER unchecked.
  return bucket === "auto";
}

function _bpApplyCurrentCheckedCount(buckets) {
  let n = 0;
  for (const b of ["auto", "outlier"]) {
    for (const r of (buckets[b] || [])) if (_bpApplyIsChecked(r, b)) n++;
  }
  return n;
}

// Sentinel key for rows whose part.supplier is empty/whitespace.
// Kept as a stable string so it round-trips through the filter
// dropdown's dataset attributes without special-casing.
const _BP_NO_SUPPLIER_KEY = "(no supplier)";

function _bpApplySupplierKey(r) {
  return r.supplier ? r.supplier : _BP_NO_SUPPLIER_KEY;
}

function _bpApplyIsRowVisible(r) {
  return !_bpApply.supplierExclude.has(_bpApplySupplierKey(r));
}

// Distinct supplier keys across the CURRENT candidate rows
// (outlier + auto only — unchanged rows never render, so they'd
// only pad the option list without giving the user anything to
// act on). Row counts come from the unfiltered buckets so the
// user always sees the full population per supplier and can toggle
// hidden ones back in without losing the count context.
function _bpApplySupplierOptions(buckets) {
  const counts = new Map();
  const feed = [...buckets.outlier, ...buckets.auto];
  for (const r of feed) {
    const k = _bpApplySupplierKey(r);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, count]) => ({ key, count }));
}

function _bpApplyRenderSupplierFilter(supplierOptions) {
  const total = supplierOptions.length;
  const excluded = supplierOptions.filter(o => _bpApply.supplierExclude.has(o.key)).length;
  const included = total - excluded;
  const label = excluded === 0
    ? `Suppliers: <strong>all ${total}</strong>`
    : `Suppliers: <strong>${included}</strong> of ${total} <span class="pill warn tiny" style="margin-left:4px">${excluded} hidden</span>`;
  if (total === 0) {
    return `<span class="muted tiny">No suppliers</span>`;
  }
  const items = supplierOptions.map(o => {
    const isChecked = !_bpApply.supplierExclude.has(o.key);
    return `<label style="display:flex;gap:6px;align-items:center;padding:3px 6px;cursor:pointer;font-size:12px;border-radius:3px" onmouseover="this.style.background='var(--bg-hover, rgba(255,255,255,0.04))'" onmouseout="this.style.background='transparent'">
        <input type="checkbox" ${isChecked ? "checked" : ""} data-supplier="${esc(o.key)}" onclick="bpApplyToggleSupplier(this.dataset.supplier, this.checked)">
        <span class="mono" style="flex:1">${esc(o.key)}</span>
        <span class="muted tiny">${o.count}</span>
      </label>`;
  }).join("");
  return `
    <details id="bp-supplier-filter" class="bp-supplier-filter" style="position:relative">
      <summary style="cursor:pointer;padding:4px 10px;border:1px solid var(--line);border-radius:4px;background:var(--bg);font-size:12px;user-select:none;display:inline-block">${label}</summary>
      <div style="position:absolute;top:calc(100% + 4px);left:0;z-index:100;background:var(--bg-1);border:1px solid var(--line);border-radius:6px;padding:6px;max-height:280px;overflow-y:auto;min-width:240px;box-shadow:0 4px 12px rgba(0,0,0,0.3)">
        <div style="display:flex;gap:6px;padding:4px 6px;border-bottom:1px solid var(--line-soft);margin-bottom:4px">
          <button class="btn tiny" onclick="bpApplySelectAllSuppliers(true)">Include all</button>
          <button class="btn tiny" onclick="bpApplySelectAllSuppliers(false)">Exclude all</button>
        </div>
        ${items}
      </div>
    </details>`;
}

function _bpApplyRenderBody() {
  const snap = _bpApplyBucketsAndSort();
  const { buckets, filteredBuckets, filteredSortedByBucket, dup, supplierOptions } = snap;

  // Header counts reflect the FILTERED view so the numbers next
  // to the tables match what's actually rendered.
  const zeroOutCount = filteredBuckets.outlier.filter(r => r.zeroOut).length
    + filteredBuckets.auto.filter(r => r.zeroOut).length;
  const totalCandidates = buckets.outlier.length + buckets.auto.length;
  const visibleCandidates = filteredBuckets.outlier.length + filteredBuckets.auto.length;
  const rowsHidden = totalCandidates - visibleCandidates;
  const excludedCount = _bpApply.supplierExclude.size;
  const hiddenIndication = excludedCount > 0
    ? ` &middot; <em class="text-warn">${excludedCount} supplier${excludedCount === 1 ? "" : "s"} hidden (${rowsHidden} row${rowsHidden === 1 ? "" : "s"})</em>`
    : "";

  const dupParentList = [...dup.dupParents];
  const dupBanner = dup.pairCount > 0
    ? `<div style="padding:8px 10px;margin-bottom:10px;border-radius:6px;background:rgba(255,181,71,0.14);border:1px solid rgba(255,181,71,0.35);color:var(--t1);font-size:12px">
         <strong>BOM data warning:</strong> ${dup.pairCount} duplicated parent&rarr;child pair${dup.pairCount === 1 ? "" : "s"}
         (parents: <span class="mono">${esc(dupParentList.slice(0, 6).join(", "))}${dupParentList.length > 6 ? ` +${dupParentList.length - 6} more` : ""}</span>)
         &mdash; planned rates under these may be inflated.
       </div>`
    : "";

  const sortKey = _bpApply.sortKey;
  const sortDir = _bpApply.sortDir === "asc" ? 1 : -1;
  const arrow = (k) => sortKey === k ? (sortDir === 1 ? " &#9650;" : " &#9660;") : "";

  // NEW /D header gains a "(steps <M/D>)" suffix when a future
  // Plan-start date is set. One string change — no new column,
  // because Apply writes a paired rateStep and the engine handles
  // the actual timing.
  const settings = _bpSettings();
  const effDt = (settings.startDate && typeof parseDateLocal === "function")
    ? parseDateLocal(settings.startDate)
    : null;
  const _today0 = new Date(); _today0.setHours(0, 0, 0, 0);
  const effIsFuture = !!(effDt && effDt.getTime() > _today0.getTime());
  const stepsSuffix = effIsFuture
    ? ` <span class="muted tiny">(steps ${effDt.getMonth() + 1}/${effDt.getDate()})</span>`
    : "";

  // renderTable receives an already-sorted, already-filtered list.
  // Sorting/filtering are hoisted into _bpApplyBucketsAndSort so
  // that all consumers (render, count, apply, range) share exactly
  // the same view.
  const renderTable = (list, bucket) => {
    if (!list.length) return `<div class="muted tiny" style="padding:10px">No rows.</div>`;
    // Bulk buttons scope to "visible" — the filtered rows in the
    // current sort order. Supplier-hidden rows are excluded from
    // this action, matching Apply semantics.
    const bulk = `<div style="display:flex;gap:8px;margin:6px 0">
           <button class="btn tiny" onclick="bpApplyBulkToggle('${bucket}', true)">Check visible</button>
           <button class="btn tiny" onclick="bpApplyBulkToggle('${bucket}', false)">Uncheck visible</button>
           <span class="muted tiny" style="align-self:center">Tip: Shift+click a row to toggle the range from the last click.</span>
         </div>`;
    const body = list.map(r => {
      // Checkbox state comes from _bpApply.touched (via
      // _bpApplyIsChecked), NOT from the DOM — so re-sort/re-
      // render/re-filter never loses a user's toggles.
      const checked = _bpApplyIsChecked(r, bucket);
      const deltaPctTxt = r.deltaPct === Infinity ? "&infin;"
        : (r.deltaPct * 100).toLocaleString(undefined, { maximumFractionDigits: 1 }) + "%";
      const deltaCls = r.deltaAbs > 0 ? "text-warn" : (r.deltaAbs < 0 ? "muted" : "dim");
      const tags = [];
      if (r.dup) tags.push(`<span class="pill warn tiny">dup BOM</span>`);
      if (r.zeroOut) tags.push(`<span class="pill muted tiny">zero-out</span>`);
      // onclick (not onchange) so the event object is available
      // for shiftKey detection in bpApplyToggle. data-pn lets
      // targeted DOM patches find the checkbox without re-
      // rendering the whole table.
      return `<tr>
        <td><input type="checkbox" ${checked ? "checked" : ""} data-pn="${esc(r.pn)}" data-bucket="${bucket}" onclick="bpApplyToggle('${esc(r.pn)}', this.checked, event)"></td>
        <td class="pn mono">${esc(r.pn)}</td>
        <td class="muted tiny">${esc((r.desc || "").slice(0, 42))}</td>
        <td class="right num mono">${_buwDailyFmt(r.current)}/d</td>
        <td class="right num mono bold">${_buwDailyFmt(r.newDaily)}/d</td>
        <td class="right num mono ${deltaCls}">${r.deltaAbs > 0 ? "+" : ""}${_buwDailyFmt(r.deltaAbs)}</td>
        <td class="right num mono ${deltaCls}">${deltaPctTxt}</td>
        <td>${tags.join(" ")}</td>
      </tr>`;
    }).join("");
    return `${bulk}
      <div id="bp-apply-${bucket}-wrap" class="tbl-wrap" style="max-height:340px;overflow:auto">
        <table class="tbl">
          <thead><tr>
            <th></th>
            <th class="clickable sortable" onclick="bpApplySetSort('pn')">PN${arrow("pn")}</th>
            <th>Desc</th>
            <th class="right clickable sortable" onclick="bpApplySetSort('current')">Current /d${arrow("current")}</th>
            <th class="right clickable sortable" onclick="bpApplySetSort('newDaily')">New /d${stepsSuffix}${arrow("newDaily")}</th>
            <th class="right clickable sortable" onclick="bpApplySetSort('delta')">&Delta;${arrow("delta")}</th>
            <th class="right clickable sortable" onclick="bpApplySetSort('deltaPct')">&Delta;%${arrow("deltaPct")}</th>
            <th>Tag</th>
          </tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  };

  const outliersHtml = renderTable(filteredSortedByBucket.outlier, "outlier");
  const autoHtml = renderTable(filteredSortedByBucket.auto, "auto");
  const supplierFilterHtml = _bpApplyRenderSupplierFilter(supplierOptions);

  return `
    <style>
      .bp-supplier-filter > summary { list-style:none; }
      .bp-supplier-filter > summary::-webkit-details-marker { display:none; }
    </style>
    ${dupBanner}
    <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:10px;font-size:12px;color:var(--t2)">
      <label>Threshold %
        <input type="number" step="1" min="0" value="${_bpApply.thresholdPct}"
               style="width:70px;margin-left:6px" class="input mono"
               onchange="bpApplySetThreshold(this.value)">
      </label>
      ${supplierFilterHtml}
      <span class="muted tiny">
        <strong>${filteredBuckets.auto.length}</strong> auto &middot;
        <strong>${filteredBuckets.outlier.length}</strong> outliers &middot;
        <strong>${filteredBuckets.unchanged.length}</strong> unchanged &middot;
        <strong>${zeroOutCount}</strong> zero-outs${hiddenIndication}
      </span>
    </div>
    <div style="margin-bottom:14px">
      <div style="font-weight:600;margin-bottom:4px">Outliers (${filteredBuckets.outlier.length}) &mdash; review before applying</div>
      ${outliersHtml}
    </div>
    <details>
      <summary style="cursor:pointer;font-weight:600">Auto (${filteredBuckets.auto.length}) &mdash; within &plusmn;${_bpApply.thresholdPct}%, default checked</summary>
      <div style="margin-top:8px">${autoHtml}</div>
    </details>
  `;
}

// Human-readable startDate annotation, used in the basis strip and
// the Apply-modal header. Returns the CLAUSE ("steps to N/wk on
// M/D") only when a future startDate is set — this now describes
// real engine behavior: Apply writes part.rateStep so projections
// burn the OLD rate on workdays until effectiveDate, then step to
// the new rate. Empty string for null / today / past (no rateStep
// is written in those cases). Callers wrap: basis strip → "Rates
// {note}."; modal header → "&middot; {note}".
function _bpApplyStartDateNote() {
  const s = _bpSettings();
  if (!s.startDate || typeof parseDateLocal !== "function") return "";
  const dt = parseDateLocal(s.startDate);
  if (!dt) return "";
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (dt.getTime() <= today.getTime()) return "";
  const md = `${dt.getMonth() + 1}/${dt.getDate()}`;
  const target = s.targetPerWeek == null ? 0 : s.targetPerWeek;
  return `steps to ${fmtNum(target)}/wk on ${md}`;
}

// Capture/restore each table's scrollTop across a body re-render.
// Threshold + sort + bulk-visible all go through _bpApplyRerender,
// which replaces innerHTML and rebuilds both wraps from scratch.
// Without capture+restore the user is thrown back to the top of
// both tables. Single-row checkbox toggles avoid this entirely by
// patching counts/button only (bpApplyToggle) — no re-render.
function _bpApplyCaptureScrollTops() {
  const tops = {};
  const outWrap = document.getElementById("bp-apply-outlier-wrap");
  const autoWrap = document.getElementById("bp-apply-auto-wrap");
  if (outWrap) tops.outlier = outWrap.scrollTop;
  if (autoWrap) tops.auto = autoWrap.scrollTop;
  return tops;
}

function _bpApplyRestoreScrollTops(tops) {
  if (!tops) return;
  const outWrap = document.getElementById("bp-apply-outlier-wrap");
  const autoWrap = document.getElementById("bp-apply-auto-wrap");
  if (outWrap && tops.outlier != null) outWrap.scrollTop = tops.outlier;
  if (autoWrap && tops.auto != null) autoWrap.scrollTop = tops.auto;
}

// Single snapshot of buckets + per-bucket sort order + filter view.
// Callers that need to know the current visible order of a bucket
// (shift-range, bulk-visible, bucket lookup by pn, apply, count)
// share this instead of re-running _bpApplyBuildRows() N times
// per handler. filteredBuckets / filteredSortedByBucket honor the
// current supplierExclude Set; buckets / sortedByBucket ignore it
// so the supplier options list has the full population to draw
// from.
function _bpApplyBucketsAndSort() {
  const built = _bpApplyBuildRows();
  const rows = built.rows;
  const dup = built.dup;
  const buckets = _bpApplyBucketRows(rows, _bpApply.thresholdPct);
  const sortDir = _bpApply.sortDir === "asc" ? 1 : -1;
  const cmp = (a, b) => _bpApplyCompare(a, b, _bpApply.sortKey) * sortDir;
  const sortedByBucket = {
    outlier: buckets.outlier.slice().sort(cmp),
    auto:    buckets.auto.slice().sort(cmp),
  };
  const filteredBuckets = {
    outlier:   buckets.outlier.filter(_bpApplyIsRowVisible),
    auto:      buckets.auto.filter(_bpApplyIsRowVisible),
    unchanged: buckets.unchanged.filter(_bpApplyIsRowVisible),
  };
  const filteredSortedByBucket = {
    outlier: sortedByBucket.outlier.filter(_bpApplyIsRowVisible),
    auto:    sortedByBucket.auto.filter(_bpApplyIsRowVisible),
  };
  const supplierOptions = _bpApplySupplierOptions(buckets);
  return { buckets, sortedByBucket, filteredBuckets, filteredSortedByBucket, dup, supplierOptions };
}

function _bpApplyBucketOf(pn, sortedByBucket) {
  if (sortedByBucket.outlier.some(r => r.pn === pn)) return "outlier";
  if (sortedByBucket.auto.some(r => r.pn === pn)) return "auto";
  return null;
}

// Patch the "Apply N rates" button label + disabled state in place.
// Called on every user action that changes _bpApply.touched or the
// supplier filter. Counts only VISIBLE checked rows — filtered-out
// suppliers are excluded from Apply per spec. Pass a snap when you
// already have one to avoid recomputing.
function _bpApplyPatchCounts(snap) {
  const btn = document.getElementById("bp-apply-btn");
  if (!btn) return;
  if (!snap) snap = _bpApplyBucketsAndSort();
  const n = _bpApplyCurrentCheckedCount(snap.filteredBuckets);
  btn.textContent = `Apply ${n} rate${n === 1 ? "" : "s"}`;
  btn.disabled = n === 0;
}

function _bpApplyUpdateCheckboxDom(pns, checked) {
  const set = new Set(pns);
  const bodyEl = document.getElementById("bp-apply-body");
  if (!bodyEl) return;
  const boxes = bodyEl.querySelectorAll('input[type=checkbox][data-pn]');
  for (const box of boxes) {
    if (set.has(box.getAttribute("data-pn"))) box.checked = !!checked;
  }
}

// Preserve the supplier-filter dropdown's open state across a body
// re-render — without this, toggling any option collapses the
// dropdown mid-click and forces the user to re-open it every time.
function _bpApplyCaptureFilterOpen() {
  const el = document.getElementById("bp-supplier-filter");
  return el ? !!el.open : false;
}

function _bpApplyRestoreFilterOpen(wasOpen) {
  const el = document.getElementById("bp-supplier-filter");
  if (el) el.open = !!wasOpen;
}

function _bpApplyRerender() {
  const tops = _bpApplyCaptureScrollTops();
  const filterOpen = _bpApplyCaptureFilterOpen();
  const bodyEl = document.getElementById("bp-apply-body");
  if (bodyEl) bodyEl.innerHTML = _bpApplyRenderBody();
  _bpApplyRestoreScrollTops(tops);
  _bpApplyRestoreFilterOpen(filterOpen);
  _bpApplyPatchCounts();
}

function bpApplySetThreshold(v) {
  const n = parseFloat(v);
  _bpApply.thresholdPct = (isFinite(n) && n >= 0) ? n : 35;
  _bpApplyRerender();
}

function bpApplyToggleSupplier(key, checked) {
  // Filter mutation NEVER touches _bpApply.touched — re-including
  // a supplier restores each row's prior checkbox state from
  // touched (or bucket default) automatically.
  if (checked) _bpApply.supplierExclude.delete(key);
  else _bpApply.supplierExclude.add(key);
  _bpApplyRerender();
}

function bpApplySelectAllSuppliers(includeAll) {
  if (includeAll) {
    _bpApply.supplierExclude.clear();
  } else {
    const snap = _bpApplyBucketsAndSort();
    for (const o of snap.supplierOptions) _bpApply.supplierExclude.add(o.key);
  }
  _bpApplyRerender();
}

function bpApplyToggle(pn, checked, ev) {
  // Shift-click: apply the clicked checkbox's new state to every
  // row between it and the last-clicked checkbox in the same
  // bucket (email-client range select).
  if (ev && ev.shiftKey) {
    _bpApplyRangeToggle(pn, checked);
    return;
  }
  _bpApply.touched.set(pn, !!checked);
  const snap = _bpApplyBucketsAndSort();
  const bucket = _bpApplyBucketOf(pn, snap.filteredSortedByBucket);
  if (bucket) _bpApply.lastClicked[bucket] = pn;
  // No body re-render — the clicked checkbox is already toggled
  // by the native click; the only stale UI is the button's count.
  _bpApplyPatchCounts(snap);
}

function _bpApplyRangeToggle(pn, newState) {
  const snap = _bpApplyBucketsAndSort();
  const bucket = _bpApplyBucketOf(pn, snap.filteredSortedByBucket);
  if (!bucket) {
    _bpApply.touched.set(pn, !!newState);
    _bpApplyPatchCounts(snap);
    return;
  }
  // Range operates on the FILTERED sort order — supplier-hidden
  // rows are not in the DOM and shouldn't be swept up by a range
  // that crosses them.
  const list = snap.filteredSortedByBucket[bucket];
  const iNow = list.findIndex(r => r.pn === pn);
  const last = _bpApply.lastClicked[bucket];
  const iLast = last ? list.findIndex(r => r.pn === last) : -1;
  let affected;
  if (iLast < 0 || iNow < 0) {
    // No prior anchor in this bucket (or anchor now filtered out):
    // fall back to a single-row toggle so the click isn't lost.
    affected = [pn];
  } else {
    const [lo, hi] = iNow < iLast ? [iNow, iLast] : [iLast, iNow];
    affected = list.slice(lo, hi + 1).map(r => r.pn);
  }
  for (const p of affected) _bpApply.touched.set(p, !!newState);
  _bpApply.lastClicked[bucket] = pn;
  _bpApplyUpdateCheckboxDom(affected, newState);
  _bpApplyPatchCounts(snap);
}

function bpApplyBulkToggle(bucket, checked) {
  const snap = _bpApplyBucketsAndSort();
  // Iterate FILTERED sort order — "visible" means rendered, which
  // excludes supplier-hidden rows per spec.
  const list = snap.filteredSortedByBucket[bucket] || [];
  for (const r of list) _bpApply.touched.set(r.pn, !!checked);
  _bpApplyRerender();
}

function bpOpenApplyModal() {
  _bpApplyReset();
  const settings = _bpSettings();
  const wpw = (typeof effectiveWorkdaysPerWeek === "function") ? effectiveWorkdaysPerWeek() : 5;
  const target = settings.targetPerWeek != null ? settings.targetPerWeek : 0;
  // supplierExclude is empty right after reset, so filteredBuckets
  // == buckets on open — initialN is the same either way.
  const snap = _bpApplyBucketsAndSort();
  const initialN = _bpApplyCurrentCheckedCount(snap.filteredBuckets);
  const startNote = _bpApplyStartDateNote();
  openModal(`
    <div class="modal-head">
      <div class="head-sm">Apply plan &rarr; Base BOM rates</div>
      <div class="muted tiny mt-xs">
        Target <strong>${fmtNum(target)}</strong>/wk &middot; mix <strong>${settings.windowWeeks}</strong> wks &middot; <strong>${wpw}</strong> workdays/wk${startNote ? ` &middot; <em>${startNote}</em>` : ""}.
        Writes part.daily${startNote ? " + paired part.rateStep" : ""} on eligible base_bom parts only.
      </div>
    </div>
    <div class="modal-body">
      <div id="bp-apply-body">${_bpApplyRenderBody()}</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button id="bp-apply-btn" class="btn primary" onclick="bpApplyRates()" ${initialN === 0 ? "disabled" : ""}>Apply ${initialN} rate${initialN === 1 ? "" : "s"}</button>
    </div>
  `);
}

function bpApplyRates() {
  // Mirror of bbuApplyPaste (js/19-page-usage.js:1129):
  //   gate once, re-verify eligibility per write, skip near-zero
  //   diffs, single audit event, saveDB + bumpStatusCache +
  //   closeModal + toast + refresh.
  //
  // Time-phased rollout: when settings.startDate is a FUTURE date
  // AND the row is not a zero-out, part.rateStep is written
  // alongside part.daily so the engine's stepped-rate helpers
  // (dailyOnDate / hasActiveRateStep in js/03-calc.js) burn the
  // OLD rate on workdays until effectiveDate, then step to the
  // new rate. LAST-APPLY-WINS: if the part already carries a
  // rateStep from a prior apply and gets re-applied before its
  // date, the new rateStep.prevDaily is the part's THEN-CURRENT
  // stored daily (i.e. the old rateStep's newDaily value we wrote
  // last time) — the previous prevDaily is discarded, because
  // "the rate I want to burn until eff" is whatever is stored
  // right now. If eff is null/today/past OR the row is a zero-
  // out, part.rateStep is DELETED so no stale step lingers.
  if (!gateEdit()) return;
  // Filtered buckets ONLY — supplier-hidden rows are excluded from
  // Apply per spec, regardless of their touched/checked state.
  const snap = _bpApplyBucketsAndSort();
  const settings = _bpSettings();
  const target = settings.targetPerWeek != null ? settings.targetPerWeek : 0;
  const partsByPn = new Map((DB.parts || []).map(p => [p.pn, p]));

  // Resolve the effective date once. eff is a Date at local
  // midnight or null. today0 is local midnight today.
  const today0 = new Date(); today0.setHours(0, 0, 0, 0);
  const eff = (settings.startDate && typeof parseDateLocal === "function")
    ? parseDateLocal(settings.startDate)
    : null;
  const effIsFuture = !!(eff && eff.getTime() > today0.getTime());

  let updated = 0, outliersApproved = 0, skipped = 0;
  let rateStepsWritten = 0, rateStepsCleared = 0;
  const unchangedCounted = snap.filteredBuckets.unchanged.length;

  const applyOne = (r, bucket) => {
    if (!_bpApplyIsChecked(r, bucket)) return;
    const part = partsByPn.get(r.pn);
    if (!part || part.itemType !== "base_bom" || isKit(part)) { skipped++; return; }
    const prev = Number(part.daily) || 0;
    const newDaily = r.newDaily;
    if (Math.abs(newDaily - prev) < 0.0001) {
      // No real change — no daily write; clear any stale rateStep
      // (defensive; a no-op if none was set).
      if (part.rateStep) { delete part.rateStep; rateStepsCleared++; }
      return;
    }
    part.daily = newDaily;
    if (effIsFuture && !r.zeroOut) {
      // Future step: keep burning `prev` on workdays until eff.
      part.rateStep = { prevDaily: prev, effectiveDate: settings.startDate };
      rateStepsWritten++;
    } else {
      // Immediate change (null/today/past eff) OR zero-out row.
      // Zero-out is exempt from stepping because a dead rate is
      // dead regardless of date — the engine must switch it now.
      if (part.rateStep) { delete part.rateStep; rateStepsCleared++; }
    }
    updated++;
    if (bucket === "outlier") outliersApproved++;
  };
  for (const r of snap.filteredBuckets.auto) applyOne(r, "auto");
  for (const r of snap.filteredBuckets.outlier) applyOne(r, "outlier");

  const supplierExcludeCount = _bpApply.supplierExclude.size;
  const filterTail = supplierExcludeCount > 0 ? `, ${supplierExcludeCount} supplier${supplierExcludeCount === 1 ? "" : "s"} filtered out` : "";
  const startDateTail = settings.startDate ? `, effective ${settings.startDate}` : "";
  const stepsTail = (rateStepsWritten || rateStepsCleared)
    ? `, ${rateStepsWritten} rateStep${rateStepsWritten === 1 ? "" : "s"} written, ${rateStepsCleared} cleared`
    : "";
  const auditDetail = { target, windowWeeks: settings.windowWeeks, thresholdPct: _bpApply.thresholdPct, supplierExcludeCount, supplierExclude: [..._bpApply.supplierExclude], rateStepsWritten, rateStepsCleared };
  if (settings.startDate) auditDetail.startDate = settings.startDate;
  logAudit(
    "daily-bulk-edit",
    `Build Plan apply @ ${target}/wk (${settings.windowWeeks}w, thr ${_bpApply.thresholdPct}%): ${updated} updated (${outliersApproved} outliers approved), ${unchangedCounted} unchanged, ${skipped} skipped${filterTail}${startDateTail}${stepsTail}`,
    auditDetail
  );
  saveDB();
  bumpStatusCache();
  closeModal();
  const tail = [];
  if (unchangedCounted) tail.push(`${unchangedCounted} unchanged`);
  if (skipped) tail.push(`${skipped} skipped`);
  showToast(
    `Applied ${updated} rate${updated === 1 ? "" : "s"} (${outliersApproved} outlier${outliersApproved === 1 ? "" : "s"})${tail.length ? " · " + tail.join(" · ") : ""}`,
    updated > 0 ? "ok" : "warn"
  );
  refresh();
}
