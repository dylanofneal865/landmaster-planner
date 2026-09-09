// Cycle Count -- MORNING ASSIGNMENT (cron).
//
// Runs weekday mornings (see netlify.toml). Populates
// cycle_count_items with three tiers:
//
//   HOT (every weekday, no recency limit):
//     * parts where onHand < 0 (real negative -- something wrong)
//     * parts where onHand <= 0 AND has a positive daily
//     * parts where (daily > 0) AND (onHand / daily) <= HOT_COVER_DAYS
//       (critical-status proxy: at or below one week of cover)
//     * operator-flagged pns from today already land as HOT via
//       cycle-count-write "flag" op -- we DON'T re-insert those,
//       just count them so the summary is right.
//
//   RUNWAY (Mondays only):
//     * daysOfCover < RUNWAY_COVER_DAYS AND not counted in the last
//       RUNWAY_RECENCY_DAYS days.
//     * shortest runway first.
//     * capped at RUNWAY_CAP_PER_WEEK; overflow rolls forward
//       naturally -- next Monday's cron re-considers.
//     * reason: "runway <N>d"
//
//   ROTATION (Mondays only):
//     * fill up to WEEKLY_TOTAL_TARGET total assignments this week
//       with least-recently-counted parts (nothing >180 days
//       uncounted -- oldest go first).
//     * frame SKUs (FRAME_PNS) forced onto a 30-day cycle: if any
//       frame pn hasn't been counted in >= FRAME_ROTATION_DAYS,
//       insert it regardless of the weekly cap.
//     * reason: "rotation" (or "rotation frame" for frames).
//
// IDEMPOTENCY: runs may fire more than once per morning (Netlify
// retries, manual triggers). For each planned pn we check whether
// an item already exists for today (or this week for RUNWAY /
// ROTATION) and skip if so.
//
// ISOLATION: reads parts + cycle_count_items + cycle_count_log,
// writes ONLY to cycle_count_items. NEVER touches parts, pos,
// po_receipts, or frame_schedule.

const { createClient } = require("@supabase/supabase-js");

// Frames get forced onto a 30-day rotation cycle -- keeps the six
// finished-goods SKUs on a predictable audit rhythm. Kept in sync
// with lib/frame-scheduler.js FRAME_PNS.
const FRAME_PNS = ["UT101001", "UT101002", "UT101003", "UT101004", "UT101005", "UT101006"];

const HOT_COVER_DAYS = 7;              // <= 1 week of cover reads as critical
const RUNWAY_COVER_DAYS = 60;
const RUNWAY_RECENCY_DAYS = 45;
const RUNWAY_CAP_PER_WEEK = 45;
const WEEKLY_TOTAL_TARGET = 60;
const ROTATION_STALE_DAYS = 180;
const FRAME_ROTATION_DAYS = 30;

function _todayIsoUtc() {
  const d = new Date();
  return d.getFullYear() + "-"
    + String(d.getMonth() + 1).padStart(2, "0") + "-"
    + String(d.getDate()).padStart(2, "0");
}

function _mondayOfIso(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  const dow = dt.getDay(); // 0=Sun..6=Sat
  const shift = (dow === 0) ? -6 : (1 - dow);
  dt.setDate(dt.getDate() + shift);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function _daysBetweenIso(isoOlder, isoNewer) {
  const older = new Date(isoOlder);
  const newer = new Date(isoNewer);
  if (isNaN(older) || isNaN(newer)) return Infinity;
  return Math.floor((newer.getTime() - older.getTime()) / (24 * 60 * 60 * 1000));
}

async function _fetchAll(supa, table, cols) {
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

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[cycle-count-assign] ${msg}`, data === undefined ? "" : data);
  const isCron = !!(event && event.headers && (event.headers["x-nf-scheduled"] || event.headers["X-Nf-Scheduled"]));

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "server not configured" }) };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const today = _todayIsoUtc();
  const monday = _mondayOfIso(today);
  const weekday = new Date(today).getUTCDay(); // 0=Sun..6=Sat, UTC
  const isMonday = weekday === 1;
  const isWeekend = weekday === 0 || weekday === 6;
  const q = (event && event.queryStringParameters) || {};
  const force = q.force === "1" || q.force === "true";
  const dryRun = q.dry === "1" || q.dry === "true";

  if (isWeekend && !force) {
    log("weekend -- skipping (pass ?force=1 to run anyway)");
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "weekend", today, weekday }) };
  }

  // ---- Load inputs ----------------------------------------------
  let partsRows, todaysItems, weeksItems, lastCountedByPn;
  try {
    [partsRows, todaysItems, weeksItems] = await Promise.all([
      _fetchAll(supa, "parts", "pn, data"),
      _fetchAll(supa, "cycle_count_items", "pn, tier, assigned_date, status"),  // filtered below
      _fetchAll(supa, "cycle_count_log", "pn, counted_at, outcome"),  // for last-counted-by-pn
    ]);
  } catch (err) {
    log("input fetch failed", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "input fetch failed", detail: err.message }) };
  }
  // Reduce items to today + this-week sets.
  const hotTodayPns = new Set(
    todaysItems.filter(r => r && r.assigned_date === today && r.tier === "hot").map(r => r.pn)
  );
  const runwayThisWeekPns = new Set(
    todaysItems.filter(r => r && r.tier === "runway" && r.assigned_date >= monday).map(r => r.pn)
  );
  const rotationThisWeekPns = new Set(
    todaysItems.filter(r => r && r.tier === "rotation" && r.assigned_date >= monday).map(r => r.pn)
  );
  const anyThisWeekPns = new Set(
    todaysItems.filter(r => r && r.assigned_date >= monday).map(r => r.pn)
  );
  const weeklyTotalSoFar = new Set(anyThisWeekPns).size;

  // Latest counted_at per pn (from log; only "counted"/"reconciled"
  // outcomes count as a valid last-count for recency purposes --
  // "skipped" doesn't reset the clock).
  lastCountedByPn = new Map();
  for (const r of weeksItems) {
    if (!r || !r.pn) continue;
    if (r.outcome !== "counted" && r.outcome !== "reconciled") continue;
    const prev = lastCountedByPn.get(r.pn);
    if (!prev || String(r.counted_at) > String(prev)) lastCountedByPn.set(r.pn, r.counted_at);
  }

  // Live catalog map. Only include parts that would be plausibly
  // countable (skip do-not-order, kits, phasing-out).
  const partsByPn = new Map();
  for (const p of partsRows) {
    if (!p || !p.pn) continue;
    const d = p.data || {};
    if (d.itemType === "do_not_order") continue;
    if (d.isKit) continue;
    if (d.phasingOut) continue;
    partsByPn.set(String(p.pn), {
      pn: String(p.pn),
      onHand: Number(d.onHand) || 0,
      daily: Number(d.daily) || 0,
      partClass: d.partClass || "",
    });
  }

  const plans = [];   // rows to insert
  const summary = { hot: 0, runway: 0, rotation: 0, framesForced: 0, skippedExisting: 0 };

  // ---- HOT -------------------------------------------------------
  for (const [pn, p] of partsByPn.entries()) {
    if (hotTodayPns.has(pn)) { summary.skippedExisting++; continue; }
    let hot = false;
    let reason = "";
    if (p.onHand < 0) { hot = true; reason = `negative on-hand (${p.onHand})`; }
    else if (p.onHand <= 0) { hot = true; reason = "zero on-hand"; }
    else if (p.daily > 0) {
      const cover = p.onHand / p.daily;
      if (cover <= HOT_COVER_DAYS) {
        hot = true;
        reason = `critical -- ${cover.toFixed(1)}d cover`;
      }
    }
    if (!hot) continue;
    plans.push({
      assigned_date: today,
      tier: "hot",
      reason,
      pn,
      system_qty_at_assign: p.onHand,
      status: "pending",
    });
    summary.hot++;
  }

  // ---- RUNWAY + ROTATION -- Mondays only ------------------------
  if (isMonday) {
    // RUNWAY.
    const runwayCandidates = [];
    for (const [pn, p] of partsByPn.entries()) {
      if (runwayThisWeekPns.has(pn)) continue;
      if (hotTodayPns.has(pn)) continue;   // HOT wins the same-day battle
      if (p.daily <= 0) continue;
      const cover = p.onHand / p.daily;
      if (cover >= RUNWAY_COVER_DAYS) continue;
      const lastAt = lastCountedByPn.get(pn);
      if (lastAt && _daysBetweenIso(lastAt, today) < RUNWAY_RECENCY_DAYS) continue;
      runwayCandidates.push({ pn, cover, p });
    }
    runwayCandidates.sort((a, b) => a.cover - b.cover);
    const runwayLimit = Math.max(0, RUNWAY_CAP_PER_WEEK);
    for (const c of runwayCandidates.slice(0, runwayLimit)) {
      plans.push({
        assigned_date: today,
        tier: "runway",
        reason: `runway ${c.cover.toFixed(1)}d`,
        pn: c.pn,
        system_qty_at_assign: c.p.onHand,
        status: "pending",
      });
      summary.runway++;
    }

    // ROTATION -- fill to WEEKLY_TOTAL_TARGET with LRU counts,
    // nothing >ROTATION_STALE_DAYS uncounted, plus forced frames
    // on 30-day cycle.
    const already = weeklyTotalSoFar + summary.hot + summary.runway;
    const rotationSlots = Math.max(0, WEEKLY_TOTAL_TARGET - already);
    const rotationCandidates = [];
    for (const [pn, p] of partsByPn.entries()) {
      if (rotationThisWeekPns.has(pn)) continue;
      if (hotTodayPns.has(pn)) continue;
      if (runwayThisWeekPns.has(pn) || plans.some(pl => pl.pn === pn)) continue;
      const lastAt = lastCountedByPn.get(pn);
      const daysSince = lastAt ? _daysBetweenIso(lastAt, today) : Infinity;
      rotationCandidates.push({ pn, daysSince, p, isFrame: FRAME_PNS.includes(pn) });
    }
    // Force frames on their 30-day cycle regardless of the cap.
    for (const c of rotationCandidates) {
      if (!c.isFrame) continue;
      if (c.daysSince < FRAME_ROTATION_DAYS) continue;
      plans.push({
        assigned_date: today,
        tier: "rotation",
        reason: `rotation frame (${c.daysSince === Infinity ? "never" : c.daysSince + "d"} since last count)`,
        pn: c.pn,
        system_qty_at_assign: c.p.onHand,
        status: "pending",
      });
      summary.rotation++;
      summary.framesForced++;
    }
    // Fill remaining slots with oldest-counted first (Infinity is
    // never-counted -- ranks worst).
    rotationCandidates.sort((a, b) => (b.daysSince === Infinity ? Number.MAX_SAFE_INTEGER : b.daysSince) - (a.daysSince === Infinity ? Number.MAX_SAFE_INTEGER : a.daysSince));
    let picked = 0;
    for (const c of rotationCandidates) {
      if (picked >= rotationSlots) break;
      if (c.isFrame && c.daysSince >= FRAME_ROTATION_DAYS) continue;  // already forced above
      if (plans.some(pl => pl.pn === c.pn)) continue;
      // Ignore if never-counted AND weekly quota is already met
      // (age > STALE always wins).
      const staleWin = c.daysSince >= ROTATION_STALE_DAYS;
      if (!staleWin && picked >= rotationSlots) break;
      plans.push({
        assigned_date: today,
        tier: "rotation",
        reason: c.daysSince === Infinity ? "rotation (never counted)" : `rotation (${c.daysSince}d)`,
        pn: c.pn,
        system_qty_at_assign: c.p.onHand,
        status: "pending",
      });
      summary.rotation++;
      picked++;
    }
  }

  log(`plan: hot=${summary.hot} runway=${summary.runway} rotation=${summary.rotation} (frames forced=${summary.framesForced})`);

  if (plans.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, today, isMonday, summary, inserted: 0 }) };
  }

  if (dryRun) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, today, isMonday, summary, inserted: 0, dryPlan: plans }),
    };
  }

  // Batched insert (Supabase can eat 200+ rows in one call).
  const { error: insErr } = await supa.from("cycle_count_items").insert(plans);
  if (insErr) {
    log("insert failed", insErr);
    return { statusCode: 500, body: JSON.stringify({ error: "insert failed", detail: insErr.message }) };
  }

  log(`inserted ${plans.length} items in ${Date.now() - t0}ms`);
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      today,
      isMonday,
      isCron,
      summary,
      inserted: plans.length,
      tookMs: Date.now() - t0,
    }),
  };
};
