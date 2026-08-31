/* =====================================================
   25-page-frame-schedule.js — v2: auto-generating run schedule.

   Sections: CONSTANTS, STATE, DATA UTILS, SLOTS, SIMULATOR,
             PERSIST HELPERS, RENDER, EDIT HANDLERS

   Frame Schedule — 14-week grid with 2-week Monday-aligned run
   slots. The line runs ONE frame per slot at its pool's cap
   for each week of the slot; STD frames can drop in on CREW/HD
   slots when there's spare capacity (stdCap > crewhdCap). Slots
   whose start Monday is within 42 calendar days of TODAY are
   LOCKED (persist forever; never regenerate); slots further out
   are PROPOSED (regenerated on every render). When a proposed
   slot's start crosses the 42-day line, it freezes: persist it
   and stop regenerating.

   v3.4 LOCK SEMANTICS — Locks fix the FRAME, not the numbers.
   A locked slot pins pn (and pn2 on a split) forever. Weekly
   QUANTITIES for every week from NEXT Monday onward are always
   recomputed from the current global caps — regardless of lock
   state. Only the CURRENT week keeps its persisted qty
   (already committed / in progress). Past weeks render persisted
   only. Cap edits therefore flow forward across locked slots:
   the cap handler re-persists every locked future week's qty
   (same pn/pn2, new numbers) after the settings write.

   ISOLATION CONTRACT (mandatory):
     - READ-ONLY against all shared stores.
     - Reads DB.parts fields (onHand, daily, desc) for the six
       hardcoded frame PNs. Reads DB.pos lines (via parseDateLocal
       for tz-safe week bucketing) for the info-only inbound-PO
       annotation in the warning row and the _fsDebugSim inbound
       table — POs are NOT credited into the sim itself; the
       schedule is the supply plan and the operator orders extra
       as needed. Never writes part fields, POs, statuses,
       queues, drafts, or any other shared store.
     - Never calls the status pipeline
       (partsWithStatus / queueParts / partStatus / computeDemand /
       bumpStatusCache).
     - Only cloud writes go to public.frame_schedule via
       setFrameScheduleWeekCloud (js/30-supabase.js). The row
       payload is {caps, qty, slot} — slot present only on the
       slot-START week.
     - Deleting this file must leave every other tab byte-identical.
   ===================================================== */

/* ============================================================
   CONSTANTS
   ============================================================ */

const FRAME_PNS = ["UT101001", "UT101002", "UT101003", "UT101004", "UT101005", "UT101006"];
const FRAME_POOL = {
  "UT101001": "std",
  "UT101002": "crewhd",
  "UT101003": "crewhd",
  "UT101004": "std",
  "UT101005": "crewhd",
  "UT101006": "crewhd",
};
// User-facing short names — internal keys stay in FRAME_PNS/FRAME_POOL.
const FRAME_SHORT = {
  "UT101001": "GAS STD",
  "UT101002": "GAS CREW",
  "UT101003": "GAS HD",
  "UT101004": "AMP STD",
  "UT101005": "AMP CREW",
  "UT101006": "AMP HD",
};
// Pool display label — never render the raw "crewhd" key user-
// facing; use this helper. STD stays as-is, "crewhd" → "CREW/HD".
function _fsPoolLabel(pool) {
  if (pool === "crewhd") return "CREW/HD";
  if (pool === "std") return "STD";
  return "";
}

// Seed reality: GAS CREW (UT101002) is mid-run through Sun Sep 6
// 2026; the first generated slot starts Mon Sep 7 2026. Every
// slot is 2 Monday-anchored weeks. Slots aligned before this
// anchor (past) are seeded to UT101002 to model the current run.
const SLOT_ANCHOR_ISO = "2026-09-07";
const SEED_PRE_ANCHOR_PN = "UT101002";

// Slots whose start Monday is within LOCK_HORIZON_DAYS calendar
// days of TODAY are LOCKED (persist forever; never regenerate).
// Slots further out are PROPOSED (regenerated on every render).
const LOCK_HORIZON_DAYS = 42;

// Workweek approximation for burn: FS_WORKDAYS_PER_WEEK * part.daily
// per week. part.daily is a per-workday rate, so 5*daily approximates
// weekly demand under a standard Mon-Fri workweek.
const FS_WORKDAYS_PER_WEEK = 5;

/* ============================================================
   STATE
   ============================================================ */

const FRAMESCHED_STATE = {
  // Per-week debounce timers for cap-edit writes.
  _writeTimers: new Map(),
  // Track slot startIsos already auto-persisted this session so
  // we don't fire redundant crossing writes on subsequent renders.
  _autoPersistedSlots: new Set(),
};

/* ============================================================
   DATA UTILS
   ============================================================ */

function _fsIsoMonday(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function _fsMdShort(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// Frame rows: six hardcoded PNs enriched with DB.parts data
// (onHand, daily, desc). If a PN isn't in DB.parts, onHand and
// daily default to 0 and inCatalog=false so the renderer can
// flag it visibly (missing pill).
function _fsRows() {
  const partsByPn = new Map((DB && Array.isArray(DB.parts)) ? DB.parts.map(p => [p.pn, p]) : []);
  return FRAME_PNS.map(pn => {
    const p = partsByPn.get(pn) || null;
    return {
      pn,
      desc: (p && p.desc) || "",
      pool: FRAME_POOL[pn] || "std",
      onHand: p ? (Number(p.onHand) || 0) : 0,
      daily:  p ? (Number(p.daily)  || 0) : 0,
      inCatalog: !!p,
    };
  });
}

// 14-week column layout: 2 past Mondays (dimmed, read-only) +
// current + 11 future. Uses mondayOfWeek from js/23 (window-
// exposed) for tz-safe Monday anchoring.
function _fsColumns() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentMonday = (typeof mondayOfWeek === "function")
    ? mondayOfWeek(today)
    : today;
  const cols = [];
  for (let i = -2; i <= 11; i++) {
    const d = (typeof addDays === "function")
      ? addDays(currentMonday, i * 7)
      : new Date(currentMonday.getTime() + i * 7 * 86400000);
    cols.push({
      iso: _fsIsoMonday(d),
      md: _fsMdShort(d),
      past: i < 0,
      current: i === 0,
      date: d,
    });
  }
  return cols;
}

function _fsWeekData(iso) {
  const wk = (DB && DB.frameSchedule && DB.frameSchedule.weeks instanceof Map)
    ? DB.frameSchedule.weeks.get(iso) : null;
  return {
    qty: (wk && wk.qty && typeof wk.qty === "object") ? wk.qty : {},
    slot: (wk && wk.slot && typeof wk.slot === "object") ? wk.slot : null,
  };
}

// Global CREW/HD + STD per-week caps from the __settings__ sentinel
// row. Defaults to 0 when the settings row hasn't been written yet
// (first-run behavior: no runs placed until user sets caps).
function _fsSettingsCaps() {
  const s = (DB && DB.frameSchedule && DB.frameSchedule.settings) || null;
  return {
    crewhd: Number(s && s.caps && s.caps.crewhd) || 0,
    std:    Number(s && s.caps && s.caps.std)    || 0,
  };
}

// Aggregate open normal PO receipts (per frame per Monday week
// key) so the simulator can credit incoming supply on the correct
// week. Blankets excluded; parseDateLocal used for tz-safe week
// bucketing. Read-only.
function _fsPOReceiptsByPnByWeek(pns, cols) {
  const receipts = new Map();
  const pnSet = new Set(pns);
  const weekIsoSet = new Set(cols.map(c => c.iso));
  const pos = (DB && Array.isArray(DB.pos)) ? DB.pos : [];
  for (const po of pos) {
    if (!po || !Array.isArray(po.lines)) continue;
    for (const ln of po.lines) {
      if (!ln || !pnSet.has(ln.pn)) continue;
      if (typeof isBlanketLine === "function" && isBlanketLine(ln)) continue;
      const remaining = Math.max(0, (Number(ln.qty) || 0) - (Number(ln.qtyReceived) || 0));
      if (remaining <= 0) continue;
      const expRaw = ln.expectedDate || po.expectedDate;
      if (!expRaw) continue;
      const dt = (typeof parseDateLocal === "function") ? parseDateLocal(expRaw) : null;
      if (!dt || isNaN(dt.getTime())) continue;
      const monday = (typeof mondayOfWeek === "function") ? mondayOfWeek(dt) : dt;
      const iso = _fsIsoMonday(monday);
      if (!weekIsoSet.has(iso)) continue;
      const key = ln.pn + "|" + iso;
      receipts.set(key, (receipts.get(key) || 0) + remaining);
    }
  }
  return receipts;
}

/* ============================================================
   SLOTS
   ============================================================ */

// Anchor: Monday Sep 7 2026. For any Monday W in the visible
// range, slot start = anchor + floor((W - anchor)/14) * 14 days.
// Returns one slot per unique slot start covering visible weeks;
// slots at the grid edges may have only 1 visible week.
//
// Slot resolution: seed slots and slots with persistence-backed
// pn are resolved AT BUILD TIME here. Auto-select (empty
// persistence, no seed) is deferred to the simulator so the pick
// can honor the running sim's projected onHand.
function _fsBuildSlots(cols) {
  const anchor = (typeof parseDateLocal === "function")
    ? parseDateLocal(SLOT_ANCHOR_ISO) : new Date(2026, 8, 7);
  anchor.setHours(0, 0, 0, 0);
  const anchorMs = anchor.getTime();
  const DAY_MS = 86400000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const lockCutoffMs = today.getTime() + LOCK_HORIZON_DAYS * DAY_MS;

  const bySlotStart = new Map();
  for (const c of cols) {
    const w = c.date.getTime();
    const daysFromAnchor = Math.round((w - anchorMs) / DAY_MS);
    const slotIdx = Math.floor(daysFromAnchor / 14);
    // DST-SAFE: use addDays (setDate) not ms arithmetic. ms math
    // across a DST end (e.g. anchor Sep 7 EDT + 56 days lands
    // 1 hour EARLIER than local Nov 2 midnight), so setHours
    // rolls the day back to Nov 1 (Sun). That made
    // _fsIsoMonday(slotStart) return "2026-11-01" while the col's
    // own iso is "2026-11-02" (cols use addDays already), so
    // weekToSlot lookup missed and the band-row rendered a
    // spurious empty cell over the DST-crossing week, shifting
    // every subsequent band right by one column.
    const slotStart = (typeof addDays === "function")
      ? addDays(anchor, slotIdx * 14)
      : new Date(anchorMs + slotIdx * 14 * DAY_MS);
    slotStart.setHours(0, 0, 0, 0);
    const slotStartIso = _fsIsoMonday(slotStart);
    let s = bySlotStart.get(slotStartIso);
    if (!s) {
      const week2 = (typeof addDays === "function")
        ? addDays(slotStart, 7)
        : new Date(slotStart.getTime() + 7 * DAY_MS);
      week2.setHours(0, 0, 0, 0);
      const preAnchor = slotStart.getTime() < anchorMs;
      const locked = slotStart.getTime() <= lockCutoffMs;
      s = {
        startIso: slotStartIso,
        startDate: slotStart,
        weekIsos: [slotStartIso, _fsIsoMonday(week2)],
        visibleWeekIsos: [],
        preAnchor,
        locked,
        resolvedPn: null,
        resolvedPn2: null,    // v3.3: 1-week split's week-2 frame
        source: null,          // "seed" | "auto" | "manual"
        pool: null,
        persistedPn: null,
        persistedPn2: null,    // v3.3
        persistedSource: null,
      };
      // Slot info is persisted on the START week (see write path);
      // fall back to the SECOND week if only that is stored (LWW
      // race safety).
      const wk1 = _fsWeekData(s.weekIsos[0]);
      const wk2 = _fsWeekData(s.weekIsos[1]);
      const persistedSlot = (wk1.slot && wk1.slot.pn) ? wk1.slot
                          : (wk2.slot && wk2.slot.pn) ? wk2.slot
                          : null;
      if (persistedSlot) {
        s.persistedPn = persistedSlot.pn;
        s.persistedPn2 = persistedSlot.pn2 || null;
        s.persistedSource = persistedSlot.source || "auto";
        s.resolvedPn = persistedSlot.pn;
        s.resolvedPn2 = persistedSlot.pn2 || null;
        s.source = persistedSlot.source || "auto";
        s.pool = FRAME_POOL[s.resolvedPn] || "std";
      } else if (s.preAnchor) {
        s.resolvedPn = SEED_PRE_ANCHOR_PN;
        s.resolvedPn2 = null;  // seed is always whole run
        s.source = "seed";
        s.pool = FRAME_POOL[SEED_PRE_ANCHOR_PN];
      }
      bySlotStart.set(slotStartIso, s);
    }
    s.visibleWeekIsos.push(c.iso);
  }
  return [...bySlotStart.values()].sort((a, b) => a.startDate - b.startDate);
}

/* ============================================================
   SIMULATOR
   ============================================================ */

// Auto-select fallback (greedy): pick the frame with the earliest
// projected runout starting from the given column, using current
// sim onHand only. Tie-break: lowest current weeks-of-cover.
// Workweek burn = daily × FS_WORKDAYS_PER_WEEK.
//
// NO PO CREDITS: the schedule is the SUPPLY PLAN — open POs are
// outside it (the operator orders extra as needed). Removing PO
// credits from the sim makes the picker choose based on what the
// PLAN alone can absorb, not what happens to also have inbound
// stock arriving. Inbound POs are surfaced as info-only in the
// warning row (see _fsBuildWarnings).
function _fsPickEarliestRunout(rows, onHand, cols, fromColIdx) {
  let bestPn = null;
  let bestRunoutIdx = Infinity;
  let bestCover = Infinity;
  for (const r of rows) {
    let oh = Number(onHand.get(r.pn)) || 0;
    let runoutIdx = Infinity;
    for (let i = fromColIdx; i < cols.length; i++) {
      oh -= r.daily * FS_WORKDAYS_PER_WEEK;
      if (oh <= 0) { runoutIdx = i; break; }
    }
    const weekly = r.daily * FS_WORKDAYS_PER_WEEK || 1;
    const cover = (Number(onHand.get(r.pn)) || 0) / weekly;
    if (runoutIdx < bestRunoutIdx || (runoutIdx === bestRunoutIdx && cover < bestCover)) {
      bestRunoutIdx = runoutIdx;
      bestCover = cover;
      bestPn = r.pn;
    }
  }
  return bestPn || rows[0].pn;
}

// STD drop-in candidate: pick the std frame with the lowest
// current onHand if it's below a 2-week workweek-demand buffer.
// Returns null when no std frame needs filler help (spec: "if
// runout lands before that frame's next scheduled run" — the
// 2-week buffer approximates "runout imminent within one slot").
function _fsPickFillerCandidate(rows, onHand, excludePn) {
  const cands = [];
  for (const r of rows) {
    if (r.pool !== "std") continue;
    if (r.pn === excludePn) continue;
    const oh = Number(onHand.get(r.pn)) || 0;
    const buffer = r.daily * FS_WORKDAYS_PER_WEEK * 2;
    if (oh < buffer) cands.push({ pn: r.pn, oh });
  }
  cands.sort((a, b) => a.oh - b.oh);
  return cands.length ? cands[0].pn : null;
}

// Main sim. Walks visible weeks in order from the CURRENT week
// forward (past weeks display persisted data directly — the sim
// starts fresh at "now" onHand). At each slot's first visible
// week: resolves the slot's pn if not already resolved (auto-
// select only; seed and persisted resolutions happen at build
// time). Per-week: places the slot's run at its pool cap,
// optional STD drop-in during CREW/HD slots, then burns workweek
// demand across all frames.
//
// NO PO CREDITS: the schedule is the SUPPLY PLAN — open PO
// lines are outside it (the operator orders extra as needed) so
// the sim ignores them entirely. Inbound POs are gathered by
// _fsPOReceiptsByPnByWeek / _fsDebugPOReceiptsDetailed for the
// warning row (info-only "may cover — verify" annotation) and
// for _fsDebugSim's inbound-PO info table — never fed into the
// running onHand.
function _fsSimulate(rows, cols, slots, globalCaps) {
  const onHand = new Map();
  for (const r of rows) onHand.set(r.pn, Number(r.onHand) || 0);
  const scheduledRuns = new Map();
  for (const r of rows) scheduledRuns.set(r.pn, []);
  // Per-frame per-week endOh timeline (aligned to visible current+
  // future cols only; past cols are skipped in the walk below).
  // Used by the optimizer's scorer and the warning-row builder.
  const onHandTimeline = new Map();
  for (const r of rows) onHandTimeline.set(r.pn, []);
  const rowsByPn = new Map(rows.map(r => [r.pn, r]));

  const weekToSlot = new Map();
  for (const s of slots) {
    for (const iso of s.weekIsos) weekToSlot.set(iso, s);
  }

  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (c.past) continue;
    const iso = c.iso;
    const slot = weekToSlot.get(iso);

    // Auto-select the slot's pn if this is its first VISIBLE week
    // in the current+future range AND the slot didn't already
    // resolve at build time (seed / persisted). Greedy fallback
    // path — the optimizer normally sets resolvedPn ahead of the
    // sim call and skips this branch.
    const isFirstVisibleFuture = slot && slot.visibleWeekIsos[0] === iso;
    if (slot && !slot.resolvedPn && isFirstVisibleFuture) {
      slot.resolvedPn = _fsPickEarliestRunout(rows, onHand, cols, i);
      slot.source = "auto";
      slot.pool = FRAME_POOL[slot.resolvedPn] || "std";
    }

    // 1. Determine placements.
    //    v3.4 RULE — Locks pin pn/pn2 only. Quantities for every
    //    week from NEXT Monday onward always recompute from the
    //    CURRENT global caps, regardless of lock state. Only the
    //    CURRENT week keeps its persisted qty (already committed/
    //    in progress). Past weeks aren't simmed (skipped above).
    const wk = _fsWeekData(iso);
    const isLockedWithPersistedQty =
      slot && slot.locked && c.current && wk.qty && Object.keys(wk.qty).length > 0;

    // v3.3: split-slot support. week 2 of a split slot runs
    // resolvedPn2 instead of resolvedPn. Each week's cap + filler
    // eligibility comes from THAT week's running frame's pool.
    let runPn = null;
    let runPool = null;
    if (slot && slot.resolvedPn) {
      const isWeek2 = slot.weekIsos[1] === iso;
      runPn = (isWeek2 && slot.resolvedPn2) ? slot.resolvedPn2 : slot.resolvedPn;
      runPool = FRAME_POOL[runPn] || "std";
    }

    if (isLockedWithPersistedQty) {
      // Replay persisted placements. Kind is inferred: pn === runPn
      // → run; else filler (only std filler is possible during a
      // CREW/HD week, which is the only cross-pool case).
      for (const [pn, q] of Object.entries(wk.qty)) {
        if (!scheduledRuns.has(pn)) continue;
        const qN = Number(q) || 0;
        if (qN <= 0) continue;
        const kind = (pn === runPn) ? "run" : "filler";
        scheduledRuns.get(pn).push({ weekIso: iso, qty: qN, kind });
        onHand.set(pn, (onHand.get(pn) || 0) + qN);
      }
    } else if (slot && runPn) {
      // Compute from CURRENT global caps — per-week pool.
      const cap = runPool === "crewhd" ? (globalCaps.crewhd || 0) : (globalCaps.std || 0);
      if (cap > 0) {
        scheduledRuns.get(runPn).push({ weekIso: iso, qty: cap, kind: "run" });
        onHand.set(runPn, (onHand.get(runPn) || 0) + cap);
      }
      // STD drop-in — ONLY when THIS WEEK's running frame is
      // CREW/HD. filler = std − crewhd, assigned to the std frame
      // most at risk (onHand below the 2-week workweek buffer).
      // In a split slot each week picks its own filler off the
      // week's running frame.
      if (runPool === "crewhd") {
        const fillerCap = Math.max(0, (globalCaps.std || 0) - (globalCaps.crewhd || 0));
        if (fillerCap > 0) {
          const fillerPn = _fsPickFillerCandidate(rows, onHand, runPn);
          if (fillerPn) {
            scheduledRuns.get(fillerPn).push({ weekIso: iso, qty: fillerCap, kind: "filler" });
            onHand.set(fillerPn, (onHand.get(fillerPn) || 0) + fillerCap);
          }
        }
      }
    }

    // 2. Burn workweek demand across all frames.
    for (const r of rows) {
      onHand.set(r.pn, (onHand.get(r.pn) || 0) - r.daily * FS_WORKDAYS_PER_WEEK);
    }

    // Record end-of-week onHand for each frame — scored below by
    // the optimizer and consumed by the warning-row builder.
    for (const r of rows) {
      onHandTimeline.get(r.pn).push({ iso, endOh: onHand.get(r.pn) || 0 });
    }
  }

  // v3.3: count 1-week splits across the current assignment for
  // the score's final tiebreak (fewer splits wins on equal
  // stockout/first-out/min-cover). Bounded scan over slots.
  let splitCount = 0;
  for (const s of slots) {
    if (s.resolvedPn2 && s.resolvedPn2 !== s.resolvedPn) splitCount++;
  }

  return { scheduledRuns, onHandTimeline, splitCount };
}

/* ============================================================
   OPTIMIZER

   Replaces the greedy per-slot pick with exhaustive enumeration
   over open (proposed / freshly-locked-not-yet-persisted) slots.
   Locked+manual slots keep their resolvedPn from build time.

   Complexity: FRAME_PNS.length ^ openSlotCount. Six frames, six
   possible open slots in a 14-week window → 6^6 = 46,656 sims;
   each sim is 6 frames × ~12 weeks of pure arithmetic. Well
   under the render budget in modern browsers.

   Fallback: if openSlotCount > 6 (shouldn't happen with the
   current window size + lock horizon, but defensive), fall back
   to greedy resolution inside _fsSimulate — the caller sees the
   same shape of result, just picked one slot at a time.

   Score (lower is better):
     1. Primary: total stockout units = Σ max(0, −endOh) across
        every (frame, current+future week) cell.
     2. Tie #1: LATEST first-stockout week wins (higher col idx).
     3. Tie #2: MAXIMIZE the minimum ending weeks-of-cover across
        frames (endOh / (daily × 5)).

   Side effect: on success, mutates the winning open slots'
   resolvedPn/source/pool in place. Callers that later inspect
   the slot objects see the winning assignment.
   ============================================================ */

const _FS_ENUM_CAP_OPEN_SLOTS = 6;   // → 6^6 = 46,656 sims max

function _fsOptimize(rows, cols, slots, globalCaps) {
  const openSlots = slots.filter(s => !s.resolvedPn);
  const N = openSlots.length;

  if (N === 0) {
    // Nothing to optimize; run the sim once with existing
    // resolutions and return.
    return _fsSimulate(rows, cols, slots, globalCaps);
  }

  if (N > _FS_ENUM_CAP_OPEN_SLOTS) {
    // Falls back to greedy per-slot pick (same behavior as
    // before v3). The sim itself resolves open slots via
    // _fsPickEarliestRunout at their first-visible-future week.
    if (typeof console !== "undefined") {
      console.warn(`[frame-schedule] ${N} open slots exceeds enumeration cap ${_FS_ENUM_CAP_OPEN_SLOTS} — falling back to greedy`);
    }
    return _fsSimulate(rows, cols, slots, globalCaps);
  }

  const F = FRAME_PNS.length;
  const TOTAL = Math.pow(F, N);
  let bestScore = null;
  let bestAssignment = null;
  let bestResult = null;

  // ===== PHASE 1: whole-run enumeration =====
  // All 6^N candidates are pure whole-run assignments (each slot
  // has resolvedPn2 = null throughout Phase 1). Phase 2 below
  // then considers splits as a targeted refinement.
  for (let combo = 0; combo < TOTAL; combo++) {
    // Decode combo into per-open-slot frame indices (base-F).
    let n = combo;
    for (let i = 0; i < N; i++) {
      const idx = n % F;
      n = Math.floor(n / F);
      const pn = FRAME_PNS[idx];
      openSlots[i].resolvedPn = pn;
      openSlots[i].resolvedPn2 = null;   // Phase 1 = whole runs only
      openSlots[i].source = "auto";
      openSlots[i].pool = FRAME_POOL[pn] || "std";
    }
    const result = _fsSimulate(rows, cols, slots, globalCaps);
    const score = _fsScoreSim(rows, result);
    if (!bestScore) {
      bestScore = score;
      bestAssignment = openSlots.map(s => s.resolvedPn);
      bestResult = result;
      continue;
    }
    const cmp = _fsCompareScores(score, bestScore);
    if (cmp < 0) {
      bestScore = score;
      bestAssignment = openSlots.map(s => s.resolvedPn);
      bestResult = result;
    } else if (cmp === 0) {
      // Tiebreak on exact score match: prefer the candidate with
      // MORE distinct frames across open slots. Prevents the
      // combo=0 all-FRAME_PNS[0] first candidate from winning by
      // default in degenerate/tied landscapes where every combo
      // scores identically — its distinctness is 1, so any more-
      // varied combo displaces it. Still-tied: keep incumbent.
      const curDistinct = new Set(openSlots.map(s => s.resolvedPn)).size;
      const bestDistinct = new Set(bestAssignment).size;
      if (curDistinct > bestDistinct) {
        bestScore = score;
        bestAssignment = openSlots.map(s => s.resolvedPn);
        bestResult = result;
      }
    }
  }

  // Loop leaves the LAST candidate's assignment on the slots.
  // Re-apply the Phase-1 winner so Phase 2 starts from the whole-
  // run optimum, not from the last-tried candidate.
  if (bestAssignment) {
    for (let i = 0; i < N; i++) {
      const pn = bestAssignment[i];
      openSlots[i].resolvedPn = pn;
      openSlots[i].resolvedPn2 = null;
      openSlots[i].source = "auto";
      openSlots[i].pool = FRAME_POOL[pn] || "std";
    }
  }

  // ===== PHASE 2: hill-climb split refinement =====
  //
  // For each open slot in turn: try every (A,B) split (6×5 = 30
  // pairs per slot; A≠B) with every OTHER slot frozen at the
  // current best. Adopt a split ONLY when it STRICTLY reduces
  // stockoutUnits vs the slot's current whole-run pick — score
  // tie or worse keeps the whole run. This gates splits behind
  // measurable stockout relief so they don't proliferate on ties.
  //
  // Repeat passes until a full pass adopts nothing; cap at
  // MAX_PASSES to bound cost. Per-slot cost per pass: 30 sims ×
  // 12 weeks × 6 frames ≈ 2,160 ops. With N≤6 open slots and
  // ≤3 passes: ~40k ops upper bound — negligible next to Phase
  // 1's 46k-sim enumeration.
  const MAX_PASSES = 3;
  let bestFinalResult = bestResult;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let adoptedAny = false;
    for (const slot of openSlots) {
      const baseResult = _fsSimulate(rows, cols, slots, globalCaps);
      const baseStockout = _fsScoreSim(rows, baseResult).stockoutUnits;
      const origPn = slot.resolvedPn;
      const origPn2 = slot.resolvedPn2 || null;
      const origPool = slot.pool;
      let bestSplitA = null;
      let bestSplitB = null;
      let bestSplitStockout = baseStockout;
      let bestSplitResult = null;
      for (const a of FRAME_PNS) {
        for (const b of FRAME_PNS) {
          if (a === b) continue;
          slot.resolvedPn = a;
          slot.resolvedPn2 = b;
          slot.pool = FRAME_POOL[a] || "std";
          const result = _fsSimulate(rows, cols, slots, globalCaps);
          const stockout = _fsScoreSim(rows, result).stockoutUnits;
          if (stockout < bestSplitStockout) {
            bestSplitStockout = stockout;
            bestSplitA = a;
            bestSplitB = b;
            bestSplitResult = result;
          }
        }
      }
      if (bestSplitA !== null && bestSplitStockout < baseStockout) {
        slot.resolvedPn = bestSplitA;
        slot.resolvedPn2 = bestSplitB;
        slot.pool = FRAME_POOL[bestSplitA] || "std";
        bestFinalResult = bestSplitResult;
        adoptedAny = true;
      } else {
        slot.resolvedPn = origPn;
        slot.resolvedPn2 = origPn2;
        slot.pool = origPool;
      }
    }
    if (!adoptedAny) break;
  }

  return bestFinalResult || _fsSimulate(rows, cols, slots, globalCaps);
}

// Score a sim result. Returns {stockoutUnits, firstStockoutIdx,
// minEndingCover} — see _fsCompareScores for the ordering.
function _fsScoreSim(rows, simResult) {
  const timelines = simResult.onHandTimeline;
  let stockoutUnits = 0;
  let firstStockoutIdx = Infinity;
  let minEndingCover = Infinity;
  for (const r of rows) {
    const t = timelines.get(r.pn) || [];
    for (let i = 0; i < t.length; i++) {
      const oh = t[i].endOh;
      if (oh < 0) {
        stockoutUnits += -oh;
        if (i < firstStockoutIdx) firstStockoutIdx = i;
      }
    }
    const endOh = t.length ? t[t.length - 1].endOh : 0;
    const weekly = (r.daily || 0) * FS_WORKDAYS_PER_WEEK;
    const cover = weekly > 0 ? endOh / weekly : Infinity;
    if (cover < minEndingCover) minEndingCover = cover;
  }
  return {
    stockoutUnits,
    firstStockoutIdx,
    minEndingCover,
    // v3.3: splits are penalized as the FINAL tiebreak. Sim
    // returns this count from the current slot assignment.
    splitCount: (simResult && simResult.splitCount) || 0,
  };
}

// Lower is better. Primary: fewer stockout units. Tie 1: LATER
// first-stockout week (higher idx). Tie 2: HIGHER min ending
// cover across frames. Tie 3 (v3.3): FEWER splits (whole runs
// preferred when everything else is equal).
function _fsCompareScores(a, b) {
  if (a.stockoutUnits !== b.stockoutUnits) {
    return a.stockoutUnits - b.stockoutUnits;
  }
  if (a.firstStockoutIdx !== b.firstStockoutIdx) {
    // Later first-stockout (higher idx) is better → invert.
    return b.firstStockoutIdx - a.firstStockoutIdx;
  }
  if (a.minEndingCover !== b.minEndingCover) {
    // Higher min ending cover is better → invert.
    return b.minEndingCover - a.minEndingCover;
  }
  // Fewer splits wins on true ties.
  return (a.splitCount || 0) - (b.splitCount || 0);
}

/* ============================================================
   WARNING BUILDER

   Per-frame stockout diagnostic derived from a sim result. For
   each frame that dips endOh below zero anywhere in the current+
   future window: reports the first stockout week, consecutive
   short-week count, and (if the frame later recovers) the week
   it's covered again + what credited that week (PO # if a
   receipt landed, "scheduled run/filler" otherwise).

   Returns an ordered list; empty list means all frames covered.
   ============================================================ */

function _fsMdFromIso(iso) {
  if (!iso || typeof iso !== "string") return "";
  const p = iso.split("-").map(Number);
  return (p.length === 3) ? `${p[1]}/${p[2]}` : iso;
}

function _fsBuildWarnings(rows, simResult, poDetail) {
  const warnings = [];
  const timelines = simResult.onHandTimeline;
  for (const r of rows) {
    const t = timelines.get(r.pn) || [];

    // Scan the timeline for CONTIGUOUS runs of endOh < 0. Each
    // negative stretch is a separate warning row — a frame that
    // dips negative, recovers via a scheduled run, then dips again
    // later should produce two rows so the operator sees both
    // stockouts distinctly. Merging them into one row hid the
    // second dip and misattributed its coverage.
    const dips = []; // [{startIdx, endIdx, coveredIdx | -1}]
    let curStart = -1;
    for (let i = 0; i < t.length; i++) {
      if (t[i].endOh < 0) {
        if (curStart < 0) curStart = i;
      } else if (curStart >= 0) {
        dips.push({ startIdx: curStart, endIdx: i - 1, coveredIdx: i });
        curStart = -1;
      }
    }
    if (curStart >= 0) {
      // Trailing dip — never recovered inside the visible window.
      dips.push({ startIdx: curStart, endIdx: t.length - 1, coveredIdx: -1 });
    }
    if (dips.length === 0) continue;

    for (const dip of dips) {
      const firstStockoutIso = t[dip.startIdx].iso;
      const shortWeekCount = dip.endIdx - dip.startIdx + 1;
      const coveredAgainIso = dip.coveredIdx >= 0 ? t[dip.coveredIdx].iso : null;

      // Coverage attribution. Sim runs WITHOUT PO credits, so the
      // only way onHand recovers is a scheduled run/filler in the
      // frame's own slot on the covered week.
      let coverReason = "";
      if (coveredAgainIso) {
        const runs = (simResult.scheduledRuns.get(r.pn) || []).filter(x => x.weekIso === coveredAgainIso);
        if (runs.length) {
          coverReason = `scheduled ${runs[0].kind}`;
        } else {
          coverReason = "credits this week";
        }
      }

      // Info-only PO annotation: earliest inbound PO landing
      // INSIDE THIS DIP's negative stretch [startIdx..endIdx].
      // Scoping to the dip window prevents a PO in a LATER dip
      // being attributed to an EARLIER unrelated dip. NOT
      // credited in the sim math ("may cover — verify" wording).
      let poInfo = null;
      for (let i = dip.startIdx; i <= dip.endIdx; i++) {
        const isoI = t[i].iso;
        const pos = poDetail.get(r.pn + "|" + isoI) || [];
        if (pos.length) { poInfo = { iso: isoI, po: pos[0] }; break; }
      }

      warnings.push({
        pn: r.pn,
        pool: r.pool,
        firstStockoutMD: _fsMdFromIso(firstStockoutIso),
        shortWeekCount,
        coveredAgainMD: coveredAgainIso ? _fsMdFromIso(coveredAgainIso) : null,
        coverReason,
        poInfo,
      });
    }
  }
  return warnings;
}

/* ============================================================
   PERSIST HELPERS
   ============================================================ */

// Build a persistence payload for one week: {caps, qty, slot?}.
// qty is the computed run+filler placements per frame for THIS
// week (locked weeks persist their computed numbers so a
// published snapshot reads straight from the table). slot is
// present ONLY on the slot-START week.
function _fsBuildWeekPayload(iso, scheduledRuns, slot, isSlotStart) {
  const qty = {};
  for (const [pn, runs] of scheduledRuns.entries()) {
    for (const r of runs) {
      if (r.weekIso === iso && r.qty > 0) qty[pn] = (qty[pn] || 0) + r.qty;
    }
  }
  const payload = { qty };
  if (isSlotStart && slot && slot.resolvedPn) {
    payload.slot = {
      pn: slot.resolvedPn,
      locked: !!slot.locked,
      source: slot.source || "auto",
    };
    // v3.3: split runs — week-2 frame goes on pn2. Whole runs
    // omit pn2 entirely so old rows and old readers are byte-
    // identical. js/30's writer additionally guards pn2 ===
    // pn2Trim && pn2 !== slot.pn.
    if (slot.resolvedPn2 && slot.resolvedPn2 !== slot.resolvedPn) {
      payload.slot.pn2 = slot.resolvedPn2;
    }
  }
  return payload;
}

// Apply an optimistic mirror update + debounced cloud write for
// one week. Mirror mutation goes IN PLACE on DB.frameSchedule.
// weeks so subsequent slot-build calls in this same render pass
// see the new state without a round-trip.
function _fsCommitWeek(iso, payload) {
  if (!DB.frameSchedule || !(DB.frameSchedule.weeks instanceof Map)) {
    DB.frameSchedule = { settings: null, weeks: new Map(), loaded: false };
  }
  const cur = DB.frameSchedule.weeks.get(iso) || {};
  DB.frameSchedule.weeks.set(iso, {
    qty: payload.qty || {},
    slot: payload.slot || null,
    updatedAt: cur.updatedAt || null,
  });
  _fsDebouncedWriteWeek(iso, payload);
}

function _fsDebouncedWriteWeek(iso, payload) {
  const prev = FRAMESCHED_STATE._writeTimers.get(iso);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    FRAMESCHED_STATE._writeTimers.delete(iso);
    if (typeof setFrameScheduleWeekCloud !== "function") return;
    setFrameScheduleWeekCloud(iso, payload).then(res => {
      if (res && res.ok && typeof logAudit === "function") {
        const parts = String(iso).split("-").map(Number);
        const md = parts.length === 3 ? `${parts[1]}/${parts[2]}` : iso;
        logAudit("frame-sched-edit", `Frame schedule: wk ${md} updated`, { week: iso });
      }
    });
  }, 400);
  FRAMESCHED_STATE._writeTimers.set(iso, t);
}

// Degenerate-state guard. A sim is degenerate when either cap is
// zero/blank OR the winning sim placed zero scheduled runs across
// all frames — in either case the schedule has no credible signal
// and persisting an auto-pick would freeze garbage. Root cause of
// the bug where a transient zero-cap intermediate made every
// candidate score identically and combo=0 (all UT101001) won by
// default; the crossing detector then persisted it before the
// user finished typing the real cap.
function _fsSimIsDegenerate(simResult, globalCaps) {
  const crewhd = Number(globalCaps && globalCaps.crewhd) || 0;
  const std    = Number(globalCaps && globalCaps.std)    || 0;
  if (crewhd <= 0 || std <= 0) return true;
  if (!simResult || !simResult.scheduledRuns) return true;
  for (const runs of simResult.scheduledRuns.values()) {
    if (runs && runs.length > 0) return false;
  }
  return true;
}

// Sanity gate for crossing slots: with all OTHER slot assignments
// held fixed, is `slot.resolvedPn` currently the best (or tied-
// best) pick for THIS slot? Swaps each of the 5 alternative
// frames into slot.resolvedPn, reruns the sim, scores each, and
// compares against the current pick.
//
// jointWinner=true (call comes straight out of a completed
// _fsOptimize in the same render tick): accept ties. This slot's
// pn IS the joint winner across all open slots, so a local tie
// against an alternate is expected and safe.
//
// jointWinner=false (any other context — future callers, defer):
// require STRICT improvement over every alternative. Under a
// degenerate/tied score landscape a local tie is not a signal;
// standalone re-checks must not persist under it.
//
// Restores slot's original assignment before returning.
//
// Cheap: 5 extra full sims per crossing candidate. At most a
// handful of crossings per render — total under 6 × 6 × 12 =
// ~430 arithmetic ops each; negligible next to the optimizer's
// 46k-sim upper bound.
function _fsIsOptimalPickForSlot(slot, rows, cols, slots, globalCaps, jointWinner) {
  const origPn = slot.resolvedPn;
  const origPn2 = slot.resolvedPn2 || null;   // v3.3: preserve split
  const origSource = slot.source;
  const origPool = slot.pool;

  const baseResult = _fsSimulate(rows, cols, slots, globalCaps);
  const baseScore = _fsScoreSim(rows, baseResult);

  // v3.3: alternates are strictly WHOLE runs — force pn2=null on
  // each swap. A persisted split is compared against the best
  // whole-run alternative; if any whole run strictly beats the
  // split, the gate defers (whole run wins ties via splitCount
  // in the score itself).
  const currentIsSplit = !!(origPn2 && origPn2 !== origPn);
  let bestAltScore = null;
  for (const altPn of FRAME_PNS) {
    // Skip the identity swap only when the CURRENT assignment is
    // a whole run (a persisted split's pn === altPn is still a
    // distinct alternative — the whole-run version of that pn).
    if (!currentIsSplit && altPn === origPn) continue;
    slot.resolvedPn = altPn;
    slot.resolvedPn2 = null;
    slot.source = "auto";
    slot.pool = FRAME_POOL[altPn] || "std";
    const result = _fsSimulate(rows, cols, slots, globalCaps);
    const score = _fsScoreSim(rows, result);
    if (!bestAltScore || _fsCompareScores(score, bestAltScore) < 0) {
      bestAltScore = score;
    }
  }

  slot.resolvedPn = origPn;
  slot.resolvedPn2 = origPn2;
  slot.source = origSource;
  slot.pool = origPool;

  if (!bestAltScore) return true;
  const cmp = _fsCompareScores(baseScore, bestAltScore);
  if (jointWinner) {
    // Just-optimized this render tick: this slot IS the joint
    // winner, so a local tie against an alternate is safe.
    return cmp <= 0;
  }
  // Standalone re-check: require STRICT improvement over every
  // alternative. Under a tied/degenerate landscape a local tie
  // is not a signal and must NOT persist.
  return cmp < 0;
}

// Fire persistence for LOCKED slots whose stored pn disagrees
// with the current sim resolution (crossings + missing rows).
// Called at the tail of a full render.
//
// SANITY GATE: before freezing a crossing, verify the assignment
// is currently optimal for that slot (see _fsIsOptimalPickForSlot).
// A transient bad optimizer pass would previously auto-lock
// garbage on the first crossing render; now we defer the freeze
// and console-warn. The next render's fresh optimizer will
// naturally correct the assignment and retry.
//
// _autoPersistedSlots is only stamped AFTER a successful persist,
// so a deferred crossing keeps re-checking every render until it
// passes the gate.
//
// jointWinner: true when this call comes immediately after a
// completed _fsOptimize in the same render tick — the gate then
// accepts ties (this slot's pn IS the joint-optimal pick).
// false/omitted: gate requires strict improvement.
function _fsPersistLockedCrossings(slots, cols, scheduledRuns, rows, globalCaps, jointWinner) {
  // DEGENERATE-STATE GUARD: no caps or no runs placed → any
  // "winner" is meaningless; freezing it would write garbage.
  // Suspend persistence entirely and warn once. Next render with
  // real caps will re-fire the crossings normally.
  if (_fsSimIsDegenerate({ scheduledRuns }, globalCaps)) {
    if (typeof console !== "undefined") {
      console.warn("[frame-sched] persistence suspended: caps missing/zero or no runs placed");
    }
    return;
  }
  const visibleIsos = new Set(cols.map(c => c.iso));
  for (const s of slots) {
    if (!s.locked || !s.resolvedPn) continue;
    if (FRAMESCHED_STATE._autoPersistedSlots.has(s.startIso)) continue;
    if (s.persistedPn === s.resolvedPn) continue;

    if (!_fsIsOptimalPickForSlot(s, rows, cols, slots, globalCaps, jointWinner)) {
      if (typeof console !== "undefined") {
        console.warn(`[frame-sched] auto-lock deferred for ${s.startIso}: assignment not currently optimal — will retry next render`);
      }
      continue;
    }

    FRAMESCHED_STATE._autoPersistedSlots.add(s.startIso);
    for (let idx = 0; idx < s.weekIsos.length; idx++) {
      const iso = s.weekIsos[idx];
      if (!visibleIsos.has(iso)) continue;
      const isStart = idx === 0;
      const payload = _fsBuildWeekPayload(iso, scheduledRuns, s, isStart);
      _fsCommitWeek(iso, payload);
    }
  }
}

// Threshold (stockout-units delta) above which a LOCKED
// auto/seed slot's persisted pn is considered materially worse
// than the alternative the optimizer would pick if the slot were
// open today. Set high enough that trivial ties don't produce
// alarm-fatigue tags; low enough that a real inversion surfaces.
const _FS_STALE_LOCK_DELTA = 5;

// Detect stale locks — LOCKED auto/seed slots whose persisted pn
// is materially worse than what the optimizer would pick now.
// Manual overrides are excluded (intentional). Returns a Set of
// startIso to tag amber "⚠ stale lock — review" in the render;
// console fsRepickSlot(iso) remains the manual fix. Never auto-
// unlocks — the operator decides.
function _fsFindStaleLocks(slots, rows, cols, globalCaps, currentSimResult) {
  const stale = new Set();
  const baseScore = _fsScoreSim(rows, currentSimResult);
  for (const s of slots) {
    if (!s.locked) continue;
    if (s.source === "manual") continue;
    if (!s.persistedPn) continue;
    const origPn = s.resolvedPn;
    const origPn2 = s.resolvedPn2 || null;   // v3.3: preserve split
    const origPool = s.pool;
    // v3.3: alternates are strictly WHOLE runs — force pn2=null.
    // A persisted split is compared against every whole-run
    // alternative including its own pn as a whole run.
    const currentIsSplit = !!(origPn2 && origPn2 !== origPn);
    let bestAltScore = null;
    let bestAltPn = null;
    for (const altPn of FRAME_PNS) {
      if (!currentIsSplit && altPn === origPn) continue;
      s.resolvedPn = altPn;
      s.resolvedPn2 = null;
      s.pool = FRAME_POOL[altPn] || "std";
      const result = _fsSimulate(rows, cols, slots, globalCaps);
      const score = _fsScoreSim(rows, result);
      if (!bestAltScore || _fsCompareScores(score, bestAltScore) < 0) {
        bestAltScore = score;
        bestAltPn = altPn;
      }
    }
    s.resolvedPn = origPn;
    s.resolvedPn2 = origPn2;
    s.pool = origPool;
    if (bestAltScore && bestAltPn !== origPn) {
      const delta = baseScore.stockoutUnits - bestAltScore.stockoutUnits;
      if (delta > _FS_STALE_LOCK_DELTA) stale.add(s.startIso);
    }
  }
  return stale;
}

/* ============================================================
   RENDER
   ============================================================ */

function renderFrameSchedule() {
  const rows = _fsRows();
  const cols = _fsColumns();
  const slots = _fsBuildSlots(cols);
  const globalCaps = _fsSettingsCaps();
  // Optimizer replaces greedy per-slot pick for OPEN (no
  // resolvedPn at build time) slots. Locked+manual slots keep
  // their build-time pn; the optimizer treats them as fixed.
  // See _fsOptimize header for the score + tie-breakers.
  //
  // Sim runs WITHOUT PO credits — the schedule is the supply
  // plan. Open POs are surfaced info-only in the warning row
  // (below) via the PO-detail aggregator.
  const simResult = _fsOptimize(rows, cols, slots, globalCaps);
  const scheduledRuns = simResult.scheduledRuns;

  // Stale-lock detection: LOCKED auto/seed slots whose persisted
  // pn is materially worse than the alternative the optimizer
  // would pick today (delta > _FS_STALE_LOCK_DELTA stockout
  // units). Manual overrides excluded. Info-only tag; no auto-
  // unlock — the operator decides via console fsRepickSlot.
  const staleLocks = _fsFindStaleLocks(slots, rows, cols, globalCaps, simResult);

  const weekToSlot = new Map();
  for (const s of slots) {
    for (const iso of s.weekIsos) weekToSlot.set(iso, s);
  }

  // Precompute per-week per-pool nonzero counts for the same-pool
  // amber flag (spec B). Past weeks read from persisted wk.qty;
  // current+future weeks read from sim's scheduledRuns.
  const poolCountByIso = new Map();
  for (const c of cols) {
    const iso = c.iso;
    const wk = _fsWeekData(iso);
    const counts = { crewhd: 0, std: 0 };
    for (const r of rows) {
      let q = 0;
      if (c.past) q = Number(wk.qty[r.pn]) || 0;
      else {
        const runs = scheduledRuns.get(r.pn) || [];
        for (const rn of runs) if (rn.weekIso === iso) q += rn.qty;
      }
      if (q > 0) counts[r.pool]++;
    }
    poolCountByIso.set(iso, counts);
  }

  // ---- Slot-band header row.
  //
  // ALIGNMENT INVARIANT (dev assertion — comment only):
  //   The band row MUST cover exactly the same 14 columns as the
  //   date-header row: sticky <th>Slot</th> + N band cells whose
  //   colspan sum equals cols.length + trailing empty <th> for
  //   the 12-wk total column. Each band cell begins directly
  //   above cols[bi] and covers cols[bi..bi+span-1]. For
  //   non-clipped slots, slot.startIso === cols[bi].iso (the
  //   leftmost visible col of the group). The `title` attribute
  //   below carries the group's slot.startIso for hover
  //   verification.
  //
  // MERGE RULE:
  //   Consecutive weeks in the same slot always merge (colspan=2
  //   when both weeks visible). Additionally, consecutive
  //   pre-anchor SEED slots that share the same resolvedPn
  //   coalesce into a single continuous band so the ongoing seed
  //   run (UT101002 through Sun Sep 6 2026) renders as one span
  //   rather than duplicate 2-week bands.
  const bandCells = [];
  let bi = 0;
  while (bi < cols.length) {
    const c = cols[bi];
    const slot = weekToSlot.get(c.iso);
    if (!slot) { bandCells.push(`<th class="fs-slot-band-empty"></th>`); bi++; continue; }
    let span = 1;
    while (bi + span < cols.length) {
      const nextSlot = weekToSlot.get(cols[bi + span].iso);
      if (!nextSlot) break;
      const sameSlot = nextSlot === slot;
      // Seed-run merge: continuous UT101002 (or any future
      // multi-slot seed with same pn) spans as one band.
      const seedMerge = slot.source === "seed"
                     && nextSlot.source === "seed"
                     && slot.resolvedPn === nextSlot.resolvedPn;
      if (!sameSlot && !seedMerge) break;
      span++;
    }
    const lockedPill = slot.locked
      ? `<span class="pill info tiny" style="letter-spacing:0.06em">locked</span>`
      : `<span class="pill muted tiny" style="opacity:0.7;letter-spacing:0.06em">proposed</span>`;
    const sourceTag = slot.source === "manual"
      ? `<span class="pill warn tiny" style="margin-left:4px" title="Manually overridden">manual</span>`
      : slot.source === "seed"
      ? `<span class="pill muted tiny" style="margin-left:4px" title="Seed run — GAS CREW mid-run through Sun Sep 6 2026">seed</span>`
      : "";
    // SELF-RUNNING MODE (v3.2): slot bands are labels only — no
    // per-slot override <select>, no per-slot re-pick button, no
    // "Re-pick all" button. Proposed slots re-optimize on every
    // render; slots crossing the 42-day horizon auto-lock+persist
    // via _fsPersistLockedCrossings. Console-only escape hatches
    // remain (window.fsRepickSlot / fsRepickAll / fsOverrideSlot).
    const shortLabel = slot.resolvedPn ? (FRAME_SHORT[slot.resolvedPn] || "") : "";
    // Stale-lock tag: shown when a persisted auto/seed pn is
    // materially worse than the current optimizer's alternative
    // pick for the same slot (see _fsFindStaleLocks). Manual
    // fix: `fsRepickSlot('<startIso>')` in DevTools console.
    const staleTag = staleLocks.has(slot.startIso)
      ? `<span class="pill warn tiny" style="margin-left:4px" title="Persisted frame no longer optimal (score improved > ${_FS_STALE_LOCK_DELTA} units by a swap). Console: fsRepickSlot('${esc(slot.startIso)}')">&#9888; stale lock &mdash; review</span>`
      : "";
    // v3.3 + cosmetic:
    //   Whole-run full band (span >= 2): "PN · short"
    //   Whole-run CLIPPED edge band (span == 1): short name only
    //     (the PN would ellipsize away anyway in a 72px column;
    //      showing "AMP STD" keeps the label meaningful).
    //   Split band (any span): "short → short" with PNs in tooltip.
    // Full labels always live in the title attribute so hover
    // reveals the PN(s) when the visible text is abbreviated or
    // ellipsized under table-layout: fixed.
    const isSplit = !!(slot.resolvedPn2 && slot.resolvedPn2 !== slot.resolvedPn);
    const isClipped = span === 1;
    let slotText;
    let splitTag = "";
    let labelForTitle;
    if (isSplit) {
      const shortLabel2 = FRAME_SHORT[slot.resolvedPn2] || "";
      splitTag = `<span class="pill info tiny" style="letter-spacing:0.06em" title="1-week split run — week 1: ${esc(slot.resolvedPn)}; week 2: ${esc(slot.resolvedPn2)}">split</span>`;
      slotText = `<span class="muted tiny">${esc(shortLabel)}</span>`
        + `<span class="muted" style="margin:0 4px">&rarr;</span>`
        + `<span class="muted tiny">${esc(shortLabel2)}</span>`;
      labelForTitle = `${slot.resolvedPn} · ${shortLabel} → ${slot.resolvedPn2} · ${shortLabel2}`;
    } else if (isClipped) {
      slotText = `<span class="muted tiny">${esc(shortLabel || (slot.resolvedPn || "—"))}</span>`;
      labelForTitle = slot.resolvedPn ? `${slot.resolvedPn}${shortLabel ? " · " + shortLabel : ""}` : "—";
    } else {
      slotText = `<span class="mono">${esc(slot.resolvedPn || "—")}</span>`
        + (shortLabel ? `<span class="muted tiny" style="margin-left:4px">&middot; ${esc(shortLabel)}</span>` : "");
      labelForTitle = slot.resolvedPn ? `${slot.resolvedPn}${shortLabel ? " · " + shortLabel : ""}` : "—";
    }
    // Two-line band: line 1 = frame text, line 2 = pills. Emit both
    // divs regardless of pill count so LOCKED and PROPOSED bands
    // sit at the same height. Inner divs ellipsize under
    // table-layout: fixed so slot content can never widen a column.
    // Full label goes in the title attribute for hover reveal.
    const bandTitle = `${labelForTitle} — slot starts ${slot.startIso} (leftmost col: ${cols[bi].iso})`;
    bandCells.push(`<th colspan="${span}" class="fs-slot-band" data-fs-slot-start="${esc(slot.startIso)}" title="${esc(bandTitle)}">
      <div class="fs-slot-text">${slotText}</div>
      <div class="fs-slot-pills">${lockedPill}${sourceTag}${splitTag}${staleTag}</div>
    </th>`);
    bi += span;
  }
  // DEV ALIGNMENT CHECK: the sum of band-cell colspans MUST equal
  // cols.length. Console-warn on drift so a future regression
  // surfaces immediately (silent in production; benign otherwise).
  if (typeof console !== "undefined") {
    let _fsSpanSum = 0;
    for (const cell of bandCells) {
      const m = /colspan="(\d+)"/.exec(cell);
      _fsSpanSum += m ? Number(m[1]) : 1;
    }
    if (_fsSpanSum !== cols.length) {
      console.warn(`[frame-schedule] slot-band colspan sum ${_fsSpanSum} !== cols.length ${cols.length}`);
    }
  }
  const slotBandRow = `<tr class="fs-slot-band-row">
    <th class="fs-sticky">Slot</th>
    ${bandCells.join("")}
    <th></th>
  </tr>`;

  // ---- Week header (M/D + ISO title) ----
  const headMD = cols.map(c =>
    `<th class="right${c.past ? " dim" : ""}${c.current ? " bold" : ""}" title="${esc(c.iso)}">${esc(c.md)}</th>`
  ).join("");

  // ---- Frame rows (computed, read-only) ----
  const frameRows = rows.map(r => {
    let total = 0;
    const cells = cols.map(c => {
      const wk = _fsWeekData(c.iso);
      let q = 0;
      let kind = null;
      if (c.past) {
        q = Number(wk.qty[r.pn]) || 0;
      } else {
        const runs = scheduledRuns.get(r.pn) || [];
        for (const rn of runs) {
          if (rn.weekIso === c.iso) {
            q += rn.qty;
            // If any run is a "run" (non-filler), the cell reads
            // as a run; only pure-filler placements read as drop-
            // in (kind stays "filler").
            kind = (rn.kind === "run") ? "run" : (kind || rn.kind);
          }
        }
      }
      total += q;
      // Same-pool amber flag: 2+ frames of THIS row's pool have
      // nonzero placements in this week, AND this cell is nonzero.
      const counts = poolCountByIso.get(c.iso) || { crewhd: 0, std: 0 };
      const amber = q > 0 && counts[r.pool] >= 2;
      const dim = c.past ? " dim" : "";
      let cls = "";
      let title = "";
      if (kind === "filler") {
        cls = " fs-filler";
        title = ` title="Drop-in filler — slot is CREW/HD; STD spare capacity credited to this frame."`;
      } else if (q > 0) {
        cls = " fs-run";
      }
      const amberStyle = amber ? ` style="background:rgba(255,181,71,0.22);"` : "";
      const amberTitle = amber && !title ? ` title="Two ${_fsPoolLabel(r.pool)} frames scheduled this week — soft flag, doesn't block."` : "";
      return `<td class="right num mono${cls}${dim}"${amberStyle}${title || amberTitle}>${q || ""}</td>`;
    }).join("");
    const poolTag = r.pool === "crewhd"
      ? `<span class="pill info tiny" style="margin-left:6px">CREW/HD</span>`
      : `<span class="pill muted tiny" style="margin-left:6px">STD</span>`;
    const missing = r.inCatalog ? "" :
      `<span class="pill warn tiny" style="margin-left:4px" title="Not in DB.parts — onHand and daily treated as 0.">missing</span>`;
    return `<tr>
      <th class="fs-sticky">
        <span class="mono">${esc(r.pn)}</span>${poolTag}${missing}
        <div class="muted tiny">${esc((r.desc || "").slice(0, 60))}</div>
      </th>
      ${cells}
      <td class="right num mono bold">${total}</td>
    </tr>`;
  }).join("");

  // ---- Warning row — projected stockouts under the WINNING
  //      optimizer assignment. Rebuild the per-PO receipt detail
  //      here (cheap; same pass the debug helper does) so each
  //      warning line can name the PO that covers the frame.
  //      Empty warnings list → single green "all covered" line.
  const _fsPoDetail = _fsDebugPOReceiptsDetailed(FRAME_PNS, cols);
  const warnings = _fsBuildWarnings(rows, simResult, _fsPoDetail);
  const warningsPanel = warnings.length === 0
    ? `<div class="fs-warn-ok">&#10003; All frames covered through the ${cols.filter(c => !c.past).length}-week window.</div>`
    : warnings.map(w => {
        // Coverage tail: prefer the sim-recovered path (scheduled
        // run/filler); otherwise mention the inbound PO as
        // INFO-ONLY (not counted in the sim's math — hence
        // "may cover — verify"). If neither: the frame is short
        // through the whole window.
        let tail;
        if (w.coveredAgainMD) {
          tail = `&mdash; covered ${esc(w.coveredAgainMD)}${w.coverReason ? ` by ${esc(w.coverReason)}` : ""}`;
        } else if (w.poInfo) {
          const dueTxt = w.poInfo.po.expRaw ? ` due ${esc(_fsMdFromIso(w.poInfo.po.expRaw))}` : "";
          tail = `&mdash; <em class="muted">PO#${esc(w.poInfo.po.poNum)}${dueTxt} may cover &mdash; verify</em>`;
        } else {
          tail = "&mdash; not covered in this window (expedite or add capacity)";
        }
        const shortName = FRAME_SHORT[w.pn] || "";
        const poolTxt = _fsPoolLabel(w.pool);
        return `<div class="fs-warn-row">
          <span class="pill crit tiny" style="letter-spacing:0.05em">&#9888; ${esc(w.pn)}</span>
          ${shortName ? `<span class="muted tiny" style="margin-left:6px">&middot; ${esc(shortName)}</span>` : ""}
          ${poolTxt ? `<span class="muted tiny" style="margin-left:6px">&middot; ${esc(poolTxt)}</span>` : ""}
          <span style="margin-left:8px">short <strong>${w.shortWeekCount}</strong> wk starting <strong>${esc(w.firstStockoutMD)}</strong> ${tail}</span>
        </div>`;
      }).join("");

  // Global caps input strip in the page head. Changes go through
  // setFrameScheduleSettingsCloud (optimistic mirror + revert)
  // and re-run the sim so proposed slots reflect the new cap;
  // locked slots keep their persisted qty.
  const globalCapsInputs = `
    <div class="fs-global-caps">
      <label class="fs-caps-label">
        <span class="muted tiny">CREW/HD cap /wk</span>
        <input id="fs-cap-crewhd" type="number" step="1" min="0" value="${globalCaps.crewhd}"
               class="input mono fs-caps-input"
               onchange="_fsHandleSettingsCap('crewhd', this.value)">
      </label>
      <label class="fs-caps-label">
        <span class="muted tiny">STD cap /wk</span>
        <input id="fs-cap-std" type="number" step="1" min="0" value="${globalCaps.std}"
               class="input mono fs-caps-input"
               onchange="_fsHandleSettingsCap('std', this.value)">
      </label>
      <div class="muted tiny" style="margin-left:12px">Filler capacity per CREW/HD slot = max(0, STD &minus; CREW/HD) = <strong>${Math.max(0, globalCaps.std - globalCaps.crewhd)}</strong>/wk</div>
      <div class="muted tiny" style="margin-left:12px">Locks fix the frame; caps set the quantity &mdash; changes apply from next week.</div>
    </div>`;

  // Degenerate-state banner: caps missing/zero or no runs placed.
  // Displayed prominently so the operator sees that the schedule
  // is paused (persistence suspended) until real caps are entered.
  const degenerate = _fsSimIsDegenerate(simResult, globalCaps);
  const degenerateBanner = degenerate
    ? `<div class="fs-degenerate-banner">Schedule paused &mdash; enter both weekly caps.</div>`
    : "";

  $("#main").innerHTML = `
    <style>
      /* table-layout: fixed pins column widths from the colgroup —
         slot-band text can no longer widen any week column, no
         matter how long the label or how many pills. */
      .fs-tbl { table-layout: fixed; }
      .fs-col-sticky { width: 240px; }
      .fs-col-week { width: 72px; }
      .fs-col-total { width: 96px; }
      .fs-sticky { position: sticky; left: 0; background: var(--bg-1); z-index: 2; width: 240px; text-align: left; }
      .fs-tbl th { background: var(--bg-1); }
      .fs-tbl th.right { text-align: right; }
      .fs-slot-band-row th { background: rgba(120,140,200,0.10); border-bottom: 2px solid var(--line); vertical-align: top; }
      .fs-slot-band { text-align: left; padding: 2px 6px; border-left: 2px solid var(--line-soft); border-right: 2px solid var(--line-soft); line-height: 1.1; overflow: hidden; }
      .fs-slot-band-empty { background: transparent; }
      /* Inner divs clip on overflow instead of widening the cell.
         display:block + white-space:nowrap keeps inline pill spans
         side-by-side; overflow:hidden + text-overflow:ellipsis
         truncates the visible text so full labels stay in title. */
      .fs-slot-text { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:11px; }
      .fs-slot-pills { display:block; white-space:nowrap; overflow:hidden; margin-top:1px; min-height:14px; }
      .fs-run { background: rgba(80,180,120,0.22); font-weight: 600; }
      .fs-filler { background: rgba(80,180,120,0.08); font-style: italic; }
      .fs-tbl td, .fs-tbl th { white-space: nowrap; }
      .fs-global-caps { display:flex; align-items:center; gap:14px; padding:10px 12px; background:var(--bg-1); border-radius:6px; margin-bottom:12px; }
      .fs-caps-label { display:flex; flex-direction:column; gap:2px; }
      .fs-caps-input { width: 84px; text-align: right; font-variant-numeric: tabular-nums; }
      .fs-warnings-panel { padding:10px 12px; background:var(--bg-1); border-radius:6px; margin-top:12px; }
      .fs-warn-ok { color: var(--ok, #4bcc80); font-size:12px; font-weight:600; }
      .fs-warn-row { font-size:12px; padding:4px 0; border-bottom:1px solid var(--line-soft); }
      .fs-warn-row:last-child { border-bottom:0; }
      .fs-warnings-panel .fs-warn-title { font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color: var(--t2); margin-bottom:6px; }
      .fs-degenerate-banner { padding:10px 12px; background:rgba(180,180,180,0.10); border:1px dashed var(--line); border-radius:6px; margin-bottom:12px; font-size:12px; color:var(--t2); }
    </style>
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Frame Schedule</div>
          <div class="page-sub mono">${slots.length} SLOT${slots.length === 1 ? "" : "S"} &middot; 14 WEEKS (2 PAST &middot; CURRENT &middot; 11 FUTURE) &middot; LOCK HORIZON ${LOCK_HORIZON_DAYS}D &middot; ANCHOR ${SLOT_ANCHOR_ISO}</div>
        </div>
      </div>

      ${globalCapsInputs}
      ${degenerateBanner}

      <div class="panel">
        <div class="panel-body flush">
          <div class="tbl-wrap" style="overflow:auto;max-height:calc(100vh - 280px)">
            <table class="tbl fs-tbl">
              <colgroup>
                <col class="fs-col-sticky">
                ${cols.map(() => `<col class="fs-col-week">`).join("")}
                <col class="fs-col-total">
              </colgroup>
              <thead>
                ${slotBandRow}
                <tr>
                  <th class="fs-sticky">Frame</th>
                  ${headMD}
                  <th class="right">12-wk total</th>
                </tr>
              </thead>
              <tbody>
                ${frameRows}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="fs-warnings-panel">
        <div class="fs-warn-title">Projected coverage &mdash; winning sequence</div>
        ${warningsPanel}
      </div>
    </div>`;

  // Fire persistence for LOCKED slots that just crossed the 42-day
  // line (or whose persisted pn no longer matches the sim). One
  // write per new crossing per session, GATED by the per-slot
  // sanity check — see _fsIsOptimalPickForSlot. jointWinner=true
  // because this call is IMMEDIATELY after _fsOptimize in the same
  // render tick — the gate accepts local ties in that context.
  _fsPersistLockedCrossings(slots, cols, scheduledRuns, rows, globalCaps, /* jointWinner */ true);
}

/* ============================================================
   EDIT HANDLERS
   ============================================================ */

// Global cap edit — CREW/HD or STD per-week cap. Goes through the
// __settings__ sentinel row via setFrameScheduleSettingsCloud
// (optimistic mirror + revert-on-error).
//
// v3.4 rule: Locks pin pn/pn2 only — quantities always flow
// forward from live caps. After the settings write we re-persist
// every LOCKED FUTURE week's qty (same slot pn/pn2, new numbers)
// so the persisted rows — and therefore the published supplier
// snapshot — reflect the new caps immediately. Current week keeps
// its persisted qty (already committed/in progress); past weeks
// are never touched.
function _fsHandleSettingsCap(pool, raw) {
  if (typeof gateEdit === "function" && !gateEdit()) return;
  if (pool !== "crewhd" && pool !== "std") return;
  const n = Math.max(0, Math.floor(Number(raw) || 0));
  const cur = _fsSettingsCaps();
  const nextCaps = { crewhd: cur.crewhd, std: cur.std };
  nextCaps[pool] = n;

  // Fire the settings write first (mirror updates synchronously
  // inside setFrameScheduleSettingsCloud, so the re-quantify sim
  // below already sees the new caps).
  const settingsPromise = (typeof setFrameScheduleSettingsCloud === "function")
    ? setFrameScheduleSettingsCloud(nextCaps)
    : Promise.resolve({ ok: false });

  // Re-quantify every LOCKED FUTURE week with the new caps.
  // Sim under nextCaps (mirror already reflects them). Locked
  // slots keep their pn/pn2 (build-time resolvedPn from
  // persistence); open slots re-optimize around them — we don't
  // persist open slots here, only locked ones.
  let requantifiedCount = 0;
  try {
    const rows = _fsRows();
    const cols = _fsColumns();
    const slots = _fsBuildSlots(cols);
    const simResult = _fsOptimize(rows, cols, slots, nextCaps);
    const scheduledRuns = simResult.scheduledRuns;
    // Skip re-quantify if the new caps are degenerate — no
    // credible numbers to persist. The banner will surface.
    if (!_fsSimIsDegenerate(simResult, nextCaps)) {
      const futureIsoSet = new Set(
        cols.filter(c => !c.past && !c.current).map(c => c.iso)
      );
      for (const s of slots) {
        if (!s.locked || !s.resolvedPn) continue;
        for (let idx = 0; idx < s.weekIsos.length; idx++) {
          const wkIso = s.weekIsos[idx];
          if (!futureIsoSet.has(wkIso)) continue;
          const isStart = idx === 0;
          const payload = _fsBuildWeekPayload(wkIso, scheduledRuns, s, isStart);
          _fsCommitWeek(wkIso, payload);
          requantifiedCount++;
        }
      }
    }
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[frame-sched] cap-change re-quantify failed", err);
    }
  }

  settingsPromise.then(res => {
    if (res && res.ok && typeof logAudit === "function") {
      const tail = requantifiedCount
        ? ` · re-quantified ${requantifiedCount} locked wk`
        : "";
      logAudit("frame-sched-edit",
        `Frame schedule: global ${_fsPoolLabel(pool)} cap = ${n}/wk${tail}`,
        { pool, cap: n, requantifiedWeeks: requantifiedCount });
    }
  });

  // Optimistic mirror update happened inside setFrameScheduleSettingsCloud
  // (before the RPC), so this render sees the new value immediately.
  renderFrameSchedule();
}

// Manual slot override. pn === "" clears the override and lets
// the sim auto-pick (persisted with source="auto"). Non-empty
// values force the slot's pn and mark it source="manual".
// Persists BOTH weeks of the slot with the same slot info on the
// start week, computed qty on both.
function _fsHandleSlotOverride(startIso, pn) {
  if (typeof gateEdit === "function" && !gateEdit()) return;
  if (pn && FRAME_PNS.indexOf(pn) < 0) return;

  // DEGENERATE-STATE REFUSAL: without both caps set, any auto pick
  // (including the one that clears an override would trigger) is
  // meaningless. Manual overrides are also refused so the write
  // isn't stranded on a schedule that can't run.
  const globalCapsForCheck = _fsSettingsCaps();
  if ((Number(globalCapsForCheck.crewhd) || 0) <= 0 || (Number(globalCapsForCheck.std) || 0) <= 0) {
    if (typeof showToast === "function") {
      showToast("Set both caps before overriding", "warn");
    }
    return;
  }

  if (!DB.frameSchedule || !(DB.frameSchedule.weeks instanceof Map)) {
    DB.frameSchedule = { settings: null, weeks: new Map(), loaded: false };
  }

  // CLEAR-OVERRIDE branch (pn === ""): clear the mirror + fire
  // cloud clear for BOTH slot weeks (same shape as
  // _fsHandleSlotRepick), drop the crossing tracker, then just
  // render — the render's optimizer + GATED crossing detector
  // handle re-lock. No direct persist here so a transient/
  // degenerate optimizer pass can't freeze garbage ungated.
  if (!pn) {
    const cols = _fsColumns();
    const slots = _fsBuildSlots(cols);
    const slot = slots.find(s => s.startIso === startIso);
    if (slot) {
      for (const wkIso of slot.weekIsos) {
        if (!cols.some(c => c.iso === wkIso)) continue;
        _fsCommitWeek(wkIso, { qty: {} });
      }
    }
    FRAMESCHED_STATE._autoPersistedSlots.delete(startIso);
    if (typeof logAudit === "function") {
      logAudit("frame-sched-edit",
        `Frame schedule: slot ${startIso} override cleared`,
        { slotStart: startIso, pn: null });
    }
    renderFrameSchedule();
    return;
  }

  // MANUAL branch (pn provided): user's explicit choice. Persist
  // {pn, locked:true, source:"manual"} directly — no sanity gate,
  // because the whole point of a manual override is to force this
  // pn regardless of what the optimizer would pick.
  const cur = DB.frameSchedule.weeks.get(startIso) || { qty: {}, slot: null };
  DB.frameSchedule.weeks.set(startIso, {
    qty: cur.qty || {},
    slot: { pn, locked: true, source: "manual" },
    updatedAt: cur.updatedAt || null,
  });
  FRAMESCHED_STATE._autoPersistedSlots.delete(startIso);

  const rows = _fsRows();
  const cols = _fsColumns();
  const slots = _fsBuildSlots(cols);
  const globalCaps = _fsSettingsCaps();
  // Optimizer: the manual slot is now fixed (build-time
  // resolvedPn from the persisted mirror update above); remaining
  // open slots re-optimize around it. Sim runs without PO
  // credits — see _fsSimulate header.
  const simResult = _fsOptimize(rows, cols, slots, globalCaps);
  const scheduledRuns = simResult.scheduledRuns;

  const slot = slots.find(s => s.startIso === startIso);
  if (slot) {
    for (let idx = 0; idx < slot.weekIsos.length; idx++) {
      const wkIso = slot.weekIsos[idx];
      if (!cols.some(c => c.iso === wkIso)) continue;
      const isStart = idx === 0;
      const payload = _fsBuildWeekPayload(wkIso, scheduledRuns, slot, isStart);
      _fsCommitWeek(wkIso, payload);
    }
  }
  if (typeof logAudit === "function") {
    logAudit("frame-sched-edit",
      `Frame schedule: slot ${startIso} override -> ${pn}`,
      { slotStart: startIso, pn });
  }
  renderFrameSchedule();
}

// Re-pick every LOCKED auto/seed slot in one go. Manual overrides
// stay put. For each eligible slot: clear the persisted slot
// descriptor + qty from the mirror (both weeks), drop the
// crossing tracker so the render's persist-crossings pass re-
// fires. Single re-render at the end runs the optimizer on the
// now-empty auto/seed slots, joint-optimizing across all of them
// under current caps + current onHand. Locked results re-persist
// in the same tick via the crossing detector. Single audit event
// summarizing how many slots were cleared.
function _fsHandleRepickAll() {
  if (typeof gateEdit === "function" && !gateEdit()) return;
  const cols = _fsColumns();
  const slots = _fsBuildSlots(cols);
  const cleared = [];
  for (const slot of slots) {
    if (!slot.locked) continue;                // proposed slots regenerate anyway
    if (slot.source === "manual") continue;    // manual overrides untouched
    for (const wkIso of slot.weekIsos) {
      if (!cols.some(c => c.iso === wkIso)) continue;
      _fsCommitWeek(wkIso, { qty: {} });
    }
    FRAMESCHED_STATE._autoPersistedSlots.delete(slot.startIso);
    cleared.push(slot.startIso);
  }
  if (typeof logAudit === "function") {
    logAudit("frame-sched-edit",
      `Frame schedule: re-pick all (${cleared.length} slot${cleared.length === 1 ? "" : "s"} cleared)`,
      { clearedSlots: cleared });
  }
  renderFrameSchedule();
}

// Re-pick a LOCKED auto/seed slot. Clears the persisted slot
// descriptor + qty for both slot weeks, drops the crossing
// tracker so the render's persist-crossings pass re-fires, and
// re-renders. The sim runs with a null persistedPn and auto-
// selects using CURRENT caps + current onHand + current PO
// receipts; the crossing detector then re-persists the fresh
// pick immediately (in the same tick). The two per-week cloud
// writes (clear + auto-picked payload) coalesce inside
// _fsDebouncedWriteWeek's 400ms window — only the auto-picked
// state lands in the row.
//
// Manual slots are excluded: the override select already handles
// pn changes and there's no auto to re-run. Proposed slots don't
// need a button — they regenerate every render.
function _fsHandleSlotRepick(startIso) {
  if (typeof gateEdit === "function" && !gateEdit()) return;
  const cols = _fsColumns();
  const slots = _fsBuildSlots(cols);
  const slot = slots.find(s => s.startIso === startIso);
  if (!slot) return;
  if (!slot.locked || slot.source === "manual") return;

  const prevPn = slot.resolvedPn || null;

  // Clear persisted slot descriptor + qty from the mirror for
  // both slot weeks. Payload {qty: {}} produces {slot: null,
  // qty: {}} in the mirror (via _fsCommitWeek) and would produce
  // a cleared row in the cloud — but the debounced write is
  // superseded by the crossing detector's fresh-pick write later
  // in this same render pass.
  for (const wkIso of slot.weekIsos) {
    if (!cols.some(c => c.iso === wkIso)) continue;
    _fsCommitWeek(wkIso, { qty: {} });
  }

  // Drop the session-cache entry so the crossing detector
  // re-fires with the fresh auto-pick on this render.
  FRAMESCHED_STATE._autoPersistedSlots.delete(startIso);

  if (typeof logAudit === "function") {
    logAudit("frame-sched-edit",
      `Frame schedule: slot ${startIso} re-picked`,
      { slotStart: startIso, prevPn });
  }

  renderFrameSchedule();
}

registerRoute("frameschedule", renderFrameSchedule);

/* ============================================================
   CONSOLE-ONLY ESCAPE HATCHES

   In self-running mode (v3.2) the schedule has no per-slot UI
   controls — bands are labels only. The three handlers below
   stay wired up for DevTools console use so an operator can
   still override / re-pick a slot when reality forces it:

     window.fsOverrideSlot("2026-10-19", "UT101003")   // pin
     window.fsOverrideSlot("2026-10-19", "")           // clear
     window.fsRepickSlot("2026-10-19")                 // re-pick one
     window.fsRepickAll()                              // re-pick every locked auto/seed

   All three go through gateEdit + logAudit + the standard
   optimize + persist flow, exactly as they did when they had
   rendered buttons. No UI paths render these — grep the file
   for onclick handlers to confirm.
   ============================================================ */
window.fsOverrideSlot = _fsHandleSlotOverride;
window.fsRepickSlot   = _fsHandleSlotRepick;
window.fsRepickAll    = _fsHandleRepickAll;

/* ============================================================
   DIAGNOSTIC — window._fsDebugSim()

   Reruns the sim in READ-ONLY mode (no persistence, no
   scheduledRuns mutation on the module state — a fresh local
   run) and prints per-frame per-week: startOh, poCredits (with
   PO nums), buildCredits (run/filler), burn, endOh. Plus a
   per-frame summary showing the first week endOh drops below 0
   ("stockout <iso>") or "covered".

   Not a route handler; not called from render. Attached to
   window for on-demand use from the DevTools console:
     _fsDebugSim()

   Zero shared-state writes; no cloud writes; safe to call
   any number of times.
   ============================================================ */

// Per-PO receipts breakdown (parallel to _fsPOReceiptsByPnByWeek
// but preserves the individual PO numbers per credit so the
// diagnostic can name them). Same predicates: normal (non-
// blanket) open lines with parseable expectedDate that falls in
// a visible week.
function _fsDebugPOReceiptsDetailed(pns, cols) {
  const detail = new Map(); // pn|iso -> [{poNum, qty, expRaw}, ...]
  const pnSet = new Set(pns);
  const weekIsoSet = new Set(cols.map(c => c.iso));
  const pos = (typeof DB !== "undefined" && Array.isArray(DB.pos)) ? DB.pos : [];
  for (const po of pos) {
    if (!po || !Array.isArray(po.lines)) continue;
    for (const ln of po.lines) {
      if (!ln || !pnSet.has(ln.pn)) continue;
      if (typeof isBlanketLine === "function" && isBlanketLine(ln)) continue;
      const remaining = Math.max(0, (Number(ln.qty) || 0) - (Number(ln.qtyReceived) || 0));
      if (remaining <= 0) continue;
      const expRaw = ln.expectedDate || po.expectedDate;
      if (!expRaw) continue;
      const dt = (typeof parseDateLocal === "function") ? parseDateLocal(expRaw) : null;
      if (!dt || isNaN(dt.getTime())) continue;
      const monday = (typeof mondayOfWeek === "function") ? mondayOfWeek(dt) : dt;
      const iso = _fsIsoMonday(monday);
      if (!weekIsoSet.has(iso)) continue;
      const key = ln.pn + "|" + iso;
      if (!detail.has(key)) detail.set(key, []);
      detail.get(key).push({ poNum: po.num || "?", qty: remaining, expRaw });
    }
  }
  return detail;
}

window._fsDebugSim = function () {
  const rows = _fsRows();
  const cols = _fsColumns();
  const slots = _fsBuildSlots(cols);
  const poDetail = _fsDebugPOReceiptsDetailed(FRAME_PNS, cols);
  const globalCaps = _fsSettingsCaps();

  // Run the optimizer first so the walk below reflects the SAME
  // pn per open slot that the render sees (avoids the debug
  // showing a divergent greedy pick).
  _fsOptimize(rows, cols, slots, globalCaps);

  // Fresh local sim state — do NOT touch the module's mirrors.
  const onHand = new Map();
  for (const r of rows) onHand.set(r.pn, Number(r.onHand) || 0);
  const perFrame = new Map(); // pn -> row[]
  for (const r of rows) perFrame.set(r.pn, []);

  const weekToSlot = new Map();
  for (const s of slots) for (const iso of s.weekIsos) weekToSlot.set(iso, s);

  console.log(`[fsDebugSim] Global caps: CREW/HD=${globalCaps.crewhd}/wk · STD=${globalCaps.std}/wk · filler=${Math.max(0, globalCaps.std - globalCaps.crewhd)}/wk`);
  console.log(`[fsDebugSim] Slot anchor ${SLOT_ANCHOR_ISO} · lock horizon ${LOCK_HORIZON_DAYS}d`);
  console.log(`[fsDebugSim] Sim runs WITHOUT PO credits — inbound POs listed at the end are info-only.`);

  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (c.past) continue;
    const iso = c.iso;
    const slot = weekToSlot.get(iso);

    // Auto-select (mirror the sim's rule; typically skipped
    // because _fsOptimize already resolved the slot).
    const isFirstVisibleFuture = slot && slot.visibleWeekIsos[0] === iso;
    if (slot && !slot.resolvedPn && isFirstVisibleFuture) {
      slot.resolvedPn = _fsPickEarliestRunout(rows, onHand, cols, i);
      slot.source = "auto";
      slot.pool = FRAME_POOL[slot.resolvedPn] || "std";
    }

    // Snapshot startOh (before build placements/burn).
    const startOh = new Map();
    for (const r of rows) startOh.set(r.pn, onHand.get(r.pn) || 0);

    // Placements (mirror the sim exactly — NO PO credits).
    // v3.3: split slots run frame A in week-1, frame B in week-2.
    // runPn is chosen per-week based on slot.weekIsos[1] === iso.
    // v3.4: persisted qty is honored only for the CURRENT week
    // (already committed/in progress). Future locked weeks always
    // recompute from live caps — see _fsSimulate header.
    const wk = _fsWeekData(iso);
    const isLockedWithPersistedQty = slot && slot.locked && c.current && wk.qty && Object.keys(wk.qty).length > 0;
    const isWeek2 = !!(slot && slot.weekIsos && slot.weekIsos[1] === iso);
    const runPn = slot && slot.resolvedPn
      ? (isWeek2 && slot.resolvedPn2 ? slot.resolvedPn2 : slot.resolvedPn)
      : null;
    const runPool = runPn ? (FRAME_POOL[runPn] || "std") : (slot ? slot.pool : "std");
    const buildCreditsThisWeek = new Map();
    for (const r of rows) buildCreditsThisWeek.set(r.pn, []);

    if (isLockedWithPersistedQty) {
      for (const [pn, q] of Object.entries(wk.qty)) {
        if (!onHand.has(pn)) continue;
        const qN = Number(q) || 0;
        if (qN <= 0) continue;
        const kind = (pn === runPn) ? "run" : "filler";
        onHand.set(pn, (onHand.get(pn) || 0) + qN);
        buildCreditsThisWeek.get(pn).push({ qty: qN, kind });
      }
    } else if (slot && runPn) {
      const cap = runPool === "crewhd" ? (globalCaps.crewhd || 0) : (globalCaps.std || 0);
      if (cap > 0) {
        onHand.set(runPn, (onHand.get(runPn) || 0) + cap);
        buildCreditsThisWeek.get(runPn).push({ qty: cap, kind: "run" });
      }
      if (runPool === "crewhd") {
        const fillerCap = Math.max(0, (globalCaps.std || 0) - (globalCaps.crewhd || 0));
        if (fillerCap > 0) {
          const fillerPn = _fsPickFillerCandidate(rows, onHand, runPn);
          if (fillerPn) {
            onHand.set(fillerPn, (onHand.get(fillerPn) || 0) + fillerCap);
            buildCreditsThisWeek.get(fillerPn).push({ qty: fillerCap, kind: "filler" });
          }
        }
      }
    }

    // Burn workweek demand.
    const burnThisWeek = new Map();
    for (const r of rows) {
      const b = r.daily * FS_WORKDAYS_PER_WEEK;
      onHand.set(r.pn, (onHand.get(r.pn) || 0) - b);
      burnThisWeek.set(r.pn, b);
    }

    // Record per-frame snapshot for this week (no poCredits
    // column — inbound POs live in the separate info table
    // below).
    for (const r of rows) {
      const bc = buildCreditsThisWeek.get(r.pn) || [];
      // v3.3: on a split slot's week-2, "slot" this row belongs to
      // is the pn2 frame. Show that in the tag so the walk lines
      // up with the actual placement.
      const splitLabel = slot && slot.resolvedPn2 && slot.resolvedPn2 !== slot.resolvedPn
        ? `${slot.resolvedPn}->${slot.resolvedPn2}`
        : (slot ? (slot.resolvedPn || "?") : "?");
      const slotTag = slot && runPn === r.pn ? `slot:${slot.startIso}`
                    : (slot ? `(slot=${splitLabel})` : "");
      perFrame.get(r.pn).push({
        week: iso,
        md: c.md,
        slot: slotTag,
        startOh: Number(startOh.get(r.pn).toFixed(3)),
        buildCredits: bc.length ? bc.map(x => `+${x.qty}(${x.kind})`).join(" ") : "",
        burn: Number((burnThisWeek.get(r.pn) || 0).toFixed(3)),
        endOh: Number(onHand.get(r.pn).toFixed(3)),
      });
    }
  }

  // Print per-frame tables.
  console.log("=== Frame Schedule sim — per-frame per-week walk (NO PO credits) ===");
  for (const r of rows) {
    console.log(`\n--- ${r.pn} · ${FRAME_SHORT[r.pn] || ""} (${_fsPoolLabel(r.pool)}) · daily=${r.daily}/wd · onHand@today=${r.onHand} ---`);
    console.table(perFrame.get(r.pn));
  }

  // Inbound POs INFO ONLY — the sim did not credit these. Shown
  // so the operator can eyeball what's coming in and decide
  // whether to expedite anything called out in the warnings.
  const inbound = [];
  const weekIsoSet = new Set(cols.filter(c => !c.past).map(c => c.iso));
  for (const key of poDetail.keys()) {
    const bar = key.indexOf("|");
    if (bar < 0) continue;
    const pn = key.slice(0, bar);
    const iso = key.slice(bar + 1);
    if (!weekIsoSet.has(iso)) continue;
    for (const p of poDetail.get(key)) {
      inbound.push({
        pn,
        short: FRAME_SHORT[pn] || "",
        week: iso,
        md: _fsMdFromIso(iso),
        poNum: p.poNum,
        qty: p.qty,
        expRaw: p.expRaw || "",
      });
    }
  }
  inbound.sort((a, b) => a.week.localeCompare(b.week) || String(a.pn).localeCompare(String(b.pn)));
  console.log(`\n=== Inbound POs (info only — NOT credited in the sim) ===`);
  if (inbound.length === 0) console.log("(none in the current+future window)");
  else console.table(inbound);

  // Summary: first week endOh drops below 0 per frame.
  const summary = [];
  for (const r of rows) {
    const walks = perFrame.get(r.pn);
    let firstStockout = null;
    for (const w of walks) {
      if (w.endOh < 0) { firstStockout = w; break; }
    }
    summary.push({
      pn: r.pn,
      pool: r.pool,
      daily: r.daily,
      startOnHand: r.onHand,
      status: firstStockout ? `stockout ${firstStockout.week} (endOh=${firstStockout.endOh})` : "covered through window",
    });
  }
  console.log("\n=== Summary: projected stockout per frame ===");
  console.table(summary);

  return { perFrame, summary };
};
