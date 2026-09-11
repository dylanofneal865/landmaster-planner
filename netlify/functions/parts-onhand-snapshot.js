// Inventory Reconciliation -- NIGHTLY LEDGER.
//
// Every night at 05:50 UTC, writes one row per Base BOM part into
// parts_onhand_snapshots. Read-only against parts / part_locations /
// po_receipts / cycle_count_log; NEVER writes on-hand (Acumatica
// remains the SoR). One nightly snapshot is a self-audit: on_hand
// change since the previous snapshot vs (receipts_qty - usage_est).
// The gap is `residual` -- the record-keeping error we don't have
// a paper trail for.
//
// Exclusions mirror cycle-count-assign.js so both surfaces see the
// same "production audit universe": Base BOM only; VMI suppliers
// (Fastenal etc.); pre-launch standalones; queued and retired
// members of transitioning chains.
//
// Manual triggers:
//   GET /.netlify/functions/parts-onhand-snapshot            -- normal run
//   GET /.netlify/functions/parts-onhand-snapshot?dry=1      -- preview, no writes
//   GET /.netlify/functions/parts-onhand-snapshot?anchor=1   -- force anchor row
//                                                              (previous snapshot ignored;
//                                                              use once at deploy so the
//                                                              first row exists).
//
// See parts_onhand_snapshots schema at the bottom of this file's
// comment header for the CREATE TABLE SQL.

const { createClient } = require("@supabase/supabase-js");
const { classifyChainRole } = require("../../lib/supersession-server.js");

const WAREHOUSE_SENTINEL = "__warehouse__";
const VMI_SUPPLIER_TOKENS = ["fastenal"];
const RETENTION_DAYS = 180;
// v-ir-1: "adjustment applied" window. Any residual within this
// many days AFTER a recorded count, opposite in sign to the
// count's variance and within ADJUSTMENT_MAGNITUDE_TOLERANCE of
// its magnitude, is flagged and excluded from the leak headline.
// Kept short so a real leak that happens to fall a week after a
// count still shows up.
const ADJUSTMENT_WINDOW_DAYS = 3;
const ADJUSTMENT_MAGNITUDE_TOLERANCE = 0.25;   // within 25% of variance

function _todayIsoUtc() {
  const d = new Date();
  return d.getFullYear() + "-"
    + String(d.getMonth() + 1).padStart(2, "0") + "-"
    + String(d.getDate()).padStart(2, "0");
}
function _isVmiPart(d) {
  if (!d || typeof d !== "object") return false;
  const c = [d.supplier, d.vendor, d.vendorName, d.supplierName, d.Supplier, d.SupplierName];
  for (const raw of c) {
    const n = String(raw || "").toLowerCase().trim();
    if (!n) continue;
    for (const t of VMI_SUPPLIER_TOKENS) if (t && n.indexOf(t) !== -1) return true;
  }
  return false;
}
function _isStandalonePreLaunch(d, todayDate) {
  const raw = d && d.transitionStartDate;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return false;
  const [y, mo, da] = raw.slice(0, 10).split("-").map(Number);
  const dt = new Date(y, mo - 1, da);
  dt.setHours(0, 0, 0, 0);
  if (isNaN(dt.getTime())) return false;
  return dt.getTime() > todayDate.getTime();
}
// Count WEEKDAYS strictly between two ISO dates (exclusive of
// both endpoints, since neither anchor should contribute usage
// to the interval it opens).
function _workdaysBetween(prevIso, curIso) {
  if (!prevIso || !curIso || prevIso >= curIso) return 0;
  const [py, pm, pd] = prevIso.split("-").map(Number);
  const [cy, cm, cd] = curIso.split("-").map(Number);
  const start = new Date(py, pm - 1, pd); start.setHours(0, 0, 0, 0);
  const end = new Date(cy, cm - 1, cd); end.setHours(0, 0, 0, 0);
  let count = 0;
  const cur = new Date(start.getTime() + 24 * 3600 * 1000);
  while (cur.getTime() < end.getTime()) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) count++;
    cur.setDate(cur.getDate() + 1);
  }
  // ALSO count the snapshot day itself if it's a weekday -- usage
  // through end-of-day-before-snapshot is what the on-hand delta
  // reflects.
  const endDow = end.getDay();
  if (endDow !== 0 && endDow !== 6) count++;
  return count;
}
async function _fetchAll(supa, table, cols, filter) {
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    let q = supa.from(table).select(cols).range(from, from + PAGE - 1);
    if (typeof filter === "function") q = filter(q);
    const { data, error } = await q;
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
  const log = (msg, data) => console.log(`[parts-onhand-snapshot] ${msg}`, data === undefined ? "" : data);
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "server not configured" }) };
  }
  const q = (event && event.queryStringParameters) || {};
  const dryRun = q.dry === "1" || q.dry === "true";
  const forceAnchor = q.anchor === "1" || q.anchor === "true";
  const today = _todayIsoUtc();
  const todayDate = new Date(today + "T00:00:00");
  todayDate.setHours(0, 0, 0, 0);

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Retention sweep -- best effort, non-fatal.
  const cutoff = new Date(todayDate.getTime() - RETENTION_DAYS * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  if (!dryRun) {
    const { error: delErr } = await supa
      .from("parts_onhand_snapshots")
      .delete()
      .lt("snapshot_date", cutoff);
    if (delErr) log("retention delete failed (non-fatal): " + delErr.message);
  }

  let partsRows, locRows, posRows, priorSnaps, logRows, priorRecents;
  try {
    [partsRows, locRows, posRows, priorSnaps, logRows] = await Promise.all([
      _fetchAll(supa, "parts", "pn, data"),
      _fetchAll(supa, "part_locations", "pn, location, qty"),
      _fetchAll(supa, "pos", "id, data"),
      _fetchAll(supa, "parts_onhand_snapshots", "snapshot_date, pn, on_hand", q =>
        q.gte("snapshot_date", new Date(todayDate.getTime() - 45 * 24 * 3600 * 1000).toISOString().slice(0, 10))),
      _fetchAll(supa, "cycle_count_log", "pn, counted_at, counted_by, counted_qty, variance, outcome", q =>
        q.gte("counted_at", new Date(todayDate.getTime() - 45 * 24 * 3600 * 1000).toISOString())),
    ]);
    // Small window of po_receipts covering the freshest snapshot
    // interval + a paranoia buffer -- we filter per-pn by prev
    // snapshot date below, so a 45d window covers every plausible
    // gap between snapshots (a two-week outage plus slop).
    priorRecents = await _fetchAll(supa, "po_receipts", "id, data", q =>
      q.gte("data->>receiptDate", new Date(todayDate.getTime() - 45 * 24 * 3600 * 1000).toISOString().slice(0, 10))
       .lte("data->>receiptDate", today));
  } catch (err) {
    log("input fetch failed: " + err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "input fetch failed", detail: err.message }) };
  }

  // Physical on-hand per pn (same priority as cycle-count-assign).
  const locSumByPn = new Map();
  const sentinelByPn = new Map();
  for (const l of (locRows || [])) {
    if (!l || !l.pn) continue;
    const qty = Number(l.qty) || 0;
    if (String(l.location) === WAREHOUSE_SENTINEL) sentinelByPn.set(l.pn, qty);
    else locSumByPn.set(l.pn, (locSumByPn.get(l.pn) || 0) + qty);
  }
  function _physicalFor(pn, avail) {
    if (locSumByPn.has(pn)) return locSumByPn.get(pn);
    if (sentinelByPn.has(pn)) return sentinelByPn.get(pn);
    return Number(avail) || 0;
  }

  const allPartsData = new Map();
  for (const p of partsRows) {
    if (!p || !p.pn) continue;
    allPartsData.set(String(p.pn), p.data || {});
  }
  const allEntries = [...allPartsData.entries()];

  // Latest snapshot per pn from priorSnaps (newest wins).
  const latestPrevByPn = new Map();
  for (const s of (priorSnaps || [])) {
    if (!s || !s.pn) continue;
    if (s.snapshot_date === today) continue;   // ignore any same-day overwrite scenario
    const prev = latestPrevByPn.get(s.pn);
    if (!prev || s.snapshot_date > prev.snapshot_date) latestPrevByPn.set(s.pn, s);
  }

  // Group po_receipts by pn -> list of { date, qty }.
  const receiptsByPn = new Map();
  for (const r of (priorRecents || [])) {
    const d = r && r.data;
    if (!d || !d.pn || !d.receiptDate) continue;
    if (d.status && String(d.status).trim() !== "Released") continue;
    let arr = receiptsByPn.get(d.pn);
    if (!arr) { arr = []; receiptsByPn.set(d.pn, arr); }
    arr.push({ date: String(d.receiptDate).slice(0, 10), qty: Number(d.qty) || 0 });
  }

  // Latest count per pn (counted / reconciled outcomes; skipped
  // never resets the anchor).
  const latestCountByPn = new Map();
  for (const r of (logRows || [])) {
    if (!r || !r.pn) continue;
    if (r.outcome !== "counted" && r.outcome !== "reconciled") continue;
    const prev = latestCountByPn.get(r.pn);
    if (!prev || String(r.counted_at) > String(prev.counted_at)) latestCountByPn.set(r.pn, r);
  }

  // Build rows.
  const rows = [];
  const stats = {
    considered: 0,
    excludedNonBaseBom: 0,
    excludedVmi: 0,
    excludedPreLaunch: 0,
    excludedQueued: 0,
    excludedRetired: 0,
    excludedPhasingOut: 0,
    anchors: 0,
    nonAnchors: 0,
    adjustmentApplied: 0,
    residualZero: 0,
    residualNonZero: 0,
  };
  for (const p of partsRows) {
    if (!p || !p.pn) continue;
    const d = p.data || {};
    const itemType = String(d.itemType || "").toLowerCase().trim();
    if (itemType !== "base_bom") { stats.excludedNonBaseBom++; continue; }
    if (_isVmiPart(d)) { stats.excludedVmi++; continue; }
    if (d.phasingOut === true) { stats.excludedPhasingOut++; continue; }
    if (_isStandalonePreLaunch(d, todayDate)) { stats.excludedPreLaunch++; continue; }
    const chain = classifyChainRole(String(p.pn), allPartsData, allEntries, todayDate);
    if (chain.transitioning) {
      if (chain.role === "queued") { stats.excludedQueued++; continue; }
      if (chain.role === "retired") {
        const stock = _physicalFor(String(p.pn), d.onHand);
        if (stock <= 0) { stats.excludedRetired++; continue; }
      }
    }
    stats.considered++;

    const pn = String(p.pn);
    const onHand = _physicalFor(pn, d.onHand);
    const dailyUse = chain.transitioning
      ? (function () {
          const anchor = allPartsData.get(chain.anchorPn) || {};
          return Number(anchor.daily) || 0;
        })()
      : (Number(d.daily) || 0);
    const prev = forceAnchor ? null : latestPrevByPn.get(pn);
    const prevDate = prev ? prev.snapshot_date : null;

    // Receipts in the interval (prev exclusive, today inclusive).
    let receiptsQty = 0;
    let receiptsCount = 0;
    const receipts = receiptsByPn.get(pn) || [];
    for (const r of receipts) {
      if (prevDate) {
        if (r.date <= prevDate) continue;
      }
      if (r.date > today) continue;
      receiptsQty += r.qty;
      receiptsCount++;
    }

    // Workday-aware usage estimate.
    const workdays = prevDate ? _workdaysBetween(prevDate, today) : 0;
    const usageEst = Math.round((dailyUse * workdays) * 100) / 100;

    // Residual: null on anchor day; otherwise (delta) - receipts + usage.
    let residual = null;
    if (prev) {
      const delta = onHand - (Number(prev.on_hand) || 0);
      residual = Math.round((delta - receiptsQty + usageEst) * 100) / 100;
    } else {
      stats.anchors++;
    }

    // Adjustment awareness: is this residual within 3 days of a
    // recorded count AND opposite-signed to that count's variance
    // AND within tolerance of its magnitude? If so, mark & we
    // exclude from headline leak on the UI.
    let adjustmentApplied = false;
    if (residual !== null && Math.abs(residual) > 0.5) {
      const cnt = latestCountByPn.get(pn);
      if (cnt && cnt.counted_at) {
        const daysSince = Math.round((todayDate.getTime() - new Date(cnt.counted_at).getTime()) / (24 * 3600 * 1000));
        const cntVar = Number(cnt.variance);
        if (daysSince >= 0 && daysSince <= ADJUSTMENT_WINDOW_DAYS && Number.isFinite(cntVar) && cntVar !== 0) {
          // Correction lands in the OPPOSITE direction of the
          // variance the counter observed: variance > 0 (counted
          // MORE than system) -> correction reduces on-hand
          // (residual < 0), and vice-versa.
          const oppositeSign = (cntVar > 0 && residual < 0) || (cntVar < 0 && residual > 0);
          const magOk = Math.abs(Math.abs(residual) - Math.abs(cntVar)) <= Math.abs(cntVar) * ADJUSTMENT_MAGNITUDE_TOLERANCE;
          if (oppositeSign && magOk) {
            adjustmentApplied = true;
            stats.adjustmentApplied++;
          }
        }
      }
    }
    if (residual !== null) {
      if (Math.abs(residual) < 0.5) stats.residualZero++;
      else stats.residualNonZero++;
      stats.nonAnchors++;
    }

    rows.push({
      snapshot_date: today,
      pn,
      on_hand: Math.round(onHand * 100) / 100,
      daily_use: Math.round(dailyUse * 10000) / 10000,
      receipts_qty: Math.round(receiptsQty * 100) / 100,
      receipts_count: receiptsCount,
      usage_est: usageEst,
      workdays_since_prev: workdays,
      prev_snapshot_date: prevDate,
      prev_on_hand: prev ? Number(prev.on_hand) || 0 : null,
      residual,
      adjustment_applied: adjustmentApplied,
      last_counted_at: (latestCountByPn.get(pn) && latestCountByPn.get(pn).counted_at) || null,
    });
  }

  log(`rows=${rows.length} today=${today} dryRun=${dryRun} forceAnchor=${forceAnchor} anchors=${stats.anchors} nonAnchors=${stats.nonAnchors} residualNonZero=${stats.residualNonZero} adjustmentApplied=${stats.adjustmentApplied}`);
  log(`exclusions nonBaseBom=${stats.excludedNonBaseBom} vmi=${stats.excludedVmi} preLaunch=${stats.excludedPreLaunch} queued=${stats.excludedQueued} retired=${stats.excludedRetired} phasingOut=${stats.excludedPhasingOut}`);

  if (dryRun) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, dryRun: true, today, wouldWrite: rows.length, stats, elapsedMs: Date.now() - t0 }) };
  }

  // Upsert in chunks (PK snapshot_date + pn -> a same-day retry
  // replaces the row cleanly).
  let written = 0;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const batch = rows.slice(i, i + CHUNK);
    const { error } = await supa
      .from("parts_onhand_snapshots")
      .upsert(batch, { onConflict: "snapshot_date,pn" });
    if (error) {
      log("upsert failed on chunk " + (i / CHUNK) + ": " + error.message);
      return { statusCode: 500, body: JSON.stringify({ error: "upsert failed", detail: error.message, wroteBeforeFailure: written }) };
    }
    written += batch.length;
  }

  log(`done: wrote ${written} rows in ${Date.now() - t0}ms`);
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, today, written, stats, elapsedMs: Date.now() - t0 }),
  };
};
