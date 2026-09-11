/* =====================================================
   lib/frame-scheduler.js -- Frame Schedule scheduler PURE math.

   Phase A of the server-side scheduler migration. Loaded by
   BOTH the browser (as a classic script before js/25) and by
   the Netlify function netlify/functions/frame-schedule-compute
   (via require) so there is EXACTLY ONE implementation of the
   sim, the weekly cover-driven scheduler, the mix candidate
   enumeration, the shared production-envelope math, the slot
   builder, and the 6^N slot-mode optimizer.

   ISOLATION CONTRACT (mandatory):
     * NO DOM references (no window, document, alert, prompt).
     * NO direct DB reads. Every input arrives via arguments;
       the browser and the function build a `ctx` bundle before
       calling in and the pure math reads only from that bundle.
     * NO side effects on shared state -- the sim mutates the
       passed-in `slots` array (optimizer's per-combo pn set)
       but nothing else. Callers who don't want that mutation
       observable pass a slots array they built for this call.
     * Byte-identical outputs vs the pre-refactor js/25 math.

   Ctx shape (built by the caller):
     {
       weekDataByIso: Map<isoMonday, {qty, slot, qtyOverride, ...}>,
       bufferWeeks:   number,       // min-cover-in-weeks floor
       scheduleMode:  "weekly"|"slots",
       today:         Date          // local midnight
       parseDateLocal: fn(iso)->Date,
       addDays:        fn(d,n)->Date,
       mondayOfWeek:   fn(d)->Date,
       dailyFor:       fn(row)->number   // optional; chain-aware rate for the browser
     }

   Both the browser wrapper (js/25) and the compute function
   set every field. The dailyFor fallback (Number(row.daily)||0)
   only kicks in for defensive callers.

   Contents (mostly VERBATIM ports of the js/25 originals):
     * FRAME_PNS / FRAME_POOL / FRAME_SHORT / FRAME_PACK etc.
     * isoMonday / mdShort / weeksBetween / packDown / packUp
     * stdAllowedPacks / stdAllowedUnits / weekEnvelopeStatus
     * simColumns / buildSlots
     * pickEarliestRunout / pickFillerCandidate / poolBehind
     * weeksToNextRunFor
     * simulate  (legacy slot mode)
     * simulateWeekly  (v7 cover-driven mode)
     * weeklyEnumerateCandidates / weeklyBaselineMinCover /
       weeklyBaselineHorizonProjection / weeklyScore /
       weeklyPickAssignment
     * optimize (6^N + Phase 2 splits + Phase 3 repair + Phase 4
       mandatory stockout prevention)
     * scoreSim / compareScores
     * runScheduler  (dispatch on ctx.scheduleMode)
     * gridKey  (render-order digest for supplier-snapshot dirty
       check + shadow-vs-browser compare)

   Export shape: UMD.
     Browser: window.FrameScheduler = { ...consts, forContext(ctx) }
     Node:    module.exports         = { ...consts, forContext(ctx) }
   The `forContext(ctx)` factory returns an object with every
   scheduling function bound to `ctx`, so the optimizer's inner
   46k simulate() calls close over the same ctx without paying
   an alloc per call.
   ===================================================== */

(function (root, factory) {
  const mod = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = mod;
  }
  if (root) {
    root.FrameScheduler = mod;
  }
})(typeof self !== "undefined" ? self : (typeof global !== "undefined" ? global : this), function () {
  "use strict";

  /* --------------------------------------------------------
     CONSTANTS -- mirror js/25 exactly.
     -------------------------------------------------------- */
  const FRAME_PNS = ["UT101001", "UT101002", "UT101003", "UT101004", "UT101005", "UT101006"];
  const FRAME_POOL = {
    "UT101001": "std",
    "UT101002": "crewhd",
    "UT101003": "crewhd",
    "UT101004": "std",
    "UT101005": "crewhd",
    "UT101006": "crewhd",
  };
  const FRAME_SHORT = {
    "UT101001": "GAS STD",
    "UT101002": "GAS CREW",
    "UT101003": "GAS HD",
    "UT101004": "AMP STD",
    "UT101005": "AMP CREW",
    "UT101006": "AMP HD",
  };
  const SLOT_ANCHOR_ISO = "2026-09-07";
  const SEED_PRE_ANCHOR_PN = "UT101002";
  const LOCK_HORIZON_DAYS = 42;
  const FS_WORKDAYS_PER_WEEK = 5;
  const FRAME_PACK = 3;
  const SIM_HORIZON_WEEKS = 20;

  // Weekly-mode scoring constants (v7.2 + v7.8).
  const WEEKLY_LOOKAHEAD_K = 3;
  const WEEKLY_CHANGEOVER_BONUS_WEEKS = 0.3;
  const WEEKLY_HORIZON_DISCOUNT = 0.9;
  const WEEKLY_MIX_PENALTY_WEEKS = 0.15;
  const WEEKLY_OVERSHOOT_HORIZON_WEEKS = 8;
  const WEEKLY_OVERSHOOT_PENALTY_PER_WEEK = 0.05;
  const WEEKLY_TIEBREAK_EPS = 0.02;

  // Slot-mode optimizer cap.
  const ENUM_CAP_OPEN_SLOTS = 6;

  const DAY_MS = 86400000;

  /* --------------------------------------------------------
     PURE HELPERS (module-scope; no ctx).
     -------------------------------------------------------- */
  function isoMonday(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  function mdShort(d) {
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function packDown(n) {
    const x = Math.floor((Number(n) || 0) / FRAME_PACK) * FRAME_PACK;
    return x < 0 ? 0 : x;
  }

  function packUp(n) {
    const x = Math.ceil((Number(n) || 0) / FRAME_PACK) * FRAME_PACK;
    return x < 0 ? 0 : x;
  }

  function stdAllowedPacks(crewhdQty, caps) {
    const crewCap = Math.max(0, Number(caps && caps.crewhd) || 0);
    const stdCap  = Math.max(0, Number(caps && caps.std)    || 0);
    if (stdCap <= 0) return 0;
    const crewhd = Math.max(0, Number(crewhdQty) || 0);
    if (crewCap <= 0) {
      return crewhd > 0 ? 0 : Math.floor(stdCap / FRAME_PACK);
    }
    const remaining = 1 - (crewhd / crewCap);
    if (remaining <= 0) return 0;
    return Math.max(0, Math.floor((remaining * stdCap) / FRAME_PACK));
  }

  function stdAllowedUnits(crewhdQty, caps) {
    return stdAllowedPacks(crewhdQty, caps) * FRAME_PACK;
  }

  function weekEnvelopeStatus(crewhdSum, stdSum, caps) {
    const crewCap = Math.max(0, Number(caps && caps.crewhd) || 0);
    const stdCap  = Math.max(0, Number(caps && caps.std)    || 0);
    const stdAllowed = stdAllowedUnits(crewhdSum, caps);
    const crewOver = crewhdSum > crewCap;
    const stdOver  = stdSum > stdAllowed;
    return {
      crewhdSum: Math.max(0, Number(crewhdSum) || 0),
      stdSum: Math.max(0, Number(stdSum) || 0),
      crewCap,
      stdCap,
      stdAllowed,
      crewOver,
      stdOver,
      over: crewOver || stdOver,
    };
  }

  // Compare two scoreSim results -- lower is better. Reads no ctx
  // so it's exported at module scope (bypasses forContext).
  function compareScores(a, b) {
    const aSC = a.stockoutWeekCount || 0;
    const bSC = b.stockoutWeekCount || 0;
    if (aSC !== bSC) return aSC - bSC;
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
    const aRC = a.runCount || 0;
    const bRC = b.runCount || 0;
    if (aRC !== bRC) return aRC - bRC;
    return (a.splitCount || 0) - (b.splitCount || 0);
  }

  // Stable digest of the render window's scheduled cells. Used by
  // supplier-snapshot dirty check in the browser AND by the compute
  // function to fill the frame_schedule_shadow.input_hash column.
  // Iterates rows in pn-ascending order so a caller who passes
  // rows in a different order (browser DB.parts order vs server
  // partsRows order) still produces the same digest -- the
  // fsCompareShadow tool's whole point.
  function gridKey(rows, cols, scheduledRuns, caps, bufferWeeks) {
    if (!Array.isArray(rows) || !Array.isArray(cols) || !scheduledRuns) return "";
    const sortedRows = rows.slice().sort((a, b) => (a.pn < b.pn ? -1 : a.pn > b.pn ? 1 : 0));
    const parts = [];
    for (const r of sortedRows) {
      const runs = scheduledRuns.get(r.pn) || [];
      for (const c of cols) {
        const iso = c.iso;
        let q = 0;
        for (const rn of runs) if (rn.weekIso === iso) q += rn.qty;
        if (q > 0) parts.push(`${r.pn}|${iso}|${Math.round(q)}`);
      }
    }
    const c = caps || {};
    parts.push(`caps|${Number(c.crewhd) || 0}|${Number(c.std) || 0}`);
    const bw = Number(bufferWeeks);
    parts.push(`bw|${Number.isFinite(bw) ? bw : ""}`);
    return parts.join(",");
  }

  /* --------------------------------------------------------
     FACTORY -- binds every ctx-dependent function to `ctx`.
     -------------------------------------------------------- */
  function forContext(ctx) {
    if (!ctx) throw new Error("FrameScheduler.forContext(ctx): ctx required");
    const weekDataByIso = (ctx.weekDataByIso instanceof Map)
      ? ctx.weekDataByIso : new Map();
    const bufferWeeks = (typeof ctx.bufferWeeks === "number" && Number.isFinite(ctx.bufferWeeks) && ctx.bufferWeeks >= 0)
      ? ctx.bufferWeeks : 1.0;
    const scheduleMode = (ctx.scheduleMode === "slots") ? "slots" : "weekly";
    const today = (ctx.today instanceof Date) ? ctx.today : (function () {
      const t = new Date(); t.setHours(0, 0, 0, 0); return t;
    })();

    const parseDateLocal = (typeof ctx.parseDateLocal === "function")
      ? ctx.parseDateLocal
      : function (s) {
          if (!s || typeof s !== "string") return null;
          const p = s.split("-").map(Number);
          if (p.length !== 3) return null;
          const d = new Date(p[0], p[1] - 1, p[2]);
          d.setHours(0, 0, 0, 0);
          return d;
        };
    const addDaysFn = (typeof ctx.addDays === "function")
      ? ctx.addDays
      : function (d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
    const mondayOfWeekFn = (typeof ctx.mondayOfWeek === "function")
      ? ctx.mondayOfWeek
      : function (d) {
          const r = new Date(d);
          const dow = r.getDay(); // 0=Sun..6=Sat
          const shift = (dow === 0) ? -6 : (1 - dow);
          r.setDate(r.getDate() + shift);
          r.setHours(0, 0, 0, 0);
          return r;
        };
    const dailyFor = (typeof ctx.dailyFor === "function")
      ? ctx.dailyFor
      : function (row) { return Number(row && row.daily) || 0; };

    // Normalized week-data reader. Matches js/25 _fsWeekData
    // shape exactly so downstream branches (isLockedWithPersistedQty,
    // qtyOverride sweep, legacy-pin fallback) behave identically.
    function weekDataFor(iso) {
      const wk = weekDataByIso.get(iso) || null;
      return {
        qty: (wk && wk.qty && typeof wk.qty === "object") ? wk.qty : {},
        slot: (wk && wk.slot && typeof wk.slot === "object") ? wk.slot : null,
        qtyOverride: (wk && wk.qtyOverride && typeof wk.qtyOverride === "object") ? wk.qtyOverride : null,
      };
    }

    /* ------------------------------------------------------
       DETERMINISM HELPERS.

       Every scheduling loop MUST iterate rows / candidates / map
       keys in a stable, environment-independent order or the
       browser and the compute function will disagree on the
       first tie-break -- exactly the fsCompareShadow divergence
       we fixed in this ticket. Every pipeline entry point below
       (simulate, simulateWeekly, optimize, scoreSim) calls
       normalizeRows on the incoming rows array before any other
       work, so downstream code sees pn-ascending order.

       Sorted-key iteration for object/map keys uses cmpAsc so
       comparisons never fall through to insertion order.
       ------------------------------------------------------ */
    const cmpAsc = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    function normalizeRows(rows) {
      if (!Array.isArray(rows)) return [];
      return rows.slice().sort((a, b) => cmpAsc(a.pn, b.pn));
    }
    function sortedKeys(objOrMap) {
      if (!objOrMap) return [];
      const keys = (objOrMap instanceof Map) ? [...objOrMap.keys()] : Object.keys(objOrMap);
      return keys.sort(cmpAsc);
    }

    /* ------------------------------------------------------
       COLUMN + SLOT BUILDERS.
       ------------------------------------------------------ */
    function simColumns() {
      const currentMonday = mondayOfWeekFn(today);
      const cols = [];
      for (let i = 0; i <= SIM_HORIZON_WEEKS - 1; i++) {
        const d = addDaysFn(currentMonday, i * 7);
        cols.push({
          iso: isoMonday(d),
          md: mdShort(d),
          past: false,
          current: i === 0,
          date: d,
        });
      }
      return cols;
    }

    // 12-week render layout (current + 11 future). Used by the
    // compute function to build the shadow's render-window slice.
    function renderColumns() {
      const currentMonday = mondayOfWeekFn(today);
      const cols = [];
      for (let i = 0; i <= 11; i++) {
        const d = addDaysFn(currentMonday, i * 7);
        cols.push({
          iso: isoMonday(d),
          md: mdShort(d),
          past: false,
          current: i === 0,
          date: d,
        });
      }
      return cols;
    }

    function buildSlots(cols) {
      const anchor = parseDateLocal(SLOT_ANCHOR_ISO) || new Date(2026, 8, 7);
      anchor.setHours(0, 0, 0, 0);
      const anchorMs = anchor.getTime();
      const lockCutoffMs = today.getTime() + LOCK_HORIZON_DAYS * DAY_MS;

      const bySlotStart = new Map();
      for (const c of cols) {
        const w = c.date.getTime();
        const daysFromAnchor = Math.round((w - anchorMs) / DAY_MS);
        const slotIdx = Math.floor(daysFromAnchor / 14);
        const slotStart = addDaysFn(anchor, slotIdx * 14);
        slotStart.setHours(0, 0, 0, 0);
        const slotStartIso = isoMonday(slotStart);
        let s = bySlotStart.get(slotStartIso);
        if (!s) {
          const week2 = addDaysFn(slotStart, 7);
          week2.setHours(0, 0, 0, 0);
          const preAnchor = slotStart.getTime() < anchorMs;
          const locked = slotStart.getTime() <= lockCutoffMs;
          s = {
            startIso: slotStartIso,
            startDate: slotStart,
            weekIsos: [slotStartIso, isoMonday(week2)],
            visibleWeekIsos: [],
            preAnchor,
            locked,
            resolvedPn: null,
            resolvedPn2: null,
            isIdle: false,
            source: null,
            pool: null,
            persistedPn: null,
            persistedPn2: null,
            persistedSource: null,
          };
          const wk1 = weekDataFor(s.weekIsos[0]);
          const wk2 = weekDataFor(s.weekIsos[1]);
          const wk1SlotEligible = wk1.slot && wk1.slot.pn && wk1.slot.mode !== "weekly";
          const wk2SlotEligible = wk2.slot && wk2.slot.pn && wk2.slot.mode !== "weekly";
          const persistedSlot = wk1SlotEligible ? wk1.slot
                              : wk2SlotEligible ? wk2.slot
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
            s.resolvedPn2 = null;
            s.source = "seed";
            s.pool = FRAME_POOL[SEED_PRE_ANCHOR_PN];
          }
          bySlotStart.set(slotStartIso, s);
        }
        s.visibleWeekIsos.push(c.iso);
      }
      return [...bySlotStart.values()].sort((a, b) => a.startDate - b.startDate);
    }

    /* ------------------------------------------------------
       SLOT-MODE SIM SUPPORT (pickers + pool-behind + weeks-
       to-next-run helpers).
       ------------------------------------------------------ */
    function weeksBetween(iso1, iso2) {
      if (!iso1 || !iso2) return 0;
      const d1 = parseDateLocal(iso1);
      const d2 = parseDateLocal(iso2);
      if (!d1 || !d2 || isNaN(d1.getTime()) || isNaN(d2.getTime())) return 0;
      return Math.max(0, Math.round((d2.getTime() - d1.getTime()) / (7 * DAY_MS)));
    }

    function weeksToNextRunFor(pn, fromIso, slots, cols) {
      let bestIso = null;
      for (const s of slots) {
        if (!s || !s.startIso) continue;
        if (s.startIso <= fromIso) continue;
        if (s.isIdle) continue;
        if (s.resolvedPn === pn) {
          const cand = s.startIso;
          if (!bestIso || cand < bestIso) bestIso = cand;
        } else if (s.resolvedPn2 === pn && s.resolvedPn2 !== s.resolvedPn) {
          const cand = s.weekIsos[1];
          if (cand && (!bestIso || cand < bestIso)) bestIso = cand;
        }
      }
      if (bestIso) return weeksBetween(fromIso, bestIso);
      const lastIso = cols && cols.length ? cols[cols.length - 1].iso : null;
      if (!lastIso) return 0;
      return weeksBetween(fromIso, lastIso) + 1;
    }

    function poolBehind(pool, rows, onHand, slots, cols, weeklyBurnByPn, bufWeeks, fromIso) {
      const bw = Math.max(0, Number(bufWeeks) || 0);
      for (const r of rows) {
        if (r.pool !== pool) continue;
        const burn = Number(weeklyBurnByPn.get(r.pn)) || 0;
        if (burn <= 0) continue;
        const weeksToNext = weeksToNextRunFor(r.pn, fromIso, slots, cols);
        const oh = Number(onHand.get(r.pn)) || 0;
        const projected = oh - weeksToNext * burn;
        const target = bw * burn;
        if (projected < target) return true;
      }
      return false;
    }

    function pickEarliestRunout(rows, onHand, cols, fromColIdx, rateByPn, bufWeeks) {
      const bw = Math.max(0, Number(bufWeeks) || 0);
      const LOOKAHEAD_WEEKS = 2;
      let bestPn = null;
      let bestRunoutIdx = Infinity;
      let bestCover = Infinity;
      let anyNeedsRun = false;
      for (const r of rows) {
        const rate = rateByPn ? (Number(rateByPn[r.pn]) || 0) : dailyFor(r);
        const weekly = rate * FS_WORKDAYS_PER_WEEK;
        let oh = Number(onHand.get(r.pn)) || 0;
        let runoutIdx = Infinity;
        for (let i = fromColIdx; i < cols.length; i++) {
          oh -= weekly;
          if (oh <= 0) { runoutIdx = i; break; }
        }
        const projectedOh = (Number(onHand.get(r.pn)) || 0) - LOOKAHEAD_WEEKS * weekly;
        const target = bw * weekly;
        if (weekly > 0 && projectedOh < target) anyNeedsRun = true;
        const cover = (weekly > 0 ? (Number(onHand.get(r.pn)) || 0) / weekly : Infinity);
        if (runoutIdx < bestRunoutIdx || (runoutIdx === bestRunoutIdx && cover < bestCover)) {
          bestRunoutIdx = runoutIdx;
          bestCover = cover;
          bestPn = r.pn;
        }
      }
      if (bw > 0 && !anyNeedsRun) return null;
      return bestPn || (rows[0] && rows[0].pn) || null;
    }

    function pickFillerCandidate(rows, onHand, excludePn, rateByPn) {
      const cands = [];
      for (const r of rows) {
        if (r.pool !== "std") continue;
        if (r.pn === excludePn) continue;
        const oh = Number(onHand.get(r.pn)) || 0;
        const rate = rateByPn ? (Number(rateByPn[r.pn]) || 0) : dailyFor(r);
        const runoutBuffer = rate * FS_WORKDAYS_PER_WEEK * 2;
        if (oh < runoutBuffer) cands.push({ pn: r.pn, oh });
      }
      cands.sort((a, b) => a.oh - b.oh);
      return cands.length ? cands[0].pn : null;
    }

    /* ------------------------------------------------------
       SIMULATE -- legacy slot mode.
       Verbatim port of js/25 _fsSimulate, with DB reads
       swapped for ctx (weekDataFor, bufferWeeks).
       ------------------------------------------------------ */
    function simulate(rows, cols, slots, globalCaps, rateByPn) {
      rows = normalizeRows(rows);
      const onHand = new Map();
      for (const r of rows) onHand.set(r.pn, Number(r.onHand) || 0);
      const scheduledRuns = new Map();
      for (const r of rows) scheduledRuns.set(r.pn, []);
      const onHandTimeline = new Map();
      for (const r of rows) onHandTimeline.set(r.pn, []);
      const rowsByPn = new Map(rows.map(r => [r.pn, r]));
      void rowsByPn;

      const weeklyBurnByPn = new Map();
      for (const r of rows) {
        const rate = rateByPn ? (Number(rateByPn[r.pn]) || 0) : dailyFor(r);
        weeklyBurnByPn.set(r.pn, rate * FS_WORKDAYS_PER_WEEK);
      }
      const bufferWeeksLocal = bufferWeeks;
      let runCount = 0;

      const weekToSlot = new Map();
      for (const s of slots) {
        for (const iso of s.weekIsos) weekToSlot.set(iso, s);
      }

      const slotWeek2Whole = new Map();
      const preOverrideByPnIso = new Map();

      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (c.past) continue;
        const iso = c.iso;
        const slot = weekToSlot.get(iso);

        const isFirstVisibleFuture = slot && slot.visibleWeekIsos[0] === iso;
        if (slot && !slot.resolvedPn && !slot.isIdle && isFirstVisibleFuture) {
          const pick = pickEarliestRunout(rows, onHand, cols, i, rateByPn, bufferWeeksLocal);
          if (pick === null) {
            slot.isIdle = true;
            slot.source = "idle";
          } else {
            slot.resolvedPn = pick;
            slot.source = "auto";
            slot.pool = FRAME_POOL[pick] || "std";
          }
        }

        const wk = weekDataFor(iso);
        const isLockedWithPersistedQty =
          slot && slot.locked && c.current && wk.qty && Object.keys(wk.qty).length > 0;

        let runPn = null;
        let runPool = null;
        if (slot && !slot.isIdle && slot.resolvedPn) {
          const isWeek2 = slot.weekIsos[1] === iso;
          runPn = (isWeek2 && slot.resolvedPn2) ? slot.resolvedPn2 : slot.resolvedPn;
          runPool = FRAME_POOL[runPn] || "std";
        }

        if (isLockedWithPersistedQty) {
          for (const pn of sortedKeys(wk.qty)) {
            if (!scheduledRuns.has(pn)) continue;
            const qN = Number(wk.qty[pn]) || 0;
            if (qN <= 0) continue;
            const kind = (pn === runPn) ? "run" : "filler";
            scheduledRuns.get(pn).push({ weekIso: iso, qty: qN, kind });
            onHand.set(pn, (onHand.get(pn) || 0) + qN);
          }
        } else if (slot && runPn) {
          const cap = runPool === "crewhd" ? (globalCaps.crewhd || 0) : (globalCaps.std || 0);
          const capPerWeekPacks = Math.floor(cap / FRAME_PACK);
          const isSplit = !!(slot.resolvedPn2 && slot.resolvedPn2 !== slot.resolvedPn);
          const isWeek1 = slot.weekIsos[0] === iso;
          const isWeek2 = slot.weekIsos[1] === iso;
          const behindThisPool = poolBehind(runPool, rows, onHand, slots, cols, weeklyBurnByPn, bufferWeeksLocal, iso);

          let placedQty = 0;
          let placedMode = "demand";
          if (behindThisPool) {
            slotWeek2Whole.delete(slot.startIso);
            placedQty = capPerWeekPacks * FRAME_PACK;
            placedMode = "catchup";
          } else if (isSplit) {
            const burnRun = weeklyBurnByPn.get(runPn) || 0;
            const ohRun  = Number(onHand.get(runPn)) || 0;
            const weeksToNext = weeksToNextRunFor(runPn, iso, slots, cols);
            const neededRaw = Math.max(0, burnRun * (weeksToNext + bufferWeeksLocal) - ohRun);
            const neededPacks = Math.ceil(neededRaw / FRAME_PACK);
            const placedPacks = Math.min(neededPacks, capPerWeekPacks);
            placedQty = placedPacks * FRAME_PACK;
          } else if (isWeek1) {
            const burnRun = weeklyBurnByPn.get(runPn) || 0;
            const ohRun  = Number(onHand.get(runPn)) || 0;
            const weeksToNext = weeksToNextRunFor(runPn, iso, slots, cols);
            const neededRaw = Math.max(0, burnRun * (weeksToNext + bufferWeeksLocal) - ohRun);
            const neededPacks = Math.ceil(neededRaw / FRAME_PACK);
            const slotCapPacks = 2 * capPerWeekPacks;
            const slotPacks = Math.min(neededPacks, slotCapPacks);
            const week1Packs = Math.min(Math.ceil(slotPacks / 2), capPerWeekPacks);
            const week2Packs = slotPacks - week1Packs;
            placedQty = week1Packs * FRAME_PACK;
            slotWeek2Whole.set(slot.startIso, { pn: runPn, qty: week2Packs * FRAME_PACK });
          } else if (isWeek2) {
            const stash = slotWeek2Whole.get(slot.startIso);
            if (stash && stash.pn === runPn) {
              placedQty = stash.qty;
            } else {
              const burnRun = weeklyBurnByPn.get(runPn) || 0;
              const ohRun  = Number(onHand.get(runPn)) || 0;
              const weeksToNext = weeksToNextRunFor(runPn, iso, slots, cols);
              const neededRaw = Math.max(0, burnRun * (weeksToNext + bufferWeeksLocal) - ohRun);
              const neededPacks = Math.ceil(neededRaw / FRAME_PACK);
              placedQty = Math.min(neededPacks, capPerWeekPacks) * FRAME_PACK;
            }
          }

          if (placedQty > 0) {
            const qty = Math.round(placedQty);
            scheduledRuns.get(runPn).push({ weekIso: iso, qty, kind: "run", mode: placedMode });
            onHand.set(runPn, (Number(onHand.get(runPn)) || 0) + qty);
            runCount++;
          }

          if (runPool === "crewhd") {
            const envelopePacks = stdAllowedPacks(placedQty, globalCaps);
            if (envelopePacks > 0) {
              const fillerPn = pickFillerCandidate(rows, onHand, runPn, rateByPn);
              if (fillerPn) {
                const stdBehind = poolBehind("std", rows, onHand, slots, cols, weeklyBurnByPn, bufferWeeksLocal, iso);
                let fillQty = 0;
                let fillMode = "demand";
                if (stdBehind) {
                  fillQty = envelopePacks * FRAME_PACK;
                  fillMode = "catchup";
                } else {
                  const burnFill = weeklyBurnByPn.get(fillerPn) || 0;
                  const ohFill = Number(onHand.get(fillerPn)) || 0;
                  const weeksToNextFill = weeksToNextRunFor(fillerPn, iso, slots, cols);
                  const neededFill = Math.max(0, burnFill * (weeksToNextFill + bufferWeeksLocal) - ohFill);
                  const neededFillPacks = Math.ceil(neededFill / FRAME_PACK);
                  const fillPacks = Math.min(neededFillPacks, envelopePacks);
                  fillQty = fillPacks * FRAME_PACK;
                }
                if (fillQty > 0) {
                  scheduledRuns.get(fillerPn).push({ weekIso: iso, qty: fillQty, kind: "filler", mode: fillMode });
                  onHand.set(fillerPn, (Number(onHand.get(fillerPn)) || 0) + fillQty);
                }
              }
            }
          }
        }

        const overrideMap = wk && wk.qtyOverride;
        if (overrideMap) {
          for (const ovPn of sortedKeys(overrideMap)) {
            if (!scheduledRuns.has(ovPn)) continue;
            const ovVal = Math.max(0, Math.floor(Number(overrideMap[ovPn]) || 0));
            const runs = scheduledRuns.get(ovPn);
            let existing = 0;
            for (let ri = runs.length - 1; ri >= 0; ri--) {
              if (runs[ri].weekIso === iso) {
                existing += runs[ri].qty;
                runs.splice(ri, 1);
              }
            }
            if (existing > 0) onHand.set(ovPn, (Number(onHand.get(ovPn)) || 0) - existing);
            if (ovVal > 0) {
              scheduledRuns.get(ovPn).push({ weekIso: iso, qty: ovVal, kind: "override" });
              onHand.set(ovPn, (Number(onHand.get(ovPn)) || 0) + ovVal);
            }
            preOverrideByPnIso.set(ovPn + "|" + iso, existing);
          }
        }

        const burnByPn = new Map();
        for (const r of rows) {
          const burn = weeklyBurnByPn.get(r.pn) || 0;
          onHand.set(r.pn, (onHand.get(r.pn) || 0) - burn);
          burnByPn.set(r.pn, burn);
        }
        for (const r of rows) {
          onHandTimeline.get(r.pn).push({
            iso,
            endOh: onHand.get(r.pn) || 0,
            burn: burnByPn.get(r.pn) || 0,
          });
        }
      }

      let splitCount = 0;
      for (const s of slots) {
        if (s.resolvedPn2 && s.resolvedPn2 !== s.resolvedPn) splitCount++;
      }

      return { scheduledRuns, onHandTimeline, splitCount, runCount, preOverrideByPnIso };
    }

    /* ------------------------------------------------------
       WEEKLY MODE -- v7 cover-driven scheduler.
       Verbatim port of js/25 _fsSimulateWeekly + companions.
       ------------------------------------------------------ */
    function weeklyBaselineMinCover(rows, onHand, weeklyBurnByPn) {
      rows = normalizeRows(rows);
      let minC = Infinity;
      for (const r of rows) {
        const burn = weeklyBurnByPn.get(r.pn) || 0;
        const oh   = Number(onHand.get(r.pn)) || 0;
        const projected = oh - burn * WEEKLY_LOOKAHEAD_K;
        const cover = burn > 0 ? (projected / burn) : Infinity;
        if (cover < minC) minC = cover;
      }
      return minC;
    }

    function weeklyEnumerateCandidates(rows, onHand, weeklyBurnByPn, globalCaps) {
      rows = normalizeRows(rows);
      const candidates = [];
      candidates.push({ pn: null, qty: 0, pn2: null, qty2: 0, isIdle: true, isMix: false });

      const rankedByPool = { crewhd: [], std: [] };
      for (const r of rows) {
        const burn = weeklyBurnByPn.get(r.pn) || 0;
        const oh   = Number(onHand.get(r.pn)) || 0;
        const cover = burn > 0 ? (oh / burn) : Infinity;
        (rankedByPool[r.pool] || rankedByPool.std).push({ pn: r.pn, cover });
      }
      // Urgency ranking: cover asc (lowest first). Ties break by
      // pn asc so top-2 selection is environment-independent when
      // two frames have identical cover (browser rows and server
      // rows can arrive from Supabase in different orders otherwise).
      const rankCmp = (a, b) => (a.cover - b.cover) || cmpAsc(a.pn, b.pn);
      rankedByPool.crewhd.sort(rankCmp);
      rankedByPool.std.sort(rankCmp);

      const crewCap = globalCaps.crewhd || 0;
      const stdCap  = globalCaps.std    || 0;
      const crewFullPacks = Math.floor(crewCap / FRAME_PACK);
      const stdFullPacks  = Math.floor(stdCap  / FRAME_PACK);

      for (const r of rows) {
        const packs = r.pool === "crewhd" ? crewFullPacks : stdFullPacks;
        const qty = packs * FRAME_PACK;
        if (qty <= 0) continue;
        candidates.push({ pn: r.pn, qty, pn2: null, qty2: 0, isIdle: false, isMix: false });
      }

      const CREW_PARTIAL_QTYS = [12, 15, 18, 21];
      const topCrew = rankedByPool.crewhd.slice(0, 2).map(x => x.pn);
      const topStd  = rankedByPool.std[0] ? rankedByPool.std[0].pn : null;
      if (topStd) {
        for (const crewPn of topCrew) {
          for (const crewQty of CREW_PARTIAL_QTYS) {
            if (crewQty > crewCap) continue;
            const fillerPacks = stdAllowedPacks(crewQty, globalCaps);
            const fillerQty = fillerPacks * FRAME_PACK;
            if (fillerQty <= 0) continue;
            candidates.push({
              pn: crewPn,
              qty: crewQty,
              pn2: topStd,
              qty2: fillerQty,
              isIdle: false,
              isMix: true,
            });
          }
        }
      }

      const STD_PARTIAL_QTYS = [12, 15, 18, 21];
      if (rankedByPool.std.length >= 2) {
        const stdA = rankedByPool.std[0].pn;
        const stdB = rankedByPool.std[1].pn;
        for (const primary of STD_PARTIAL_QTYS) {
          const remainderRaw = stdCap - primary;
          if (remainderRaw < FRAME_PACK * 4) continue;
          const remainderPacks = Math.floor(remainderRaw / FRAME_PACK);
          const remainderQty = remainderPacks * FRAME_PACK;
          if (remainderQty <= 0) continue;
          candidates.push({
            pn: stdA,
            qty: primary,
            pn2: stdB,
            qty2: remainderQty,
            isIdle: false,
            isMix: true,
          });
        }
      }

      return candidates;
    }

    // v-lex-1: baseline projection now also emits the two lexicographic
    // tiers per frame (stockoutDisc = discounted count of weeks with
    // cover<=0; shortfallDisc = discounted sum of max(0, floor-cover)).
    // The floor argument is the same bufWeeksLocal the picker uses for
    // its overshoot cap; a floor of 0 makes tier 2 vacuous, which is
    // fine -- tier 1 still runs.
    function weeklyBaselineHorizonProjection(rows, onHand, weeklyBurnByPn, remainingWeeks, floorWeeks) {
      rows = normalizeRows(rows);
      const floor = Math.max(0, Number(floorWeeks) || 0);
      const perFrameDiscMin = new Map();
      const perFrameRawMin  = new Map();
      const perFrameStockoutDisc  = new Map();
      const perFrameShortfallDisc = new Map();
      for (const r of rows) {
        const burn = weeklyBurnByPn.get(r.pn) || 0;
        const oh   = Number(onHand.get(r.pn)) || 0;
        let minDisc = Infinity;
        let minRaw  = Infinity;
        let stockoutDisc  = 0;
        let shortfallDisc = 0;
        let discountFactor = 1;
        for (let w = 1; w <= remainingWeeks; w++) {
          const ohAfter = oh - burn * w;
          const cover = burn > 0 ? (ohAfter / burn) : Infinity;
          const disc = Number.isFinite(cover) ? cover * discountFactor : Infinity;
          if (disc < minDisc) minDisc = disc;
          if (cover < minRaw) minRaw = cover;
          if (burn > 0 && ohAfter <= 0) stockoutDisc += discountFactor;
          if (burn > 0 && floor > 0 && cover < floor) {
            shortfallDisc += (floor - cover) * discountFactor;
          }
          discountFactor *= WEEKLY_HORIZON_DISCOUNT;
        }
        perFrameDiscMin.set(r.pn, minDisc);
        perFrameRawMin.set(r.pn, minRaw);
        perFrameStockoutDisc.set(r.pn, stockoutDisc);
        perFrameShortfallDisc.set(r.pn, shortfallDisc);
      }
      return { perFrameDiscMin, perFrameRawMin, perFrameStockoutDisc, perFrameShortfallDisc };
    }

    function weeklyScore(candidate, rows, onHand, previousPn, weeklyBurnByPn, bufWeeksLocal, globalCaps, baselineMinCover, remainingWeeks, baselineProjection) {
      rows = normalizeRows(rows);
      const addedByPn = new Map();
      if (candidate && !candidate.isIdle) {
        if (candidate.pn && candidate.qty > 0) {
          addedByPn.set(candidate.pn, (addedByPn.get(candidate.pn) || 0) + candidate.qty);
        }
        if (candidate.pn2 && candidate.qty2 > 0) {
          addedByPn.set(candidate.pn2, (addedByPn.get(candidate.pn2) || 0) + candidate.qty2);
        }
      }

      // v-lex-1: pull the floor once so per-frame horizons that need to
      // walk fresh (added>0) can compute tier-2 shortfalls under the
      // same rule the baseline used.
      const floor = Math.max(0, Number(bufWeeksLocal) || 0);
      let minDiscountedCover = Infinity;
      let horizonMinRaw = Infinity;
      let totalStockoutDisc  = 0;   // tier 1 across all frames
      let totalShortfallDisc = 0;   // tier 2 across all frames
      const coverAfterThisWeek = new Map();
      for (const r of rows) {
        const burn = weeklyBurnByPn.get(r.pn) || 0;
        const baseOh = Number(onHand.get(r.pn)) || 0;
        const added = addedByPn.get(r.pn) || 0;
        const startOh = baseOh + added;
        const coverThis = burn > 0 ? (startOh / burn) : Infinity;
        coverAfterThisWeek.set(r.pn, coverThis);

        let frameDiscMin;
        let frameRawMin;
        let frameStockoutDisc  = 0;
        let frameShortfallDisc = 0;
        if (added > 0) {
          let mDisc = Infinity;
          let mRaw  = Infinity;
          let df = 1;
          for (let w = 1; w <= remainingWeeks; w++) {
            const ohAfter = startOh - burn * w;
            const cover = burn > 0 ? (ohAfter / burn) : Infinity;
            const disc = Number.isFinite(cover) ? cover * df : Infinity;
            if (disc < mDisc) mDisc = disc;
            if (cover < mRaw) mRaw = cover;
            if (burn > 0 && ohAfter <= 0) frameStockoutDisc += df;
            if (burn > 0 && floor > 0 && cover < floor) {
              frameShortfallDisc += (floor - cover) * df;
            }
            df *= WEEKLY_HORIZON_DISCOUNT;
          }
          frameDiscMin = mDisc;
          frameRawMin  = mRaw;
        } else {
          frameDiscMin = baselineProjection.perFrameDiscMin.get(r.pn);
          frameRawMin  = baselineProjection.perFrameRawMin.get(r.pn);
          frameStockoutDisc  = baselineProjection.perFrameStockoutDisc.get(r.pn) || 0;
          frameShortfallDisc = baselineProjection.perFrameShortfallDisc.get(r.pn) || 0;
        }
        if (frameDiscMin < minDiscountedCover) minDiscountedCover = frameDiscMin;
        if (frameRawMin  < horizonMinRaw)      horizonMinRaw      = frameRawMin;
        totalStockoutDisc  += frameStockoutDisc;
        totalShortfallDisc += frameShortfallDisc;
      }

      let score = minDiscountedCover;

      const rawBaseline = Number.isFinite(baselineMinCover) ? baselineMinCover : 0;
      const overshootFloor = Math.max(Number(bufWeeksLocal) || 0, rawBaseline);
      const overshootCap = overshootFloor + WEEKLY_OVERSHOOT_HORIZON_WEEKS;
      const penalizeOvershoot = (pn) => {
        const c = coverAfterThisWeek.get(pn);
        if (Number.isFinite(c) && c > overshootCap) {
          score -= (c - overshootCap) * WEEKLY_OVERSHOOT_PENALTY_PER_WEEK;
        }
      };
      if (candidate && !candidate.isIdle) {
        if (candidate.pn && candidate.qty > 0) penalizeOvershoot(candidate.pn);
        if (candidate.pn2 && candidate.qty2 > 0 && candidate.pn2 !== candidate.pn) penalizeOvershoot(candidate.pn2);
      }

      if (candidate && candidate.isMix) {
        score -= WEEKLY_MIX_PENALTY_WEEKS;
      }

      if (candidate && !candidate.isIdle && candidate.pn && candidate.pn === previousPn && Number.isFinite(score)) {
        score += WEEKLY_CHANGEOVER_BONUS_WEEKS;
      }

      return {
        score,
        horizonMinRaw,
        stockoutDisc:  totalStockoutDisc,
        shortfallDisc: totalShortfallDisc,
      };
    }

    function weeklyPickAssignment(rows, onHand, previousPn, weeklyBurnByPn, bufWeeksLocal, globalCaps, cols, currentColIdx) {
      rows = normalizeRows(rows);
      const baselineMinCover = weeklyBaselineMinCover(rows, onHand, weeklyBurnByPn);
      const remainingWeeks = Math.max(1, (Array.isArray(cols) ? cols.length : 0) - (Number.isFinite(currentColIdx) ? currentColIdx : 0));
      const baselineProjection = weeklyBaselineHorizonProjection(rows, onHand, weeklyBurnByPn, remainingWeeks, bufWeeksLocal);
      const candidates = weeklyEnumerateCandidates(rows, onHand, weeklyBurnByPn, globalCaps);

      // v-lex-1: LEXICOGRAPHIC OBJECTIVE. Prior behavior blended
      // stockout severity into the same scalar as changeover bonus /
      // mix penalty / overshoot penalty, which meant a candidate that
      // built cover for an already-safe frame could outscore one that
      // prevented a stockout on a hungry frame -- exactly the GAS HD
      // vs AMP Crew trade that motivated this fix. The compare tuple
      // is strict:
      //   TIER 1  stockoutDisc  asc  (fewer discounted stockout weeks wins)
      //   TIER 2  shortfallDisc asc  (less below-floor shortfall wins)
      //   TIER 3  snappedScore  desc (existing min-disc-cover + penalties/bonus)
      //   TIER 3+ horizonMinRaw desc, frames asc, primaryQty desc,
      //           primaryPn asc, secondaryPn asc  (existing tie-breaks)
      //
      // Weights are DELIBERATELY NOT USED. The bug was that a big
      // enough tier-3 win could swamp a tier-1 loss.
      //
      // Eps snapping: tier 1 and tier 2 also snap to eps buckets so
      // browser / server floats in the last ulp don't disagree on
      // which tier a candidate is in; the same WEEKLY_TIEBREAK_EPS
      // is used for all three tiers.
      const scored = candidates.map(cand => {
        const s = weeklyScore(cand, rows, onHand, previousPn, weeklyBurnByPn, bufWeeksLocal, globalCaps, baselineMinCover, remainingWeeks, baselineProjection);
        const snappedScore     = Math.round((Number.isFinite(s.score) ? s.score : -1e18) / WEEKLY_TIEBREAK_EPS) * WEEKLY_TIEBREAK_EPS;
        const snappedStockout  = Math.round((Number.isFinite(s.stockoutDisc)  ? s.stockoutDisc  : 0) / WEEKLY_TIEBREAK_EPS) * WEEKLY_TIEBREAK_EPS;
        const snappedShortfall = Math.round((Number.isFinite(s.shortfallDisc) ? s.shortfallDisc : 0) / WEEKLY_TIEBREAK_EPS) * WEEKLY_TIEBREAK_EPS;
        const frames = (cand.pn ? 1 : 0) + (cand.pn2 ? 1 : 0);
        return {
          cand,
          snappedStockout,
          snappedShortfall,
          snappedScore,
          horizonMinRaw: Number.isFinite(s.horizonMinRaw) ? s.horizonMinRaw : -Infinity,
          frames,
          primaryQty: Number(cand.qty) || 0,
          primaryPn:   cand.pn  || "",
          secondaryPn: cand.pn2 || "",
        };
      });
      scored.sort((a, b) => {
        if (a.snappedStockout  !== b.snappedStockout)  return a.snappedStockout  - b.snappedStockout;
        if (a.snappedShortfall !== b.snappedShortfall) return a.snappedShortfall - b.snappedShortfall;
        if (a.snappedScore !== b.snappedScore) return b.snappedScore - a.snappedScore;
        if (a.horizonMinRaw !== b.horizonMinRaw) return b.horizonMinRaw - a.horizonMinRaw;
        if (a.frames !== b.frames) return a.frames - b.frames;
        if (a.primaryQty !== b.primaryQty) return b.primaryQty - a.primaryQty;
        const p = cmpAsc(a.primaryPn, b.primaryPn);
        if (p !== 0) return p;
        return cmpAsc(a.secondaryPn, b.secondaryPn);
      });

      const best = scored[0] ? scored[0].cand : null;
      if (!best || best.isIdle) return null;
      return best;
    }

    function simulateWeekly(rows, cols, slots, globalCaps, rateByPn) {
      rows = normalizeRows(rows);
      const onHand = new Map();
      for (const r of rows) onHand.set(r.pn, Number(r.onHand) || 0);
      const scheduledRuns = new Map();
      for (const r of rows) scheduledRuns.set(r.pn, []);
      const onHandTimeline = new Map();
      for (const r of rows) onHandTimeline.set(r.pn, []);
      const preOverrideByPnIso = new Map();

      const weeklyBurnByPn = new Map();
      for (const r of rows) {
        const rate = rateByPn ? (Number(rateByPn[r.pn]) || 0) : dailyFor(r);
        weeklyBurnByPn.set(r.pn, rate * FS_WORKDAYS_PER_WEEK);
      }
      const bufferWeeksLocal = bufferWeeks;
      let runCount = 0;

      const pinByIso = new Map();
      if (Array.isArray(slots)) {
        for (const s of slots) {
          if (!s.locked || !s.resolvedPn) continue;
          for (let idx = 0; idx < s.weekIsos.length; idx++) {
            const wkIso = s.weekIsos[idx];
            const usePn2 = idx === 1 && !!s.resolvedPn2 && s.resolvedPn2 !== s.resolvedPn;
            pinByIso.set(wkIso, {
              pn: usePn2 ? s.resolvedPn2 : s.resolvedPn,
              source: s.source || "auto",
              locked: true,
              fromSlot: true,
            });
          }
        }
      }
      // Iterate weekDataByIso in a sorted, environment-independent
      // order. The pinByIso guard ("if pinByIso.has(iso) continue")
      // means iteration order does not affect the FINAL map -- but
      // browsers and Node build the source Map from Supabase rows
      // in unspecified order, and sorting here removes one class of
      // silent divergence between the two.
      for (const iso of sortedKeys(weekDataByIso)) {
        if (iso === "__settings__") continue;
        const wk = weekDataByIso.get(iso);
        const slot = wk && wk.slot;
        if (!slot || !slot.pn || slot.mode !== "weekly") continue;
        if (pinByIso.has(iso)) continue;
        pinByIso.set(iso, {
          pn: slot.pn,
          source: slot.source || "weekly-auto",
          locked: !!slot.locked,
          fromWeeklyPin: true,
          qty:  (typeof slot.qty  === "number" && Number.isFinite(slot.qty)  && slot.qty  >= 0) ? Math.floor(slot.qty)  : null,
          pn2:  (slot.pn2 && slot.pn2 !== slot.pn) ? slot.pn2 : null,
          qty2: (typeof slot.qty2 === "number" && Number.isFinite(slot.qty2) && slot.qty2 >= 0) ? Math.floor(slot.qty2) : null,
        });
      }

      let previousPn = null;

      for (let i = 0; i < cols.length; i++) {
        const c = cols[i];
        if (c.past) continue;
        const iso = c.iso;
        const wk = weekDataFor(iso);

        const isLockedWithPersistedQty =
          c.current && pinByIso.has(iso) && wk.qty && Object.keys(wk.qty).length > 0;

        if (isLockedWithPersistedQty) {
          const pin = pinByIso.get(iso);
          const runPn = pin.pn;
          for (const pn of sortedKeys(wk.qty)) {
            if (!scheduledRuns.has(pn)) continue;
            const qN = Number(wk.qty[pn]) || 0;
            if (qN <= 0) continue;
            const kind = (pn === runPn) ? "run" : "filler";
            scheduledRuns.get(pn).push({ weekIso: iso, qty: qN, kind });
            onHand.set(pn, (onHand.get(pn) || 0) + qN);
          }
          previousPn = runPn;
        } else {
          let assignment = null;
          let legacyPinPn = null;
          if (pinByIso.has(iso)) {
            const pin = pinByIso.get(iso);
            if (Number.isFinite(pin.qty) && pin.qty > 0) {
              assignment = {
                pn: pin.pn,
                qty: pin.qty,
                pn2: (pin.pn2 && Number.isFinite(pin.qty2) && pin.qty2 > 0) ? pin.pn2 : null,
                qty2: (pin.pn2 && Number.isFinite(pin.qty2) && pin.qty2 > 0) ? pin.qty2 : 0,
                isIdle: false,
                isMix: !!(pin.pn2 && Number.isFinite(pin.qty2) && pin.qty2 > 0),
              };
            } else {
              legacyPinPn = pin.pn;
            }
          } else {
            assignment = weeklyPickAssignment(rows, onHand, previousPn, weeklyBurnByPn, bufferWeeksLocal, globalCaps, cols, i);
          }

          if (assignment) {
            if (assignment.pn && assignment.qty > 0) {
              scheduledRuns.get(assignment.pn).push({
                weekIso: iso,
                qty: assignment.qty,
                kind: "run",
                mode: "demand",
              });
              onHand.set(assignment.pn, (Number(onHand.get(assignment.pn)) || 0) + assignment.qty);
              runCount++;
            }
            if (assignment.pn2 && assignment.qty2 > 0) {
              const primaryIsCrew = assignment.pn && FRAME_POOL[assignment.pn] === "crewhd";
              scheduledRuns.get(assignment.pn2).push({
                weekIso: iso,
                qty: assignment.qty2,
                kind: primaryIsCrew ? "filler" : "run",
                mode: "demand",
              });
              onHand.set(assignment.pn2, (Number(onHand.get(assignment.pn2)) || 0) + assignment.qty2);
              if (!primaryIsCrew) runCount++;
            }
            previousPn = assignment.pn || null;
          } else if (legacyPinPn) {
            const chosenPn = legacyPinPn;
            const pool = FRAME_POOL[chosenPn] || "std";
            const cap = pool === "crewhd" ? (globalCaps.crewhd || 0) : (globalCaps.std || 0);
            const capPacks = Math.floor(cap / FRAME_PACK);
            const burnRun = weeklyBurnByPn.get(chosenPn) || 0;
            const ohRun  = Number(onHand.get(chosenPn)) || 0;
            const behindThisPool = poolBehind(pool, rows, onHand, slots, cols, weeklyBurnByPn, bufferWeeksLocal, iso);
            const neededRaw = Math.max(0, burnRun * (1 + bufferWeeksLocal) - ohRun);
            let neededPacks = Math.ceil(neededRaw / FRAME_PACK);
            if (behindThisPool) neededPacks = capPacks;
            const placedPacks = Math.min(neededPacks, capPacks);
            const placedQty = placedPacks * FRAME_PACK;
            if (placedQty > 0) {
              scheduledRuns.get(chosenPn).push({
                weekIso: iso,
                qty: placedQty,
                kind: "run",
                mode: behindThisPool ? "catchup" : "demand",
              });
              onHand.set(chosenPn, ohRun + placedQty);
              runCount++;
            }
            if (pool === "crewhd") {
              const envelopePacks = stdAllowedPacks(placedQty, globalCaps);
              if (envelopePacks > 0) {
                const fillerPn = pickFillerCandidate(rows, onHand, chosenPn, rateByPn);
                if (fillerPn) {
                  const burnF = weeklyBurnByPn.get(fillerPn) || 0;
                  const ohF   = Number(onHand.get(fillerPn)) || 0;
                  const neededF = Math.max(0, burnF * (1 + bufferWeeksLocal) - ohF);
                  const stdBehind = poolBehind("std", rows, onHand, slots, cols, weeklyBurnByPn, bufferWeeksLocal, iso);
                  const fillPacks = stdBehind
                    ? envelopePacks
                    : Math.min(Math.ceil(neededF / FRAME_PACK), envelopePacks);
                  const fillQty = fillPacks * FRAME_PACK;
                  if (fillQty > 0) {
                    scheduledRuns.get(fillerPn).push({
                      weekIso: iso,
                      qty: fillQty,
                      kind: "filler",
                      mode: stdBehind ? "catchup" : "demand",
                    });
                    onHand.set(fillerPn, ohF + fillQty);
                  }
                }
              }
            }
            previousPn = chosenPn;
          } else {
            previousPn = null;
          }
        }

        const overrideMap = wk && wk.qtyOverride;
        if (overrideMap) {
          for (const ovPn of sortedKeys(overrideMap)) {
            if (!scheduledRuns.has(ovPn)) continue;
            const ovVal = Math.max(0, Math.floor(Number(overrideMap[ovPn]) || 0));
            const runs = scheduledRuns.get(ovPn);
            let existing = 0;
            for (let ri = runs.length - 1; ri >= 0; ri--) {
              if (runs[ri].weekIso === iso) {
                existing += runs[ri].qty;
                runs.splice(ri, 1);
              }
            }
            if (existing > 0) onHand.set(ovPn, (Number(onHand.get(ovPn)) || 0) - existing);
            if (ovVal > 0) {
              scheduledRuns.get(ovPn).push({ weekIso: iso, qty: ovVal, kind: "override" });
              onHand.set(ovPn, (Number(onHand.get(ovPn)) || 0) + ovVal);
            }
            preOverrideByPnIso.set(ovPn + "|" + iso, existing);
          }
        }

        const burnByPn = new Map();
        for (const r of rows) {
          const burn = weeklyBurnByPn.get(r.pn) || 0;
          onHand.set(r.pn, (onHand.get(r.pn) || 0) - burn);
          burnByPn.set(r.pn, burn);
        }
        for (const r of rows) {
          onHandTimeline.get(r.pn).push({
            iso,
            endOh: onHand.get(r.pn) || 0,
            burn: burnByPn.get(r.pn) || 0,
          });
        }
      }

      return { scheduledRuns, onHandTimeline, splitCount: 0, runCount, preOverrideByPnIso };
    }

    /* ------------------------------------------------------
       SCORER + COMPARATOR (slot-mode optimizer support).
       ------------------------------------------------------ */
    function scoreSim(rows, simResult, bufferWeeksOverride) {
      rows = normalizeRows(rows);
      const timelines = simResult.onHandTimeline;
      const bufWeeks = Math.max(0, Number(bufferWeeksOverride != null ? bufferWeeksOverride : bufferWeeks) || 0);
      let stockoutWeekCount = 0;
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
            stockoutWeekCount++;
            stockoutUnits += -oh;
            if (i < firstStockoutIdx) firstStockoutIdx = i;
          } else if (bufWeeks > 0 && burn > 0) {
            const target = bufWeeks * burn;
            if (oh < target) breachUnits += (target - oh);
          }
          if (oh >= 0 && burn > 0) {
            const cover = oh / burn;
            if (cover < minRunningCover) minRunningCover = cover;
          }
        }
      }
      return {
        stockoutWeekCount,
        stockoutUnits,
        breachUnits,
        firstStockoutIdx,
        minRunningCover,
        splitCount: (simResult && simResult.splitCount) || 0,
        runCount: (simResult && simResult.runCount) || 0,
      };
    }

    /* ------------------------------------------------------
       OPTIMIZER (legacy slot mode).
       Verbatim port of js/25 _fsOptimize (Phase 1 enumeration,
       Phase 2 split hill-climb, Phase 3 stockout repair,
       Phase 4 mandatory stockout prevention, IDLE post-pass).
       ------------------------------------------------------ */
    function optimize(rows, cols, slots, globalCaps, visibleStartIsos, rateByPn) {
      rows = normalizeRows(rows);
      const allOpen = slots.filter(s => !s.resolvedPn);
      const openSlots = visibleStartIsos
        ? allOpen.filter(s => visibleStartIsos.has(s.startIso))
        : allOpen;
      const beyondSlots = visibleStartIsos
        ? allOpen.filter(s => !visibleStartIsos.has(s.startIso))
        : [];
      const N = openSlots.length;

      const resetBeyond = () => {
        for (const b of beyondSlots) {
          b.resolvedPn = null;
          b.resolvedPn2 = null;
          b.isIdle = false;
          b.source = null;
          b.pool = null;
        }
      };

      if (N === 0) {
        resetBeyond();
        return simulate(rows, cols, slots, globalCaps, rateByPn);
      }

      if (N > ENUM_CAP_OPEN_SLOTS) {
        if (typeof console !== "undefined") {
          console.warn(`[frame-schedule] ${N} visible open slots exceeds enumeration cap ${ENUM_CAP_OPEN_SLOTS} -- falling back to greedy`);
        }
        resetBeyond();
        return simulate(rows, cols, slots, globalCaps, rateByPn);
      }

      const F = FRAME_PNS.length;
      const CHOICES = F + 1;
      const IDLE_IDX = F;
      const TOTAL = Math.pow(CHOICES, N);
      let bestScore = null;
      let bestAssignment = null;
      let bestResult = null;

      for (let combo = 0; combo < TOTAL; combo++) {
        let n = combo;
        for (let i = 0; i < N; i++) {
          const idx = n % CHOICES;
          n = Math.floor(n / CHOICES);
          if (idx === IDLE_IDX) {
            openSlots[i].resolvedPn = null;
            openSlots[i].resolvedPn2 = null;
            openSlots[i].isIdle = true;
            openSlots[i].source = "idle";
            openSlots[i].pool = null;
          } else {
            const pn = FRAME_PNS[idx];
            openSlots[i].resolvedPn = pn;
            openSlots[i].resolvedPn2 = null;
            openSlots[i].isIdle = false;
            openSlots[i].source = "auto";
            openSlots[i].pool = FRAME_POOL[pn] || "std";
          }
        }
        resetBeyond();
        const result = simulate(rows, cols, slots, globalCaps, rateByPn);
        const score = scoreSim(rows, result);
        const snapshot = () => openSlots.map(s => ({ pn: s.resolvedPn, isIdle: !!s.isIdle }));
        if (!bestScore) {
          bestScore = score;
          bestAssignment = snapshot();
          bestResult = result;
          continue;
        }
        if (score.stockoutWeekCount > bestScore.stockoutWeekCount) continue;
        const cmp = compareScores(score, bestScore);
        if (cmp < 0) {
          bestScore = score;
          bestAssignment = snapshot();
          bestResult = result;
        } else if (cmp === 0) {
          const distinctKey = s => s.isIdle ? "__idle__" : s.resolvedPn;
          const curDistinct = new Set(openSlots.map(distinctKey)).size;
          const bestDistinct = new Set(bestAssignment.map(a => a.isIdle ? "__idle__" : a.pn)).size;
          if (curDistinct > bestDistinct) {
            bestScore = score;
            bestAssignment = snapshot();
            bestResult = result;
          }
        }
      }

      if (bestAssignment) {
        for (let i = 0; i < N; i++) {
          const a = bestAssignment[i];
          if (a.isIdle) {
            openSlots[i].resolvedPn = null;
            openSlots[i].resolvedPn2 = null;
            openSlots[i].isIdle = true;
            openSlots[i].source = "idle";
            openSlots[i].pool = null;
          } else {
            openSlots[i].resolvedPn = a.pn;
            openSlots[i].resolvedPn2 = null;
            openSlots[i].isIdle = false;
            openSlots[i].source = "auto";
            openSlots[i].pool = FRAME_POOL[a.pn] || "std";
          }
        }
      }

      const MAX_PASSES = 3;
      let bestFinalResult = bestResult;
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        let adoptedAny = false;
        for (const slot of openSlots) {
          if (slot.isIdle) continue;
          resetBeyond();
          const baseResult = simulate(rows, cols, slots, globalCaps, rateByPn);
          const baseScore = scoreSim(rows, baseResult);
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
              const result = simulate(rows, cols, slots, globalCaps, rateByPn);
              const score = scoreSim(rows, result);
              if (compareScores(score, bestSplitScore) < 0) {
                bestSplitScore = score;
                bestSplitA = a;
                bestSplitB = b;
                bestSplitResult = result;
              }
            }
          }
          if (bestSplitA !== null && compareScores(bestSplitScore, baseScore) < 0) {
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

      const REPAIR_MAX_PASSES = 3;
      let repairResult = bestFinalResult || simulate(rows, cols, slots, globalCaps, rateByPn);
      for (let pass = 0; pass < REPAIR_MAX_PASSES; pass++) {
        const timelines = repairResult.onHandTimeline;
        const stockoutFrames = [];
        for (const r of rows) {
          const t = timelines.get(r.pn) || [];
          for (let i = 0; i < t.length; i++) {
            if (t[i].endOh < 0) {
              stockoutFrames.push({ pn: r.pn, firstStockIso: t[i].iso });
              break;
            }
          }
        }
        if (stockoutFrames.length === 0) break;
        let adoptedAny = false;
        for (const sf of stockoutFrames) {
          const candidates = slots
            .filter(s => !s.locked
                      && s.source !== "manual"
                      && s.startIso < sf.firstStockIso
                      && (s.isIdle || (s.resolvedPn && s.resolvedPn !== sf.pn)))
            // Plain ISO string compare -- localeCompare depends on
            // the host's ICU data and can rank differently across
            // browsers / Node builds. Fully-formed YYYY-MM-DD
            // strings sort correctly with `<` everywhere.
            .sort((a, b) => cmpAsc(a.startIso, b.startIso));
          for (const slot of candidates) {
            const origPn = slot.resolvedPn;
            const origPn2 = slot.resolvedPn2 || null;
            const origPool = slot.pool;
            const origSource = slot.source;
            const origIdle = !!slot.isIdle;
            slot.resolvedPn = sf.pn;
            slot.resolvedPn2 = null;
            slot.isIdle = false;
            slot.pool = FRAME_POOL[sf.pn] || "std";
            slot.source = "auto";
            resetBeyond();
            const trialResult = simulate(rows, cols, slots, globalCaps, rateByPn);
            const trialScore = scoreSim(rows, trialResult);
            const curScore = scoreSim(rows, repairResult);
            if (compareScores(trialScore, curScore) < 0) {
              repairResult = trialResult;
              adoptedAny = true;
              break;
            }
            slot.resolvedPn = origPn;
            slot.resolvedPn2 = origPn2;
            slot.isIdle = origIdle;
            slot.pool = origPool;
            slot.source = origSource;
          }
          if (adoptedAny) break;
        }
        if (!adoptedAny) break;
      }

      resetBeyond();

      const PHASE4_MAX_PASSES = 6;
      let phase4Result = repairResult;
      for (let pass = 0; pass < PHASE4_MAX_PASSES; pass++) {
        const timelines = phase4Result.onHandTimeline;
        const stockoutFrames = [];
        for (const r of rows) {
          const t = timelines.get(r.pn) || [];
          for (let i = 0; i < t.length; i++) {
            if (t[i].endOh < 0) {
              stockoutFrames.push({ pn: r.pn, firstStockIso: t[i].iso });
              break;
            }
          }
        }
        if (stockoutFrames.length === 0) break;
        let adoptedAny = false;
        for (const sf of stockoutFrames) {
          const candidates = slots
            .filter(s => !s.locked
                      && s.source !== "manual"
                      && s.startIso < sf.firstStockIso
                      && (s.resolvedPn !== sf.pn || s.isIdle))
            // Latest-first, plain ISO string compare (see Phase-3
            // note above). No locale dependency.
            .sort((a, b) => cmpAsc(b.startIso, a.startIso));
          for (const slot of candidates) {
            const origPn = slot.resolvedPn;
            const origPn2 = slot.resolvedPn2 || null;
            const origPool = slot.pool;
            const origSource = slot.source;
            const origIdle = !!slot.isIdle;
            slot.resolvedPn = sf.pn;
            slot.resolvedPn2 = null;
            slot.isIdle = false;
            slot.pool = FRAME_POOL[sf.pn] || "std";
            slot.source = "auto";
            resetBeyond();
            const trial = simulate(rows, cols, slots, globalCaps, rateByPn);
            const t2 = trial.onHandTimeline.get(sf.pn) || [];
            let stillStocksOut = false;
            for (let i = 0; i < t2.length; i++) {
              if (t2[i].endOh < 0) { stillStocksOut = true; break; }
            }
            if (!stillStocksOut) {
              phase4Result = trial;
              adoptedAny = true;
              break;
            }
            slot.resolvedPn = origPn;
            slot.resolvedPn2 = origPn2;
            slot.isIdle = origIdle;
            slot.pool = origPool;
            slot.source = origSource;
          }
          if (adoptedAny) break;
        }
        if (!adoptedAny) break;
      }
      resetBeyond();
      repairResult = phase4Result;

      const finalRuns = repairResult && repairResult.scheduledRuns;
      if (finalRuns) {
        for (const s of slots) {
          if (s.locked) continue;
          if (s.source === "manual") continue;
          if (s.isIdle) continue;
          if (!s.resolvedPn) continue;
          const weekIsoSet = new Set(s.weekIsos);
          let anyRun = false;
          for (const [, runs] of finalRuns.entries()) {
            for (const r of runs) {
              if (r.qty > 0 && weekIsoSet.has(r.weekIso)) { anyRun = true; break; }
            }
            if (anyRun) break;
          }
          if (!anyRun) {
            s.isIdle = true;
            s.source = "idle";
          }
        }
      }

      return repairResult;
    }

    /* ------------------------------------------------------
       DISPATCH.
       ------------------------------------------------------ */
    function runScheduler(rows, cols, slots, globalCaps, visibleStartIsos, rateByPn) {
      if (scheduleMode === "weekly") {
        return simulateWeekly(rows, cols, slots, globalCaps, rateByPn);
      }
      return optimize(rows, cols, slots, globalCaps, visibleStartIsos, rateByPn);
    }

    return {
      // ctx echo
      bufferWeeks,
      scheduleMode,
      // columns + slots
      simColumns,
      renderColumns,
      buildSlots,
      // sim primitives
      pickEarliestRunout,
      pickFillerCandidate,
      poolBehind,
      weeksToNextRunFor,
      weeksBetween,
      // main sims
      simulate,
      simulateWeekly,
      // weekly-mode
      weeklyPickAssignment,
      weeklyScore,
      weeklyEnumerateCandidates,
      weeklyBaselineMinCover,
      weeklyBaselineHorizonProjection,
      // optimizer
      optimize,
      scoreSim,
      compareScores,
      runScheduler,
    };
  }

  return {
    // exposed constants
    FRAME_PNS,
    FRAME_POOL,
    FRAME_SHORT,
    FRAME_PACK,
    SLOT_ANCHOR_ISO,
    SEED_PRE_ANCHOR_PN,
    LOCK_HORIZON_DAYS,
    FS_WORKDAYS_PER_WEEK,
    SIM_HORIZON_WEEKS,
    // ctx-free pure helpers
    isoMonday,
    mdShort,
    packDown,
    packUp,
    stdAllowedPacks,
    stdAllowedUnits,
    weekEnvelopeStatus,
    compareScores,
    gridKey,
    // factory
    forContext,
  };
});
