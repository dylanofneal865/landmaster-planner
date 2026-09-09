/* =====================================================
   26-page-cycle-counts.js -- Cycle Count workbench.

   Sidebar: STOCK > Cycle Counts.

   ISOLATION CONTRACT (mandatory):
     * READ-ONLY against parts / pos / usage / frame_schedule / etc.
     * NEVER writes parts.data.onHand -- Acumatica is the SoR;
       the sync brings adjusted truth back on its normal cadence.
     * All mutating actions POST to /.netlify/functions/cycle-count-write
       with x-fs-edit-token (from FS_EDIT_TOKEN_CLIENT) + x-app-build
       (APP_BUILD).
     * Never calls the status pipeline (partsWithStatus / queueParts).
     * Deleting this file must leave every other tab byte-identical.

   Data model (mirrored into DB.cycleCounts by js/30-supabase.js):
     DB.cycleCounts = {
       items:  Map<id, {id, assigned_date, tier, reason, pn,
                        system_qty_at_assign, counted_qty, counted_by,
                        counted_at, variance, status, recount_of,
                        note, updated_at}>,
       log:    Array<{ id, item_id, pn, assigned_date, counted_at,
                       counted_by, tier, reason, system_qty_at_assign,
                       counted_qty, variance, variance_pct, outcome,
                       note, recount_of }>  (newest first)
       loaded: bool,
     }
   ===================================================== */

/* ============================================================
   CONSTANTS
   ============================================================ */

// Kept in sync with the server-side thresholds in
// netlify/functions/cycle-count-write.js. Rendered in tooltips so
// the counter knows what triggers a recount.
const CC_VAR_TOLERANCE_PCT = 0.10;
const CC_VAR_TOLERANCE_UNITS = 5;

// Drift detector -- N consecutive same-direction variances flag
// a part as "systematic drift" (backflush / BOM misconfig). Kept
// small so a real drift shows up quickly.
const CC_DRIFT_MIN_CONSECUTIVE = 3;

// Trailing weeks the IRA (inventory record accuracy) trend covers.
const CC_IRA_TREND_WEEKS = 8;

// Local storage key for the operator's name (persists across
// counts on the same device -- 4 counters, one tablet each).
const CC_NAME_KEY = "landmaster.cycleCount.counter";

/* ============================================================
   STATE
   ============================================================ */

const CC_STATE = {
  // Which section is expanded / focused. "today" | "runway" | "rotation" | "completed"
  _tab: "today",
  // Show-completed toggle within each tier (default hides
  // counted/reconciled to focus on pending work).
  _showCompleted: false,
  // Auto-reconcile scan debounce (fires once after hydration or
  // after the operator submits a count, to catch any items whose
  // live on-hand has already converged).
  _reconcileScanTimer: null,
  _reconcileScanInFlight: false,
  // In-flight submit guard per item -- prevents a double-tap
  // producing two POSTs while the first is still resolving.
  _pending: new Set(),
};

/* ============================================================
   HELPERS -- name, tolerance, drift, live qty
   ============================================================ */

function _ccName() {
  try {
    const v = localStorage.getItem(CC_NAME_KEY);
    return (typeof v === "string" && v.trim()) ? v.trim() : "";
  } catch (_) { return ""; }
}
function _ccSetName(v) {
  const s = String(v || "").trim();
  try { localStorage.setItem(CC_NAME_KEY, s); } catch (_) {}
  return s;
}

// Live parts.data.onHand for a given pn (read from the client's
// DB.parts mirror -- populated by the same sync path everything
// else on the app reads from).
function _ccLiveOnHand(pn) {
  if (typeof DB === "undefined" || !DB || !Array.isArray(DB.parts)) return null;
  const p = DB.parts.find(x => x && x.pn === pn);
  if (!p) return null;
  return Number(p.onHand) || 0;
}

// Beyond tolerance? Matches cycle-count-write.js exactly.
function _ccBeyondTolerance(sysQty, counted) {
  const variance = (Number(counted) || 0) - (Number(sysQty) || 0);
  const absUnits = Math.abs(variance);
  const s = Math.abs(Number(sysQty) || 0);
  const pct = s < 1e-9 ? (counted === 0 ? 0 : 1) : Math.abs(variance) / s;
  if (absUnits <= CC_VAR_TOLERANCE_UNITS) return pct > CC_VAR_TOLERANCE_PCT && absUnits > CC_VAR_TOLERANCE_UNITS;
  return pct > CC_VAR_TOLERANCE_PCT;
}

// Drift detector -- reads the last 5 log entries for a pn from
// DB.cycleCounts.log (already sorted newest-first by the hydration
// path). "Systematic drift" when 3+ consecutive same-direction
// variances (positive OR negative -- either way it's a signal
// something's off). Returns null when no drift OR when the part
// has fewer than 3 recorded counts.
function _ccDriftFor(pn) {
  const log = (DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log)) ? DB.cycleCounts.log : [];
  const rows = [];
  for (const r of log) {
    if (!r || r.pn !== pn) continue;
    if (r.outcome !== "counted" && r.outcome !== "reconciled" && r.outcome !== "recount") continue;
    if (typeof r.variance !== "number" || !Number.isFinite(r.variance)) continue;
    rows.push(r);
    if (rows.length >= 5) break;
  }
  if (rows.length < CC_DRIFT_MIN_CONSECUTIVE) return null;
  // Consecutive-from-newest same-sign run.
  let sign = null;
  let run = 0;
  let sum = 0;
  for (const r of rows) {
    if (Math.abs(r.variance) < 1e-9) break;
    const s = r.variance > 0 ? 1 : -1;
    if (sign === null) { sign = s; run = 1; sum = r.variance; continue; }
    if (s !== sign) break;
    run++;
    sum += r.variance;
  }
  if (run < CC_DRIFT_MIN_CONSECUTIVE) return null;
  const avgPerWeek = sum / run;
  return {
    consecutive: run,
    direction: sign > 0 ? "over" : "under",
    avgPerCount: sum / run,
    avgPerWeek,
    sampleCount: rows.length,
  };
}

/* ============================================================
   ITEM LIST HELPERS
   ============================================================ */

function _ccAllItems() {
  if (!(DB && DB.cycleCounts && DB.cycleCounts.items instanceof Map)) return [];
  return [...DB.cycleCounts.items.values()];
}

function _ccOpenByTier(tier) {
  return _ccAllItems()
    .filter(i => i && i.tier === tier && (i.status === "pending" || i.status === "recount"))
    .sort((a, b) => {
      // Sort: newest assigned first, then by pn.
      const ad = String(a.assigned_date || "");
      const bd = String(b.assigned_date || "");
      if (ad !== bd) return bd < ad ? -1 : 1;
      return String(a.pn || "") < String(b.pn || "") ? -1 : 1;
    });
}

function _ccCompletedByTier(tier) {
  return _ccAllItems()
    .filter(i => i && i.tier === tier && (i.status === "counted" || i.status === "reconciled" || i.status === "skipped"))
    .sort((a, b) => String(b.counted_at || b.updated_at || "").localeCompare(String(a.counted_at || a.updated_at || "")))
    .slice(0, 40);
}

// The "today" set includes HOT-tier items AND any pending flagged
// items landed by an operator flag today.
function _ccTodayHotAndFlagged() {
  const today = _ccTodayIso();
  return _ccAllItems()
    .filter(i => i && i.assigned_date === today && (i.tier === "hot" || i.tier === "flagged") && (i.status === "pending" || i.status === "recount"))
    .sort((a, b) => {
      // recount rows first (they need urgent attention -- someone
      // hit a variance), then by pn.
      const ar = a.status === "recount" ? 0 : 1;
      const br = b.status === "recount" ? 0 : 1;
      if (ar !== br) return ar - br;
      return String(a.pn || "") < String(b.pn || "") ? -1 : 1;
    });
}

function _ccTodayIso() {
  const d = new Date();
  return d.getFullYear() + "-"
    + String(d.getMonth() + 1).padStart(2, "0") + "-"
    + String(d.getDate()).padStart(2, "0");
}

function _ccMondayIso(dateOrIso) {
  const d = (dateOrIso instanceof Date) ? new Date(dateOrIso)
          : (typeof dateOrIso === "string" ? new Date(dateOrIso + "T00:00:00") : new Date());
  d.setHours(0, 0, 0, 0);
  const dow = d.getDay();
  const shift = (dow === 0) ? -6 : (1 - dow);
  d.setDate(d.getDate() + shift);
  return d.getFullYear() + "-"
    + String(d.getMonth() + 1).padStart(2, "0") + "-"
    + String(d.getDate()).padStart(2, "0");
}

/* ============================================================
   SUMMARY STRIP
   ============================================================ */

function _ccSummary() {
  const items = _ccAllItems();
  const log = (DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log)) ? DB.cycleCounts.log : [];
  const today = _ccTodayIso();
  const weekMonday = _ccMondayIso(today);

  const weekItems = items.filter(i => i && i.assigned_date >= weekMonday);
  const pending = weekItems.filter(i => i.status === "pending" || i.status === "recount");
  const completed = weekItems.filter(i => i.status !== "pending" && i.status !== "recount");
  const completionPct = weekItems.length > 0 ? (completed.length / weekItems.length) : 0;

  // IRA = counted rows this week within tolerance / all counted rows this week.
  let inTolerance = 0;
  let outTolerance = 0;
  for (const i of weekItems) {
    if (i.status !== "counted" && i.status !== "reconciled") continue;
    if (typeof i.counted_qty !== "number") continue;
    const beyond = _ccBeyondTolerance(i.system_qty_at_assign, i.counted_qty);
    if (beyond) outTolerance++;
    else inTolerance++;
  }
  const iraPct = (inTolerance + outTolerance) > 0 ? inTolerance / (inTolerance + outTolerance) : null;

  // 8-week IRA trend from log.
  const trend = [];
  for (let w = CC_IRA_TREND_WEEKS - 1; w >= 0; w--) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (w * 7));
    const mIso = _ccMondayIso(d);
    const next = new Date(mIso + "T00:00:00"); next.setDate(next.getDate() + 7);
    const nIso = next.getFullYear() + "-" + String(next.getMonth() + 1).padStart(2, "0") + "-" + String(next.getDate()).padStart(2, "0");
    let inTol = 0, outTol = 0;
    for (const r of log) {
      if (!r || (r.outcome !== "counted" && r.outcome !== "reconciled")) continue;
      const at = r.counted_at || "";
      if (at < mIso || at >= nIso) continue;
      if (typeof r.counted_qty !== "number") continue;
      const beyond = _ccBeyondTolerance(r.system_qty_at_assign, r.counted_qty);
      if (beyond) outTol++;
      else inTol++;
    }
    const tot = inTol + outTol;
    trend.push({ mondayIso: mIso, ira: tot > 0 ? (inTol / tot) : null, n: tot });
  }

  // IRA by class, this week.
  const byClass = { A: { in: 0, out: 0 }, B: { in: 0, out: 0 }, C: { in: 0, out: 0 }, "": { in: 0, out: 0 } };
  for (const i of weekItems) {
    if (i.status !== "counted" && i.status !== "reconciled") continue;
    if (typeof i.counted_qty !== "number") continue;
    const part = (typeof DB !== "undefined" && DB && Array.isArray(DB.parts)) ? DB.parts.find(p => p.pn === i.pn) : null;
    const cls = (part && part.partClass) || "";
    const beyond = _ccBeyondTolerance(i.system_qty_at_assign, i.counted_qty);
    const bucket = byClass[cls] || byClass[""];
    if (beyond) bucket.out++; else bucket.in++;
  }

  // Repeat offenders: distinct pns whose log has >=3 rows with
  // any variance beyond tolerance in the last 60 days.
  const now = Date.now();
  const sixtyDaysAgo = new Date(now - 60 * 24 * 3600 * 1000).toISOString();
  const offenderMap = new Map();
  for (const r of log) {
    if (!r || (r.outcome !== "counted" && r.outcome !== "reconciled")) continue;
    if ((r.counted_at || "") < sixtyDaysAgo) continue;
    if (typeof r.counted_qty !== "number") continue;
    if (!_ccBeyondTolerance(r.system_qty_at_assign, r.counted_qty)) continue;
    offenderMap.set(r.pn, (offenderMap.get(r.pn) || 0) + 1);
  }
  const repeatOffenders = [...offenderMap.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pn, count]) => ({ pn, count }));

  // Open drift flags -- scan every pn in the log's distinct set.
  const seenPns = new Set(log.map(r => r && r.pn).filter(Boolean));
  const driftFlags = [];
  for (const pn of seenPns) {
    const d = _ccDriftFor(pn);
    if (d) driftFlags.push({ pn, drift: d });
  }
  driftFlags.sort((a, b) => Math.abs(b.drift.avgPerCount) - Math.abs(a.drift.avgPerCount));

  return {
    weekCompletion: completionPct,
    weekPending: pending.length,
    weekCompleted: completed.length,
    weekTotal: weekItems.length,
    ira: iraPct,
    trend,
    byClass,
    repeatOffenders,
    driftFlags,
  };
}

/* ============================================================
   ACTIONS -- flag / submit / skip
   All POST to /.netlify/functions/cycle-count-write via
   postCycleCountBatch in js/30-supabase.js.
   ============================================================ */

// Public: called by js/10 (parts drawer + row action). Also
// exposed on window so command-palette / other callers can flag.
async function flagPartForCount(pn, note) {
  const clean = String(pn || "").trim();
  if (!clean) { if (typeof showToast === "function") showToast("Missing pn", "warn"); return; }
  const noteClean = (typeof note === "string") ? note.trim() : "";
  const live = _ccLiveOnHand(clean);
  if (typeof postCycleCountBatch !== "function") {
    if (typeof showToast === "function") showToast("Cycle count writer not loaded", "warn");
    return;
  }
  const res = await postCycleCountBatch([{
    op: "flag",
    pn: clean,
    note: noteClean,
    systemQtyNow: live == null ? 0 : live,
  }]);
  if (!res || !res.ok) {
    if (typeof showToast === "function") showToast("Flag failed" + ((res && res.error && res.error.message) ? ": " + res.error.message : ""), "warn");
    return;
  }
  const r = res.results && res.results[0];
  if (r && r.dedupe) {
    if (typeof showToast === "function") showToast(`${clean} already on today's HOT list`, "");
  } else {
    if (typeof showToast === "function") showToast(`${clean} added to today's HOT list`, "ok", "Flagged for count");
  }
  // Trigger a hydration refresh so the flagged item appears in
  // the tab (js/30 exposes _fetchAllCycleCounts).
  if (typeof _refetchCycleCounts === "function") await _refetchCycleCounts();
  if (typeof refresh === "function") refresh();
}
if (typeof window !== "undefined") window.flagPartForCount = flagPartForCount;

async function _ccSubmitCount(itemId) {
  if (CC_STATE._pending.has(itemId)) return;
  const item = DB.cycleCounts.items.get(itemId);
  if (!item) return;
  const input = document.getElementById(`cc-in-${itemId}`);
  const raw = input ? input.value : "";
  const val = Number(raw);
  if (!Number.isFinite(val) || val < 0) { if (typeof showToast === "function") showToast("Counted qty must be a non-negative number", "warn"); return; }
  const counter = _ccName();
  if (!counter) { if (typeof showToast === "function") showToast("Enter your name at the top of the page first", "warn"); return; }
  if (item.recount_of) {
    // Blind guard on the client too -- surface early.
    const parent = DB.cycleCounts.items.get(item.recount_of);
    if (parent && parent.counted_by && parent.counted_by.trim().toLowerCase() === counter.toLowerCase()) {
      if (typeof showToast === "function") showToast(`Recount must be a different counter than ${parent.counted_by}`, "warn");
      return;
    }
  }
  CC_STATE._pending.add(itemId);
  const btn = document.getElementById(`cc-submit-${itemId}`);
  if (btn) { btn.disabled = true; btn.textContent = "..."; }
  const res = await postCycleCountBatch([{
    op: "submitCount",
    itemId,
    counted_qty: Math.round(val),
    counted_by: counter,
  }]);
  CC_STATE._pending.delete(itemId);
  if (!res || !res.ok) {
    const err = (res && res.results && res.results[0] && res.results[0].error) || (res && res.error && res.error.message) || "unknown";
    if (typeof showToast === "function") showToast("Submit failed: " + err, "warn");
    if (btn) { btn.disabled = false; btn.textContent = "Submit"; }
    return;
  }
  const r = res.results[0];
  if (r.status === "recount") {
    if (typeof showToast === "function") showToast(`Variance beyond tolerance -- recount spawned for ${item.pn}`, "warn", "Recount required");
  } else {
    if (typeof showToast === "function") showToast(`Counted ${item.pn} = ${Math.round(val)}`, "ok");
  }
  if (typeof _refetchCycleCounts === "function") await _refetchCycleCounts();
  if (typeof refresh === "function") refresh();
  // Kick a reconcile-scan in case the live qty already matches.
  _ccScheduleReconcileScan();
}
if (typeof window !== "undefined") window._ccSubmitCount = _ccSubmitCount;

async function _ccSkip(itemId) {
  const item = DB.cycleCounts.items.get(itemId);
  if (!item) return;
  const reason = (typeof prompt === "function") ? prompt(`Skip reason for ${item.pn}?\n(required -- appears in the log)`, "") : "";
  const clean = (typeof reason === "string") ? reason.trim() : "";
  if (!clean) { if (typeof showToast === "function") showToast("Skip needs a reason", "warn"); return; }
  const res = await postCycleCountBatch([{ op: "skip", itemId, reason: clean }]);
  if (!res || !res.ok) {
    const err = (res && res.results && res.results[0] && res.results[0].error) || "unknown";
    if (typeof showToast === "function") showToast("Skip failed: " + err, "warn");
    return;
  }
  if (typeof showToast === "function") showToast(`Skipped ${item.pn}`, "");
  if (typeof _refetchCycleCounts === "function") await _refetchCycleCounts();
  if (typeof refresh === "function") refresh();
}
if (typeof window !== "undefined") window._ccSkip = _ccSkip;

// Reconcile-scan: any counted-status item whose live parts.data
// .onHand has converged within RECONCILE_UNITS gets marked
// reconciled. Runs on hydration and after every submit.
async function _ccReconcileScan() {
  if (CC_STATE._reconcileScanInFlight) return;
  const items = _ccAllItems();
  const candidates = [];
  for (const i of items) {
    if (!i || i.status !== "counted") continue;
    if (typeof i.counted_qty !== "number") continue;
    const live = _ccLiveOnHand(i.pn);
    if (live == null) continue;
    if (Math.abs(live - i.counted_qty) <= 1) {
      candidates.push({ op: "reconcileFromLive", itemId: i.id, currentOnHand: live });
    }
  }
  if (candidates.length === 0) return;
  CC_STATE._reconcileScanInFlight = true;
  try {
    // Chunk at 50 to stay under the 100 max the writer accepts.
    while (candidates.length > 0) {
      const batch = candidates.splice(0, 50);
      const res = await postCycleCountBatch(batch);
      if (!res || !res.ok) break;
    }
    if (typeof _refetchCycleCounts === "function") await _refetchCycleCounts();
    if (typeof refresh === "function" && document.querySelector('[data-page="cycle-counts"]')) refresh();
  } finally {
    CC_STATE._reconcileScanInFlight = false;
  }
}
function _ccScheduleReconcileScan() {
  if (CC_STATE._reconcileScanTimer) clearTimeout(CC_STATE._reconcileScanTimer);
  CC_STATE._reconcileScanTimer = setTimeout(() => {
    CC_STATE._reconcileScanTimer = null;
    _ccReconcileScan().catch(() => {});
  }, 800);
}
if (typeof window !== "undefined") {
  window._ccReconcileScan = _ccReconcileScan;
  window._ccScheduleReconcileScan = _ccScheduleReconcileScan;
}

/* ============================================================
   RENDER
   ============================================================ */

function _ccPill(status) {
  const cls = status === "pending"    ? ""
            : status === "counted"    ? "ok"
            : status === "reconciled" ? "ok"
            : status === "recount"    ? "warn"
            : status === "skipped"    ? "muted"
            : "";
  return `<span class="pill ${cls}">${(status || "").toUpperCase()}</span>`;
}

function _ccVarianceCell(item) {
  if (item.status === "pending" || item.status === "recount") return `<td class="dim">-</td>`;
  if (typeof item.counted_qty !== "number") return `<td class="dim">-</td>`;
  const v = (item.counted_qty || 0) - (item.system_qty_at_assign || 0);
  const s = Math.abs(item.system_qty_at_assign || 0);
  const pct = s < 1e-9 ? (item.counted_qty === 0 ? 0 : 1) : (v / s);
  const beyond = _ccBeyondTolerance(item.system_qty_at_assign, item.counted_qty);
  const cls = beyond ? "text-warn bold" : (Math.abs(v) < 1e-9 ? "dim" : "");
  const sign = v > 0 ? "+" : "";
  return `<td class="right num ${cls}">${sign}${v} <span class="dim tiny">(${(pct*100).toFixed(1)}%)</span></td>`;
}

function _ccPartClass(pn) {
  if (typeof DB === "undefined" || !DB || !Array.isArray(DB.parts)) return "";
  const p = DB.parts.find(x => x && x.pn === pn);
  return (p && p.partClass) || "";
}

function _ccPartDesc(pn) {
  if (typeof DB === "undefined" || !DB || !Array.isArray(DB.parts)) return "";
  const p = DB.parts.find(x => x && x.pn === pn);
  return (p && p.desc) || "";
}

function _ccRenderItemRow(item, opts) {
  opts = opts || {};
  const blindRecount = !!item.recount_of;
  const parent = blindRecount ? DB.cycleCounts.items.get(item.recount_of) : null;
  const cls = _ccPartClass(item.pn);
  const desc = _ccPartDesc(item.pn);
  const live = _ccLiveOnHand(item.pn);
  const drift = _ccDriftFor(item.pn);
  const isOpen = item.status === "pending" || item.status === "recount";
  const nameDisabled = !_ccName();
  return `
    <tr data-cc-id="${esc(item.id)}">
      <td class="pn">
        ${esc(item.pn)}
        ${cls ? `<span class="pill tiny muted" style="margin-left:6px">${esc(cls)}</span>` : ""}
        ${blindRecount ? `<span class="pill tiny warn" style="margin-left:6px" title="BLIND recount -- first count hidden until this row is completed by a different counter">RECOUNT</span>` : ""}
        ${drift ? `<span class="pill tiny warn" style="margin-left:6px" title="Systematic drift -- ${drift.consecutive} consecutive ${drift.direction} counts, avg ${drift.avgPerCount.toFixed(1)}/count. Check BOM/backflush.">DRIFT</span>` : ""}
      </td>
      <td class="dim" style="max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(desc)}</td>
      <td>
        <span class="pill tiny ${item.tier === "hot" ? "crit" : item.tier === "runway" ? "warn" : "muted"}">${esc((item.tier || "").toUpperCase())}</span>
        <div class="dim tiny">${esc(item.reason || "")}</div>
      </td>
      <td class="right num">${blindRecount ? '<span class="dim">-</span>' : (item.system_qty_at_assign == null ? "-" : Math.round(item.system_qty_at_assign))}</td>
      <td class="right num dim">${live == null ? "-" : Math.round(live)}</td>
      <td class="right">
        ${isOpen
          ? `<input class="input num" type="number" min="0" step="1" id="cc-in-${esc(item.id)}" placeholder="qty" style="width:88px;text-align:right" ${nameDisabled ? "disabled" : ""} onkeydown="if(event.key==='Enter')_ccSubmitCount('${esc(item.id)}')">`
          : `<span class="num">${item.counted_qty == null ? "-" : Math.round(item.counted_qty)}</span>`}
      </td>
      ${_ccVarianceCell(item)}
      <td>
        ${_ccPill(item.status)}
        ${item.counted_by ? `<div class="dim tiny">by ${esc(item.counted_by)}</div>` : ""}
      </td>
      <td class="right" style="white-space:nowrap">
        ${isOpen ? `
          <button class="btn xs primary" id="cc-submit-${esc(item.id)}" onclick="_ccSubmitCount('${esc(item.id)}')" ${nameDisabled ? "disabled title='Enter your name at the top first'" : ""}>Submit</button>
          <button class="btn xs" onclick="_ccSkip('${esc(item.id)}')">Skip</button>
        ` : `
          <button class="btn xs ghost" onclick="openPartDetail('${esc(item.pn)}')">Open part</button>
        `}
      </td>
    </tr>
  `;
}

function _ccRenderTable(items, opts) {
  opts = opts || {};
  if (items.length === 0) {
    return `<div class="empty" style="padding:16px"><div class="empty-title muted">${esc(opts.emptyMsg || "Nothing here")}</div></div>`;
  }
  return `
    <div class="tbl-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th>Part #</th>
            <th>Description</th>
            <th>Tier / reason</th>
            <th class="right">Sys qty (at assign)</th>
            <th class="right">Live qty (now)</th>
            <th class="right">Counted qty</th>
            <th class="right">Variance</th>
            <th>Status</th>
            <th class="right"></th>
          </tr>
        </thead>
        <tbody>${items.map(i => _ccRenderItemRow(i, opts)).join("")}</tbody>
      </table>
    </div>
  `;
}

function _ccRenderSummaryStrip(s) {
  const trendMax = 100;
  const trendHtml = s.trend.map(w => {
    const pct = w.ira == null ? null : Math.round(w.ira * 100);
    const h = w.ira == null ? 3 : Math.max(4, Math.round(w.ira * 44));
    const color = w.ira == null ? "var(--t3,#999)" : w.ira >= 0.95 ? "var(--ok,#3a7)" : w.ira >= 0.85 ? "var(--warn,#c85)" : "var(--crit,#c33)";
    const label = w.ira == null ? "no counts" : `${pct}% (n=${w.n})`;
    const short = w.mondayIso.slice(5);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px" title="Week of ${w.mondayIso} -- ${label}">
      <div style="width:14px;height:44px;background:var(--surf-2,#eee);border-radius:2px;position:relative;overflow:hidden">
        <div style="position:absolute;bottom:0;left:0;right:0;height:${h}px;background:${color}"></div>
      </div>
      <div class="dim tiny">${short}</div>
    </div>`;
  }).join("");
  const iraText = s.ira == null ? "-" : (Math.round(s.ira * 1000) / 10) + "%";
  const complText = (Math.round(s.weekCompletion * 1000) / 10) + "%";
  const classHtml = ["A","B","C",""].map(cls => {
    const b = s.byClass[cls] || { in: 0, out: 0 };
    const tot = b.in + b.out;
    if (tot === 0) return "";
    const label = cls || "-";
    const pct = Math.round((b.in / tot) * 100);
    return `<div><span class="pill tiny muted">${esc(label)}</span> <span class="mono">${pct}% <span class="dim">n=${tot}</span></span></div>`;
  }).filter(Boolean).join("");
  const driftHtml = s.driftFlags.length === 0 ? `<span class="dim">none</span>` : s.driftFlags.slice(0, 5).map(d => `
    <div class="mono tiny" title="${esc(d.pn)} -- ${d.drift.consecutive} consecutive ${d.drift.direction}, avg ${d.drift.avgPerCount.toFixed(1)}/count">${esc(d.pn)} <span class="text-warn">${d.drift.avgPerCount > 0 ? "+" : ""}${d.drift.avgPerCount.toFixed(1)}</span></div>
  `).join("");
  const offenderHtml = s.repeatOffenders.length === 0 ? `<span class="dim">none</span>` : s.repeatOffenders.slice(0, 5).map(o => `
    <div class="mono tiny">${esc(o.pn)} <span class="text-warn">x${o.count}</span></div>
  `).join("");
  return `
    <div class="row gap-md" style="align-items:stretch;margin:12px 0;flex-wrap:wrap">
      <div class="card" style="padding:12px;min-width:180px">
        <div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase">Week completion</div>
        <div class="head-lg mono">${complText}</div>
        <div class="dim tiny">${s.weekCompleted}/${s.weekTotal} done, ${s.weekPending} open</div>
      </div>
      <div class="card" style="padding:12px;min-width:180px">
        <div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase">Inventory record accuracy (week)</div>
        <div class="head-lg mono">${iraText}</div>
        <div class="dim tiny">within tolerance = max(${Math.round(CC_VAR_TOLERANCE_PCT*100)}%, ${CC_VAR_TOLERANCE_UNITS} units)</div>
      </div>
      <div class="card" style="padding:12px;min-width:260px">
        <div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase">IRA trend -- ${CC_IRA_TREND_WEEKS} wks</div>
        <div style="display:flex;gap:6px;align-items:flex-end;padding-top:6px">${trendHtml}</div>
      </div>
      <div class="card" style="padding:12px;min-width:180px">
        <div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase">IRA by class (week)</div>
        <div style="display:flex;flex-direction:column;gap:4px;padding-top:4px">${classHtml || `<span class="dim">no counts yet</span>`}</div>
      </div>
      <div class="card" style="padding:12px;min-width:200px">
        <div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase">Repeat offenders (60d)</div>
        <div style="display:flex;flex-direction:column;gap:2px;padding-top:4px">${offenderHtml}</div>
      </div>
      <div class="card" style="padding:12px;min-width:220px">
        <div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase">Systematic drift</div>
        <div style="display:flex;flex-direction:column;gap:2px;padding-top:4px">${driftHtml}</div>
        <div class="dim tiny mt-xs">3+ consecutive same-direction counts. Check BOM/backflush.</div>
      </div>
    </div>
  `;
}

function renderCycleCounts() {
  const main = document.getElementById("main");
  if (!main) return;
  // If the hydration hasn't landed yet, render a placeholder and
  // fire a fetch -- realtime will re-refresh on completion.
  if (!(DB && DB.cycleCounts) || !DB.cycleCounts.loaded) {
    main.innerHTML = `<div class="page" data-page="cycle-counts"><div class="empty"><div class="empty-title muted">Loading cycle counts...</div></div></div>`;
    if (typeof _refetchCycleCounts === "function") {
      _refetchCycleCounts().then(() => { if (CURRENT_ROUTE === "cycle-counts") refresh(); }).catch(() => {});
    }
    return;
  }
  const s = _ccSummary();
  const todayItems = _ccTodayHotAndFlagged();
  const runwayItems = _ccOpenByTier("runway");
  const rotationItems = _ccOpenByTier("rotation");
  const doneItems = CC_STATE._showCompleted
    ? [..._ccCompletedByTier("hot"), ..._ccCompletedByTier("flagged"), ..._ccCompletedByTier("runway"), ..._ccCompletedByTier("rotation")]
        .sort((a, b) => String(b.counted_at || b.updated_at || "").localeCompare(String(a.counted_at || a.updated_at || "")))
        .slice(0, 60)
    : [];
  const name = _ccName();
  const html = `
    <div class="page" data-page="cycle-counts">
      <div class="page-hd">
        <div>
          <h1>Cycle Counts</h1>
          <p class="muted">Weekly + daily audit lists. Never writes on-hand -- Acumatica stays the system of record; sync brings adjusted truth back.</p>
        </div>
        <div class="row gap-sm">
          <label class="row gap-sm" style="align-items:center">
            <span class="muted tiny">Your name</span>
            <input class="input" id="cc-name-input" value="${esc(name)}" placeholder="e.g. Marisol" style="width:180px" onchange="_ccOnNameInput(this.value)">
          </label>
          <button class="btn" onclick="_ccToggleCompleted()">${CC_STATE._showCompleted ? "Hide completed" : "Show completed"}</button>
        </div>
      </div>

      ${_ccRenderSummaryStrip(s)}

      ${!name ? `<div class="banner warn" style="margin-bottom:8px">Enter your name above before submitting counts -- it's stamped on every log row (and enforces the blind-recount rule).</div>` : ""}

      <div class="dr-section" style="margin-top:16px">Today (HOT + operator flags)</div>
      ${_ccRenderTable(todayItems, { emptyMsg: "Nothing hot today. Refill from Acumatica sync as new negatives / critical parts land, or flag a part from its drawer." })}

      <div class="dr-section" style="margin-top:16px">This week -- Runway (< 60d cover, not counted in 45d)</div>
      ${_ccRenderTable(runwayItems, { emptyMsg: "No open runway rows. Mondays' cron fills this list." })}

      <div class="dr-section" style="margin-top:16px">This week -- Rotation (LRU + frame 30d cycle)</div>
      ${_ccRenderTable(rotationItems, { emptyMsg: "No open rotation rows this week." })}

      ${CC_STATE._showCompleted ? `
        <div class="dr-section" style="margin-top:16px">Completed / skipped / reconciled (most recent 60)</div>
        ${_ccRenderTable(doneItems, { emptyMsg: "No completed rows yet." })}
      ` : ""}
    </div>
  `;
  main.innerHTML = html;
  // Kick a reconcile scan on every render (debounced) so an
  // Acumatica sync that lands mid-session reconciles counted rows
  // without waiting for another action.
  _ccScheduleReconcileScan();
}
function _ccOnNameInput(v) { _ccSetName(v); if (typeof refresh === "function") refresh(); }
function _ccToggleCompleted() { CC_STATE._showCompleted = !CC_STATE._showCompleted; if (typeof refresh === "function") refresh(); }
if (typeof window !== "undefined") {
  window._ccOnNameInput = _ccOnNameInput;
  window._ccToggleCompleted = _ccToggleCompleted;
}

/* ============================================================
   PART-DRAWER HOOKS -- called from js/10-page-parts.js.
   ============================================================ */

// Render the "last 5 counts" table for a part. Returns "" if the
// pn has never been counted (js/10 hides the section then).
function renderPartCycleCountHistory(pn) {
  if (!(DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log))) return "";
  const rows = DB.cycleCounts.log.filter(r => r && r.pn === pn).slice(0, 5);
  if (rows.length === 0) return "";
  const drift = _ccDriftFor(pn);
  const driftLine = drift
    ? `<div class="banner warn tiny" style="margin-bottom:8px">Systematic drift detected -- ${drift.consecutive} consecutive ${drift.direction} counts, avg ${drift.avgPerCount.toFixed(1)}/count. Check BOM / backflush.</div>`
    : "";
  const body = rows.map(r => {
    const v = (typeof r.variance === "number") ? r.variance : null;
    const sign = (v == null) ? "" : (v > 0 ? "+" : "");
    const pct = (typeof r.variance_pct === "number") ? (Math.round(r.variance_pct * 1000) / 10) + "%" : "-";
    return `<tr>
      <td class="dim tiny">${esc((r.counted_at || "").slice(0, 16).replace("T", " "))}</td>
      <td>${esc(r.counted_by || "")}</td>
      <td class="dim tiny">${esc(r.tier || "")} ${esc(r.reason || "")}</td>
      <td class="right num">${r.system_qty_at_assign == null ? "-" : Math.round(r.system_qty_at_assign)}</td>
      <td class="right num">${r.counted_qty == null ? "-" : Math.round(r.counted_qty)}</td>
      <td class="right num ${v != null && Math.abs(v) > CC_VAR_TOLERANCE_UNITS ? "text-warn" : "dim"}">${v == null ? "-" : (sign + v)} <span class="dim tiny">${pct}</span></td>
      <td>${_ccPill(r.outcome)}</td>
    </tr>`;
  }).join("");
  return `
    <div class="dr-section">Cycle count history (last 5)</div>
    ${driftLine}
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr>
        <th>When</th><th>Who</th><th>Tier / reason</th>
        <th class="right">Sys</th><th class="right">Counted</th><th class="right">Variance</th><th>Outcome</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  `;
}
if (typeof window !== "undefined") window.renderPartCycleCountHistory = renderPartCycleCountHistory;

// Small compact "flag for count" button js/10 renders in the
// parts drawer + parts table row. Returns HTML.
function flagForCountButton(pn, opts) {
  opts = opts || {};
  const cls = opts.size === "xs" ? "btn xs" : "btn";
  const stop = opts.stopPropagation ? "event.stopPropagation();" : "";
  const title = "Add this part to today's HOT count list";
  const label = opts.icon ? "flag" : "Flag for count";
  return `<button class="${cls}" title="${esc(title)}" onclick="${stop}(function(){const n=prompt('Optional note (why is this flagged?)',''); if(n===null)return; flagPartForCount('${esc(pn)}', n||'');})()">${esc(label)}</button>`;
}
if (typeof window !== "undefined") window.flagForCountButton = flagForCountButton;

/* ============================================================
   ROUTE REGISTRATION
   ============================================================ */
if (typeof registerRoute === "function") registerRoute("cycle-counts", renderCycleCounts);
