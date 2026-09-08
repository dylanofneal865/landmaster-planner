// Frame Schedule -- SERVER-SIDE COMPUTE (Phase A of the
// server-side scheduler migration).
//
// Loads the same inputs the browser uses:
//   * frame_schedule rows (per-week + __settings__ sentinel)
//     -- for manual pins, weekly-auto pins, slot data,
//     qtyOverrides, caps, bufferWeeks, scheduleMode.
//   * parts rows for the six frame PNs -- onHand + daily.
// Runs the SAME weekly scheduler the browser runs, via the
// shared lib/frame-scheduler.js module (there is exactly ONE
// implementation of the sim; both this function and js/25
// import it).
// Upserts the projected plan into a NEW shadow table
// frame_schedule_shadow. The function NEVER touches
// frame_schedule, frame_schedule_published, parts, or any
// other existing table -- Phase A is read-plus-shadow-write
// only. Phase B (a later ticket) may promote shadow rows into
// the live table; this function does not.
//
// Trigger: cron every 15 minutes (netlify.toml); also
// callable on demand via HTTP GET / POST -- pass ?dry=1 to
// return the projected plan without writing.
//
// Env:
//   SUPABASE_URL          e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY  service-role key
//
// Contract:
//   * Never modifies, migrates, or deletes rows in existing
//     tables (frame_schedule / frame_schedule_published /
//     frame_schedule_snapshots / parts / po_receipts).
//   * All new state lives in frame_schedule_shadow.
//   * Revertible: unset the cron in netlify.toml OR set the
//     env FS_COMPUTE_ENABLED=0 (checked below) to disable
//     without deleting the function.
//
// See lib/frame-scheduler.js for the shared math surface and
// js/25's window.fsCompareShadow() for the client-side
// browser-vs-shadow diff tool.

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const FrameScheduler = require("../../lib/frame-scheduler.js");

const FRAME_PNS = FrameScheduler.FRAME_PNS;

// tiny helpers that match js/02-utils.js so the shared scheduler
// sees byte-identical date arithmetic on both sides.
function parseDateLocal(s) {
  if (!s || typeof s !== "string") return null;
  const p = s.split("-").map(Number);
  if (p.length !== 3) return null;
  const d = new Date(p[0], p[1] - 1, p[2]);
  d.setHours(0, 0, 0, 0);
  return d;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function mondayOfWeek(d) {
  // Mirror js/23-bom-usage-weekly.js -- Monday-based (Sun -> prev Mon).
  const r = new Date(d);
  const dow = r.getDay();
  const shift = (dow === 0) ? -6 : (1 - dow);
  r.setDate(r.getDate() + shift);
  r.setHours(0, 0, 0, 0);
  return r;
}

async function fetchAll(supa, table, cols) {
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supa.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch ${table} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Build the weekDataByIso map + settings snapshot from
// frame_schedule rows. Mirrors js/30 _populateFrameScheduleFromRows
// exactly so the compute path reads pins/overrides/slot data the
// same way the browser does.
function ingestFrameSchedule(rows) {
  const weekDataByIso = new Map();
  let settings = { caps: { crewhd: 0, std: 0 }, bufferWeeks: null, scheduleMode: "weekly", publishToken: null, lastPublishedAt: null, minWriteBuild: 0 };
  for (const row of rows || []) {
    if (!row || !row.fg_sku) continue;
    const key = String(row.fg_sku);
    const d = row.data || {};
    if (key === "__settings__") {
      const bw = Number(d.bufferWeeks);
      settings = {
        caps: {
          crewhd: Number(d.caps && d.caps.crewhd) || 0,
          std:    Number(d.caps && d.caps.std)    || 0,
        },
        bufferWeeks: (Number.isFinite(bw) && bw >= 0) ? bw : null,
        scheduleMode: (d.scheduleMode === "slots") ? "slots" : "weekly",
        publishToken: (typeof d.publishToken === "string") ? d.publishToken : null,
        lastPublishedAt: (typeof d.lastPublishedAt === "string") ? d.lastPublishedAt : null,
        minWriteBuild: (typeof d.minWriteBuild === "number" && Number.isFinite(d.minWriteBuild) && d.minWriteBuild >= 0) ? Math.floor(d.minWriteBuild) : 0,
      };
      continue;
    }
    const slot = (d.slot && typeof d.slot === "object" && d.slot.pn)
      ? {
          pn: String(d.slot.pn),
          pn2: (typeof d.slot.pn2 === "string" && d.slot.pn2) ? d.slot.pn2 : null,
          locked: !!d.slot.locked,
          source: (d.slot.source === "manual" || d.slot.source === "seed" || d.slot.source === "weekly-auto")
                    ? d.slot.source : "auto",
          mode: d.slot.mode === "weekly" ? "weekly" : null,
          qty:  (typeof d.slot.qty  === "number" && d.slot.qty  >= 0 && Number.isFinite(d.slot.qty))  ? Math.floor(d.slot.qty)  : null,
          qty2: (typeof d.slot.qty2 === "number" && d.slot.qty2 >= 0 && Number.isFinite(d.slot.qty2)) ? Math.floor(d.slot.qty2) : null,
        }
      : null;
    let qtyOverride = null;
    if (d.qtyOverride && typeof d.qtyOverride === "object") {
      qtyOverride = {};
      for (const [k, v] of Object.entries(d.qtyOverride)) {
        const n = Math.floor(Number(v));
        if (Number.isFinite(n) && n >= 0) qtyOverride[k] = n;
      }
      if (Object.keys(qtyOverride).length === 0) qtyOverride = null;
    }
    weekDataByIso.set(key, {
      qty: (d.qty && typeof d.qty === "object") ? d.qty : {},
      slot,
      qtyOverride,
      updatedAt: row.updated_at || null,
    });
  }
  return { weekDataByIso, settings };
}

/* ============================================================
   AUDIT: browser path from raw parts data -> scheduler inputs.

   The browser's renderFrameSchedule builds its scheduler inputs
   from DB.parts like this:

     _fsRows()           -- for each FRAME_PN:
                            { pn,
                              onHand:  Number(part.onHand) || 0,
                              daily:   Number(part.daily)  || 0,   RAW
                              pool:    FRAME_POOL[pn] || "std",
                              part:    the DB.parts entry (used
                                       downstream by _fsDaily) }
     rateByPn[r.pn]      -- _fsDaily(r), which is chain-aware:
                              chainDisplayDaily(part) when the
                              part is in an ACTIVELY-TRANSITIONING
                              supersession chain (lineage.length
                              >= 2 AND at least one member has
                              phasingOut). Otherwise Number(part.daily).
                              For UT101002 (which IS in a chain
                              transitioning to a newer PN) the
                              browser burns at chainDisplayDaily
                              (anchor.daily, higher) NOT part.daily.
                              This is the field whose divergence
                              produced the fsCompareShadow diff at
                              the first freely-scheduled week.
     weeklyBurn          -- rateByPn[pn] * FS_WORKDAYS_PER_WEEK (5).
                            Computed inside the scheduler; not a
                            separate input.

   Per _fsDaily's own docblock and every explicit callsite audit
   in js/25 (search for `rateByPn`), rate STEPS (scheduled ramps
   in js/03) are INTENTIONALLY IGNORED here -- the schedule DRIVES
   production toward the current full rate immediately rather than
   honoring a historical ramp date. That means the scheduler input
   is chainDisplayDaily(part), not chainedDailyDaily-at-week-N.

   Every other browser input to the scheduler (caps, bufferWeeks,
   scheduleMode, week pins, qtyOverrides, slot data) comes from
   the __settings__ row and the per-week frame_schedule rows,
   which we already ingest byte-for-byte via ingestFrameSchedule.

   REPLICATED on the server (this file):
     * onHand         -- raw parts.data.onHand (identical shape).
     * daily raw      -- raw parts.data.daily  (identical shape).
     * chain daily    -- chainDisplayDailyServer, faithful port of
                         js/03 chainDisplayDaily + supersessionLineage.
                         Loads supersededBy + phasingOut from
                         parts.data across ALL parts (not just the
                         6 frames) because the lineage walk goes
                         BACKWARD to find predecessors whose
                         supersededBy points at the current pn.
     * pool           -- FrameScheduler.FRAME_POOL (const).
     * ingest         -- ingestFrameSchedule (mirrors
                         js/30 _populateFrameScheduleFromRows).

   EXCLUDED on the server (with justification):
     * rate steps     -- js/03's schedule of dated rate changes.
                         Browser's _fsDaily explicitly ignores them
                         per the FS_WORKDAYS_PER_WEEK doc block.
                         Excluding here matches the browser.
     * kit BOM math   -- kits are consumed differently from
                         frames; FRAME_PNS are non-kit assemblies.
                         chainDisplayDailyServer inputs are the
                         same fields (part.daily) whether or not
                         the part is a kit component; there is no
                         BOM-level rate adjustment applied by the
                         browser to _fsDaily.
     * PO receipts    -- explicitly excluded from the sim on BOTH
                         sides (`NO PO CREDITS` doc block in js/25).
     * TZ handling    -- Date construction identical between sides
                         (local midnight; timezone-agnostic ISO
                         Monday string keys everywhere).
   ============================================================ */

// Faithful port of js/03 supersessionChain (forward walk following
// part.supersededBy). Same cycle guard. `byPn` is Map<pn -> partData>.
function supersessionChainServer(pn, byPn) {
  const out = [];
  const visited = new Set();
  let cur = pn ? String(pn).trim() : "";
  while (cur && !visited.has(cur)) {
    out.push(cur);
    visited.add(cur);
    const p = byPn.get(cur);
    const next = (p && p.supersededBy) ? String(p.supersededBy).trim() : "";
    if (!next || next === cur) break;
    cur = next;
  }
  return out;
}

// Faithful port of js/03 supersessionLineage (BACKWARD via
// predecessors whose supersededBy points at me, THEN FORWARD via
// supersessionChain). Returns anchor-first ordered pn list.
function supersessionLineageServer(pn, byPn, allEntries) {
  const start = pn ? String(pn).trim() : "";
  if (!start) return [];
  const back = [];
  const seen = new Set([start]);
  let cur = start;
  while (true) {
    // O(N) scan mirrors js/03 (same Array.find shape).
    let pred = null;
    for (const [predPn, predData] of allEntries) {
      if (predData && predData.supersededBy && String(predData.supersededBy).trim() === cur) {
        pred = { pn: predPn };
        break;
      }
    }
    if (!pred) break;
    if (seen.has(pred.pn)) break;   // cycle guard
    back.unshift(pred.pn);
    seen.add(pred.pn);
    cur = pred.pn;
  }
  const forward = supersessionChainServer(start, byPn);
  return [...back, ...forward];
}

// Faithful port of js/03 chainDisplayDaily. Returns anchor.daily
// when the part is in an actively-transitioning chain (lineage
// >= 2 AND any member has phasingOut). Otherwise returns own daily.
// Also returns metadata for the compute-time inputs snapshot.
function chainDisplayDailyServer(pn, byPn, allEntries) {
  const own = byPn.get(pn) || {};
  const ownDaily = Number(own.daily) || 0;
  const lineage = supersessionLineageServer(pn, byPn, allEntries);
  if (lineage.length < 2) {
    return { daily: ownDaily, ownDaily, chainMembers: lineage, chainTransitioning: false, chainAnchorPn: null };
  }
  const transitioning = lineage.some(memberPn => {
    const m = byPn.get(memberPn);
    return !!(m && m.phasingOut);
  });
  const anchorPn = lineage[0];
  if (!transitioning) {
    return { daily: ownDaily, ownDaily, chainMembers: lineage, chainTransitioning: false, chainAnchorPn: anchorPn };
  }
  const anchor = byPn.get(anchorPn);
  const daily = anchor ? (Number(anchor.daily) || 0) : ownDaily;
  return { daily, ownDaily, chainMembers: lineage, chainTransitioning: true, chainAnchorPn: anchorPn };
}

// Build the 6-row FRAME_PNS row set from parts + return the
// per-frame inputs snapshot that will be stored in the shadow
// __settings__ sentinel (see the AUDIT block above for what's
// replicated vs excluded).
function buildFrameRows(partsRows) {
  const byPn = new Map();
  for (const r of partsRows || []) {
    if (!r || !r.pn) continue;
    byPn.set(String(r.pn), r.data || {});
  }
  const allEntries = [...byPn.entries()];   // reused by lineage walks
  const rows = [];
  const perFrameInputs = {};                 // exported to __settings__
  for (const pn of FRAME_PNS) {
    const d = byPn.get(pn) || {};
    const chain = chainDisplayDailyServer(pn, byPn, allEntries);
    const dailyEffective = chain.daily;      // what the scheduler sees
    const weeklyBurn = dailyEffective * FrameScheduler.FS_WORKDAYS_PER_WEEK;
    rows.push({
      pn,
      desc: (d && d.desc) || "",
      pool: FrameScheduler.FRAME_POOL[pn] || "std",
      onHand: Number(d.onHand) || 0,
      daily:  Number(d.daily)  || 0,          // RAW, matches _fsRows
      inCatalog: byPn.has(pn),
    });
    perFrameInputs[pn] = {
      onHand: Number(d.onHand) || 0,
      dailyRaw: Number(d.daily) || 0,
      dailyEffective,
      weeklyBurn,
      chainMembers: chain.chainMembers,
      chainAnchorPn: chain.chainAnchorPn,
      chainTransitioning: chain.chainTransitioning,
      // ingestAdjustments captures anything the ingest pipeline
      // does to the raw parts.data fields. Currently we take
      // onHand + daily verbatim, chain-adjust daily -> dailyEffective,
      // and nothing else. If a future ingest step massages onHand
      // (e.g. subtracting a reserved allocation), record it here.
      ingestAdjustments: {
        onHand: "raw parts.data.onHand",
        daily: chain.chainTransitioning
          ? `chain-anchor daily from ${chain.chainAnchorPn} (chain: ${chain.chainMembers.join(",")})`
          : "raw parts.data.daily",
      },
    };
  }
  return { rows, perFrameInputs };
}

function computeInputHash(frameSchedRows, partsRows, settings) {
  const h = crypto.createHash("sha256");
  // Order-independent: include only the fields that drive the sim.
  const sched = (frameSchedRows || []).map(r => ({
    k: String(r.fg_sku || ""),
    d: r.data || {},
  })).sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0);
  const parts = (partsRows || [])
    .filter(r => FRAME_PNS.includes(String(r.pn)))
    .map(r => ({
      pn: String(r.pn),
      onHand: Number(r.data && r.data.onHand) || 0,
      daily:  Number(r.data && r.data.daily)  || 0,
    }))
    .sort((a, b) => a.pn < b.pn ? -1 : a.pn > b.pn ? 1 : 0);
  h.update(JSON.stringify({ sched, parts, settings }));
  return h.digest("hex");
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[frame-schedule-compute] ${msg}`, data === undefined ? "" : data);

  if (process.env.FS_COMPUTE_ENABLED === "0" || process.env.FS_COMPUTE_ENABLED === "false") {
    log("disabled via FS_COMPUTE_ENABLED env -- skipping");
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "disabled" }) };
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    return { statusCode: 500, body: JSON.stringify({ error: "Missing env vars" }) };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let frameSchedRows, partsRows;
  try {
    [frameSchedRows, partsRows] = await Promise.all([
      fetchAll(supa, "frame_schedule", "fg_sku, weekly_qty, data, updated_at"),
      fetchAll(supa, "parts", "pn, data, updated_at"),
    ]);
  } catch (err) {
    log("input fetch failed", err && err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "input fetch failed", detail: err && err.message }) };
  }

  const { weekDataByIso, settings } = ingestFrameSchedule(frameSchedRows);
  const { rows, perFrameInputs } = buildFrameRows(partsRows);
  const globalCaps = settings.caps || { crewhd: 0, std: 0 };
  const bufferWeeks = (typeof settings.bufferWeeks === "number" && Number.isFinite(settings.bufferWeeks) && settings.bufferWeeks >= 0)
    ? settings.bufferWeeks : 1.0;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const todayIso = today.getFullYear() + "-"
    + String(today.getMonth() + 1).padStart(2, "0") + "-"
    + String(today.getDate()).padStart(2, "0");
  const ctx = {
    weekDataByIso,
    bufferWeeks,
    scheduleMode: settings.scheduleMode || "weekly",
    today,
    parseDateLocal,
    addDays,
    mondayOfWeek,
    // dailyFor is the fallback path the scheduler uses when
    // rateByPn is not passed. Chain-aware -- mirrors js/25's
    // _fsDaily. Every hot-path caller passes rateByPn (built
    // below from perFrameInputs) so this fallback rarely fires,
    // but keep it correct so a bare simulate() call from a test
    // or a future caller doesn't silently pick the raw rate.
    dailyFor: (row) => {
      const rec = row && row.pn ? perFrameInputs[row.pn] : null;
      if (rec && Number.isFinite(rec.dailyEffective)) return rec.dailyEffective;
      return Number(row && row.daily) || 0;
    },
  };
  const sched = FrameScheduler.forContext(ctx);

  // rateByPn feeds the scheduler's per-workday rate table. Reads
  // dailyEffective (chain-adjusted, mirrors browser _fsDaily) NOT
  // the raw parts.data.daily. This was the fsCompareShadow
  // divergence: reading raw daily here burned UT101002 at ~0.16/d
  // while the browser burned it at ~0.61/d (anchor's rate), so
  // the two plans agreed through pinned weeks and forked at the
  // first freely-scheduled week.
  const rateByPn = {};
  for (const r of rows) rateByPn[r.pn] = perFrameInputs[r.pn].dailyEffective;

  const simCols = sched.simColumns();
  const renderCols = sched.renderColumns();
  const visibleStartIsos = new Set(renderCols.map(c => c.iso));
  const slots = sched.buildSlots(simCols);
  const simResult = sched.runScheduler(rows, simCols, slots, globalCaps, visibleStartIsos, rateByPn);
  const scheduledRuns = simResult.scheduledRuns;

  // Pack the sim result into one shadow row per iso in simCols.
  // data.qty = {pn -> qty} (only nonzero entries); data.slot =
  // resolved slot descriptor for that iso (if any); data.kinds =
  // {pn -> "run"|"filler"|"override"} so the compare tool can see
  // WHY a placement landed.
  const isoToSlot = new Map();
  for (const s of slots) {
    for (const iso of s.weekIsos) isoToSlot.set(iso, s);
  }

  const nowIso = new Date().toISOString();
  const inputHash = computeInputHash(frameSchedRows, partsRows, {
    caps: globalCaps,
    bufferWeeks,
    scheduleMode: settings.scheduleMode,
    minWriteBuild: settings.minWriteBuild,
  });

  const shadowRows = [];
  for (const c of simCols) {
    const iso = c.iso;
    const qtyMap = {};
    const kindMap = {};
    for (const r of rows) {
      const runs = scheduledRuns.get(r.pn) || [];
      let q = 0;
      let kind = null;
      for (const rn of runs) {
        if (rn && rn.weekIso === iso) {
          q += Number(rn.qty) || 0;
          if (!kind) kind = rn.kind || "run";
        }
      }
      if (q > 0) {
        qtyMap[r.pn] = q;
        kindMap[r.pn] = kind || "run";
      }
    }
    const slot = isoToSlot.get(iso) || null;
    const slotBlob = slot ? {
      startIso: slot.startIso,
      weekIsos: slot.weekIsos,
      pn: slot.resolvedPn || null,
      pn2: slot.resolvedPn2 || null,
      isIdle: !!slot.isIdle,
      source: slot.source || null,
      locked: !!slot.locked,
      pool: slot.pool || null,
    } : null;
    shadowRows.push({
      fg_sku: iso,
      weekly_qty: null,
      data: {
        qty: qtyMap,
        kinds: kindMap,
        slot: slotBlob,
        current: !!c.current,
      },
      updated_at: nowIso,
      computed_at: nowIso,
      input_hash: inputHash,
    });
  }
  // Build the list of week rows honored as pins. Two sources
  // (mirrors simulateWeekly's pinByIso construction):
  //   (a) legacy 2-week locked slots (source: "seed" | "auto" |
  //       "manual"; both weeks pinned)
  //   (b) v7.1 per-week weekly-mode pins (slot.mode === "weekly";
  //       source: "weekly-auto" | "manual")
  // qtyOverride entries piggyback on any week that carries one so
  // the fsCompareShadow tool can see WHAT constraint the sim saw.
  const weeklyPins = [];
  const seenPinIsos = new Set();
  for (const s of slots) {
    if (!s.locked || !s.resolvedPn) continue;
    for (let idx = 0; idx < s.weekIsos.length; idx++) {
      const iso = s.weekIsos[idx];
      if (seenPinIsos.has(iso)) continue;
      seenPinIsos.add(iso);
      const wk = weekDataByIso.get(iso) || {};
      const usePn2 = idx === 1 && !!s.resolvedPn2 && s.resolvedPn2 !== s.resolvedPn;
      weeklyPins.push({
        iso,
        pn: usePn2 ? s.resolvedPn2 : s.resolvedPn,
        source: s.source || "auto",
        fromSlot: true,
        qty: (wk.qty && typeof wk.qty === "object") ? wk.qty : {},
        qtyOverride: (wk.qtyOverride && typeof wk.qtyOverride === "object") ? wk.qtyOverride : null,
      });
    }
  }
  const isosSorted = [...weekDataByIso.keys()].sort();
  for (const iso of isosSorted) {
    if (iso === "__settings__") continue;
    if (seenPinIsos.has(iso)) continue;
    const wk = weekDataByIso.get(iso) || {};
    const slot = wk && wk.slot;
    if (!slot || !slot.pn || slot.mode !== "weekly") {
      // Not a pin, but if a qtyOverride is set, surface it -- the
      // sim honors those as hard placements too.
      if (wk.qtyOverride && Object.keys(wk.qtyOverride).length > 0) {
        weeklyPins.push({
          iso,
          pn: null,
          source: "qtyOverride-only",
          fromSlot: false,
          qty: (wk.qty && typeof wk.qty === "object") ? wk.qty : {},
          qtyOverride: wk.qtyOverride,
        });
      }
      continue;
    }
    weeklyPins.push({
      iso,
      pn: slot.pn,
      source: slot.source || "weekly-auto",
      fromSlot: false,
      qty: (typeof slot.qty === "number") ? slot.qty : null,
      pn2: (slot.pn2 && slot.pn2 !== slot.pn) ? slot.pn2 : null,
      qty2: (typeof slot.qty2 === "number") ? slot.qty2 : null,
      qtyOverride: (wk.qtyOverride && typeof wk.qtyOverride === "object") ? wk.qtyOverride : null,
    });
  }

  const gridKey = FrameScheduler.gridKey(rows, renderCols, scheduledRuns, globalCaps, bufferWeeks);

  // DETERMINISM SELF-TEST. Run the scheduler a SECOND time from
  // the same loaded inputs (fresh factory, fresh slot descriptors,
  // fresh sim result -- everything the first pass mutated is
  // rebuilt) and assert the gridKey matches. Logs one line per
  // run: DETERMINISM OK / DETERMINISM FAIL <gk1> vs <gk2>. A FAIL
  // means an in-process ordering nondeterminism has crept back in
  // (Map iteration order, unsorted tie-break, floating-point sum
  // order); the shadow write still proceeds so the compare tool
  // can still surface the exact per-cell diff.
  let determinismLine;
  try {
    const sched2 = FrameScheduler.forContext(ctx);
    const cols2 = sched2.simColumns();
    const renderCols2 = sched2.renderColumns();
    const visible2 = new Set(renderCols2.map(c => c.iso));
    const slots2 = sched2.buildSlots(cols2);
    const res2 = sched2.runScheduler(rows, cols2, slots2, globalCaps, visible2, rateByPn);
    const gridKey2 = FrameScheduler.gridKey(rows, renderCols2, res2.scheduledRuns, globalCaps, bufferWeeks);
    if (gridKey === gridKey2) {
      determinismLine = "DETERMINISM OK";
      log(determinismLine);
    } else {
      determinismLine = "DETERMINISM FAIL";
      log(`${determinismLine} gridKey1 vs gridKey2`, { g1: gridKey, g2: gridKey2 });
    }
  } catch (err) {
    determinismLine = "DETERMINISM SELF-TEST THREW";
    log(determinismLine, err && err.message);
  }

  // Stamp the __settings__ sentinel with EVERYTHING the browser
  // needs to diff its own inputs against ours. fsCompareShadow
  // reads this first -- an INPUT DIFF surfaces a divergence at
  // the ingest layer BEFORE the plan diff table. Fields the
  // browser mirrors 1:1:
  //   perFrameInputs[pn] -> onHand, dailyRaw, dailyEffective,
  //                         weeklyBurn, chainMembers,
  //                         chainAnchorPn, chainTransitioning,
  //                         ingestAdjustments.
  //   anchorIso          -- FrameScheduler.SLOT_ANCHOR_ISO const.
  //   todayIso           -- the "today" the sim saw (local
  //                         midnight, ISO YYYY-MM-DD).
  //   determinism        -- DETERMINISM OK / FAIL from above.
  //   weeklyPins         -- every honored pin + qtyOverride entry.
  shadowRows.push({
    fg_sku: "__settings__",
    weekly_qty: null,
    data: {
      caps: globalCaps,
      bufferWeeks,
      scheduleMode: settings.scheduleMode,
      simHorizonWeeks: FrameScheduler.SIM_HORIZON_WEEKS,
      simFirstIso: simCols[0] ? simCols[0].iso : null,
      simLastIso: simCols[simCols.length - 1] ? simCols[simCols.length - 1].iso : null,
      framePns: FRAME_PNS,
      anchorIso: FrameScheduler.SLOT_ANCHOR_ISO,
      todayIso,
      determinism: determinismLine,
      perFrameInputs,
      weeklyPins,
    },
    updated_at: nowIso,
    computed_at: nowIso,
    input_hash: inputHash,
  });

  const summary = {
    ok: true,
    inputHash,
    gridKey,
    determinism: determinismLine,
    simFirstIso: simCols[0] ? simCols[0].iso : null,
    simLastIso: simCols[simCols.length - 1] ? simCols[simCols.length - 1].iso : null,
    weeks: simCols.length,
    rowsToWrite: shadowRows.length,
    scheduleMode: settings.scheduleMode,
    caps: globalCaps,
    bufferWeeks,
    tookMs: Date.now() - t0,
  };

  // Dry mode -- return the plan without writing. Useful for
  // eyeballing a proposed plan before enabling the write path.
  const q = (event && event.queryStringParameters) || {};
  if (q.dry === "1" || q.dry === "true") {
    log("dry run -- not writing shadow", summary);
    return {
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...summary, dryPlan: shadowRows }),
    };
  }

  // Upsert into frame_schedule_shadow. Batched writes -- Supabase
  // handles 21 rows in a single round trip comfortably.
  const { error: writeErr } = await supa
    .from("frame_schedule_shadow")
    .upsert(shadowRows, { onConflict: "fg_sku" });
  if (writeErr) {
    log("shadow upsert failed", { code: writeErr.code, message: writeErr.message });
    return {
      statusCode: 500,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "shadow write failed", detail: writeErr.message }),
    };
  }

  log("shadow updated", summary);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(summary),
  };
};
