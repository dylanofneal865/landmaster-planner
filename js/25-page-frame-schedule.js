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
       as needed. Reads DB.poReceipts (populated by the daily
       PO-receipts sync) for the "got N" received-vs-scheduled
       overlay on past+current cells; receipts NEVER feed the sim.
       Never writes part fields, POs, receipts, statuses,
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

// Workweek approximation for burn: FS_WORKDAYS_PER_WEEK * per-workday
// rate. The per-workday rate is FLAT `part.daily` — no scheduled
// rate-step lookup. Rationale: this schedule DRIVES future
// production, so it plans at the current full run rate immediately
// rather than honoring a historical ramp date. A frame with a
// pending scheduled ramp is treated as if the ramp has already
// taken effect (which is the outcome the schedule aims to bring
// about).
const FS_WORKDAYS_PER_WEEK = 5;

// v4 HORIZON — the sim walks a longer window than the render. Scoring
// covers 20 future weeks so a late-window stockout influences today's
// slot picks; only 12 render (unchanged public grid). Beyond-window
// open slots use the greedy _fsPickEarliestRunout fallback inside the
// sim; only visible open slots enumerate (see _fsOptimize).
//
// Bound rationale: 6^N grows fast (46,656 sims at N=6). Enumerating
// all 10 open slots that could fit in the 20-week horizon would blow
// the ceiling. The visible slots are the ones we actually persist,
// so they get the exhaustive treatment; beyond-window slots are
// influenced by the tail-cost signal but don't participate in the
// combinatorial search.
const SIM_HORIZON_WEEKS = 20;

/* ============================================================
   STATE
   ============================================================ */

const FRAMESCHED_STATE = {
  // Per-week debounce timers for cap-edit writes.
  _writeTimers: new Map(),
  // Track slot startIsos already auto-persisted this session so
  // we don't fire redundant crossing writes on subsequent renders.
  _autoPersistedSlots: new Set(),
  // Receipt History panel: which slice of the full-archive history
  // to render. "8" | "26" | "all"; default 26. In-memory only —
  // reverts on reload, which is fine (a display preference, not a
  // decision that needs to travel across sessions).
  _historyRange: "26",
  // Currently expanded receipt-detail cell — {pn, iso} or null.
  // Accordion behavior: one open at a time. Click the same cell
  // again or Escape closes.
  _expandedCell: null,
  // Whether the document-level Escape/click listener has been
  // installed. Guarded so re-renders don't stack listeners.
  _accordionEscInstalled: false,
  // v4.1 SAFETY BUFFER — minimum COVER in weeks the optimizer tries
  // to hold above zero for every frame at every sim week. Default
  // 1.0 = one full week of forward burn kept as cushion. Persisted
  // in the __settings__ row as `bufferWeeks` (see
  // setFrameScheduleSettingsCloud + _populateFrameScheduleFromRows).
  // Session-local fallback only for a live edit before the round-
  // trip lands; the reader (_fsSettingsBufferWeeks) prefers the
  // cloud value.
  _bufferWeeks: null,
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
      // Underlying DB.parts object kept for the true-demand panel
      // and for any consumer that wants desc/onHand fields directly.
      // The sim burn uses the flat `daily` field above as the rate;
      // no rate-step lookup happens anywhere in this file.
      part: p,
    };
  });
}

// Chain-aware per-workday rate. Frames that participate in a
// supersession chain expose their TRUE consumption rate on
// chainDisplayDaily(part) — not part.daily. UT101002 for example
// reads daily 0.162 (its own PN slice) but chainDisplayDaily 0.61
// (~4× — the rate the chain actually burns). Every burn source in
// this file — sim, pickers, buffer target, true-demand panel,
// history Plan/wk — must consult this helper instead of
// Number(row.daily), or every chained frame is undercounted.
//
// Fallback order:
//   1. chainDisplayDaily(part) when the engine helper is loaded
//      AND returns a finite non-null number.
//   2. Number(row.daily) — the raw per-PN rate.
//   3. 0.
// Isolation: chainDisplayDaily is a pure read; nothing mutates.
function _fsDaily(row) {
  const part = row && row.part;
  if (part && typeof chainDisplayDaily === "function") {
    const chained = Number(chainDisplayDaily(part));
    if (Number.isFinite(chained) && chained > 0) return chained;
  }
  return Number(row && row.daily) || 0;
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

// v4.1 Safety buffer (min cover in WEEKS) — reads the cloud
// settings row's `bufferWeeks` field when present; falls back to
// the session-local FRAMESCHED_STATE._bufferWeeks set by the input
// handler. Default 1.0 = one week's forward burn kept as cushion.
// Legacy `settings.buffer` (integer units) intentionally ignored —
// the units-based term was superseded by this weeks-based one
// before it saw production use.
const _FS_BUFFER_WEEKS_DEFAULT = 1.0;
function _fsSettingsBufferWeeks() {
  const s = (DB && DB.frameSchedule && DB.frameSchedule.settings) || null;
  const cloudVal = s && Number.isFinite(Number(s.bufferWeeks)) ? Number(s.bufferWeeks) : null;
  if (cloudVal !== null && cloudVal >= 0) return cloudVal;
  const localVal = Number(FRAMESCHED_STATE._bufferWeeks);
  if (Number.isFinite(localVal) && localVal >= 0) return localVal;
  return _FS_BUFFER_WEEKS_DEFAULT;
}

// Target on-hand at end of week for a frame — the buffer term
// against which endOh is compared. bufferWeeks × per-workday rate
// (flat part.daily) × 5. Returns 0 when the frame has no daily
// rate — no cushion signal when there's no burn to cover.
// weekDate is retained in the signature for future callers even
// though the flat-rate model doesn't consult it.
function _fsTargetUnits(row, weekDate, bufferWeeks) {
  void weekDate;
  const bw = Number(bufferWeeks);
  if (!Number.isFinite(bw) || bw <= 0) return 0;
  const rate = _fsDaily(row);
  return bw * rate * FS_WORKDAYS_PER_WEEK;
}

// v4 Sim column set — extends the 14-week render layout to a
// SIM_HORIZON_WEEKS future horizon. Same 2 past cols; same current;
// SIM_HORIZON_WEEKS future cols instead of 11. Fields identical to
// _fsColumns's shape so callers are drop-in interchangeable.
function _fsSimColumns() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const currentMonday = (typeof mondayOfWeek === "function")
    ? mondayOfWeek(today)
    : today;
  const cols = [];
  for (let i = -2; i <= SIM_HORIZON_WEEKS - 1; i++) {
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
function _fsPickEarliestRunout(rows, onHand, cols, fromColIdx, rateByPn) {
  let bestPn = null;
  let bestRunoutIdx = Infinity;
  let bestCover = Infinity;
  for (const r of rows) {
    // Prefer the memoized rate from the caller's rateByPn map;
    // fall back to _fsDaily only when a direct caller didn't
    // provide one (defensive — every hot-path caller should).
    const rate = rateByPn ? (Number(rateByPn[r.pn]) || 0) : _fsDaily(r);
    const weekly = rate * FS_WORKDAYS_PER_WEEK;
    let oh = Number(onHand.get(r.pn)) || 0;
    let runoutIdx = Infinity;
    for (let i = fromColIdx; i < cols.length; i++) {
      oh -= weekly;
      if (oh <= 0) { runoutIdx = i; break; }
    }
    const cover = (weekly > 0 ? (Number(onHand.get(r.pn)) || 0) / weekly : Infinity);
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
function _fsPickFillerCandidate(rows, onHand, excludePn, rateByPn) {
  const cands = [];
  for (const r of rows) {
    if (r.pool !== "std") continue;
    if (r.pn === excludePn) continue;
    const oh = Number(onHand.get(r.pn)) || 0;
    // Flat full-rate burn: the 2-week runout buffer here uses the
    // chain-aware daily rate as-is (rate steps are ignored — see
    // the FS_WORKDAYS_PER_WEEK header comment for rationale).
    // Memoized rate — see rateByPn comment on _fsSimulate.
    const rate = rateByPn ? (Number(rateByPn[r.pn]) || 0) : _fsDaily(r);
    const runoutBuffer = rate * FS_WORKDAYS_PER_WEEK * 2;
    if (oh < runoutBuffer) cands.push({ pn: r.pn, oh });
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
function _fsSimulate(rows, cols, slots, globalCaps, rateByPn) {
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
  // Precompute the flat per-week burn per frame once — the sim
  // uses the CHAIN-AWARE per-workday rate as-is (rate steps
  // intentionally ignored; this schedule DRIVES production toward
  // the current rate immediately). See FS_WORKDAYS_PER_WEEK
  // comment and _fsDaily header for why chainDisplayDaily matters.
  //
  // PERF: rateByPn is MEMOIZED per render — the optimizer runs
  // ~46k sims per Phase 1 and chainDisplayDaily is an
  // O(chain-length) walk. Calling _fsDaily(r) inside every sim
  // was a hot-path chain-walk explosion (millions per render).
  // Callers now build `const rateByPn = {}; for (const r of rows)
  // rateByPn[r.pn] = _fsDaily(r);` ONCE per render and pass it
  // through. The `_fsDaily(r)` fallback below is only exercised
  // by tests / diagnostic callers that pass undefined.
  const weeklyBurnByPn = new Map();
  for (const r of rows) {
    const rate = rateByPn ? (Number(rateByPn[r.pn]) || 0) : _fsDaily(r);
    weeklyBurnByPn.set(r.pn, rate * FS_WORKDAYS_PER_WEEK);
  }

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
      slot.resolvedPn = _fsPickEarliestRunout(rows, onHand, cols, i, rateByPn);
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
          const fillerPn = _fsPickFillerCandidate(rows, onHand, runPn, rateByPn);
          if (fillerPn) {
            scheduledRuns.get(fillerPn).push({ weekIso: iso, qty: fillerCap, kind: "filler" });
            onHand.set(fillerPn, (onHand.get(fillerPn) || 0) + fillerCap);
          }
        }
      }
    }

    // 2. Burn workweek demand across all frames using the FLAT
    //    per-week burn (part.daily × 5) — precomputed above. This
    //    is the same number every simulated week; a scheduled rate
    //    step in js/03 has no effect here because the schedule
    //    drives production toward the current rate immediately.
    const burnByPn = new Map();
    for (const r of rows) {
      const burn = weeklyBurnByPn.get(r.pn) || 0;
      onHand.set(r.pn, (onHand.get(r.pn) || 0) - burn);
      burnByPn.set(r.pn, burn);
    }

    // Record end-of-week onHand + burn for each frame — scored
    // below by the optimizer, consumed by the warning-row builder,
    // and used by the running-cover minimum. Burn stored so the
    // scorer can compute cover_wk = endOh / burn without re-doing
    // the rate resolution.
    for (const r of rows) {
      onHandTimeline.get(r.pn).push({
        iso,
        endOh: onHand.get(r.pn) || 0,
        burn: burnByPn.get(r.pn) || 0,
      });
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

function _fsOptimize(rows, cols, slots, globalCaps, visibleStartIsos, rateByPn) {
  // v4: split open slots into two buckets.
  //   openSlots     — slots we ENUMERATE over combinatorially.
  //   beyondSlots   — slots the SIM's greedy fallback picks for us.
  // visibleStartIsos, when provided, restricts enumeration to slots
  // whose startIso is in that set (= slots that will actually be
  // rendered + persisted). Beyond-window slots still influence the
  // tail cost via the sim, but they don't participate in 6^N.
  // Reason: with SIM_HORIZON_WEEKS=20 there can easily be 10 open
  // slots; 6^10 = 60M sims would blow the ceiling.
  const allOpen = slots.filter(s => !s.resolvedPn);
  const openSlots = visibleStartIsos
    ? allOpen.filter(s => visibleStartIsos.has(s.startIso))
    : allOpen;
  const beyondSlots = visibleStartIsos
    ? allOpen.filter(s => !visibleStartIsos.has(s.startIso))
    : [];
  const N = openSlots.length;

  // Before every sim call, reset beyond-slot resolutions so the
  // greedy picker fires fresh based on THIS combo's onHand
  // progression. Otherwise the first combo's greedy pick sticks
  // and biases every subsequent combo.
  const resetBeyond = () => {
    for (const b of beyondSlots) {
      b.resolvedPn = null;
      b.resolvedPn2 = null;
      b.source = null;
      b.pool = null;
    }
  };

  if (N === 0) {
    // Nothing to enumerate. Still run the sim once with beyond-slot
    // greedy fallback and return.
    resetBeyond();
    return _fsSimulate(rows, cols, slots, globalCaps, rateByPn);
  }

  if (N > _FS_ENUM_CAP_OPEN_SLOTS) {
    // Falls back to greedy per-slot pick (same behavior as
    // before v3). The sim itself resolves open slots via
    // _fsPickEarliestRunout at their first-visible-future week.
    if (typeof console !== "undefined") {
      console.warn(`[frame-schedule] ${N} visible open slots exceeds enumeration cap ${_FS_ENUM_CAP_OPEN_SLOTS} — falling back to greedy`);
    }
    resetBeyond();
    return _fsSimulate(rows, cols, slots, globalCaps, rateByPn);
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
    resetBeyond();
    const result = _fsSimulate(rows, cols, slots, globalCaps, rateByPn);
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
      resetBeyond();
      const baseResult = _fsSimulate(rows, cols, slots, globalCaps, rateByPn);
      const baseScore = _fsScoreSim(rows, baseResult);
      const origPn = slot.resolvedPn;
      const origPn2 = slot.resolvedPn2 || null;
      const origPool = slot.pool;
      let bestSplitA = null;
      let bestSplitB = null;
      let bestSplitScore = baseScore;
      let bestSplitResult = null;
      for (const a of FRAME_PNS) {
        for (const b of FRAME_PNS) {
          if (a === b) continue;
          slot.resolvedPn = a;
          slot.resolvedPn2 = b;
          slot.pool = FRAME_POOL[a] || "std";
          resetBeyond();
          const result = _fsSimulate(rows, cols, slots, globalCaps, rateByPn);
          const score = _fsScoreSim(rows, result);
          // v4.1: adopt when the FULL comparator says the split is
          // strictly better — not just stockoutUnits. The prior
          // stockout-only gate accepted breaches and cover
          // regressions as long as stockout stayed the same.
          if (_fsCompareScores(score, bestSplitScore) < 0) {
            bestSplitScore = score;
            bestSplitA = a;
            bestSplitB = b;
            bestSplitResult = result;
          }
        }
      }
      if (bestSplitA !== null && _fsCompareScores(bestSplitScore, baseScore) < 0) {
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

  resetBeyond();
  return bestFinalResult || _fsSimulate(rows, cols, slots, globalCaps, rateByPn);
}

// Score a sim result. Returns {stockoutUnits, breachUnits,
// firstStockoutIdx, minRunningCover, splitCount} — see
// _fsCompareScores for the ordering.
//
// v4.1 buffer term (breachUnits): Σ max(0, targetUnits − endOh)
// across (frame, week) pairs where 0 ≤ endOh < targetUnits.
// targetUnits = bufferWeeks × rate(frame, week) × 5 so a rate step
// changes the target on the week it takes effect — the cushion
// scales with the demand it's cushioning.
//
// v4.1 maximin cover (minRunningCover): min over ALL frames AND
// ALL sim weeks of endOh / burnThatWeek (weeks). The prior
// minEndingCover measured only the final week; this catches a
// mid-window near-miss too. Weeks with burn == 0 contribute
// Infinity (no cover signal).
function _fsScoreSim(rows, simResult, bufferWeeksOverride) {
  const timelines = simResult.onHandTimeline;
  const bufferWeeks = Math.max(0, Number(bufferWeeksOverride != null ? bufferWeeksOverride : _fsSettingsBufferWeeks()) || 0);
  let stockoutUnits = 0;
  let breachUnits = 0;
  let firstStockoutIdx = Infinity;
  let minRunningCover = Infinity;
  for (const r of rows) {
    const t = timelines.get(r.pn) || [];
    for (let i = 0; i < t.length; i++) {
      const oh = t[i].endOh;
      const burn = t[i].burn || 0;
      if (oh < 0) {
        stockoutUnits += -oh;
        if (i < firstStockoutIdx) firstStockoutIdx = i;
      } else if (bufferWeeks > 0 && burn > 0) {
        const target = bufferWeeks * burn;
        if (oh < target) breachUnits += (target - oh);
      }
      // Running cover: skip stockout weeks (already penalized by
      // stockoutUnits) and zero-burn weeks (no cover signal).
      if (oh >= 0 && burn > 0) {
        const cover = oh / burn;
        if (cover < minRunningCover) minRunningCover = cover;
      }
    }
  }
  return {
    stockoutUnits,
    breachUnits,
    firstStockoutIdx,
    minRunningCover,
    splitCount: (simResult && simResult.splitCount) || 0,
  };
}

// Lower total-ordering is better.
// Tier 1: stockoutUnits ↑ (fewer wins — real negative on-hand is
//         always the worst outcome; no soft term outranks it).
// Tier 2: breachUnits ↑ (fewer buffer-breach units wins). Distinct
//         from stockout — never traded for a stockout increase.
// Tier 3: firstStockoutIdx ↓ (LATER first-stockout wins).
// Tier 4: minRunningCover ↓ (HIGHER minimum running cover wins).
// Tier 5: splitCount ↑ (fewer splits wins).
function _fsCompareScores(a, b) {
  if (a.stockoutUnits !== b.stockoutUnits) {
    return a.stockoutUnits - b.stockoutUnits;
  }
  const aBU = a.breachUnits || 0;
  const bBU = b.breachUnits || 0;
  if (aBU !== bBU) return aBU - bBU;
  if (a.firstStockoutIdx !== b.firstStockoutIdx) {
    return b.firstStockoutIdx - a.firstStockoutIdx;
  }
  const aMC = (a.minRunningCover === Infinity) ? Number.MAX_VALUE : a.minRunningCover;
  const bMC = (b.minRunningCover === Infinity) ? Number.MAX_VALUE : b.minRunningCover;
  if (aMC !== bMC) return bMC - aMC;
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

// MM/DD/YYYY variant used by the receipt-history "history from X"
// header note — full year matters for pre-schedule archive dates.
function _fsMdLongFromIso(iso) {
  if (!iso || typeof iso !== "string") return "";
  const p = iso.split("-").map(Number);
  return (p.length === 3) ? `${p[1]}/${p[2]}/${p[0]}` : iso;
}

// Look up the historical slot governing a given ISO Monday. Used
// by the receipt-history tooltip to name a placement's kind
// (run / drop-in / split). Computes slot bucketing via anchor +
// 14-day math (matches _fsBuildSlots), then reads persisted slot
// info from the start week — the writer always attaches slot on
// the slot-start row. Pre-anchor weeks fall back to the seed pn.
// Returns { slotPn, slotPn2, isWeek2, source } or null if we
// can't resolve. Pure read; safe to call anywhere.
function _fsHistoricalSlotForIso(iso) {
  if (!iso || typeof iso !== "string") return null;
  const anchor = (typeof parseDateLocal === "function")
    ? parseDateLocal(SLOT_ANCHOR_ISO) : new Date(2026, 8, 7);
  anchor.setHours(0, 0, 0, 0);
  const target = parseDateLocal(iso);
  if (!target || isNaN(target.getTime())) return null;
  target.setHours(0, 0, 0, 0);
  const DAY_MS = 86400000;
  // For pre-anchor weeks the seed run rule applies (single pn,
  // always SEED_PRE_ANCHOR_PN).
  if (target.getTime() < anchor.getTime()) {
    return { slotPn: SEED_PRE_ANCHOR_PN, slotPn2: null, isWeek2: false, source: "seed" };
  }
  const daysFromAnchor = Math.round((target.getTime() - anchor.getTime()) / DAY_MS);
  const slotIdx = Math.floor(daysFromAnchor / 14);
  const slotStart = (typeof addDays === "function")
    ? addDays(anchor, slotIdx * 14)
    : new Date(anchor.getTime() + slotIdx * 14 * DAY_MS);
  slotStart.setHours(0, 0, 0, 0);
  const startIso = _fsIsoMonday(slotStart);
  const wk1 = _fsWeekData(startIso);
  const persistedSlot = (wk1.slot && wk1.slot.pn) ? wk1.slot : null;
  // Fallback (LWW race): the second week may hold slot info if the
  // start-week write hasn't landed yet.
  let usedSlot = persistedSlot;
  if (!usedSlot) {
    const week2 = (typeof addDays === "function")
      ? addDays(slotStart, 7) : new Date(slotStart.getTime() + 7 * DAY_MS);
    week2.setHours(0, 0, 0, 0);
    const w2 = _fsWeekData(_fsIsoMonday(week2));
    if (w2.slot && w2.slot.pn) usedSlot = w2.slot;
  }
  if (!usedSlot) return null;
  const isWeek2 = target.getTime() >= slotStart.getTime() + 7 * DAY_MS;
  return {
    slotPn: usedSlot.pn,
    slotPn2: usedSlot.pn2 || null,
    isWeek2,
    source: usedSlot.source || "auto",
  };
}

function _fsBuildWarnings(rows, simResult, poDetail) {
  const warnings = [];
  const timelines = simResult.onHandTimeline;
  const bufferWeeks = _fsSettingsBufferWeeks();
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
        severity: "stockout",
        firstStockoutIso,
        firstStockoutMD: _fsMdFromIso(firstStockoutIso),
        shortWeekCount,
        coveredAgainIso,
        coveredAgainMD: coveredAgainIso ? _fsMdFromIso(coveredAgainIso) : null,
        coverReason,
        poInfo,
      });
    }

    // v4.1 BUFFER BREACH — CONTIGUOUS runs of 0 <= endOh < target,
    // where target = bufferWeeks × burn(that week). Distinct from
    // stockouts (positive on-hand but below the safety cushion)
    // so operators see them as an amber flag, not a red one.
    // Skipped entirely when bufferWeeks is 0 (feature opt-in).
    if (bufferWeeks > 0) {
      const breaches = [];
      let brStart = -1;
      for (let i = 0; i < t.length; i++) {
        const oh = t[i].endOh;
        const burn = t[i].burn || 0;
        const target = bufferWeeks * burn;
        const inBreach = (oh >= 0 && target > 0 && oh < target);
        if (inBreach) {
          if (brStart < 0) brStart = i;
        } else if (brStart >= 0) {
          breaches.push({ startIdx: brStart, endIdx: i - 1 });
          brStart = -1;
        }
      }
      if (brStart >= 0) breaches.push({ startIdx: brStart, endIdx: t.length - 1 });
      for (const br of breaches) {
        // Report the week with the LOWEST cover across the run —
        // that's the moment the cushion is thinnest. Weeks in
        // units + weeks-of-cover.
        let minCover = Infinity;
        let minIdx = br.startIdx;
        for (let i = br.startIdx; i <= br.endIdx; i++) {
          const burn = t[i].burn || 0;
          const cover = burn > 0 ? t[i].endOh / burn : Infinity;
          if (cover < minCover) { minCover = cover; minIdx = i; }
        }
        const minOh = t[minIdx].endOh;
        const minBurn = t[minIdx].burn || 0;
        const targetAtMin = bufferWeeks * minBurn;
        warnings.push({
          pn: r.pn,
          pool: r.pool,
          severity: "buffer",
          breachStartIso: t[br.startIdx].iso,
          breachMinIso: t[minIdx].iso,
          firstStockoutMD: _fsMdFromIso(t[br.startIdx].iso),
          shortWeekCount: br.endIdx - br.startIdx + 1,
          minOh,
          minCoverWeeks: minCover === Infinity ? null : minCover,
          bufferTargetWeeks: bufferWeeks,
          bufferTargetUnits: targetAtMin,
        });
      }
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
//
// v4.1 onHandAtClose: preserved from the mirror when the incoming
// payload doesn't provide it (mirrors the writer's preservation
// semantics in setFrameScheduleWeekCloud). A caller writing only
// a snapshot (payload = {onHandAtClose:...}) keeps the row's qty
// and slot intact; a caller writing qty keeps the row's existing
// snapshot intact.
function _fsCommitWeek(iso, payload) {
  if (!DB.frameSchedule || !(DB.frameSchedule.weeks instanceof Map)) {
    DB.frameSchedule = { settings: null, weeks: new Map(), loaded: false };
  }
  const cur = DB.frameSchedule.weeks.get(iso) || {};
  const nextQty = ("qty" in payload) ? (payload.qty || {}) : (cur.qty || {});
  const nextSlot = ("slot" in payload) ? (payload.slot || null) : (cur.slot || null);
  const nextSnap = ("onHandAtClose" in payload) ? (payload.onHandAtClose || null) : (cur.onHandAtClose || null);
  DB.frameSchedule.weeks.set(iso, {
    qty: nextQty,
    slot: nextSlot,
    onHandAtClose: nextSnap,
    updatedAt: cur.updatedAt || null,
  });
  // The cloud writer applies the same preservation semantics —
  // send only the fields the caller populated so the write is
  // minimal + non-destructive.
  const outPayload = {};
  if ("qty" in payload) outPayload.qty = payload.qty;
  else outPayload.qty = cur.qty || {};
  if ("slot" in payload) outPayload.slot = payload.slot;
  else if (cur.slot) outPayload.slot = cur.slot;
  if ("onHandAtClose" in payload) outPayload.onHandAtClose = payload.onHandAtClose;
  else if (cur.onHandAtClose) outPayload.onHandAtClose = cur.onHandAtClose;
  _fsDebouncedWriteWeek(iso, outPayload);
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
function _fsIsOptimalPickForSlot(slot, rows, cols, slots, globalCaps, jointWinner, rateByPn) {
  const origPn = slot.resolvedPn;
  const origPn2 = slot.resolvedPn2 || null;   // v3.3: preserve split
  const origSource = slot.source;
  const origPool = slot.pool;

  const baseResult = _fsSimulate(rows, cols, slots, globalCaps, rateByPn);
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
    const result = _fsSimulate(rows, cols, slots, globalCaps, rateByPn);
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
function _fsPersistLockedCrossings(slots, cols, scheduledRuns, rows, globalCaps, jointWinner, visibleIsoSet, rateByPn) {
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
  // v4: cols may be simCols (20-week horizon) while writes MUST
  // stay scoped to the render window. Caller passes visibleIsoSet
  // for that. Falls back to cols-derived set for pre-v4 callers.
  const visibleIsos = visibleIsoSet || new Set(cols.map(c => c.iso));
  for (const s of slots) {
    if (!s.locked || !s.resolvedPn) continue;
    if (FRAMESCHED_STATE._autoPersistedSlots.has(s.startIso)) continue;
    if (s.persistedPn === s.resolvedPn) continue;

    if (!_fsIsOptimalPickForSlot(s, rows, cols, slots, globalCaps, jointWinner, rateByPn)) {
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

  // ── HISTORY GAP FIX ─────────────────────────────────────────────
  // For LOCKED slots (including seed), ensure the CURRENT week has
  // a persisted qty so that once the week rolls into "past" the
  // render's past-column reader has real numbers to show. Runs on
  // every render, gated only by "no persisted qty yet" — idempotent
  // once the current week has been quantified. No sanity-gate
  // needed: this pass persists QTY, not pn (pn was gated above).
  //
  // Degenerate caps: payload.qty is empty → skip write. So a
  // transient zero-caps render can't stamp a blank current week.
  const currentCol = cols.find(c => c.current);
  if (currentCol) {
    for (const s of slots) {
      if (!s.locked || !s.resolvedPn) continue;
      const idx = s.weekIsos.indexOf(currentCol.iso);
      if (idx < 0) continue;
      const wk = _fsWeekData(currentCol.iso);
      if (wk.qty && Object.keys(wk.qty).length > 0) continue;
      const payload = _fsBuildWeekPayload(currentCol.iso, scheduledRuns, s, idx === 0);
      if (payload.qty && Object.keys(payload.qty).length > 0) {
        _fsCommitWeek(currentCol.iso, payload);
      }
    }
  }

  // v4.1 ON-HAND SNAPSHOT — write today's actual on-hand for each
  // frame into the CURRENT week's row as data.onHandAtClose.
  // Never touches past weeks (their snapshot is already frozen).
  // Idempotent — a re-render just refreshes with the latest live
  // on-hand. When the week rolls into "past" next Monday, the
  // last render's snapshot becomes the closed-week reference for
  // downstream actual-burn math (Plan vs Actual on the history
  // panel). Behaves as the "one-time seed on first run" for a
  // brand-new tab: the FIRST render populates the field, and
  // subsequent renders refresh it.
  if (currentCol) {
    const snap = {};
    for (const r of rows) snap[r.pn] = Number(r.onHand) || 0;
    _fsCommitWeek(currentCol.iso, { onHandAtClose: snap });
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
function _fsFindStaleLocks(slots, rows, cols, globalCaps, currentSimResult, rateByPn) {
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
      const result = _fsSimulate(rows, cols, slots, globalCaps, rateByPn);
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
   TRUE-DEMAND PANEL

   Purely descriptive "how much do we ACTUALLY need each week to
   keep up with rate × 5 for every frame" view. No sim, no
   persistence — reads part.daily + part.onHand only.

   Per-pool comparison lines share this "sustained @ mix" idea:
   the one physical line can only run one pool at a time, so the
   sustainable weekly output of any pool is that pool's CAP scaled
   by its share of TOTAL frame demand.

     crewhd_sustained = crewhd_cap × (crewhd_demand / total_demand)
     std_sustained    = std_cap    × (std_demand    / total_demand)
                       + drop_in_spare × (crewhd_demand / total_demand)

   where drop_in_spare = max(0, std_cap − crewhd_cap) captures the
   fact that a CREW/HD-scheduled week has spare capacity that
   drops in as STD. The bottom line compares TOTAL demand to
   lineMax (= max(std_cap, crewhd_cap)) — that's the theoretical
   ceiling of a single-line run.
   ============================================================ */

function _fsBuildTrueDemandPanel(rows, globalCaps) {
  const crewhdCap = Number(globalCaps && globalCaps.crewhd) || 0;
  const stdCap    = Number(globalCaps && globalCaps.std)    || 0;
  const lineMax   = Math.max(crewhdCap, stdCap);

  // Per-frame burn + cover. Uses _fsDaily so chained frames report
  // their true chain rate (e.g. UT101002 = 0.61 chain vs 0.162
  // raw), not just their own PN slice — otherwise the panel
  // undercounts real demand.
  const perFrame = rows.map(r => {
    const daily = _fsDaily(r);
    const burn  = daily * FS_WORKDAYS_PER_WEEK;
    const oh    = Number(r.onHand) || 0;
    const cover = burn > 0 ? (oh / burn) : Infinity;
    return { pn: r.pn, pool: r.pool, short: FRAME_SHORT[r.pn] || "", burn, cover, oh };
  });

  // Pool subtotals.
  let crewhdDemand = 0;
  let stdDemand    = 0;
  for (const f of perFrame) {
    if (f.pool === "crewhd") crewhdDemand += f.burn;
    else if (f.pool === "std") stdDemand += f.burn;
  }
  const totalDemand = crewhdDemand + stdDemand;
  const crewhdShare = totalDemand > 0 ? crewhdDemand / totalDemand : 0;
  const stdShare    = totalDemand > 0 ? stdDemand    / totalDemand : 0;
  const dropInSpare = Math.max(0, stdCap - crewhdCap);
  const crewhdSustained = crewhdCap * crewhdShare;
  const stdSustained    = stdCap    * stdShare + dropInSpare * crewhdShare;

  // Per-frame table rows.
  const frameLinesHtml = perFrame.map(f => {
    const coverTxt = f.cover === Infinity ? "&mdash;" : `${f.cover.toFixed(1)} wk`;
    const poolPill = f.pool === "crewhd"
      ? `<span class="pill info tiny" style="margin-left:6px">CREW/HD</span>`
      : `<span class="pill muted tiny" style="margin-left:6px">STD</span>`;
    return `<tr>
      <td class="mono tiny"><strong>${esc(f.pn)}</strong>${f.short ? `<span class="muted"> &middot; ${esc(f.short)}</span>` : ""}${poolPill}</td>
      <td class="right mono tiny">${f.burn.toFixed(1)}/wk</td>
      <td class="right mono tiny muted">${coverTxt}</td>
    </tr>`;
  }).join("");

  // Formatter for "deficit / surplus X.X/wk"
  const deltaTxt = (need, sustained) => {
    const diff = sustained - need;
    const cls = diff >= 0 ? "fs-td-surplus" : "fs-td-deficit";
    const word = diff >= 0 ? "surplus" : "deficit";
    return `<span class="${cls}"><strong>${word}</strong> ${Math.abs(diff).toFixed(1)}/wk</span>`;
  };

  const crewhdLine = `CREW/HD: need <strong>${crewhdDemand.toFixed(1)}/wk</strong> &middot; cap ${crewhdCap}/wk &middot; sustained @ mix <strong>${crewhdSustained.toFixed(1)}/wk</strong> &middot; ${deltaTxt(crewhdDemand, crewhdSustained)}`;
  const stdLine    = `STD: need <strong>${stdDemand.toFixed(1)}/wk</strong> &middot; cap ${stdCap}/wk &middot; sustained @ mix <strong>${stdSustained.toFixed(1)}/wk</strong> &middot; ${deltaTxt(stdDemand, stdSustained)}`;

  const overLine = totalDemand > lineMax;
  const totalDiff = lineMax - totalDemand;
  const totalWord = totalDiff >= 0 ? "surplus" : "deficit";
  const bottomCls = overLine ? "fs-td-bottom fs-td-over" : "fs-td-bottom fs-td-under";
  const bottomLine = `<div class="${bottomCls}"><strong>Bottom line:</strong> line makes ~${lineMax}/wk, total frame demand ~${totalDemand.toFixed(1)}/wk &mdash; <strong>${totalWord} ${Math.abs(totalDiff).toFixed(1)}/wk</strong></div>`;

  return `
    <div class="fs-true-demand-panel">
      <div class="fs-warn-title">True demand &mdash; no capacity limit</div>
      <table class="fs-td-tbl">
        <thead>
          <tr>
            <th class="left mono tiny muted">frame</th>
            <th class="right mono tiny muted">burn</th>
            <th class="right mono tiny muted">weeks of cover</th>
          </tr>
        </thead>
        <tbody>${frameLinesHtml}</tbody>
      </table>
      <div class="fs-td-pool-line">${crewhdLine}</div>
      <div class="fs-td-pool-line">${stdLine}</div>
      ${bottomLine}
    </div>`;
}

/* ============================================================
   RENDER
   ============================================================ */

function renderFrameSchedule() {
  const rows = _fsRows();
  // v4 SIM vs RENDER cols: sim walks SIM_HORIZON_WEEKS ahead so
  // late-window stockouts influence today's slot picks; the grid
  // only renders the 14-col window (2 past + 12 future). Slots
  // are built off simCols so beyond-window slots exist; the render
  // naturally skips them when it iterates renderCols for cells.
  const renderCols = _fsColumns();
  const simCols = _fsSimColumns();
  const slots = _fsBuildSlots(simCols);
  const cols = renderCols;   // legacy alias — the render loop reads `cols`
  const globalCaps = _fsSettingsCaps();
  // v4 restrict the combinatorial enumeration to slots whose start
  // Monday is in the RENDER window — only visible slots are
  // persisted; beyond-window slots fall back to greedy inside the
  // sim (see _fsOptimize's beyondSlots handling).
  const visibleStartIsos = new Set(renderCols.map(c => c.iso));
  // v4.2 PERF: memoize the chain-aware daily rate per frame ONCE
  // per render. Every _fsSimulate call (~46k during Phase 1)
  // consults this map for the per-week burn — WITHOUT it, each
  // sim rebuilds its burn table via _fsDaily → chainDisplayDaily,
  // running millions of chain walks per render and hanging the
  // tab. See rateByPn comment inside _fsSimulate.
  const rateByPn = {};
  for (const r of rows) rateByPn[r.pn] = _fsDaily(r);
  // Optimizer replaces greedy per-slot pick for OPEN (no
  // resolvedPn at build time) slots. Locked+manual slots keep
  // their build-time pn; the optimizer treats them as fixed.
  // See _fsOptimize header for the score + tie-breakers.
  //
  // Sim runs WITHOUT PO credits — the schedule is the supply
  // plan. Open POs are surfaced info-only in the warning row
  // (below) via the PO-detail aggregator.
  const simResult = _fsOptimize(rows, simCols, slots, globalCaps, visibleStartIsos, rateByPn);
  const scheduledRuns = simResult.scheduledRuns;

  // Stale-lock detection: LOCKED auto/seed slots whose persisted
  // pn is materially worse than the alternative the optimizer
  // would pick today (delta > _FS_STALE_LOCK_DELTA stockout
  // units). Manual overrides excluded. Info-only tag; no auto-
  // unlock — the operator decides via console fsRepickSlot.
  const staleLocks = _fsFindStaleLocks(slots, rows, simCols, globalCaps, simResult, rateByPn);

  const weekToSlot = new Map();
  for (const s of slots) {
    for (const iso of s.weekIsos) weekToSlot.set(iso, s);
  }

  // Received-qty index: sum DB.poReceipts by (pn|weekIso). Consumed
  // by the RECEIPT HISTORY panel below (grid cells no longer show
  // "got N" — that annotation moved OFF the schedule grid so slot
  // content can't affect column widths). DB.poReceipts is READ
  // ONLY here — populated by _fetchAllPoReceipts (js/30). No iso
  // filter: the panel spans 8 past Mondays that may lie OUTSIDE
  // the grid's visible cols, and DB.poReceipts is already scoped
  // to 26 weeks by the fetch.
  const receivedByPnWeek = new Map();
  const _poReceipts = (typeof DB !== "undefined" && Array.isArray(DB.poReceipts)) ? DB.poReceipts : [];
  const _frameSet = new Set(FRAME_PNS);
  for (const rec of _poReceipts) {
    if (!rec || !rec.pn || !rec.weekIso) continue;
    if (!_frameSet.has(rec.pn)) continue;
    const key = rec.pn + "|" + rec.weekIso;
    receivedByPnWeek.set(key, (receivedByPnWeek.get(key) || 0) + (Number(rec.qty) || 0));
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
    // Full label + provenance goes in the title attribute for
    // hover reveal (item 7).
    //
    // Provenance fields:
    //   - span: "2-week slot" or "1-week slot (clipped at grid edge)"
    //   - lock date: slot start minus LOCK_HORIZON_DAYS (the day
    //     this slot enters the auto-lock horizon). Written as
    //     "auto-locks on MM/DD/YYYY" or "locked" if already past.
    //   - source: seed / auto / manual (already surfaced as a
    //     pill; included here for hover text too).
    //   - split (when set): both frame names + the reason our
    //     Phase-2 hill-climb adopted a split (only when it
    //     STRICTLY reduces stockout units).
    const spanText = span === 2 ? "2-week slot" : "1-week slot (clipped at grid edge)";
    let lockText = "";
    {
      const startMs = slot.startDate.getTime();
      const lockMs = startMs - LOCK_HORIZON_DAYS * 86400000;
      const lockDt = new Date(lockMs);
      lockDt.setHours(0, 0, 0, 0);
      const lockIso = _fsIsoMonday(new Date(lockMs));   // rough YYYY-MM-DD
      // We want the actual date the slot crossed into the lock
      // horizon, not its enclosing Monday. Format via component
      // math so the display isn't Monday-normalized.
      const yy = lockDt.getFullYear();
      const mm = String(lockDt.getMonth() + 1).padStart(2, "0");
      const dd = String(lockDt.getDate()).padStart(2, "0");
      lockText = slot.locked
        ? `locked (started tracking on ${mm}/${dd}/${yy})`
        : `auto-locks on ${mm}/${dd}/${yy}`;
      // silence unused var warning
      void lockIso;
    }
    const sourceText = slot.source === "seed"
      ? "seed run (mid-run before the anchor)"
      : slot.source === "manual"
      ? "manual override"
      : "auto (optimizer pick)";
    let splitText = "";
    if (isSplit) {
      const wholeName1 = `${slot.resolvedPn}${shortLabel ? " · " + shortLabel : ""}`;
      const short2 = FRAME_SHORT[slot.resolvedPn2] || "";
      const wholeName2 = `${slot.resolvedPn2}${short2 ? " · " + short2 : ""}`;
      splitText = ` · split: ${wholeName1} → ${wholeName2} (adopted by Phase-2 hill-climb only when it strictly reduces projected stockouts vs the whole-run alternative)`;
    }
    const bandTitle = `${labelForTitle} — ${spanText} — ${lockText} — ${sourceText}${splitText} — slot starts ${slot.startIso} (leftmost col: ${cols[bi].iso})`;
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
  //
  // Item 6: each nonzero cell carries an enriched tooltip:
  //   "<frame> · <week> · run 20 (cap 20) · projected on hand at
  //    week end: N"
  // built from the winning sim's onHandTimeline so the operator
  // can see the WHY behind every placement without opening
  // _fsDebugSim.
  const endOhByPnWeek = new Map();
  if (simResult && simResult.onHandTimeline instanceof Map) {
    for (const [pn, tl] of simResult.onHandTimeline.entries()) {
      for (const e of tl) endOhByPnWeek.set(pn + "|" + e.iso, e.endOh);
    }
  }
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
      if (kind === "filler") cls = " fs-filler";
      else if (q > 0) cls = " fs-run";

      // Rich tooltip (item 6). Rebuilds for every nonzero cell so
      // it stays in sync with the current sim's numbers.
      let title = "";
      if (q > 0) {
        const cap = r.pool === "crewhd" ? (globalCaps.crewhd || 0) : (globalCaps.std || 0);
        const endOh = endOhByPnWeek.has(r.pn + "|" + c.iso)
          ? Math.round(Number(endOhByPnWeek.get(r.pn + "|" + c.iso)))
          : null;
        const kindLabel = (kind === "filler") ? "filler" : "run";
        const capNote = kindLabel === "filler"
          ? " (STD spare capacity dropped in on a CREW/HD slot)"
          : ` (cap ${cap})`;
        const eohNote = endOh !== null ? ` · projected on hand at week end: ${endOh}` : "";
        const amberNote = amber ? ` · flag: two ${_fsPoolLabel(r.pool)} frames scheduled this week` : "";
        title = ` title="${esc(`${r.pn} · wk ${c.iso} · ${kindLabel} ${q}${capNote}${eohNote}${amberNote}`)}"`;
      } else if (amber) {
        title = ` title="Two ${_fsPoolLabel(r.pool)} frames scheduled this week — soft flag, doesn't block."`;
      }
      const amberStyle = amber ? ` style="background:rgba(255,181,71,0.22);"` : "";
      return `<td class="right num mono${cls}${dim}"${amberStyle}${title}>${q || ""}</td>`;
    }).join("");
    const poolTag = r.pool === "crewhd"
      ? `<span class="pill info tiny" style="margin-left:6px">CREW/HD</span>`
      : `<span class="pill muted tiny" style="margin-left:6px">STD</span>`;
    const missing = r.inCatalog ? "" :
      `<span class="pill warn tiny" style="margin-left:4px" title="Not in DB.parts — onHand and daily treated as 0.">missing</span>`;
    return `<tr id="fs-frame-row-${esc(r.pn)}" data-fs-pn="${esc(r.pn)}">
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
  //      Degenerate sim (zero caps or no runs placed) → "sim
  //      paused" instead of a misleading "all covered" (item 10).
  //      Each warning row is clickable → scroll + flash the
  //      matching frame row in the grid above (item 8).
  const _fsPoDetail = _fsDebugPOReceiptsDetailed(FRAME_PNS, cols);
  const warnings = _fsBuildWarnings(rows, simResult, _fsPoDetail);
  const _fsWarnDegenerate = _fsSimIsDegenerate(simResult, globalCaps);

  // v4.2 CONSOLIDATED COVERAGE PANEL — one row per frame, two
  // lines max. Red line only when stockouts exist; amber line
  // only when buffer breaches exist; fully-covered frames
  // absent. Frames with stockouts sort ahead of buffer-only
  // frames; ties break by earliest date / worst cover. Rows
  // beyond the first 6 collapse into a <details> disclosure so
  // a bad week doesn't drown out today's actionable rows.
  const _fsMonthAbbrev = iso => {
    if (!iso || typeof iso !== "string") return "";
    const m = Number(iso.split("-")[1]) || 0;
    const names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return names[m - 1] || "";
  };
  // Visible-window iso set = current + future render cols. Any
  // dip outside this set is beyond the 12 visible weeks and
  // renders as a dim month tag "(Dec)" instead of a full date.
  const _fsVisibleIsoSet = new Set(cols.filter(c => !c.past).map(c => c.iso));
  const _fsDateOrMonth = iso => {
    if (!iso) return "";
    if (_fsVisibleIsoSet.has(iso)) return _fsMdFromIso(iso);
    return `<span class="muted">(${_fsMonthAbbrev(iso)})</span>`;
  };

  let warningsPanel;
  if (_fsWarnDegenerate) {
    warningsPanel = `<div class="fs-warn-ok muted" style="opacity:0.7">Sim paused &mdash; caps missing/zero; coverage not evaluated.</div>`;
  } else if (warnings.length === 0) {
    warningsPanel = `<div class="fs-warn-ok">&#10003; All frames covered through the ${cols.filter(c => !c.past).length}-week window.</div>`;
  } else {
    // Group by frame.
    const byPn = new Map();
    for (const w of warnings) {
      let entry = byPn.get(w.pn);
      if (!entry) {
        entry = { pn: w.pn, pool: w.pool, stockouts: [], breaches: [] };
        byPn.set(w.pn, entry);
      }
      if (w.severity === "stockout") entry.stockouts.push(w);
      else if (w.severity === "buffer") entry.breaches.push(w);
    }
    // Sort: stockout frames first (by earliest stockout iso),
    // then buffer-only frames (by worst cover ascending — worst
    // = smallest number = most at risk).
    const stockoutFrames = [];
    const bufferOnlyFrames = [];
    for (const e of byPn.values()) {
      if (e.stockouts.length > 0) stockoutFrames.push(e);
      else bufferOnlyFrames.push(e);
    }
    stockoutFrames.sort((a, b) => {
      const aIso = a.stockouts.reduce((min, s) => s.firstStockoutIso < min ? s.firstStockoutIso : min, a.stockouts[0].firstStockoutIso);
      const bIso = b.stockouts.reduce((min, s) => s.firstStockoutIso < min ? s.firstStockoutIso : min, b.stockouts[0].firstStockoutIso);
      return aIso.localeCompare(bIso);
    });
    bufferOnlyFrames.sort((a, b) => {
      const aWorst = a.breaches.reduce((min, br) => (br.minCoverWeeks !== null && br.minCoverWeeks < min) ? br.minCoverWeeks : min, Infinity);
      const bWorst = b.breaches.reduce((min, br) => (br.minCoverWeeks !== null && br.minCoverWeeks < min) ? br.minCoverWeeks : min, Infinity);
      return aWorst - bWorst;
    });
    const orderedFrames = stockoutFrames.concat(bufferOnlyFrames);

    // Header count line: "N stockouts · M frames under cover target".
    // M includes stockout frames — every stockout is definitionally
    // below cover, and the operator wants the total count of frames
    // needing attention, not just the buffer-only subset.
    const nStockouts = stockoutFrames.length;
    const nUnderCover = orderedFrames.length;
    const bufferWeeksLabel = Number(_fsSettingsBufferWeeks()).toFixed(1);

    // Render one row per frame.
    const renderFrameRow = (e) => {
      const shortName = FRAME_SHORT[e.pn] || "";
      const poolTxt = _fsPoolLabel(e.pool);
      const headerHtml = `<div class="fs-warn-head">
        <span class="pill ${e.stockouts.length ? 'crit' : 'warn'} tiny" style="letter-spacing:0.05em">&#9888; ${esc(e.pn)}</span>
        ${shortName ? `<span class="muted tiny" style="margin-left:6px">&middot; ${esc(shortName)}</span>` : ""}
        ${poolTxt ? `<span class="muted tiny" style="margin-left:6px">&middot; ${esc(poolTxt)}</span>` : ""}
      </div>`;

      // Red line — aggregate: total short weeks across all
      // stockout dips; earliest start iso; "covered" tail from
      // the LAST dip's coveredAgainIso when every dip recovers,
      // else "not covered in window".
      let redLine = "";
      if (e.stockouts.length > 0) {
        const totalShort = e.stockouts.reduce((s, d) => s + d.shortWeekCount, 0);
        const sortedByStart = e.stockouts.slice().sort((a, b) => a.firstStockoutIso.localeCompare(b.firstStockoutIso));
        const firstIso = sortedByStart[0].firstStockoutIso;
        const anyUncovered = sortedByStart.some(d => !d.coveredAgainIso);
        let tailHtml;
        if (anyUncovered) {
          tailHtml = ` &mdash; <span class="muted">not covered in window</span>`;
        } else {
          const lastCovered = sortedByStart[sortedByStart.length - 1].coveredAgainIso;
          tailHtml = ` &mdash; covered ${_fsDateOrMonth(lastCovered)}`;
        }
        redLine = `<div class="fs-warn-line fs-warn-line-stockout">short <strong>${totalShort}</strong> wk from <strong>${_fsDateOrMonth(firstIso)}</strong>${tailHtml}</div>`;
      }

      // Amber line — worst 3 breaches (by cover ascending),
      // shown chronologically; "+N more" if truncated. All
      // covers formatted to 1 decimal.
      let amberLine = "";
      if (e.breaches.length > 0) {
        const withCover = e.breaches.filter(br => br.minCoverWeeks !== null && br.breachMinIso);
        const sortedWorst = withCover.slice().sort((a, b) => a.minCoverWeeks - b.minCoverWeeks);
        const picked = sortedWorst.slice(0, 3);
        picked.sort((a, b) => a.breachMinIso.localeCompare(b.breachMinIso));
        const truncated = withCover.length - picked.length;
        const dipStr = picked.map(br => {
          const dt = _fsDateOrMonth(br.breachMinIso);
          const cov = Number(br.minCoverWeeks).toFixed(1);
          return `${dt} (${cov}wk)`;
        }).join(" &middot; ");
        const moreTail = truncated > 0 ? ` &middot; <span class="muted">+${truncated} more</span>` : "";
        amberLine = `<div class="fs-warn-line fs-warn-line-buffer">below <strong>${bufferWeeksLabel}</strong> wk cover: ${dipStr}${moreTail}</div>`;
      }

      return `<div class="fs-warn-row" role="button" tabindex="0" style="cursor:pointer" onclick="_fsScrollToFrameRow('${esc(e.pn)}')" title="Click to jump to the ${esc(e.pn)} row in the schedule grid">
        ${headerHtml}
        ${redLine}
        ${amberLine}
      </div>`;
    };

    const headerLine = `<div class="fs-warn-summary muted tiny"><strong>${nStockouts}</strong> stockout${nStockouts === 1 ? "" : "s"} &middot; <strong>${nUnderCover}</strong> frame${nUnderCover === 1 ? "" : "s"} under cover target</div>`;

    // First 6 visible; beyond wrapped in <details>.
    const VISIBLE_ROW_CAP = 6;
    const visibleRows = orderedFrames.slice(0, VISIBLE_ROW_CAP).map(renderFrameRow).join("");
    const overflowFrames = orderedFrames.slice(VISIBLE_ROW_CAP);
    const overflowHtml = overflowFrames.length === 0
      ? ""
      : `<details class="fs-warn-more"><summary class="muted tiny">+${overflowFrames.length} more frame${overflowFrames.length === 1 ? "" : "s"}</summary>${overflowFrames.map(renderFrameRow).join("")}</details>`;

    warningsPanel = `${headerLine}${visibleRows}${overflowHtml}`;
  }

  // ---- Receipt History panel (scheduled vs received) ----
  // Off-grid overlay of the FULL history archive for FRAME_PNS.
  // Weeks span from the earliest known frame-schedule week OR
  // earliest FRAME_PN receipt (whichever is older) through the
  // LAST COMPLETED week. Newest on the LEFT, oldest on the right;
  // horizontally scrollable with the frame column sticky. Range
  // control narrows to 8 / 26 / all (default 26). CSV export
  // downloads frame,week,scheduled,received for the shown range,
  // with an optional detail toggle that switches to receipt-level
  // rows (one per RC line). Reads persisted qty for scheduled
  // (past weeks only ever have persisted qty — the sim skips past
  // cols) and receivedByPnWeek for received. NO persistence writes.
  //
  // Item 1: weeks with receipts but no schedule (pre-schedule
  // era) render "sched — · got N" so real deliveries surface even
  // when the planning tab hadn't started running yet.
  // Item 3: short weeks red-tinted, over-delivery amber-tinted;
  // per-frame tail exposes delivered %, cumulative variance, and
  // "weeks short" count; column footer sums all frames per week.
  // Item 4: buttons whose range exceeds available history are
  // disabled; header names the first week of history.
  const currentIso = (cols.find(c => c.current) || {}).iso || null;

  // Compute prev-Monday (Monday before current week). Fall back to
  // today's local Monday when no current col exists.
  let prevMondayAnchor;
  if (currentIso) {
    const currentCol = cols.find(c => c.current);
    prevMondayAnchor = (typeof addDays === "function")
      ? addDays(currentCol.date, -7)
      : new Date(currentCol.date.getTime() - 7 * 86400000);
  } else {
    prevMondayAnchor = new Date();
    prevMondayAnchor.setHours(0, 0, 0, 0);
    const back = (prevMondayAnchor.getDay() + 6) % 7;
    prevMondayAnchor.setDate(prevMondayAnchor.getDate() - back - 7);
  }
  prevMondayAnchor.setHours(0, 0, 0, 0);
  const prevMondayIso = _fsIsoMonday(prevMondayAnchor);

  // Earliest Monday = min of (persisted frame_schedule weeks with
  // any real frame qty, DB.poReceipts weeks for FRAME_PNS). Also
  // track earliestSchedIso separately so we can flag pre-schedule
  // cells as "sched —" rather than "sched 0" (item 1).
  let earliestIso = null;
  let earliestSchedIso = null;
  if (DB.frameSchedule && DB.frameSchedule.weeks instanceof Map) {
    for (const [iso, wk] of DB.frameSchedule.weeks.entries()) {
      if (!wk || !wk.qty) continue;
      let any = false;
      for (const pn of FRAME_PNS) { if (Number(wk.qty[pn]) > 0) { any = true; break; } }
      if (!any) continue;
      if (iso > prevMondayIso) continue;
      if (!earliestIso || iso < earliestIso) earliestIso = iso;
      if (!earliestSchedIso || iso < earliestSchedIso) earliestSchedIso = iso;
    }
  }
  for (const rec of _poReceipts) {
    if (!rec || !rec.pn || !rec.weekIso) continue;
    if (!_frameSet.has(rec.pn)) continue;
    if (rec.weekIso > prevMondayIso) continue;
    if (!earliestIso || rec.weekIso < earliestIso) earliestIso = rec.weekIso;
  }
  const hasAnyHistory = !!earliestIso;
  if (!earliestIso) earliestIso = prevMondayIso;

  // Build every Monday from earliestIso through prevMondayIso,
  // step 7 days. Then reverse for NEWEST-ON-LEFT display order.
  const historyIsosAsc = [];
  if (hasAnyHistory) {
    const start = parseDateLocal(earliestIso);
    start.setHours(0, 0, 0, 0);
    let d = new Date(start.getTime());
    // Safety cap: 10 years of weekly steps = 520 iterations.
    for (let steps = 0; steps < 520; steps++) {
      const iso = _fsIsoMonday(d);
      historyIsosAsc.push(iso);
      if (iso >= prevMondayIso) break;
      d = (typeof addDays === "function") ? addDays(d, 7) : new Date(d.getTime() + 7 * 86400000);
      d.setHours(0, 0, 0, 0);
    }
  }
  const allHistoryIsos = historyIsosAsc.slice().reverse();   // newest first (left)

  // Apply range filter — pure render slice. FRAMESCHED_STATE holds
  // the current selection so it survives re-renders (cap edits,
  // reconnect refresh) within the session.
  const range = FRAMESCHED_STATE._historyRange || "26";
  let visibleHistoryIsos;
  if (range === "all") {
    visibleHistoryIsos = allHistoryIsos;
  } else {
    const n = (range === "8") ? 8 : 26;
    visibleHistoryIsos = allHistoryIsos.slice(0, n);
  }

  const totalWeeks = allHistoryIsos.length;
  const shownWeeks = visibleHistoryIsos.length;

  // Empty-state: no history rows anywhere — the tab is new or the
  // sync hasn't landed yet. Skip the table entirely.
  let historyPanel;
  if (!hasAnyHistory) {
    historyPanel = `
      <div class="fs-history-panel">
        <div class="fs-warn-title">Receipt history &mdash; scheduled vs received</div>
        <div class="fs-hist-empty">No history yet &mdash; scheduled quantities and receipts will appear here once the daily PO-receipts sync has run and the schedule has recorded its first weekly qty.</div>
      </div>`;
  } else {
    // ---- Layout summary (redesign) ----
    // Columns L→R: Frame (sticky) · This wk (live, dim) · N week cols
    //   (newest→oldest) · Received tot · Scheduled tot · Δ · Delivered %
    //   · Wks short. Δ/%/short are only rendered when at least one
    //   scheduled week is in range for that frame — otherwise the
    //   panel becomes a wall of dashes for pre-schedule pn's.
    // Cells: number-over-number. Big received on top; small "/ N"
    //   scheduled beneath. Pre-schedule cells drop the "/ N" line.
    //   Nothing-nothing → single dim center dot. Whole-cell
    //   background encodes status. No text labels ("sched","got")
    //   in cells; a legend under the title carries the colors.
    // Accordion: click a cell → inline expansion row directly under
    //   the frame row with the receipts. One open at a time.
    const expanded = FRAMESCHED_STATE._expandedCell;

    // Column footer sums (all frames, per visible week).
    const colFooterSched = new Array(visibleHistoryIsos.length).fill(0);
    const colFooterRecv  = new Array(visibleHistoryIsos.length).fill(0);

    // Helper: pool pill (matches grid).
    const poolPill = pool => pool === "crewhd"
      ? `<span class="pill info tiny" style="margin-left:6px">CREW/HD</span>`
      : `<span class="pill muted tiny" style="margin-left:6px">STD</span>`;

    // Helper: numeric cell renderer.
    //   - Recv qty ONLY as the visible number. Whole-cell background
    //     encodes status. Short-week cells show a tiny "-N" corner
    //     (shortfall); over-delivery shows "+N". Nothing else in the
    //     cell — the browser-title attribute is intentionally omitted
    //     since the custom hover card carries the rich content.
    //   - data-fs-hist-* attrs are the tooltip's lookup keys.
    //   - tabindex="0" on interactive cells so the hover card fires
    //     on keyboard focus too.
    // `variant` in: "ok" | "short" | "over" | "pre" | "none".
    const cellHTML = (recv, sched, variant, clickable, pn, iso) => {
      const cls = "fs-hist-cell fs-cell-" + variant;
      const cur = clickable ? "cursor:pointer;" : "";
      const clickAttr = clickable
        ? ` onclick="_fsToggleReceiptDetails('${esc(pn)}','${esc(iso)}',event)"`
        : "";
      const focusAttrs = clickable ? ` tabindex="0"` : "";
      const isOpen = clickable && expanded && expanded.pn === pn && expanded.iso === iso;
      const openCls = isOpen ? " fs-cell-open" : "";
      const dataAttrs = ` data-fs-hist-pn="${esc(pn)}" data-fs-hist-iso="${esc(iso)}" data-fs-hist-variant="${variant}"`;
      let body;
      if (variant === "none") {
        body = `<span class="fs-cell-dot">&middot;</span>`;
      } else {
        // Recv qty is the primary. Corner badge only on short /
        // over cells — the one-glance shortfall / surplus number.
        let corner = "";
        if (variant === "short") {
          const short = Math.max(0, sched - recv);
          if (short > 0) corner = `<span class="fs-cell-corner fs-corner-short">&minus;${short}</span>`;
        } else if (variant === "over") {
          const surplus = recv - sched;
          if (surplus > 0) corner = `<span class="fs-cell-corner fs-corner-over">+${surplus}</span>`;
        }
        body = `<div class="fs-cell-primary">${recv}</div>${corner}`;
      }
      return `<td class="${cls}${openCls}" style="${cur}"${focusAttrs}${dataAttrs}${clickAttr}>${body}</td>`;
    };

    // Row per frame in FRAME_PNS order.
    const historyRows = [];
    // Column-index of any accordion expansion (used to know how
    // wide the drill-down row spans). Total = 1 sticky + 1 thiswk
    // + N week cols + tail cols (variable, computed below).
    for (const pn of FRAME_PNS) {
      const short = FRAME_SHORT[pn] || "";
      const pool = FRAME_POOL[pn] || "std";
      let winSched = 0;
      let winRecv = 0;
      let weeksShort = 0;
      let hasSchedInRange = false;

      // Week cells (newest → oldest).
      const weekCellHTML = visibleHistoryIsos.map((iso, colIdx) => {
        const wk = _fsWeekData(iso);
        const sched = Number(wk.qty && wk.qty[pn]) || 0;
        const recv = Number(receivedByPnWeek.get(pn + "|" + iso)) || 0;
        const preSchedule = earliestSchedIso ? (iso < earliestSchedIso) : true;
        const clickable = (sched > 0 || recv > 0);

        if (sched === 0 && recv === 0) {
          return cellHTML(0, 0, "none", false, pn, iso);
        }
        if (preSchedule) {
          colFooterRecv[colIdx] += recv;
          return cellHTML(recv, 0, "pre", clickable, pn, iso);
        }
        // Post-schedule counted week.
        hasSchedInRange = hasSchedInRange || (sched > 0);
        winSched += sched;
        winRecv += recv;
        colFooterSched[colIdx] += sched;
        colFooterRecv[colIdx] += recv;
        let variant;
        if (recv > sched) variant = "over";
        else if (recv < sched) { variant = "short"; weeksShort++; }
        else variant = "ok";
        return cellHTML(recv, sched, variant, clickable, pn, iso);
      }).join("");

      // "This wk" leftmost live column — dim, received so far.
      const thisWkRecv = currentIso ? (Number(receivedByPnWeek.get(pn + "|" + currentIso)) || 0) : 0;
      const thisWkClickable = !!currentIso && thisWkRecv > 0;
      const thisWkOpen = thisWkClickable && expanded && expanded.pn === pn && expanded.iso === currentIso;
      const thisWkCell = `<td class="fs-hist-cell fs-cell-thiswk${thisWkOpen ? " fs-cell-open" : ""}"
          style="${thisWkClickable ? 'cursor:pointer;' : ''}"
          ${currentIso ? `data-fs-hist-pn="${esc(pn)}" data-fs-hist-iso="${esc(currentIso)}" data-fs-hist-variant="thiswk"` : ""}
          ${thisWkClickable ? `tabindex="0"` : ""}
          ${thisWkClickable ? `onclick="_fsToggleReceiptDetails('${esc(pn)}','${esc(currentIso)}',event)"` : ""}>
          <div class="fs-cell-primary">${thisWkRecv}</div>
        </td>`;

      // Tails: Received total + Scheduled total always shown. Δ /
      // Delivered % / Wks short only shown when a scheduled week
      // exists in range (spec: "otherwise show just Received total
      // so the panel isn't a wall of dashes"). We keep Sched total
      // in that case too so the meaning of Received is anchored.
      // Tails also drop browser-title in favor of the custom
      // tooltip. Each tail carries data-fs-hist-tail plus the
      // per-row numeric context so the hover card can explain the
      // calc with the actual numbers filled in.
      // Simplify: N-with-schedule = count of visible isos where wk.qty[pn] > 0.
      let nWithSched = 0;
      for (const iso of visibleHistoryIsos) {
        const wk = _fsWeekData(iso);
        if (Number(wk.qty && wk.qty[pn]) > 0) nWithSched++;
      }
      const dataRow = ` data-fs-hist-pn="${esc(pn)}" data-fs-hist-recv="${winRecv}" data-fs-hist-sched="${winSched}" data-fs-hist-schedweeks="${nWithSched}" data-fs-hist-wksshort="${weeksShort}"`;
      const recvTotCell = `<td class="fs-hist-cell fs-tot-recv" data-fs-hist-tail="recv-tot"${dataRow} tabindex="0"><div class="fs-cell-primary"><strong>${winRecv}</strong></div></td>`;
      const schedTotCell = `<td class="fs-hist-cell fs-tot-sched" data-fs-hist-tail="sched-tot"${dataRow} tabindex="0"><div class="fs-cell-primary">${winSched}</div></td>`;
      let tailExtras = "";
      if (hasSchedInRange) {
        const variance = winRecv - winSched;
        const varSign = variance > 0 ? "+" : "";
        const varCls = variance > 0 ? "fs-cell-over" : variance < 0 ? "fs-cell-short" : "fs-cell-ok";
        const dPct = winSched > 0 ? Math.round((winRecv / winSched) * 100) : null;
        const pctCls = dPct === null ? "fs-cell-none" : (dPct >= 100 ? "fs-cell-ok" : "fs-cell-short");
        const shortCls = weeksShort > 0 ? "fs-cell-short" : "fs-cell-ok";
        tailExtras = `
          <td class="fs-hist-cell ${varCls}" data-fs-hist-tail="var"${dataRow} tabindex="0"><div class="fs-cell-primary">${varSign}${variance}</div></td>
          <td class="fs-hist-cell ${pctCls}" data-fs-hist-tail="pct"${dataRow} tabindex="0"><div class="fs-cell-primary">${dPct === null ? "&mdash;" : dPct + "%"}</div></td>
          <td class="fs-hist-cell ${shortCls}" data-fs-hist-tail="wks-short"${dataRow} tabindex="0"><div class="fs-cell-primary">${weeksShort}</div></td>`;
      } else {
        tailExtras = `
          <td class="fs-hist-cell fs-cell-none"><span class="fs-cell-dot">&middot;</span></td>
          <td class="fs-hist-cell fs-cell-none"><span class="fs-cell-dot">&middot;</span></td>
          <td class="fs-hist-cell fs-cell-none"><span class="fs-cell-dot">&middot;</span></td>`;
      }

      // v4.1 Plan /wk and Actual /wk — steady-state signals showing
      // whether the current burn plan matches reality. Plan = rate ×
      // 5 at the CURRENT week's Monday. Actual = mean of weekly
      // burns over the LAST 4 CLOSED weeks; each week's burn =
      // prevOnHandAtClose + received − onHandAtClose. Dimmed "—"
      // until ≥ 2 snapshots exist (needed to compute at least one
      // week's burn). Green when actual ≤ plan (cushion building);
      // red when actual > plan (burning faster than planned).
      //
      // NOTE: this block runs INSIDE `for (const pn of FRAME_PNS)` —
      // there is no loop var `r` in scope. Resolve the row for this
      // pn from `rows` (top-of-render _fsRows()). Prior bug pulled
      // `r` from an outer scope that no longer exists in this file.
      let rowForPn = null;
      for (const rr of rows) { if (rr.pn === pn) { rowForPn = rr; break; } }
      // Flat plan: chain-aware daily × 5 — chained frames (e.g.
      // UT101002) plot the rate the chain actually consumes, not
      // just their own PN slice. Rate steps intentionally
      // ignored. Pulls from the memoized rateByPn built once at
      // the top of render so this row doesn't chain-walk again.
      const planRate = Number(rateByPn[pn]) || 0;
      const planPerWeek = planRate * FS_WORKDAYS_PER_WEEK;
      const actualBurns = [];
      let snapshotCount = 0;
      if (currentIso) {
        // Walk back up to 4 closed weeks. Anchor = currentIso.
        for (let step = 1; step <= 4; step++) {
          const wkDate = parseDateLocal(currentIso);
          wkDate.setDate(wkDate.getDate() - step * 7);
          const wkIso = _fsIsoMonday(wkDate);
          const prevWkDate = new Date(wkDate.getTime());
          prevWkDate.setDate(prevWkDate.getDate() - 7);
          const prevIsoLocal = _fsIsoMonday(prevWkDate);
          const wk = _fsWeekData(wkIso);
          const prevWk = _fsWeekData(prevIsoLocal);
          const thisSnap = wk.onHandAtClose && Number.isFinite(Number(wk.onHandAtClose[pn]))
            ? Number(wk.onHandAtClose[pn]) : null;
          const prevSnap = prevWk.onHandAtClose && Number.isFinite(Number(prevWk.onHandAtClose[pn]))
            ? Number(prevWk.onHandAtClose[pn]) : null;
          if (thisSnap !== null) snapshotCount++;
          if (thisSnap !== null && prevSnap !== null) {
            const receivedThisWk = Number(receivedByPnWeek.get(pn + "|" + wkIso)) || 0;
            actualBurns.push({ iso: wkIso, val: prevSnap + receivedThisWk - thisSnap });
          }
        }
      }
      // Actual /wk = mean of collected values. Show dim "—" when
      // snapshotCount < 2 (per spec).
      let actualPerWeek = null;
      if (snapshotCount >= 2 && actualBurns.length > 0) {
        actualPerWeek = actualBurns.reduce((s, x) => s + x.val, 0) / actualBurns.length;
      }
      const planStr = Number(planPerWeek).toFixed(1);
      let planCell;
      let actualCell;
      if (planPerWeek > 0) {
        const planDataRow = ` data-fs-hist-plan="${planPerWeek.toFixed(3)}" data-fs-hist-actual="${actualPerWeek === null ? "" : actualPerWeek.toFixed(3)}" data-fs-hist-burns="${esc(JSON.stringify(actualBurns))}" data-fs-hist-pn="${esc(pn)}"`;
        planCell = `<td class="fs-hist-cell fs-tot-recv" data-fs-hist-tail="plan-wk"${planDataRow} tabindex="0"><div class="fs-cell-primary">${planStr}</div></td>`;
        if (actualPerWeek === null) {
          actualCell = `<td class="fs-hist-cell fs-cell-none" data-fs-hist-tail="actual-wk"${planDataRow} tabindex="0"><span class="fs-cell-dot">&mdash;</span></td>`;
        } else {
          const cls = actualPerWeek <= planPerWeek ? "fs-cell-ok" : "fs-cell-short";
          actualCell = `<td class="fs-hist-cell ${cls}" data-fs-hist-tail="actual-wk"${planDataRow} tabindex="0"><div class="fs-cell-primary">${actualPerWeek.toFixed(1)}</div></td>`;
        }
      } else {
        planCell = `<td class="fs-hist-cell fs-cell-none"><span class="fs-cell-dot">&middot;</span></td>`;
        actualCell = `<td class="fs-hist-cell fs-cell-none"><span class="fs-cell-dot">&middot;</span></td>`;
      }

      // Frame column: PN + short name + pool pill (grid parity).
      const frameCell = `<th class="fs-hist-sticky">
        <span class="mono">${esc(pn)}</span>${poolPill(pool)}
        ${short ? `<div class="muted tiny">${esc(short)}</div>` : ""}
      </th>`;

      historyRows.push(`<tr data-fs-hist-pn="${esc(pn)}">
        ${frameCell}
        ${thisWkCell}
        ${weekCellHTML}
        ${recvTotCell}
        ${schedTotCell}
        ${tailExtras}
        ${planCell}
        ${actualCell}
      </tr>`);

      // Accordion expansion row — INLINE under the frame row, spans
      // the entire table width. Only rendered when this frame row's
      // pn matches expanded.pn; a single row is open at a time.
      if (expanded && expanded.pn === pn) {
        // sticky + thisWk + weeks + 7 tail (recv, sched, Δ, %, wksShort, plan, actual)
        const totalCols = 1 + 1 + visibleHistoryIsos.length + 7;
        const rcRows = [];
        if (typeof DB !== "undefined" && Array.isArray(DB.poReceipts)) {
          for (const rec of DB.poReceipts) {
            if (!rec || rec.pn !== pn || rec.weekIso !== expanded.iso) continue;
            rcRows.push(rec);
          }
        }
        rcRows.sort((a, b) => {
          const d = String(a.receiptDate || "").localeCompare(String(b.receiptDate || ""));
          if (d !== 0) return d;
          return String(a.receiptNbr || "").localeCompare(String(b.receiptNbr || ""));
        });
        let running = 0;
        const rcTbody = rcRows.length === 0
          ? `<tr><td colspan="6" class="muted tiny" style="padding:8px">No receipts recorded for ${esc(pn)} · wk ${esc(_fsMdLongFromIso(expanded.iso))}.</td></tr>`
          : rcRows.map(r => {
              const q = Number(r.qty) || 0;
              running += q;
              const rcNum = r.receiptNbr || "";
              return `<tr>
                <td class="mono tiny">${esc(rcNum)}</td>
                <td class="mono tiny">${esc(r.poNum || "")}</td>
                <td class="mono tiny">${esc(r.receiptDate || "")}</td>
                <td class="right mono tiny">${q}</td>
                <td class="right mono tiny muted">${running}</td>
                <td class="mono tiny"><span class="fs-acc-copy" role="button" tabindex="0" title="Copy RC#" onclick="_fsCopyRc('${esc(rcNum)}',event)">copy</span></td>
              </tr>`;
            }).join("");
        const shortName = FRAME_SHORT[pn] || "";
        historyRows.push(`<tr class="fs-hist-accordion" data-fs-hist-pn="${esc(pn)}" data-fs-hist-iso="${esc(expanded.iso)}">
          <td colspan="${totalCols}">
            <div class="fs-acc-body">
              <div class="fs-acc-header">
                <span class="mono">${esc(pn)}</span>
                ${shortName ? `<span class="muted tiny" style="margin-left:6px">&middot; ${esc(shortName)}</span>` : ""}
                <span class="muted tiny" style="margin-left:8px">wk of ${esc(_fsMdLongFromIso(expanded.iso))}</span>
                <span class="pill muted tiny" role="button" tabindex="0" style="cursor:pointer;margin-left:auto;letter-spacing:0.05em" onclick="_fsToggleReceiptDetails('${esc(pn)}','${esc(expanded.iso)}',event)">close</span>
              </div>
              <table class="tbl fs-acc-tbl">
                <thead><tr><th>RC#</th><th>PO#</th><th>Date</th><th class="right">Qty</th><th class="right">Running</th><th></th></tr></thead>
                <tbody>${rcTbody}</tbody>
              </table>
            </div>
          </td>
        </tr>`);
      }
    }
    const historyRowsHTML = historyRows.join("");

    // Column footer row — all-frames received / scheduled per week
    // in the same number-over-number format. Empty tail cells so
    // colspan matches the header exactly (no colspan spanning that
    // could break sticky-header column alignment under some browsers).
    const footerCells = visibleHistoryIsos.map((iso, i) => {
      const s = colFooterSched[i];
      const r = colFooterRecv[i];
      if (s === 0 && r === 0) {
        return `<td class="fs-hist-cell fs-cell-none"><span class="fs-cell-dot">&middot;</span></td>`;
      }
      let variant;
      if (r > s) variant = "over";
      else if (r < s) variant = "short";
      else variant = "ok";
      return `<td class="fs-hist-cell fs-cell-${variant}" title="All frames: received ${r}, scheduled ${s}"><div class="fs-cell-primary">${r}</div><div class="fs-cell-secondary">/ ${s}</div></td>`;
    }).join("");
    const historyFoot = `
      <tfoot>
        <tr class="fs-hist-foot">
          <th class="fs-hist-sticky">All frames</th>
          <td class="fs-hist-cell fs-cell-none"><span class="fs-cell-dot">&middot;</span></td>
          ${footerCells}
          <td class="fs-hist-cell fs-cell-none"></td>
          <td class="fs-hist-cell fs-cell-none"></td>
          <td class="fs-hist-cell fs-cell-none"></td>
          <td class="fs-hist-cell fs-cell-none"></td>
          <td class="fs-hist-cell fs-cell-none"></td>
          <td class="fs-hist-cell fs-cell-none"></td>
          <td class="fs-hist-cell fs-cell-none"></td>
        </tr>
      </tfoot>`;

    // Header cells with a month-separator vertical line when the
    // month changes from the previous (right-neighbor, since we
    // render newest-first left→right — same month runs continue
    // together and the separator marks the older month boundary).
    // Full ISO in title.
    const historyHeadMD = visibleHistoryIsos.map((iso, i) => {
      const [y, m] = iso.split("-");
      const prevIso = i > 0 ? visibleHistoryIsos[i - 1] : null;
      const prevMonth = prevIso ? prevIso.split("-")[1] : null;
      const monthSep = (prevMonth && prevMonth !== m) ? " fs-hist-month-sep" : "";
      return `<th class="right${monthSep}" title="${esc(iso)}">${esc(_fsMdFromIso(iso))}</th>`;
    }).join("");

    // Range control — buttons disabled when their nominal range
    // exceeds available history. "all" never disabled. CSV
    // controls (detail toggle + button) unchanged.
    const rangeBtn = (label, val, disabled) => {
      const active = (range === val);
      if (disabled) {
        return `<span class="pill muted tiny" style="margin-left:4px;letter-spacing:0.05em;opacity:0.4;cursor:not-allowed" title="Only ${totalWeeks} wk of history available">${esc(label)}</span>`;
      }
      const cls = active ? "pill info tiny" : "pill muted tiny";
      return `<span class="${cls}" role="button" tabindex="0" style="cursor:pointer;margin-left:4px;letter-spacing:0.05em" onclick="_fsHandleHistoryRange('${val}')">${esc(label)}</span>`;
    };
    const csvDetail = !!FRAMESCHED_STATE._csvDetail;
    const rangeControl = `
      <div class="fs-history-controls">
        <span class="muted tiny">Show:</span>
        ${rangeBtn("last 8 wk", "8", totalWeeks < 8)}
        ${rangeBtn("26 wk", "26", totalWeeks < 26)}
        ${rangeBtn("all", "all", false)}
        <span class="muted tiny" style="margin-left:12px">${shownWeeks} of ${totalWeeks} wk shown</span>
        <label class="muted tiny" style="margin-left:auto;display:inline-flex;align-items:center;gap:4px;cursor:pointer" title="Include receipt-level rows (RC#, PO#, date, qty) in the CSV">
          <input type="checkbox" id="fs-hist-csv-detail" ${csvDetail ? "checked" : ""}
                 onchange="FRAMESCHED_STATE._csvDetail = this.checked">
          detail
        </label>
        <span class="pill muted tiny" role="button" tabindex="0" style="cursor:pointer;margin-left:8px;letter-spacing:0.05em" onclick="_fsDownloadHistoryCsv()" title="Download scheduled vs received for the shown range">Download CSV</span>
      </div>`;

    // Legend (redesign): one line under the title explaining the
    // whole-cell background colors — no per-cell text labels.
    const legend = `
      <div class="fs-hist-legend muted tiny">
        <span class="fs-legend-swatch fs-cell-ok"></span> met
        <span class="fs-legend-swatch fs-cell-short"></span> short
        <span class="fs-legend-swatch fs-cell-over"></span> over
        <span class="fs-legend-swatch fs-cell-pre"></span> pre-schedule receipt
        <span class="fs-legend-swatch fs-cell-none"></span> no schedule
      </div>`;

    const headerNote = `
      <div class="fs-hist-header-note muted tiny">
        history from ${esc(_fsMdLongFromIso(historyIsosAsc[0]))}
      </div>`;

    historyPanel = `
      <div class="fs-history-panel">
        <div class="fs-warn-title">Receipt history &mdash; scheduled vs received</div>
        ${legend}
        ${headerNote}
        ${rangeControl}
        <div class="tbl-wrap fs-history-wrap" style="overflow:auto">
          <table class="tbl fs-history-tbl">
            <colgroup>
              <col class="fs-hist-col-sticky">
              <col class="fs-hist-col-thiswk">
              ${visibleHistoryIsos.map(() => `<col class="fs-hist-col-week">`).join("")}
              <col class="fs-hist-col-tot">
              <col class="fs-hist-col-tot">
              <col class="fs-hist-col-var">
              <col class="fs-hist-col-pct">
              <col class="fs-hist-col-short">
              <col class="fs-hist-col-tot">
              <col class="fs-hist-col-tot">
            </colgroup>
            <thead>
              <tr>
                <th class="fs-hist-sticky">Frame</th>
                <th class="right" title="Received so far in the current week">This wk</th>
                ${historyHeadMD}
                <th class="right" title="Received across the shown range">Received</th>
                <th class="right" title="Scheduled across the shown range">Scheduled</th>
                <th class="right" title="Cumulative received − scheduled">&Delta;</th>
                <th class="right" title="Received / scheduled × 100">Delivered %</th>
                <th class="right" title="Weeks where received &lt; scheduled">Wks short</th>
                <th class="right" title="Planned burn per week = rate × 5 (updated with any active rate step)">Plan /wk</th>
                <th class="right" title="Actual burn per week over the last 4 closed weeks (prev on-hand + received − on-hand)">Actual /wk</th>
              </tr>
            </thead>
            <tbody>
              ${historyRowsHTML}
            </tbody>
            ${historyFoot}
          </table>
        </div>
        <div id="fs-hist-tooltip" class="fs-tt" hidden></div>
      </div>`;
  }
  // Install the tooltip delegated listeners once. Safe to call
  // on every render — the guard flag makes it a no-op after the
  // first attach.
  _fsInstallHistTooltip();

  // Global caps input strip in the page head. Changes go through
  // setFrameScheduleSettingsCloud (optimistic mirror + revert)
  // and re-run the sim so proposed slots reflect the new cap;
  // locked slots keep their persisted qty.
  // Item 9: Enter commits the value (blur → onchange chain fires).
  // preventDefault stops a form submission side effect; blur is
  // what actually triggers the settings write via onchange.
  const capKeyHandler = `onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}"`;
  const currentBufferWeeks = _fsSettingsBufferWeeks();
  const globalCapsInputs = `
    <div class="fs-global-caps">
      <label class="fs-caps-label">
        <span class="muted tiny">CREW/HD cap /wk</span>
        <input id="fs-cap-crewhd" type="number" step="1" min="0" value="${globalCaps.crewhd}"
               class="input mono fs-caps-input"
               ${capKeyHandler}
               onchange="_fsHandleSettingsCap('crewhd', this.value)">
      </label>
      <label class="fs-caps-label">
        <span class="muted tiny">STD cap /wk</span>
        <input id="fs-cap-std" type="number" step="1" min="0" value="${globalCaps.std}"
               class="input mono fs-caps-input"
               ${capKeyHandler}
               onchange="_fsHandleSettingsCap('std', this.value)">
      </label>
      <label class="fs-caps-label" title="Optimizer keeps end-of-week on-hand at or above bufferWeeks × week's burn per frame when possible. 0 = feature off. Persisted in the __settings__ row.">
        <span class="muted tiny">Min cover (weeks)</span>
        <input id="fs-cap-buffer-weeks" type="number" step="0.5" min="0" value="${currentBufferWeeks}"
               class="input mono fs-caps-input"
               ${capKeyHandler}
               onchange="_fsHandleSettingsBufferWeeks(this.value)">
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
      /* Receipt-status color palette — reused by the Receipt History
         panel below. Grid cells no longer carry these classes; the
         overlay lives entirely in its own table. */
      .fs-got-ok      { color: var(--ok, #4bcc80); }
      .fs-got-short   { color: var(--crit, #ff6b6b); }
      .fs-got-none    { color: var(--t2); opacity: 0.55; }
      .fs-got-current { color: var(--t2); opacity: 0.70; font-style: italic; }
      /* Receipt History panel — separate fixed-layout table so slot
         content in the schedule grid can never affect its widths.
         Numeric cells (no text labels). Whole-cell background
         encodes status; see the legend under the panel title. */
      .fs-history-panel { padding:10px 12px; background:var(--bg-1); border-radius:6px; margin-top:12px; }
      .fs-history-tbl { table-layout: fixed; border-collapse: separate; border-spacing: 0; }
      .fs-history-tbl th, .fs-history-tbl td { white-space: nowrap; padding: 3px 6px; vertical-align: middle; }
      .fs-history-tbl thead th { position: sticky; top: 0; background: var(--bg-1); z-index: 3; border-bottom: 1px solid var(--line); font-size: 10px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--t2); }
      .fs-history-tbl th.right { text-align: right; }
      .fs-hist-col-sticky { width: 240px; }
      .fs-hist-col-week   { width: 72px; }
      .fs-hist-col-thiswk { width: 84px; }
      .fs-hist-col-tot    { width: 84px; }
      .fs-hist-col-pct    { width: 96px; }
      .fs-hist-col-var    { width: 76px; }
      .fs-hist-col-short  { width: 88px; }
      .fs-hist-sticky { position: sticky; left: 0; background: var(--bg-1); z-index: 4; width: 240px; text-align: left; }
      .fs-history-tbl thead .fs-hist-sticky { z-index: 5; }
      /* Numeric cells — single received number + optional corner
         badge (short/over). Position relative so the corner can
         anchor absolutely inside the cell. */
      .fs-hist-cell { position: relative; text-align: right; overflow: hidden; font-size: 12px; line-height: 1.05; }
      .fs-hist-cell:focus { outline: 2px solid var(--info, #6ab0ff); outline-offset: -2px; }
      .fs-cell-primary { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; font-size: 14px; font-weight: 500; }
      .fs-cell-secondary { font-size: 10px; opacity: 0.65; font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
      .fs-cell-dot { color: var(--t2); opacity: 0.35; font-size: 14px; }
      .fs-cell-corner { position: absolute; top: 1px; left: 3px; font-size: 9px; font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; letter-spacing: 0.02em; opacity: 0.85; }
      .fs-corner-short { color: var(--crit, #e05a5a); }
      .fs-corner-over  { color: #b57828; }
      /* Whole-cell background per status */
      .fs-cell-ok    { background: rgba(80,180,120,0.14); }
      .fs-cell-short { background: rgba(220,60,60,0.18); }
      .fs-cell-over  { background: rgba(255,181,71,0.20); }
      .fs-cell-pre   { background: rgba(120,140,200,0.10); }
      .fs-cell-none  { background: transparent; }
      .fs-cell-thiswk { background: rgba(120,140,200,0.10); font-style: italic; }
      .fs-cell-open { outline: 2px solid var(--info, #6ab0ff); outline-offset: -2px; }
      /* Month separator — vertical line in the header where the
         month boundary falls (body/footer cells left unmarked to
         keep the visual quiet; the header is where the reader
         orients themselves). */
      .fs-hist-month-sep { border-left: 2px solid var(--line); }
      /* Legend */
      .fs-hist-legend { padding: 4px 4px 2px 4px; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: 11px; }
      .fs-legend-swatch { display: inline-block; width: 12px; height: 10px; border-radius: 2px; vertical-align: -1px; margin-right: 4px; border: 1px solid var(--line-soft); }
      .fs-legend-swatch.fs-cell-none { background: transparent; }
      /* Controls + header note (unchanged) */
      .fs-history-controls { display:flex; align-items:center; gap:2px; padding:2px 4px 8px 4px; font-size:11px; }
      .fs-hist-header-note { padding:2px 4px 6px 4px; font-size:11px; }
      .fs-hist-empty { padding: 12px 8px; font-size: 12px; color: var(--t2); font-style: italic; }
      /* Footer row: same number-over-number look, subtle separator */
      .fs-hist-foot td, .fs-hist-foot th { border-top: 2px solid var(--line); background: rgba(120,140,200,0.06); font-weight: 600; }
      .fs-hist-foot .fs-cell-primary { font-weight: 600; }
      /* Accordion */
      .fs-hist-accordion > td { background: rgba(120,140,200,0.08); border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 8px 12px; }
      .fs-acc-body { display: flex; flex-direction: column; gap: 6px; }
      .fs-acc-header { display: flex; align-items: center; gap: 4px; padding-bottom: 4px; border-bottom: 1px solid var(--line-soft); }
      .fs-acc-tbl th, .fs-acc-tbl td { padding: 3px 8px; }
      .fs-acc-tbl thead th { border-bottom: 1px solid var(--line-soft); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--t2); }
      .fs-acc-copy { color: var(--info, #6ab0ff); cursor: pointer; text-decoration: underline; }
      .fs-acc-copy:hover { opacity: 0.8; }
      /* Custom hover card for cells + tail cells. Fixed position
         so overflow containers can't clip it. Instant appearance
         (no transition) — the browser-title behavior it replaces
         has ~700ms latency that felt sluggish. */
      .fs-tt {
        position: fixed;
        z-index: 200;
        min-width: 240px;
        max-width: 340px;
        padding: 8px 10px;
        border-radius: 6px;
        background: var(--bg-2, #1a1e26);
        border: 1px solid var(--line, #33384a);
        box-shadow: 0 8px 24px rgba(0,0,0,0.42);
        font-size: 11px;
        line-height: 1.35;
        color: var(--t, #e7eaf0);
        pointer-events: none;
      }
      .fs-tt-header { padding-bottom: 4px; margin-bottom: 4px; border-bottom: 1px solid var(--line-soft, #2a2f3d); font-size: 12px; }
      .fs-tt-row { display: flex; justify-content: space-between; gap: 12px; padding: 1px 0; }
      .fs-tt-label { color: var(--t2); }
      .fs-tt-value { font-family: var(--font-mono, monospace); font-variant-numeric: tabular-nums; }
      .fs-tt-ok    { color: var(--ok, #4bcc80); }
      .fs-tt-short { color: var(--crit, #e05a5a); }
      .fs-tt-over  { color: #d9a03a; }
      .fs-tt-pre   { color: #8fa5d9; }
      .fs-tt-hint  { margin-top: 6px; padding-top: 4px; border-top: 1px solid var(--line-soft, #2a2f3d); font-size: 10px; }
      .fs-tt-body  { padding: 2px 0; font-family: var(--font-mono, monospace); }
      /* Warning row → frame row flash */
      @keyframes fs-row-flash-anim {
        0%   { background: rgba(255,181,71,0.35); }
        60%  { background: rgba(255,181,71,0.35); }
        100% { background: transparent; }
      }
      .fs-row-flash > * { animation: fs-row-flash-anim 1.4s ease-out; }
      .fs-warn-row:hover { background: rgba(120,140,200,0.06); }
      .fs-global-caps { display:flex; align-items:center; gap:14px; padding:10px 12px; background:var(--bg-1); border-radius:6px; margin-bottom:12px; }
      .fs-caps-label { display:flex; flex-direction:column; gap:2px; }
      .fs-caps-input { width: 84px; text-align: right; font-variant-numeric: tabular-nums; }
      .fs-warnings-panel { padding:10px 12px; background:var(--bg-1); border-radius:6px; margin-top:12px; }
      /* True-Demand panel — reads part.daily + part.onHand only,
         no sim, no persistence. Sits above Coverage Warnings. */
      .fs-true-demand-panel { padding:10px 12px; background:var(--bg-1); border-radius:6px; margin-top:12px; }
      .fs-true-demand-panel .fs-warn-title { font-size:11px; letter-spacing:0.06em; text-transform:uppercase; color: var(--t2); margin-bottom:6px; }
      .fs-td-tbl { border-collapse:collapse; margin: 4px 0 6px 0; }
      .fs-td-tbl th, .fs-td-tbl td { padding: 2px 10px 2px 0; text-align:left; }
      .fs-td-tbl th.right, .fs-td-tbl td.right { text-align:right; }
      .fs-td-pool-line { font-size:12px; padding: 2px 0; }
      .fs-td-bottom { font-size:12px; padding: 6px 0 0 0; border-top: 1px solid var(--line-soft); margin-top: 4px; }
      .fs-td-bottom.fs-td-over  { color: var(--crit, #e05a5a); font-weight: 600; }
      .fs-td-bottom.fs-td-under { color: var(--ok, #4bcc80); }
      .fs-td-surplus { color: var(--ok, #4bcc80); }
      .fs-td-deficit { color: var(--crit, #e05a5a); }
      .fs-warn-ok { color: var(--ok, #4bcc80); font-size:12px; font-weight:600; }
      .fs-warn-row { font-size:12px; padding:4px 0; border-bottom:1px solid var(--line-soft); }
      .fs-warn-row:last-child { border-bottom:0; }
      /* v4: buffer-breach rows are amber, distinct from red stockouts */
      .fs-warn-buffer { color: var(--warn, #d9a03a); }
      /* v4.2 consolidated panel — one row per frame, two lines max */
      .fs-warn-summary { padding: 2px 0 6px 0; font-size:11px; letter-spacing:0.04em; }
      .fs-warn-head { display:flex; align-items:center; gap:2px; font-size:12px; }
      .fs-warn-line { font-size:12px; padding: 1px 0 1px 20px; line-height:1.35; }
      .fs-warn-line-stockout { color: var(--crit, #e05a5a); }
      .fs-warn-line-buffer   { color: var(--warn, #d9a03a); }
      .fs-warn-more { margin-top: 4px; }
      .fs-warn-more > summary { cursor: pointer; padding: 4px 0; list-style: revert; }
      .fs-warn-more[open] > summary { margin-bottom: 2px; }
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

      ${_fsBuildTrueDemandPanel(rows, globalCaps)}

      <div class="fs-warnings-panel">
        <div class="fs-warn-title">Coverage warnings</div>
        ${warningsPanel}
      </div>

      ${historyPanel}
    </div>`;

  // Fire persistence for LOCKED slots that just crossed the 42-day
  // line (or whose persisted pn no longer matches the sim). One
  // write per new crossing per session, GATED by the per-slot
  // sanity check — see _fsIsOptimalPickForSlot. jointWinner=true
  // because this call is IMMEDIATELY after _fsOptimize in the same
  // render tick — the gate accepts local ties in that context.
  _fsPersistLockedCrossings(slots, simCols, scheduledRuns, rows, globalCaps, /* jointWinner */ true, visibleStartIsos, rateByPn);
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
  // v4.1: preserve current bufferWeeks through a caps edit so
  // toggling a cap doesn't wipe the min-cover setting.
  nextCaps.bufferWeeks = _fsSettingsBufferWeeks();

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
    const renderCols = _fsColumns();
    const simCols = _fsSimColumns();
    const slots = _fsBuildSlots(simCols);
    const visibleStartIsos = new Set(renderCols.map(c => c.iso));
    // Memoize chain-aware rate ONCE — see renderFrameSchedule comment.
    const rateByPn = {};
    for (const r of rows) rateByPn[r.pn] = _fsDaily(r);
    const simResult = _fsOptimize(rows, simCols, slots, nextCaps, visibleStartIsos, rateByPn);
    const cols = renderCols;   // used by the futureIsoSet builder below
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
    if (res && res.ok) {
      const tail = requantifiedCount
        ? ` · re-quantified ${requantifiedCount} locked wk`
        : "";
      if (typeof logAudit === "function") {
        logAudit("frame-sched-edit",
          `Frame schedule: global ${_fsPoolLabel(pool)} cap = ${n}/wk${tail}`,
          { pool, cap: n, requantifiedWeeks: requantifiedCount });
      }
      // Item 9: toast confirms the write landed and how many
      // downstream weeks it re-quantified. showToast is defined
      // app-wide (see js/24, js/22). Guarded for absence.
      if (typeof showToast === "function") {
        showToast(`Caps saved · ${requantifiedCount} future wk re-quantified`, "ok");
      }
    } else if (typeof showToast === "function") {
      showToast("Cap change failed to save — check connection", "warn");
    }
  });

  // Optimistic mirror update happened inside setFrameScheduleSettingsCloud
  // (before the RPC), so this render sees the new value immediately.
  renderFrameSchedule();
}

// Receipt History range control — flip the visible slice and
// re-render. Values: "8" | "26" | "all". Pure display state, no
// PIN gate (nothing writes to shared stores). Unknown values are
// clamped to "26" so a bad inline value can't wedge the panel.
function _fsHandleHistoryRange(val) {
  const allowed = new Set(["8", "26", "all"]);
  FRAMESCHED_STATE._historyRange = allowed.has(String(val)) ? String(val) : "26";
  renderFrameSchedule();
}

// v4.1 Min-cover (weeks) input handler. Persists bufferWeeks
// through setFrameScheduleSettingsCloud (js/30 accepts the field
// alongside caps). Snaps to 0.5-step increments; anything else
// rounds down. Optimistic mirror (via the writer) + immediate
// re-render so the optimizer picks up the new target on the same
// tick.
function _fsHandleSettingsBufferWeeks(raw) {
  if (typeof gateEdit === "function" && !gateEdit()) return;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return;
  // Snap to nearest 0.5.
  const bufferWeeks = Math.max(0, Math.round(parsed * 2) / 2);
  // Session-local fallback so a live change is visible even if
  // the cloud write is in flight or fails; the reader prefers
  // cloud when it arrives.
  FRAMESCHED_STATE._bufferWeeks = bufferWeeks;
  const cur = _fsSettingsCaps();
  if (typeof setFrameScheduleSettingsCloud === "function") {
    setFrameScheduleSettingsCloud({ crewhd: cur.crewhd, std: cur.std, bufferWeeks })
      .then(res => {
        if (res && res.ok) {
          if (typeof logAudit === "function") {
            logAudit("frame-sched-edit", `Frame schedule: min cover = ${bufferWeeks} wk`, { bufferWeeks });
          }
          if (typeof showToast === "function") {
            showToast(`Min cover set to ${bufferWeeks} wk`, "ok");
          }
        } else if (typeof showToast === "function") {
          showToast("Min cover save failed — check connection", "warn");
        }
      });
  }
  renderFrameSchedule();
}

// Receipt-history drill-down — INLINE accordion.
//
// Click a cell → open an expansion row directly under that frame
// row listing the RC lines behind the number (RC#, PO#, date, qty,
// running total, plus a copy-RC# link). One open at a time; click
// the same cell again OR press Escape to close.
//
// State lives on FRAMESCHED_STATE._expandedCell = {pn, iso} | null.
// The render pass reads it and injects the extra <tr> at the
// right point; nothing else is DOM-mutated here — the toggle just
// flips state and re-renders.
function _fsToggleReceiptDetails(pn, iso, evt) {
  if (evt && typeof evt.stopPropagation === "function") evt.stopPropagation();
  const cur = FRAMESCHED_STATE._expandedCell;
  if (cur && cur.pn === pn && cur.iso === iso) {
    FRAMESCHED_STATE._expandedCell = null;
  } else {
    FRAMESCHED_STATE._expandedCell = { pn, iso };
  }
  // Install the Escape listener once per session so subsequent
  // re-renders don't stack it.
  if (!FRAMESCHED_STATE._accordionEscInstalled) {
    document.addEventListener("keydown", e => {
      if (e.key !== "Escape") return;
      if (!FRAMESCHED_STATE._expandedCell) return;
      FRAMESCHED_STATE._expandedCell = null;
      renderFrameSchedule();
    });
    FRAMESCHED_STATE._accordionEscInstalled = true;
  }
  renderFrameSchedule();
}

// Copy an RC# to the clipboard from the accordion's "copy" link.
// Best-effort — falls back to a hidden textarea when the async
// Clipboard API is unavailable. Uses the app's showToast when
// present to confirm.
function _fsCopyRc(rcNum, evt) {
  if (evt && typeof evt.stopPropagation === "function") evt.stopPropagation();
  if (!rcNum) return;
  const done = ok => {
    if (typeof showToast === "function") {
      showToast(ok ? `Copied ${rcNum}` : "Copy failed", ok ? "ok" : "warn");
    }
  };
  try {
    if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(String(rcNum)).then(() => done(true), () => done(false));
      return;
    }
  } catch (_) { /* fall through */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = String(rcNum);
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand("copy");
    document.body.removeChild(ta);
    done(!!ok);
  } catch (_) {
    done(false);
  }
}

// Custom Receipt-History tooltip.
//
// Replaces the browser `title` attribute for history cells so we
// can render a multi-line, styled hover card that:
//   - matches the app's dark UI (rather than the OS's tooltip),
//   - appears INSTANTLY on hover/focus (no ~700ms browser delay),
//   - is anchored to the cell (not the cursor) so it doesn't jitter,
//   - fires on keyboard focus for accessibility.
//
// Wiring: a single hidden <div id="fs-hist-tooltip"> lives inside
// the panel. We install DELEGATED listeners on document once and
// switch on `data-fs-hist-*` attrs on the target.
//
// Content builders:
//   - Cells (data-fs-hist-pn + data-fs-hist-iso): frame · week /
//     sched · received (with count) · variance · run-kind · click hint.
//   - Tails (data-fs-hist-tail): explains the metric with the row's
//     numeric context filled in.
function _fsInstallHistTooltip() {
  if (FRAMESCHED_STATE._tooltipInstalled) return;
  FRAMESCHED_STATE._tooltipInstalled = true;

  const isTargetable = el => !!(el && el.getAttribute && (
    el.getAttribute("data-fs-hist-pn") ||
    el.getAttribute("data-fs-hist-tail")
  ));
  const findTargetable = el => {
    while (el && el !== document.body) {
      if (isTargetable(el)) return el;
      el = el.parentElement;
    }
    return null;
  };
  document.addEventListener("mouseover", e => {
    const t = findTargetable(e.target);
    if (!t) return;
    _fsHistTooltipShow(t);
  });
  document.addEventListener("mouseout", e => {
    const t = findTargetable(e.target);
    if (!t) return;
    // Only hide when the pointer actually leaves the targetable
    // cell (not when it moves between the cell's inner children).
    const rel = e.relatedTarget;
    if (rel && (t === rel || t.contains(rel))) return;
    _fsHistTooltipHide();
  });
  document.addEventListener("focusin", e => {
    const t = findTargetable(e.target);
    if (!t) return;
    _fsHistTooltipShow(t);
  });
  document.addEventListener("focusout", e => {
    const t = findTargetable(e.target);
    if (!t) return;
    _fsHistTooltipHide();
  });
}

function _fsHistTooltipShow(target) {
  const tt = document.getElementById("fs-hist-tooltip");
  if (!tt || !target) return;
  const tail = target.getAttribute("data-fs-hist-tail");
  const pn = target.getAttribute("data-fs-hist-pn");
  const iso = target.getAttribute("data-fs-hist-iso");
  const variant = target.getAttribute("data-fs-hist-variant");
  let html = "";
  if (tail) {
    html = _fsHistTooltipHtmlTail(tail, target);
  } else if (pn && iso) {
    html = _fsHistTooltipHtmlCell(pn, iso, variant);
  }
  if (!html) return;
  tt.innerHTML = html;
  tt.hidden = false;
  // Anchor to the target's bounding rect (not the mouse) so the
  // card doesn't jitter as the cursor moves inside the cell.
  const r = target.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const w = tt.offsetWidth || 260;
  const h = tt.offsetHeight || 140;
  // Prefer above the cell; drop below if there's no room.
  let top = r.top - h - 8;
  if (top < 8) top = Math.min(vh - h - 8, r.bottom + 8);
  let left = r.left + Math.max(0, (r.width - w) / 2);
  if (left + w > vw - 8) left = vw - w - 8;
  if (left < 8) left = 8;
  tt.style.left = left + "px";
  tt.style.top  = top + "px";
}

function _fsHistTooltipHide() {
  const tt = document.getElementById("fs-hist-tooltip");
  if (tt) tt.hidden = true;
}

function _fsHistTooltipHtmlCell(pn, iso, variant) {
  const short = FRAME_SHORT[pn] || "";
  const wk = _fsWeekData(iso);
  const sched = Number(wk.qty && wk.qty[pn]) || 0;
  // Live recv sum from DB.poReceipts (cheap; ~few hundred rows).
  let recv = 0;
  let receiptCount = 0;
  if (typeof DB !== "undefined" && Array.isArray(DB.poReceipts)) {
    for (const rec of DB.poReceipts) {
      if (!rec || rec.pn !== pn || rec.weekIso !== iso) continue;
      recv += Number(rec.qty) || 0;
      receiptCount++;
    }
  }
  const preSchedule = variant === "pre";
  const noData = variant === "none";
  const thisWk = variant === "thiswk";
  const row = (label, value, cls) =>
    `<div class="fs-tt-row"><span class="fs-tt-label">${label}</span><span class="fs-tt-value${cls ? ' ' + cls : ''}">${value}</span></div>`;
  const header = `<div class="fs-tt-header">
    <span class="mono">${esc(pn)}</span>${short ? ` <span class="muted">&middot; ${esc(short)}</span>` : ""}
    <span class="muted"> &middot; week of ${esc(_fsMdLongFromIso(iso))}</span>
  </div>`;
  const schedText = (sched > 0)
    ? String(sched)
    : (preSchedule ? "&mdash; (no schedule that week)" : "&mdash;");
  const recvText = (receiptCount > 0)
    ? `${recv} <span class="muted">(${receiptCount} receipt${receiptCount === 1 ? "" : "s"})</span>`
    : String(recv);
  let variance;
  if (preSchedule) {
    variance = `<span class="fs-tt-pre">pre-schedule receipt</span>`;
  } else if (thisWk) {
    variance = `<span class="muted">partial (this week)</span>`;
  } else if (sched === 0 && recv === 0) {
    variance = `<span class="muted">&mdash;</span>`;
  } else if (recv < sched) {
    variance = `<span class="fs-tt-short">&minus;${sched - recv} short</span>`;
  } else if (recv > sched) {
    variance = `<span class="fs-tt-over">+${recv - sched} over</span>`;
  } else {
    variance = `<span class="fs-tt-ok">met</span>`;
  }
  // Run kind, only when scheduled and post-schedule.
  let runTypeRow = "";
  if (!preSchedule && !noData && !thisWk && sched > 0) {
    const info = _fsHistoricalSlotForIso(iso);
    let kindText = "";
    if (info && info.slotPn) {
      const isSplit = !!(info.slotPn2 && info.slotPn2 !== info.slotPn);
      const activePn = isSplit ? (info.isWeek2 ? info.slotPn2 : info.slotPn) : info.slotPn;
      if (isSplit && pn === activePn) kindText = `split (wk ${info.isWeek2 ? 2 : 1})`;
      else if (pn === activePn) kindText = "run";
      else kindText = "drop-in";
    }
    if (kindText) runTypeRow = row("Run type", kindText);
  }
  const clickHint = (variant !== "none")
    ? `<div class="fs-tt-hint muted">Click for receipt lines</div>`
    : "";
  return header
    + row("Scheduled", schedText)
    + row("Received", recvText)
    + row("Variance", variance)
    + runTypeRow
    + clickHint;
}

function _fsHistTooltipHtmlTail(tail, target) {
  const winRecv = Number(target.getAttribute("data-fs-hist-recv")) || 0;
  const winSched = Number(target.getAttribute("data-fs-hist-sched")) || 0;
  const nSched = Number(target.getAttribute("data-fs-hist-schedweeks")) || 0;
  const weeksShort = Number(target.getAttribute("data-fs-hist-wksshort")) || 0;
  const pn = target.getAttribute("data-fs-hist-pn") || "";
  const header = `<div class="fs-tt-header"><span class="mono">${esc(pn)}</span> <span class="muted">&middot; window totals</span></div>`;
  let body;
  const variance = winRecv - winSched;
  const varSign = variance > 0 ? "+" : "";
  const pct = winSched > 0 ? Math.round((winRecv / winSched) * 100) : null;
  switch (tail) {
    case "recv-tot":
      body = `<div class="fs-tt-body">Total received across the shown range.<br><span class="muted">post-schedule weeks only &mdash; pre-schedule receipts feed the per-week column but not this row-tail number.</span><br><strong>${winRecv}</strong> units received across ${nSched} scheduled wk.</div>`;
      break;
    case "sched-tot":
      body = `<div class="fs-tt-body">Total scheduled across the shown range.<br><strong>${winSched}</strong> units scheduled across ${nSched} wk.</div>`;
      break;
    case "var":
      body = `<div class="fs-tt-body">&Delta; = received &minus; scheduled over ${nSched} wk with schedules.<br><strong>${varSign}${variance}</strong> = ${winRecv} &minus; ${winSched}.</div>`;
      break;
    case "pct":
      body = `<div class="fs-tt-body">Delivered % = received &divide; scheduled &times; 100, over ${nSched} wk with schedules.<br><strong>${pct === null ? "—" : pct + "%"}</strong> = ${winRecv} &divide; ${winSched} &times; 100.</div>`;
      break;
    case "wks-short":
      body = `<div class="fs-tt-body">Weeks where received &lt; scheduled.<br><strong>${weeksShort}</strong> of ${nSched} scheduled wk fell short.</div>`;
      break;
    case "plan-wk": {
      const plan = Number(target.getAttribute("data-fs-hist-plan")) || 0;
      body = `<div class="fs-tt-body">Planned burn per week = rate &times; 5 workdays.<br><strong>${plan.toFixed(2)}</strong> units/wk at the current rate (any active rate step is reflected).</div>`;
      break;
    }
    case "actual-wk": {
      const plan = Number(target.getAttribute("data-fs-hist-plan")) || 0;
      const actualAttr = target.getAttribute("data-fs-hist-actual") || "";
      const actual = actualAttr === "" ? null : Number(actualAttr);
      let burns = [];
      try { burns = JSON.parse(target.getAttribute("data-fs-hist-burns") || "[]"); } catch (_) { burns = []; }
      const lines = burns.length === 0
        ? `<span class="muted">Not enough on-hand snapshots yet (need 2+ consecutive weeks).</span>`
        : burns.map(b => `<div class="fs-tt-row"><span class="fs-tt-label">${esc(_fsMdLongFromIso(b.iso))}</span><span class="fs-tt-value">${Number(b.val).toFixed(2)}</span></div>`).join("");
      const summary = actual === null
        ? `<strong>&mdash;</strong>`
        : `<strong>${actual.toFixed(2)}</strong> mean vs plan ${plan.toFixed(2)}`;
      body = `<div class="fs-tt-body">Actual burn per week = mean over the last 4 CLOSED weeks of<br><span class="muted">prev on-hand + received &minus; on-hand</span>.<br>${summary}</div>${lines}`;
      break;
    }
    default:
      body = "";
  }
  return header + body;
}

// Item 8: warnings-panel row click → scroll the matching frame
// row in the schedule grid into view and briefly flash it.
// Uses scrollIntoView with block:"center" so the row lands
// well inside the viewport; falls back gracefully if the id
// isn't in the DOM (older render or renamed pn).
function _fsScrollToFrameRow(pn) {
  if (!pn) return;
  const row = document.getElementById("fs-frame-row-" + pn);
  if (!row) return;
  try {
    row.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch (_) {
    row.scrollIntoView();
  }
  row.classList.add("fs-row-flash");
  setTimeout(() => row.classList.remove("fs-row-flash"), 1400);
}

// Receipt History CSV export — client-side only. Rebuilds the
// panel's data for the currently shown range (same math as the
// render pass) and delivers a Blob via a temporary anchor. NO
// cloud calls; no writes; no state mutation.
//
// Columns: frame,week,scheduled,received. One row per (pn, week)
// including zero-zero pairs so the CSV mirrors the visible table
// exactly. Current week is NOT included — the panel treats it as
// a partial-info column, and mixing partial receipts into a
// reconcile export would be misleading.
function _fsDownloadHistoryCsv() {
  try {
    const cols = _fsColumns();
    const currentCol = cols.find(c => c.current);
    // Compute prev-Monday (same fallback as render).
    let prevMondayAnchor;
    if (currentCol) {
      prevMondayAnchor = (typeof addDays === "function") ? addDays(currentCol.date, -7)
                                                          : new Date(currentCol.date.getTime() - 7 * 86400000);
    } else {
      prevMondayAnchor = new Date();
      prevMondayAnchor.setHours(0, 0, 0, 0);
      const back = (prevMondayAnchor.getDay() + 6) % 7;
      prevMondayAnchor.setDate(prevMondayAnchor.getDate() - back - 7);
    }
    prevMondayAnchor.setHours(0, 0, 0, 0);
    const prevMondayIso = _fsIsoMonday(prevMondayAnchor);

    // Received index for FRAME_PNS across the archive.
    const receivedByPnWeek = new Map();
    const _poReceipts = (typeof DB !== "undefined" && Array.isArray(DB.poReceipts)) ? DB.poReceipts : [];
    const _frameSet = new Set(FRAME_PNS);
    for (const rec of _poReceipts) {
      if (!rec || !rec.pn || !rec.weekIso) continue;
      if (!_frameSet.has(rec.pn)) continue;
      const key = rec.pn + "|" + rec.weekIso;
      receivedByPnWeek.set(key, (receivedByPnWeek.get(key) || 0) + (Number(rec.qty) || 0));
    }

    // Earliest known Monday from persisted schedule + receipts.
    let earliestIso = null;
    if (DB.frameSchedule && DB.frameSchedule.weeks instanceof Map) {
      for (const [iso, wk] of DB.frameSchedule.weeks.entries()) {
        if (!wk || !wk.qty) continue;
        let any = false;
        for (const pn of FRAME_PNS) { if (Number(wk.qty[pn]) > 0) { any = true; break; } }
        if (!any) continue;
        if (iso > prevMondayIso) continue;
        if (!earliestIso || iso < earliestIso) earliestIso = iso;
      }
    }
    for (const rec of _poReceipts) {
      if (!rec || !rec.pn || !rec.weekIso) continue;
      if (!_frameSet.has(rec.pn)) continue;
      if (rec.weekIso > prevMondayIso) continue;
      if (!earliestIso || rec.weekIso < earliestIso) earliestIso = rec.weekIso;
    }
    if (!earliestIso) earliestIso = prevMondayIso;

    // Ascending week list, then range-slice (newest side).
    const asc = [];
    {
      const start = parseDateLocal(earliestIso);
      start.setHours(0, 0, 0, 0);
      let d = new Date(start.getTime());
      for (let steps = 0; steps < 520; steps++) {
        const iso = _fsIsoMonday(d);
        asc.push(iso);
        if (iso >= prevMondayIso) break;
        d = (typeof addDays === "function") ? addDays(d, 7) : new Date(d.getTime() + 7 * 86400000);
        d.setHours(0, 0, 0, 0);
      }
    }
    const newestFirst = asc.slice().reverse();
    const range = FRAMESCHED_STATE._historyRange || "26";
    const visible = (range === "all") ? newestFirst : newestFirst.slice(0, range === "8" ? 8 : 26);
    // CSV lines ordered oldest → newest so a reconcile is easy to
    // scan chronologically. Display order (newest-left) is a
    // rendering choice, not an export contract.
    const chronological = visible.slice().reverse();

    // Detail toggle (item 5): when checked, emit one row per RC
    // line for the shown range instead of one summary row per
    // (pn, week). Summary rows are still useful for a quick
    // reconciliation; detail rows are for traceability all the
    // way back to Acumatica documents.
    const detail = !!FRAMESCHED_STATE._csvDetail;
    const visibleIsoSet = new Set(chronological);
    const csvEscape = v => {
      const s = String(v == null ? "" : v);
      // Quote if the value contains a delimiter, quote, or newline.
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    let lines;
    if (detail) {
      lines = ["frame,week,receiptNbr,poNum,receiptDate,qty,vendor"];
      // Detail rows: filter DB.poReceipts to FRAME_PNS + visible
      // range; sort by (frame, week ASC, receiptDate ASC, RC#).
      const detailRows = [];
      for (const rec of _poReceipts) {
        if (!rec || !rec.pn || !rec.weekIso) continue;
        if (!_frameSet.has(rec.pn)) continue;
        if (!visibleIsoSet.has(rec.weekIso)) continue;
        detailRows.push(rec);
      }
      detailRows.sort((a, b) => {
        if (a.pn !== b.pn) return FRAME_PNS.indexOf(a.pn) - FRAME_PNS.indexOf(b.pn);
        if (a.weekIso !== b.weekIso) return String(a.weekIso).localeCompare(String(b.weekIso));
        const d = String(a.receiptDate || "").localeCompare(String(b.receiptDate || ""));
        if (d !== 0) return d;
        return String(a.receiptNbr || "").localeCompare(String(b.receiptNbr || ""));
      });
      for (const rec of detailRows) {
        lines.push([
          csvEscape(rec.pn),
          csvEscape(rec.weekIso),
          csvEscape(rec.receiptNbr || ""),
          csvEscape(rec.poNum || ""),
          csvEscape(rec.receiptDate || ""),
          csvEscape(Number(rec.qty) || 0),
          csvEscape(rec.vendor || ""),
        ].join(","));
      }
    } else {
      lines = ["frame,week,scheduled,received"];
      for (const pn of FRAME_PNS) {
        for (const iso of chronological) {
          const wk = _fsWeekData(iso);
          const sched = Number(wk.qty && wk.qty[pn]) || 0;
          const recv = Number(receivedByPnWeek.get(pn + "|" + iso)) || 0;
          lines.push(`${pn},${iso},${sched},${recv}`);
        }
      }
    }

    const csv = lines.join("\n") + "\n";
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const kind = detail ? "detail" : "summary";
    a.download = `frame-receipt-history-${kind}-${range}-${_fsIsoMonday(new Date())}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Free the object URL on next tick so the click-triggered
    // navigation has time to consume it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[frame-sched] receipt history CSV export failed", err);
    }
  }
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
  const renderCols = _fsColumns();
  const simCols = _fsSimColumns();
  const slots = _fsBuildSlots(simCols);
  const cols = renderCols;
  const visibleStartIsos = new Set(renderCols.map(c => c.iso));
  const globalCaps = _fsSettingsCaps();
  // Memoize chain-aware rate ONCE — see renderFrameSchedule comment.
  const rateByPn = {};
  for (const r of rows) rateByPn[r.pn] = _fsDaily(r);
  // Optimizer: the manual slot is now fixed (build-time
  // resolvedPn from the persisted mirror update above); remaining
  // open slots re-optimize around it. Sim runs without PO
  // credits — see _fsSimulate header.
  const simResult = _fsOptimize(rows, simCols, slots, globalCaps, visibleStartIsos, rateByPn);
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
  // v4: walk SIM_HORIZON_WEEKS ahead so the debug output matches
  // what the optimizer scored against.
  const cols = _fsSimColumns();
  const renderCols = _fsColumns();
  const slots = _fsBuildSlots(cols);
  const poDetail = _fsDebugPOReceiptsDetailed(FRAME_PNS, cols);
  const globalCaps = _fsSettingsCaps();
  const bufferWeeks = _fsSettingsBufferWeeks();
  const visibleStartIsos = new Set(renderCols.map(c => c.iso));
  // Memoize chain-aware rate ONCE — see renderFrameSchedule comment.
  const rateByPn = {};
  for (const r of rows) rateByPn[r.pn] = _fsDaily(r);

  // Run the optimizer first so the walk below reflects the SAME
  // pn per open slot that the render sees (avoids the debug
  // showing a divergent greedy pick).
  _fsOptimize(rows, cols, slots, globalCaps, visibleStartIsos, rateByPn);

  // Fresh local sim state — do NOT touch the module's mirrors.
  const onHand = new Map();
  for (const r of rows) onHand.set(r.pn, Number(r.onHand) || 0);
  const perFrame = new Map(); // pn -> row[]
  for (const r of rows) perFrame.set(r.pn, []);
  const bufferBreachByPn = new Map();
  const minCoverByPn = new Map();
  for (const r of rows) {
    bufferBreachByPn.set(r.pn, 0);
    minCoverByPn.set(r.pn, Infinity);
  }

  const weekToSlot = new Map();
  for (const s of slots) for (const iso of s.weekIsos) weekToSlot.set(iso, s);

  console.log(`[fsDebugSim] Global caps: CREW/HD=${globalCaps.crewhd}/wk · STD=${globalCaps.std}/wk · filler=${Math.max(0, globalCaps.std - globalCaps.crewhd)}/wk`);
  console.log(`[fsDebugSim] Min cover: ${bufferWeeks} wk (0 = feature off) · targetUnits = bufferWeeks × burn(wk)`);
  console.log(`[fsDebugSim] Slot anchor ${SLOT_ANCHOR_ISO} · lock horizon ${LOCK_HORIZON_DAYS}d · sim horizon ${SIM_HORIZON_WEEKS} wk (render ${renderCols.length} wk)`);
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
      slot.resolvedPn = _fsPickEarliestRunout(rows, onHand, cols, i, rateByPn);
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
          const fillerPn = _fsPickFillerCandidate(rows, onHand, runPn, rateByPn);
          if (fillerPn) {
            onHand.set(fillerPn, (onHand.get(fillerPn) || 0) + fillerCap);
            buildCreditsThisWeek.get(fillerPn).push({ qty: fillerCap, kind: "filler" });
          }
        }
      }
    }

    // Burn workweek demand. Flat rate — same value every week
    // (_fsDaily × 5). Chain-aware; rate steps intentionally
    // ignored; schedule drives production toward the current rate.
    // Track raw part.daily alongside so the debug output shows
    // both numbers and the gap is visible for chained frames.
    const burnThisWeek = new Map();
    const rateThisWeek = new Map();
    const rateRawThisWeek = new Map();
    for (const r of rows) {
      // PERF: rate lookup goes through the memoized rateByPn (see
      // renderFrameSchedule) so the per-week debug walk doesn't
      // chain-walk again.
      const rate = Number(rateByPn[r.pn]) || 0;
      const rateRaw = Number(r.daily) || 0;
      const b = rate * FS_WORKDAYS_PER_WEEK;
      onHand.set(r.pn, (onHand.get(r.pn) || 0) - b);
      burnThisWeek.set(r.pn, b);
      rateThisWeek.set(r.pn, rate);
      rateRawThisWeek.set(r.pn, rateRaw);
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
      const endOh = onHand.get(r.pn) || 0;
      const burn = burnThisWeek.get(r.pn) || 0;
      const targetUnits = bufferWeeks > 0 ? bufferWeeks * burn : 0;
      const bufferFlag = (targetUnits > 0 && endOh >= 0 && endOh < targetUnits) ? "!" : "";
      if (bufferFlag) bufferBreachByPn.set(r.pn, (bufferBreachByPn.get(r.pn) || 0) + (targetUnits - endOh));
      const coverWk = burn > 0 && endOh >= 0 ? endOh / burn : (endOh >= 0 ? Infinity : 0);
      if (coverWk !== Infinity && coverWk < (minCoverByPn.get(r.pn) || Infinity)) {
        minCoverByPn.set(r.pn, coverWk);
      }
      perFrame.get(r.pn).push({
        week: iso,
        md: c.md,
        slot: slotTag,
        rawDaily: Number(rateRawThisWeek.get(r.pn).toFixed(3)),
        chainDaily: Number(rateThisWeek.get(r.pn).toFixed(3)),
        startOh: Number(startOh.get(r.pn).toFixed(3)),
        buildCredits: bc.length ? bc.map(x => `+${x.qty}(${x.kind})`).join(" ") : "",
        burn: Number(burn.toFixed(3)),
        endOh: Number(endOh.toFixed(3)),
        targetUnits: bufferWeeks > 0 ? Number(targetUnits.toFixed(3)) : "",
        coverWk: coverWk === Infinity ? "inf" : Number(coverWk.toFixed(2)),
        bufferBreach: bufferFlag,
      });
    }
  }

  // Print per-frame tables.
  console.log("=== Frame Schedule sim — per-frame per-week walk (NO PO credits) ===");
  for (const r of rows) {
    const breach = bufferBreachByPn.get(r.pn) || 0;
    const minCover = minCoverByPn.get(r.pn);
    const breachNote = (bufferWeeks > 0)
      ? ` · buffer breach total: ${Number(breach.toFixed(3))} units`
      : "";
    const coverNote = (minCover !== undefined && minCover !== Infinity)
      ? ` · min running cover: ${Number(minCover.toFixed(2))} wk`
      : "";
    const rawDaily = Number(r.daily) || 0;
    const chainDaily = _fsDaily(r);
    const rateGapNote = (chainDaily > 0 && Math.abs(chainDaily - rawDaily) > 1e-6)
      ? ` [chain is ${(chainDaily / (rawDaily || chainDaily)).toFixed(1)}x raw]`
      : "";
    console.log(`\n--- ${r.pn} · ${FRAME_SHORT[r.pn] || ""} (${_fsPoolLabel(r.pool)}) · daily=${rawDaily}/wd · chainDaily=${chainDaily}/wd${rateGapNote} · onHand@today=${r.onHand}${breachNote}${coverNote} ---`);
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
      rawDaily: r.daily,
      chainDaily: _fsDaily(r),
      startOnHand: r.onHand,
      status: firstStockout ? `stockout ${firstStockout.week} (endOh=${firstStockout.endOh})` : "covered through window",
    });
  }
  console.log("\n=== Summary: projected stockout per frame ===");
  console.table(summary);

  return { perFrame, summary };
};
