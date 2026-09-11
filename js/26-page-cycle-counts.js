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
  // v-cc-live -- supervisor tab is now REPORT + LIVE-FEED shaped.
  // Retained tab-switch state for the collapsed open-queue below.
  _tab: "today",
  // Vestigial from the old "show completed" toggle; kept for any
  // legacy caller. New surface routes completed items through the
  // live feed instead.
  _showCompleted: false,
  // v-cc-live UI state.
  _openQueueExpanded: false,       // collapsed by default per ticket
  _trendExpanded: false,            // 8-week trend behind an expander
  _chimeOn: false,                   // localStorage-backed on init
  _feedExpanded: new Set(),         // log ids whose bin breakdown is open
  _attnExpanded: new Set(),          // needs-attention item ids whose bins are open
  _liveSubscribed: false,
  _lastSeenLogAt: null,              // ISO -- rows newer flash on render
  _pollTimer: null,
  _lastAttnPendingIds: new Set(),    // used for chime debounce
  _initedFromLS: false,
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

// v-cc-loc-4 -- PHYSICAL live on-hand for a pn (shelf qty, not
// planning-available). Preference:
//   1. Sum of DB.partLocations entries (per-location parts)
//   2. DB.partOnHandPhysical (aggregate __warehouse__ sentinel)
//   3. null when neither is populated (part_locations sync hasn't
//      landed yet for this pn -- caller renders as "-")
// The planner's parts.data.onHand is AVAILABLE (Reserved/Allocated
// removed) and would understate what the counter sees on the
// shelf; never fall back to it here.
function _ccLiveOnHand(pn) {
  if (typeof DB === "undefined" || !DB) return null;
  if (DB.partLocations instanceof Map) {
    const bins = DB.partLocations.get(pn);
    if (Array.isArray(bins) && bins.length > 0) {
      let s = 0;
      for (const b of bins) s += Number(b.qty) || 0;
      return s;
    }
  }
  if (DB.partOnHandPhysical instanceof Map) {
    const v = DB.partOnHandPhysical.get(pn);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
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

// v-cc-loc-2 fix 1 -- AUTO-SWEPT SKIP DETECTOR.
//
// The cycle-count-assign backlog sweep marks non-BaseBOM /
// vendor-managed / pre-launch-successor / phasing-out items as
// status="skipped" with a note ending "excluded by policy". These
// rows are policy filtering, NOT audit work -- they must be
// excluded from the completion + IRA metric denominators so a
// 101-row auto-sweep doesn't inflate week completion to 76.5%
// with zero counts actually done.
//
// Operator skips (a counter typed a reason -- "damaged label",
// "bin locked", etc.) DO count in the denominator as unworked --
// the shift did the work of assessing them and the buyer needs to
// see them as open. Those never carry the "excluded by policy"
// suffix.
function _isAutoSweptSkip(item) {
  if (!item || item.status !== "skipped") return false;
  const note = String(item.note || "").toLowerCase();
  // Two cron-emitted phrases (kept in sync with cycle-count-
  // assign's _sweepNoteFor):
  //   "excluded by policy"           -- non-BaseBOM, vendor-managed,
  //                                     phasing-out, chain-successor
  //                                     pre-launch
  //   "excluded until cut-in window" -- standalone pre-launch
  // Operator skips carry a typed reason that matches neither.
  return /excluded by policy/.test(note) || /excluded until cut-in window/.test(note);
}

function _ccSummary() {
  const items = _ccAllItems();
  const log = (DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log)) ? DB.cycleCounts.log : [];
  const today = _ccTodayIso();
  const weekMonday = _ccMondayIso(today);

  const weekItemsAll = items.filter(i => i && i.assigned_date >= weekMonday);
  // Auto-swept skips filtered from BOTH sides of the ratio.
  const weekItems = weekItemsAll.filter(i => !_isAutoSweptSkip(i));
  const autoSweptThisWeek = weekItemsAll.length - weekItems.length;
  const pending = weekItems.filter(i => i.status === "pending" || i.status === "recount");
  const counted = weekItems.filter(i => i.status === "counted" || i.status === "reconciled");
  const operatorSkipped = weekItems.filter(i => i.status === "skipped");
  // Completion pct = counted / (counted + operator-skipped + open).
  // Auto-swept never enters this ratio.
  const completionPct = weekItems.length > 0 ? (counted.length / weekItems.length) : 0;

  // IRA = counted rows this week within tolerance / all counted
  // rows this week. Auto-swept items never had counted_qty, so
  // they naturally contribute nothing here; explicit filter is
  // belt-and-suspenders.
  let inTolerance = 0;
  let outTolerance = 0;
  for (const i of weekItems) {
    if (_isAutoSweptSkip(i)) continue;
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

  // IRA by class, this week. weekItems is already auto-swept-free.
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
    weekOpen: pending.length,                 // pending + recount
    weekCounted: counted.length,              // counted + reconciled
    weekOperatorSkipped: operatorSkipped.length,
    weekActive: weekItems.length,             // denominator (excludes auto-swept)
    weekAutoSwept: autoSweptThisWeek,         // reported separately
    // Legacy field names kept for callers that still read them --
    // updated to the auto-swept-excluded numbers.
    weekPending: pending.length,
    weekCompleted: counted.length,
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

/* ============================================================
   v-cc-loc-1 phase 1 -- MOBILE FULL-SCREEN COUNT CARD.

   Rendered when the counter taps a row for an item that has
   cycle_count_item_locations snapshotted at assignment time.
   Full-screen modal with:
     * Part header (pn, desc, tier badge, reason)
     * One row per snapshotted location: location code, desc,
       system qty at assign, large numeric input (inputmode=numeric
       so the tablet's number pad opens), live per-location
       variance below.
     * "Add other location (found elsewhere)" -- reveals a
       location + qty pair the counter can enter for stock that
       turned up in an unexpected bin.
     * Live total (sum of listed + extras) with variance vs the
       item's system_qty_at_assign.
     * Submit -- requires EVERY listed location filled (0 valid).
       Payload posts locations[] via postCycleCountBatch; the
       write function enforces the same "all bins filled" rule
       + sum-matches-counted_qty rule against DB truth.

   Items WITHOUT any location snapshot rows (aggregate-only pns)
   fall through to the existing single-total inline input --
   nothing changes for them.
   ============================================================ */
function _ccHasLocations(itemId) {
  if (!(DB && DB.cycleCountItemLocations instanceof Map)) return false;
  const rows = DB.cycleCountItemLocations.get(itemId);
  return Array.isArray(rows) && rows.length > 0;
}

function _ccBumpCardSum() {
  const inputs = document.querySelectorAll(".cc-loc-input");
  let sum = 0;
  let missing = 0;
  for (const inp of inputs) {
    const raw = String(inp.value || "").trim();
    if (raw === "") missing++;
    const n = Math.round(Number(raw));
    if (Number.isFinite(n) && n >= 0) sum += n;
    // Update per-row variance cell if present.
    const row = inp.closest("[data-loc-row]");
    if (row) {
      const sys = Number(row.getAttribute("data-sys")) || 0;
      const varCell = row.querySelector(".cc-loc-var");
      if (varCell) {
        if (raw === "") { varCell.textContent = "-"; varCell.className = "cc-loc-var dim mono"; }
        else {
          const v = n - sys;
          varCell.textContent = (v > 0 ? "+" : "") + v;
          varCell.className = "cc-loc-var mono " + (v === 0 ? "dim" : (Math.abs(v) > CC_VAR_TOLERANCE_UNITS ? "text-warn bold" : ""));
        }
      }
    }
  }
  const sumEl = document.getElementById("cc-card-sum");
  const varEl = document.getElementById("cc-card-var");
  const submitBtn = document.getElementById("cc-card-submit");
  const item = CC_STATE._card && CC_STATE._card.item;
  if (sumEl) sumEl.textContent = String(sum);
  if (item && varEl) {
    const sys = Number(item.system_qty_at_assign) || 0;
    const v = sum - sys;
    varEl.textContent = (v > 0 ? "+" : "") + v + " vs system " + sys;
    varEl.className = "mono " + (v === 0 ? "dim" : (_ccBeyondTolerance(sys, sum) ? "text-warn bold" : ""));
  }
  if (submitBtn) {
    submitBtn.disabled = missing > 0 || !_ccName();
    submitBtn.title = missing > 0 ? `Fill every listed location first (${missing} left)`
                    : !_ccName()  ? "Enter your name on the Cycle Counts tab first"
                    : "";
  }
}
function _ccCardAddExtra() {
  const wrap = document.getElementById("cc-card-extras");
  if (!wrap) return;
  const idx = wrap.children.length;
  const row = document.createElement("div");
  row.className = "row gap-sm";
  row.setAttribute("data-loc-row", "extra");
  row.setAttribute("data-sys", "0");
  row.setAttribute("data-extra", "1");
  row.style.cssText = "padding:12px;background:var(--surf-2,#f3f4f6);border-radius:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap";
  row.innerHTML = `
    <input class="input" placeholder="Location code (e.g. R12/A03)" data-loc-extra-code style="min-width:180px;font-size:16px;padding:10px" />
    <span class="dim mono tiny" style="min-width:60px">system 0</span>
    <input class="input num cc-loc-input" type="number" inputmode="numeric" min="0" step="1" placeholder="counted" data-loc-extra-qty style="width:110px;font-size:20px;padding:12px;text-align:right" oninput="_ccBumpCardSum()" />
    <span class="cc-loc-var mono dim">-</span>
    <button class="btn xs ghost" onclick="this.closest('[data-loc-row]').remove(); _ccBumpCardSum();" title="Remove this extra location">remove</button>
  `;
  wrap.appendChild(row);
  const codeInput = row.querySelector("[data-loc-extra-code]");
  if (codeInput) codeInput.focus();
  _ccBumpCardSum();
}
if (typeof window !== "undefined") {
  window._ccBumpCardSum = _ccBumpCardSum;
  window._ccCardAddExtra = _ccCardAddExtra;
}

async function _ccOpenCountCard(itemId) {
  const item = DB.cycleCounts.items.get(itemId);
  if (!item) return;
  const locs = (DB.cycleCountItemLocations instanceof Map)
    ? (DB.cycleCountItemLocations.get(itemId) || [])
    : [];
  if (locs.length === 0) {
    // Fall back to single-total flow -- caller shouldn't have
    // reached here, but be defensive.
    return _ccSubmitCount(itemId);
  }
  CC_STATE._card = { item, itemId };
  const desc = _ccPartDesc(item.pn);
  const cls = _ccPartClass(item.pn);
  const rowsHtml = locs.map(l => `
    <div class="row gap-sm" data-loc-row data-loc="${esc(l.location)}" data-sys="${l.system_qty_at_assign}" style="padding:14px;background:var(--surf-2,#f3f4f6);border-radius:8px;margin-bottom:8px;align-items:center;flex-wrap:wrap">
      <div style="min-width:150px;flex:1">
        <div class="mono" style="font-size:18px;font-weight:600">${esc(l.location)}</div>
        ${l.location_desc ? `<div class="dim tiny">${esc(l.location_desc)}</div>` : ""}
      </div>
      <div class="dim mono" style="min-width:80px;text-align:right">system <b>${Math.round(l.system_qty_at_assign)}</b></div>
      <input class="input num cc-loc-input" type="number" inputmode="numeric" min="0" step="1" placeholder="qty"
             data-loc="${esc(l.location)}" style="width:110px;font-size:22px;padding:12px;text-align:right"
             oninput="_ccBumpCardSum()"
             onkeydown="if(event.key==='Enter'){const n=this.closest('[data-loc-row]').nextElementSibling; if(n){const ni=n.querySelector('input');if(ni)ni.focus();}}" />
      <span class="cc-loc-var mono dim" style="min-width:70px;text-align:right">-</span>
    </div>
  `).join("");
  const nameOk = !!_ccName();
  const html = `
    <div class="modal-head" style="padding:14px 16px;background:var(--surf-1,#f9fafb);border-bottom:1px solid var(--border,#e5e7eb);position:sticky;top:0;z-index:2">
      <div class="row gap-sm" style="align-items:flex-start;justify-content:space-between">
        <div>
          <div class="mono" style="font-size:22px;font-weight:700">${esc(item.pn)}</div>
          <div class="dim" style="margin-top:2px">${esc(desc)}</div>
          <div class="row gap-sm" style="margin-top:6px">
            <span class="pill ${item.tier === "hot" ? "crit" : item.tier === "runway" ? "warn" : "muted"}">${esc((item.tier || "").toUpperCase())}</span>
            ${cls ? `<span class="pill muted">${esc(cls)}</span>` : ""}
            ${item.recount_of ? `<span class="pill warn">RECOUNT (blind)</span>` : ""}
          </div>
          ${item.reason ? `<div class="dim tiny" style="margin-top:6px">${esc(item.reason)}</div>` : ""}
        </div>
        <button class="btn ghost" data-close style="font-size:20px;line-height:1;padding:8px 14px">Cancel</button>
      </div>
    </div>
    <div class="modal-body" style="padding:16px;max-height:calc(100vh - 220px);overflow-y:auto">
      ${!nameOk ? `<div class="banner warn" style="margin-bottom:12px">Enter your name on the Cycle Counts tab first -- required before Submit.</div>` : ""}
      <div class="dr-section" style="margin-top:0">Locations (${locs.length}) -- every listed bin must be counted (0 is valid).</div>
      ${rowsHtml}
      <div class="dr-section" style="margin-top:14px">Found elsewhere</div>
      <p class="dim tiny">Stock in a bin that isn't on the assignment list? Add it here -- an audit log row records it.</p>
      <div id="cc-card-extras"></div>
      <button class="btn" onclick="_ccCardAddExtra()">+ Add other location</button>
    </div>
    <div class="modal-foot" style="padding:14px 16px;background:var(--surf-1,#f9fafb);border-top:1px solid var(--border,#e5e7eb);position:sticky;bottom:0;z-index:2;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
      <div style="flex:1;min-width:180px">
        <div class="dim tiny">Counted total</div>
        <div><span id="cc-card-sum" class="mono" style="font-size:26px;font-weight:700">0</span> <span id="cc-card-var" class="mono dim" style="margin-left:8px">- vs system ${item.system_qty_at_assign}</span></div>
      </div>
      <button class="btn primary" id="cc-card-submit" style="font-size:18px;padding:14px 22px;min-width:140px" ${nameOk ? "" : "disabled"} onclick="_ccSubmitCardCount('${esc(itemId)}')">Submit count</button>
    </div>
  `;
  if (typeof openModal === "function") openModal(html);
  _ccBumpCardSum();
}
if (typeof window !== "undefined") window._ccOpenCountCard = _ccOpenCountCard;

async function _ccSubmitCardCount(itemId) {
  if (CC_STATE._pending.has(itemId)) return;
  const item = DB.cycleCounts.items.get(itemId);
  if (!item) return;
  const counter = _ccName();
  if (!counter) { if (typeof showToast === "function") showToast("Enter your name on the Cycle Counts tab first", "warn"); return; }
  const rows = document.querySelectorAll("[data-loc-row]");
  const locations = [];
  let sum = 0;
  for (const r of rows) {
    const isExtra = r.getAttribute("data-extra") === "1";
    const codeInput = isExtra ? r.querySelector("[data-loc-extra-code]") : null;
    const location = isExtra ? String((codeInput && codeInput.value) || "").trim() : String(r.getAttribute("data-loc") || "").trim();
    const qtyInput = r.querySelector(".cc-loc-input");
    const raw = qtyInput ? String(qtyInput.value || "").trim() : "";
    if (isExtra && !location) continue;   // blank extra: skip
    if (!location) return; // shouldn't happen for listed rows
    if (raw === "") {
      if (typeof showToast === "function") showToast(`Location ${location} is empty -- 0 is valid but a value is required`, "warn");
      if (qtyInput) qtyInput.focus();
      return;
    }
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < 0) {
      if (typeof showToast === "function") showToast(`Location ${location} qty must be a non-negative number`, "warn");
      if (qtyInput) qtyInput.focus();
      return;
    }
    sum += n;
    const payloadRow = { location, counted_qty: n };
    if (isExtra) payloadRow.foundElsewhere = true;
    locations.push(payloadRow);
  }
  if (locations.length === 0) {
    if (typeof showToast === "function") showToast("Nothing to submit", "warn");
    return;
  }
  if (item.recount_of) {
    const parent = DB.cycleCounts.items.get(item.recount_of);
    if (parent && parent.counted_by && parent.counted_by.trim().toLowerCase() === counter.toLowerCase()) {
      if (typeof showToast === "function") showToast(`Recount must be a different counter than ${parent.counted_by}`, "warn");
      return;
    }
  }
  CC_STATE._pending.add(itemId);
  const btn = document.getElementById("cc-card-submit");
  if (btn) { btn.disabled = true; btn.textContent = "Submitting..."; }
  const res = await postCycleCountBatch([{
    op: "submitCount",
    itemId,
    counted_qty: sum,
    counted_by: counter,
    locations,
  }]);
  CC_STATE._pending.delete(itemId);
  if (!res || !res.ok) {
    const err = (res && res.results && res.results[0] && res.results[0].error) || (res && res.error && res.error.message) || "unknown";
    if (typeof showToast === "function") showToast("Submit failed: " + err, "warn");
    if (btn) { btn.disabled = false; btn.textContent = "Submit count"; }
    return;
  }
  const r = res.results[0];
  if (r.status === "recount") {
    if (typeof showToast === "function") showToast(`Variance beyond tolerance -- recount spawned for ${item.pn}`, "warn", "Recount required");
  } else {
    if (typeof showToast === "function") showToast(`Counted ${item.pn} = ${sum}`, "ok");
  }
  if (typeof closeModal === "function") closeModal();
  if (typeof _refetchCycleCounts === "function") await _refetchCycleCounts();
  if (typeof refresh === "function") refresh();
  _ccScheduleReconcileScan();
}
if (typeof window !== "undefined") window._ccSubmitCardCount = _ccSubmitCardCount;

async function _ccSubmitCount(itemId) {
  if (CC_STATE._pending.has(itemId)) return;
  const item = DB.cycleCounts.items.get(itemId);
  if (!item) return;
  // v-cc-loc-1 -- route location-aware items to the full-screen
  // count card instead of the single-input inline flow.
  if (_ccHasLocations(itemId)) return _ccOpenCountCard(itemId);
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
  // v-cc-loc-9 -- stamp the skipper's name so the supervisor tab
  // shows who skipped in the live feed (was blank previously when
  // a supervisor skipped from the desktop expanded queue).
  const counter = _ccName();
  const payload = { op: "skip", itemId, reason: clean };
  if (counter) payload.counted_by = counter;
  const res = await postCycleCountBatch([payload]);
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

// v-cc-live-perf -- session-lifetime parts cache. Previously every
// call to _ccPartClass / _ccPartDesc / _ccDollarImpactFor / etc
// did a linear DB.parts.find scan (O(1600) per call, called N
// times per render). Now one build per session, invalidated only
// if the caller explicitly asks (_ccInvalidatePartsCache).
function _ccPartsCache() {
  if (CC_STATE._partsCache instanceof Map) return CC_STATE._partsCache;
  const m = new Map();
  if (typeof DB !== "undefined" && DB && Array.isArray(DB.parts)) {
    for (const p of DB.parts) {
      if (!p || !p.pn) continue;
      m.set(p.pn, {
        desc: p.desc || "",
        cost: Number(p.cost) || 0,
        cls:  p.partClass || "",
      });
    }
  }
  CC_STATE._partsCache = m;
  return m;
}
function _ccInvalidatePartsCache() { CC_STATE._partsCache = null; }
if (typeof window !== "undefined") window._ccInvalidatePartsCache = _ccInvalidatePartsCache;

function _ccPartClass(pn) {
  const rec = _ccPartsCache().get(pn);
  return rec ? rec.cls : "";
}
function _ccPartDesc(pn) {
  const rec = _ccPartsCache().get(pn);
  return rec ? rec.desc : "";
}
function _ccPartCost(pn) {
  const rec = _ccPartsCache().get(pn);
  return rec ? rec.cost : 0;
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
  const locs = (DB.cycleCountItemLocations instanceof Map) ? (DB.cycleCountItemLocations.get(item.id) || []) : [];
  const hasLocs = locs.length > 0;
  return `
    <tr data-cc-id="${esc(item.id)}">
      <td class="pn">
        ${esc(item.pn)}
        ${cls ? `<span class="pill tiny muted" style="margin-left:6px">${esc(cls)}</span>` : ""}
        ${blindRecount ? `<span class="pill tiny warn" style="margin-left:6px" title="BLIND recount -- first count hidden until this row is completed by a different counter">RECOUNT</span>` : ""}
        ${drift ? `<span class="pill tiny warn" style="margin-left:6px" title="Systematic drift -- ${drift.consecutive} consecutive ${drift.direction} counts, avg ${drift.avgPerCount.toFixed(1)}/count. Check BOM/backflush.">DRIFT</span>` : ""}
        ${hasLocs ? `<span class="pill tiny" style="margin-left:6px;background:var(--accent-soft,#eef);color:var(--accent,#36c)" title="Item has ${locs.length} location snapshot(s); tap Count to open the per-location card">${locs.length} bins</span>` : ""}
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
          ? (hasLocs
              ? `<span class="dim tiny">use Count</span>`
              : `<input class="input num" type="number" inputmode="numeric" min="0" step="1" id="cc-in-${esc(item.id)}" placeholder="qty" style="width:88px;text-align:right;font-size:16px" ${nameDisabled ? "disabled" : ""} onkeydown="if(event.key==='Enter')_ccSubmitCount('${esc(item.id)}')">`)
          : `<span class="num">${item.counted_qty == null ? "-" : Math.round(item.counted_qty)}</span>`}
      </td>
      ${_ccVarianceCell(item)}
      <td>
        ${_ccPill(item.status)}
        ${item.counted_by ? `<div class="dim tiny">by ${esc(item.counted_by)}</div>` : ""}
      </td>
      <td class="right" style="white-space:nowrap">
        ${isOpen ? `
          <button class="btn xs primary" id="cc-submit-${esc(item.id)}" onclick="_ccSubmitCount('${esc(item.id)}')" ${nameDisabled ? "disabled title='Enter your name at the top first'" : ""}>${hasLocs ? "Count" : "Submit"}</button>
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
            <th class="right" title="Physical shelf qty at the time the item was assigned (QtyOnHandinWarehouse / sum of QtyOnHandinLocation). NOT parts.data.onHand -- that's planning-available.">SYS ON-HAND (at assign)</th>
            <th class="right" title="Physical shelf qty now, per the latest Acumatica sync. NOT parts.data.onHand.">SYS ON-HAND (now)</th>
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
        <div class="dim tiny">${s.weekCounted}/${s.weekActive} counted, ${s.weekOpen} open${s.weekOperatorSkipped > 0 ? ` (+${s.weekOperatorSkipped} operator-skipped)` : ""}</div>
        ${s.weekAutoSwept > 0 ? `<div class="dim tiny" title="Rows the assignment cron auto-skipped as ineligible (non-BaseBOM / vendor-managed / pre-launch successor / phasing-out). Not counted in the ratio.">${s.weekAutoSwept} auto-swept (policy)</div>` : ""}
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

/* ============================================================
   v-cc-live -- SUPERVISOR HELPERS (live feed, needs-attention,
   pulse dot, chime, verify/recount actions).
   ============================================================ */
const CC_CHIME_LS = "landmaster.cycleCount.chime";
const CC_LAST_SEEN_LS = "landmaster.cycleCount.lastSeenLogAt";

function _ccInitLocalState() {
  if (CC_STATE._initedFromLS) return;
  CC_STATE._initedFromLS = true;
  try { CC_STATE._chimeOn = localStorage.getItem(CC_CHIME_LS) === "1"; } catch (_) {}
  try { CC_STATE._lastSeenLogAt = localStorage.getItem(CC_LAST_SEEN_LS) || null; } catch (_) {}
}
function _ccPersistLastSeen(atIso) {
  if (!atIso) return;
  const cur = CC_STATE._lastSeenLogAt || "";
  if (atIso > cur) {
    CC_STATE._lastSeenLogAt = atIso;
    try { localStorage.setItem(CC_LAST_SEEN_LS, atIso); } catch (_) {}
  }
}
function _ccToggleChime() {
  CC_STATE._chimeOn = !CC_STATE._chimeOn;
  try { localStorage.setItem(CC_CHIME_LS, CC_STATE._chimeOn ? "1" : "0"); } catch (_) {}
  if (typeof refresh === "function") refresh();
}
if (typeof window !== "undefined") window._ccToggleChime = _ccToggleChime;
function _ccPlayChime() {
  if (!CC_STATE._chimeOn) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.15);
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.3);
  } catch (_) {}
}

/* ---- action wrappers -------------------------------------- */
async function _ccVerifyLog(logId, rowBtn) {
  const reviewer = _ccName();
  if (!reviewer) { if (typeof showToast === "function") showToast("Enter your name at the top before verifying", "warn"); return; }
  if (rowBtn) { rowBtn.disabled = true; rowBtn.textContent = "..."; }
  const res = await postCycleCountBatch([{ op: "verifyLog", logId, reviewed_by: reviewer }]);
  if (!res || !res.ok) {
    if (typeof showToast === "function") showToast("Verify failed: " + ((res && res.results && res.results[0] && res.results[0].error) || (res && res.error && res.error.message) || "unknown"), "warn");
    if (rowBtn) { rowBtn.disabled = false; rowBtn.textContent = "Verified"; }
    return;
  }
  if (typeof showToast === "function") showToast("Verified -- send the adjustment to Acumatica manually.", "ok");
  if (typeof _refetchCycleCounts === "function") await _refetchCycleCounts();
  if (typeof refresh === "function") refresh();
}
if (typeof window !== "undefined") window._ccVerifyLog = _ccVerifyLog;

async function _ccRequestRecount(itemId, rowBtn, opts) {
  opts = opts || {};
  const requester = _ccName();
  // Two send-back-out shapes routed here:
  //   COUNT rows (counted / recount log outcomes) -> requestRecount
  //     op: spawns a recount CHILD (tier=flagged, recount_of=parent);
  //     blind rule fires server-side (different counter required).
  //   SKIP rows (skipped log outcomes) -> reassignFromSkip op:
  //     flips the SAME item back to pending, clears the counted_*
  //     fields left over from the skip, moves assigned_date to
  //     today. NO blind rule -- any counter can pick it up (a
  //     skip was never a count).
  const skipMode = !!opts.fromSkip;
  let note = "";
  if (opts.promptForNote) {
    const raw = (typeof prompt === "function")
      ? prompt(skipMode
          ? "Optional note for the counter (shows on their phone card; e.g. 'bin should be unlocked now'):"
          : "Optional note for the counter (shows on their phone card; e.g. 'recheck RMSTOR-LM bin'):",
          "")
      : "";
    if (raw === null) return;   // supervisor cancelled the prompt
    note = String(raw || "").trim();
  } else if (typeof opts.note === "string") {
    note = opts.note.trim();
  }
  const restoreLabel = (rowBtn && rowBtn.textContent) || "Send back out";
  if (rowBtn) { rowBtn.disabled = true; rowBtn.textContent = "..."; }
  const payload = skipMode
    ? { op: "reassignFromSkip", itemId, requested_by: requester }
    : { op: "requestRecount",    itemId, requested_by: requester };
  if (note) payload.note = note;
  const res = await postCycleCountBatch([payload]);
  if (!res || !res.ok) {
    if (typeof showToast === "function") showToast("Send back failed: " + ((res && res.results && res.results[0] && res.results[0].error) || (res && res.error && res.error.message) || "unknown"), "warn");
    if (rowBtn) { rowBtn.disabled = false; rowBtn.textContent = restoreLabel; }
    return;
  }
  const r = res.results && res.results[0];
  if (r && r.skipped) {
    if (typeof showToast === "function") showToast(skipMode ? "Item is no longer skipped -- nothing to reassign." : "A recount is already pending for this item.", "");
  } else if (typeof showToast === "function") {
    showToast(skipMode
      ? "Sent back out -- any counter can pick it up now."
      : "Sent back out -- next counter (other than the original) will pick it up.",
      "ok");
  }
  if (typeof _refetchCycleCounts === "function") await _refetchCycleCounts();
  if (typeof refresh === "function") refresh();
}
if (typeof window !== "undefined") window._ccRequestRecount = _ccRequestRecount;
// Convenience wrapper for the live-feed "Send back out" button --
// always prompts for the optional note. Pass { fromSkip: true } for
// skip rows so the write function's reassignFromSkip op runs
// instead of requestRecount.
function _ccSendBackOut(itemId, rowBtn, opts) {
  const merged = Object.assign({ promptForNote: true }, opts || {});
  return _ccRequestRecount(itemId, rowBtn, merged);
}
if (typeof window !== "undefined") window._ccSendBackOut = _ccSendBackOut;

/* ---- live feed data -------------------------------------- */
function _ccRecentLogRows(limit) {
  const log = (DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log)) ? DB.cycleCounts.log : [];
  return log.slice(0, Math.max(1, limit || 40));
}
function _ccLogRowIsAttention(row) {
  if (!row) return false;
  if (row.outcome !== "counted" && row.outcome !== "recount") return false;
  if (typeof row.counted_qty !== "number") return false;
  if (row.reviewed_by) return false;  // already verified
  return _ccBeyondTolerance(row.system_qty_at_assign, row.counted_qty);
}
function _ccDollarImpactFor(row) {
  const pn = row && row.pn;
  const v = (typeof row.variance === "number") ? row.variance : ((Number(row.counted_qty) || 0) - (Number(row.system_qty_at_assign) || 0));
  const cost = _ccPartCost(pn);
  return { units: v, dollars: cost * Math.abs(v), cost };
}
function _ccItemHasPendingRecount(parentItemId) {
  if (!(DB && DB.cycleCounts && DB.cycleCounts.items instanceof Map)) return false;
  for (const it of DB.cycleCounts.items.values()) {
    if (it && it.recount_of === parentItemId && (it.status === "pending" || it.status === "recount")) return true;
  }
  return false;
}
// v-cc-loc-8 -- lifecycle state for a parent item across ANY of
// its recount children. Return values drive the live-feed
// "Send back out" button label + disabled state:
//   "none"     -- no recount child exists; button reads "Send
//                 back out" and is active.
//   "pending"  -- at least one recount child exists in status
//                 pending or recount; button reads "recount
//                 pending" and is disabled.
//   "counted"  -- every recount child has completed (counted /
//                 reconciled / skipped) and none are still open;
//                 button reads "recounted &#10003;" and is disabled.
// A parent that has NEVER been recounted returns "none"; once
// even one child lands, we transition to counted (or pending
// while the child is still open). Latest child wins the state.
function _ccItemRecountStatus(parentItemId) {
  if (!(DB && DB.cycleCounts && DB.cycleCounts.items instanceof Map)) return "none";
  const children = [];
  for (const it of DB.cycleCounts.items.values()) {
    if (it && it.recount_of === parentItemId) children.push(it);
  }
  if (children.length === 0) return "none";
  for (const c of children) {
    if (c.status === "pending" || c.status === "recount") return "pending";
  }
  return "counted";
}

/* ---- render fragments ------------------------------------ */
function _ccPulseDot(state) {
  const color = state === "subscribed" ? "var(--ok,#3a7)"
              : state === "polling"    ? "var(--warn,#c85)"
              : state === "connecting" ? "var(--dim,#888)"
              : /* unavailable */        "var(--crit,#c33)";
  const label = state === "subscribed" ? "realtime connected"
              : state === "polling"    ? "polling fallback (realtime unavailable)"
              : state === "connecting" ? "connecting..."
              : "realtime unavailable";
  return `<span class="cc-pulse-dot" data-state="${esc(state)}" title="${esc(label)}" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color};box-shadow:0 0 8px ${color};vertical-align:middle;margin-left:8px;animation:${state === "subscribed" ? "cc-pulse 2s infinite" : "none"}"></span>`;
}

function _ccBinBreakdownRow(row) {
  // Reads row.locations (jsonb from cycle_count_log). Returns HTML
  // for a bin-breakdown block; empty string when no location data.
  if (!row || !Array.isArray(row.locations) || row.locations.length === 0) return "";
  // Match each bin to a snapshot system qty via cycle_count_item_locations.
  const snapshot = (DB.cycleCountItemLocations instanceof Map)
    ? (DB.cycleCountItemLocations.get(row.item_id) || [])
    : [];
  const sysByLoc = new Map(snapshot.map(s => [s.location, Number(s.system_qty_at_assign) || 0]));
  const body = row.locations.map(l => {
    const cnt = Math.round(Number(l.counted_qty) || 0);
    const sys = sysByLoc.has(l.location) ? sysByLoc.get(l.location) : (l.foundElsewhere ? 0 : null);
    const v = sys == null ? null : (cnt - sys);
    const cls = (v == null) ? "dim" : (Math.abs(v) > CC_VAR_TOLERANCE_UNITS ? "text-warn bold" : (v === 0 ? "dim" : ""));
    return `<tr>
      <td class="mono">${esc(l.location)}${l.foundElsewhere ? ' <span class="pill tiny warn">found</span>' : ""}</td>
      <td class="right num dim">${sys == null ? "-" : Math.round(sys)}</td>
      <td class="right num">${cnt}</td>
      <td class="right num ${cls}">${v == null ? "-" : (v > 0 ? "+" : "") + v}</td>
    </tr>`;
  }).join("");
  return `
    <div style="padding:6px 0 6px 12px">
      <div class="tbl-wrap"><table class="tbl" style="max-width:520px">
        <thead><tr><th>Bin</th><th class="right">Sys</th><th class="right">Counted</th><th class="right">Variance</th></tr></thead>
        <tbody>${body}</tbody>
      </table></div>
    </div>
  `;
}

// v-cc-live-perf -- factored out of _ccRenderLiveFeed so
// _ccPatchAfterDelta can prepend one row without re-rendering
// the entire feed. Returns a bare `<tr>` (+ optional breakdown
// row) HTML string for one log row.
function _ccRenderFeedTr(r, lastSeen) {
  const at = r.counted_at || "";
  const isNew = at && lastSeen && at > lastSeen;
  const v = (typeof r.variance === "number") ? r.variance : 0;
  const sys = Math.abs(Number(r.system_qty_at_assign) || 0);
  const pct = sys < 1e-9 ? (r.counted_qty === 0 ? 0 : 1) : Math.abs(v) / sys;
  const beyond = (typeof r.counted_qty === "number") ? _ccBeyondTolerance(r.system_qty_at_assign, r.counted_qty) : false;
  const vCls = beyond ? "text-warn bold" : (v === 0 ? "dim" : "");
  const statusLabel = r.reviewed_by ? "verified"
                    : r.outcome === "recount" ? "recount"
                    : r.outcome === "reconciled" ? "ok"
                    : r.outcome === "skipped" ? "skipped"
                    : "counted";
  const statusCls = statusLabel === "verified" ? "ok"
                  : statusLabel === "recount" ? "warn"
                  : statusLabel === "ok" ? "ok"
                  : statusLabel === "skipped" ? "muted"
                  : "";
  const desc = _ccPartDesc(r.pn);
  const hasBins = Array.isArray(r.locations) && r.locations.length > 0;
  const expanded = CC_STATE._feedExpanded.has(r.id);
  const isSkipRow = r.outcome === "skipped";
  let sendBtn = "";
  if (r.item_id) {
    if (isSkipRow) {
      const cur = (DB.cycleCounts.items instanceof Map) ? DB.cycleCounts.items.get(r.item_id) : null;
      const curStatus = cur ? cur.status : null;
      if (curStatus === "skipped") {
        sendBtn = `<button class="btn xs" title="Reassign this skipped item as pending -- prompts for an optional note that shows on the counter's phone card. No blind rule; any counter can pick it up." onclick="event.stopPropagation();_ccSendBackOut('${esc(r.item_id)}', this, { fromSkip: true })">Send back out</button>`;
      } else if (curStatus === "pending" || curStatus === "recount") {
        sendBtn = `<button class="btn xs" disabled title="Skip already reassigned and waiting for a counter">reassigned</button>`;
      } else {
        sendBtn = `<button class="btn xs ghost" disabled title="Item has been handled since the skip">handled</button>`;
      }
    } else {
      const rs = _ccItemRecountStatus(r.item_id);
      if (rs === "none") {
        sendBtn = `<button class="btn xs" title="Spawn a recount for a different counter -- prompts for an optional note that shows on their phone card" onclick="event.stopPropagation();_ccSendBackOut('${esc(r.item_id)}', this)">Send back out</button>`;
      } else if (rs === "pending") {
        sendBtn = `<button class="btn xs" disabled title="A recount is already open for this item">recount pending</button>`;
      } else {
        sendBtn = `<button class="btn xs ghost" disabled title="This item has already been recounted">recounted &#10003;</button>`;
      }
    }
  }
  const skipReasonInline = isSkipRow
    ? `<span class="dim tiny">skipped: ${esc(r.note || r.reason || "no reason given")}</span>`
    : "";
  const trHtml = `
    <tr data-log-id="${esc(r.id)}" class="${isNew ? "cc-new-flash" : ""}${isSkipRow ? " cc-skip-row" : ""}" ${hasBins ? `onclick="_ccToggleFeedExpand('${esc(r.id)}')"` : ""} style="${hasBins ? "cursor:pointer" : ""}">
      <td class="dim tiny mono">${esc((at || "").slice(11, 16))}</td>
      <td>${esc(r.counted_by || "-")}</td>
      <td>
        <span class="mono">${esc(r.pn)}</span>${hasBins ? ` <span class="dim tiny">${expanded ? "&#9662;" : "&#9656;"} ${r.locations.length} bin${r.locations.length === 1 ? "" : "s"}</span>` : ""}
        <div class="dim tiny">${esc(desc)}</div>
        ${skipReasonInline}
      </td>
      <td class="right num">${r.system_qty_at_assign == null ? "-" : Math.round(r.system_qty_at_assign)}</td>
      <td class="right num">${isSkipRow ? '<span class="dim">-</span>' : (r.counted_qty == null ? "-" : Math.round(r.counted_qty))}</td>
      <td class="right num ${vCls}">${isSkipRow ? '<span class="dim">-</span>' : `${v > 0 ? "+" : ""}${v} <span class="dim tiny">(${(pct * 100).toFixed(1)}%)</span>`}</td>
      <td><span class="pill tiny ${statusCls}">${(statusLabel === "ok" ? "reconciled" : statusLabel).toUpperCase()}</span>${r.reviewed_by ? `<div class="dim tiny">by ${esc(r.reviewed_by)}</div>` : ""}</td>
      <td class="right" style="white-space:nowrap">${sendBtn}</td>
    </tr>`;
  const breakdown = (hasBins && expanded)
    ? `<tr data-log-id="${esc(r.id)}-bd" class="cc-breakdown-row"><td colspan="8" style="background:var(--surf-2,#f5f5f7);padding:0">${_ccBinBreakdownRow(r)}</td></tr>`
    : "";
  return trHtml + breakdown;
}

function _ccRenderLiveFeed() {
  const rows = _ccRecentLogRows(60);
  if (rows.length === 0) {
    return `<div class="empty" style="padding:16px"><div class="empty-title muted">No counts logged yet. New submissions appear here as they arrive.</div></div>`;
  }
  const lastSeen = CC_STATE._lastSeenLogAt || "";
  const body = rows.map(r => _ccRenderFeedTr(r, lastSeen)).join("");
  return `
    <div class="tbl-wrap">
      <table class="tbl cc-feed-table">
        <thead><tr>
          <th>Time</th><th>Counter</th><th>Part / description</th>
          <th class="right">SYS ON-HAND</th><th class="right">Counted</th><th class="right">Variance</th>
          <th>Status</th><th></th>
        </tr></thead>
        <tbody id="cc-feed-tbody">${body}</tbody>
      </table>
    </div>
  `;
}
function _ccToggleFeedExpand(id) {
  if (CC_STATE._feedExpanded.has(id)) CC_STATE._feedExpanded.delete(id);
  else CC_STATE._feedExpanded.add(id);
  if (typeof refresh === "function") refresh();
}
if (typeof window !== "undefined") window._ccToggleFeedExpand = _ccToggleFeedExpand;

function _ccRenderNeedsAttention() {
  const log = (DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log)) ? DB.cycleCounts.log : [];
  // Only consider the LATEST log row per item (recounts supersede).
  const latestByItem = new Map();
  for (const r of log) {
    if (!r || !r.item_id) continue;
    const prev = latestByItem.get(r.item_id);
    if (!prev || (r.counted_at || "") > (prev.counted_at || "")) latestByItem.set(r.item_id, r);
  }
  const attn = [];
  for (const r of latestByItem.values()) {
    if (!_ccLogRowIsAttention(r)) continue;
    const impact = _ccDollarImpactFor(r);
    attn.push({ row: r, impact });
  }
  attn.sort((a, b) => (Number(b.impact.dollars) || 0) - (Number(a.impact.dollars) || 0));
  if (attn.length === 0) {
    return `<div class="empty" style="padding:12px"><div class="empty-title muted">No open variances -- every count within tolerance (or already verified).</div></div>`;
  }
  const rows = attn.map(({ row, impact }) => {
    const v = impact.units;
    const pendingRecount = _ccItemHasPendingRecount(row.item_id);
    const dollarTxt = impact.dollars == null || impact.cost == null || impact.cost === 0
      ? `<span class="dim">no cost</span>`
      : `${(v < 0 ? "-" : "")}$${Math.abs(impact.dollars).toFixed(2)}`;
    const expanded = CC_STATE._attnExpanded.has(row.item_id);
    const desc = _ccPartDesc(row.pn);
    const cls = _ccPartClass(row.pn);
    const hasBins = Array.isArray(row.locations) && row.locations.length > 0;
    const mainRow = `
      <tr>
        <td>
          <div><span class="mono bold">${esc(row.pn)}</span>${cls ? `<span class="pill tiny muted" style="margin-left:6px">${esc(cls)}</span>` : ""}</div>
          <div class="dim tiny">${esc(desc)}</div>
          ${hasBins ? `<button class="btn xs ghost" onclick="_ccToggleAttnExpand('${esc(row.item_id)}')">${expanded ? "hide" : "show"} bins</button>` : ""}
        </td>
        <td class="dim tiny">${esc((row.counted_at || "").slice(0, 16).replace("T", " "))}<div>${esc(row.counted_by || "")}</div></td>
        <td class="right num">${row.system_qty_at_assign == null ? "-" : Math.round(row.system_qty_at_assign)}</td>
        <td class="right num">${row.counted_qty == null ? "-" : Math.round(row.counted_qty)}</td>
        <td class="right num text-warn bold">${v > 0 ? "+" : ""}${v}</td>
        <td class="right num bold">${dollarTxt}</td>
        <td class="right" style="white-space:nowrap">
          <button class="btn xs primary" onclick="_ccVerifyLog('${esc(row.id)}', this)" title="Attest that this variance is real and adjustment should be sent to Acumatica. Writes reviewed_by/at on the log row; NEVER writes on-hand.">Verified &mdash; send to Acumatica</button>
          <button class="btn xs" onclick="_ccSendBackOut('${esc(row.item_id)}', this)" ${pendingRecount ? "disabled title='Recount already pending'" : "title='Spawn a recount for a different counter -- prompts for an optional note'"}>${pendingRecount ? "Recount pending" : "Request recount"}</button>
        </td>
      </tr>`;
    const breakdown = (hasBins && expanded)
      ? `<tr><td colspan="7" style="background:var(--surf-2,#f5f5f7);padding:0">${_ccBinBreakdownRow(row)}</td></tr>`
      : "";
    return mainRow + breakdown;
  }).join("");
  return `
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr>
        <th>Part</th><th>When / counter</th>
        <th class="right">SYS ON-HAND</th><th class="right">Counted</th><th class="right">Variance</th><th class="right">$ impact</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  `;
}
function _ccToggleAttnExpand(id) {
  if (CC_STATE._attnExpanded.has(id)) CC_STATE._attnExpanded.delete(id);
  else CC_STATE._attnExpanded.add(id);
  if (typeof refresh === "function") refresh();
}
if (typeof window !== "undefined") window._ccToggleAttnExpand = _ccToggleAttnExpand;

function _ccRenderTightSummary(s) {
  const complText = (Math.round(s.weekCompletion * 1000) / 10) + "%";
  const iraText = s.ira == null ? "-" : (Math.round(s.ira * 1000) / 10) + "%";
  const trendBtn = `<button class="btn xs ghost" onclick="_ccToggleTrend()">${CC_STATE._trendExpanded ? "&#9650; hide 8-wk trend" : "&#9660; show 8-wk trend"}</button>`;
  const trendHtml = CC_STATE._trendExpanded ? _ccRenderTrend(s) : "";
  const offCount = s.repeatOffenders.length;
  const driftCount = s.driftFlags.length;
  return `
    <div class="row gap-md" style="align-items:stretch;margin:12px 0;flex-wrap:wrap">
      <div class="card" style="padding:10px 14px;min-width:160px"><div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase">Week completion</div><div class="head-lg mono">${complText}</div><div class="dim tiny">${s.weekCounted}/${s.weekActive} counted, ${s.weekOpen} open</div></div>
      <div class="card" style="padding:10px 14px;min-width:160px"><div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase">Accuracy (week)</div><div class="head-lg mono">${iraText}</div><div class="dim tiny">within max(${Math.round(CC_VAR_TOLERANCE_PCT*100)}%, ${CC_VAR_TOLERANCE_UNITS} units)</div></div>
      <div class="card" style="padding:10px 14px;min-width:150px"><div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase">Repeat offenders</div><div class="head-lg mono">${offCount}</div><div class="dim tiny">last 60 days</div></div>
      <div class="card" style="padding:10px 14px;min-width:150px"><div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase">Drift flags</div><div class="head-lg mono">${driftCount}</div><div class="dim tiny">check BOM / backflush</div></div>
      <div class="card" style="padding:10px 14px;min-width:170px;display:flex;align-items:center;justify-content:center">${trendBtn}</div>
    </div>
    ${trendHtml}
  `;
}
function _ccRenderTrend(s) {
  const trendHtml = s.trend.map(w => {
    const pct = w.ira == null ? null : Math.round(w.ira * 100);
    const h = w.ira == null ? 3 : Math.max(4, Math.round(w.ira * 60));
    const color = w.ira == null ? "var(--t3,#999)" : w.ira >= 0.95 ? "var(--ok,#3a7)" : w.ira >= 0.85 ? "var(--warn,#c85)" : "var(--crit,#c33)";
    const label = w.ira == null ? "no counts" : `${pct}% (n=${w.n})`;
    const short = w.mondayIso.slice(5);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:3px" title="Week of ${w.mondayIso} -- ${label}">
      <div style="width:22px;height:64px;background:var(--surf-2,#eee);border-radius:3px;position:relative;overflow:hidden">
        <div style="position:absolute;bottom:0;left:0;right:0;height:${h}px;background:${color}"></div>
      </div>
      <div class="dim tiny">${short}</div>
    </div>`;
  }).join("");
  return `<div class="card" style="padding:14px;margin-bottom:12px"><div class="muted tiny" style="letter-spacing:.08em;text-transform:uppercase;margin-bottom:8px">Inventory record accuracy -- last 8 weeks</div><div style="display:flex;gap:12px;align-items:flex-end">${trendHtml}</div></div>`;
}
function _ccToggleTrend() { CC_STATE._trendExpanded = !CC_STATE._trendExpanded; if (typeof refresh === "function") refresh(); }
if (typeof window !== "undefined") window._ccToggleTrend = _ccToggleTrend;

function _ccOpenQueueSummary() {
  const items = _ccAllItems().filter(i => i && (i.status === "pending" || i.status === "recount"));
  const byTier = { hot: 0, runway: 0, rotation: 0, flagged: 0 };
  for (const i of items) byTier[i.tier] = (byTier[i.tier] || 0) + 1;
  const parts = [];
  if (byTier.hot)      parts.push(`${byTier.hot} hot`);
  if (byTier.flagged)  parts.push(`${byTier.flagged} flagged`);
  if (byTier.runway)   parts.push(`${byTier.runway} runway`);
  if (byTier.rotation) parts.push(`${byTier.rotation} rotation`);
  return `${items.length} open${parts.length ? " -- " + parts.join(" / ") : ""}`;
}
function _ccToggleOpenQueue() { CC_STATE._openQueueExpanded = !CC_STATE._openQueueExpanded; if (typeof refresh === "function") refresh(); }
if (typeof window !== "undefined") window._ccToggleOpenQueue = _ccToggleOpenQueue;

function _ccRenderOpenQueueBody() {
  const todayItems = _ccTodayHotAndFlagged();
  const runwayItems = _ccOpenByTier("runway");
  const rotationItems = _ccOpenByTier("rotation");
  return `
    <div class="dr-section" style="margin-top:12px">Today (HOT + operator flags)</div>
    ${_ccRenderTable(todayItems, { emptyMsg: "Nothing hot today." })}
    <div class="dr-section" style="margin-top:12px">This week -- Runway (< 60d cover, not counted in 45d)</div>
    ${_ccRenderTable(runwayItems, { emptyMsg: "No open runway rows." })}
    <div class="dr-section" style="margin-top:12px">This week -- Rotation (LRU + frame 30d cycle)</div>
    ${_ccRenderTable(rotationItems, { emptyMsg: "No open rotation rows." })}
  `;
}

/* ---- v-cc-live-perf: DELTA FETCH + DOM PATCH -------------
   Realtime event / poll tick used to call _refetchCycleCounts
   (three full-table fetches) + refresh() (full-page navigate
   with scrollTop reset). For a supervisor watching the tab in
   the background, that was 3 round-trips + ~200ms of DOM
   thrash per event.

   New path:
     * _ccFetchLogDelta(sinceIso)      -- only rows newer than
       the watermark, or a bounded refresh limit on first load.
     * _ccFetchItemsDelta(sinceIso)    -- only items with
       updated_at > watermark.
     * _ccMergeLog / _ccMergeItems     -- in-place merge into
       DB.cycleCounts.log / items, advancing the watermarks.
     * _ccApplyDelta                    -- targeted DOM patch:
       new log rows prepend into #cc-feed-tbody, existing rows
       replaced in place when they update (verifyLog etc), and
       the summary + needs-attention + open-queue-summary
       blocks re-render their inner HTML only.
     * refresh() ONLY runs on user actions (chime toggle,
       expand queue, name input, etc), never on realtime.
   ----------------------------------------------------------- */
function _ccFetchLogDelta(sinceIso, limit) {
  if (typeof _supa === "undefined" || !_supa) return Promise.resolve([]);
  let q = _supa
    .from("cycle_count_log")
    .select("id, item_id, pn, assigned_date, counted_at, counted_by, tier, reason, system_qty_at_assign, counted_qty, variance, variance_pct, outcome, note, recount_of, reviewed_by, reviewed_at, locations")
    .order("counted_at", { ascending: false });
  if (sinceIso) q = q.gt("counted_at", sinceIso);
  if (limit) q = q.limit(limit);
  return q.then(({ data, error }) => {
    if (error) { console.warn("[cc-delta] log fetch failed:", error.message); return []; }
    return data || [];
  });
}
function _ccFetchItemsDelta(sinceIso) {
  if (typeof _supa === "undefined" || !_supa) return Promise.resolve([]);
  let q = _supa
    .from("cycle_count_items")
    .select("id, assigned_date, tier, reason, pn, system_qty_at_assign, counted_qty, counted_by, counted_at, variance, status, recount_of, note, created_at, updated_at");
  if (sinceIso) q = q.gt("updated_at", sinceIso);
  return q.then(({ data, error }) => {
    if (error) { console.warn("[cc-delta] items fetch failed:", error.message); return []; }
    return data || [];
  });
}
function _ccMergeLogRows(rows) {
  if (!(DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log))) return { added: [], updated: [] };
  const existing = DB.cycleCounts.log;
  const byId = new Map(existing.map(r => [r.id, r]));
  const added = [];
  const updated = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    if (byId.has(r.id)) {
      Object.assign(byId.get(r.id), r);
      updated.push(r.id);
    } else {
      byId.set(r.id, r);
      added.push(r);
    }
    if (r.counted_at && (!CC_STATE._logWatermark || r.counted_at > CC_STATE._logWatermark)) {
      CC_STATE._logWatermark = r.counted_at;
    }
  }
  if (added.length > 0) {
    // Rebuild in newest-first order (cheap: log is capped at
    // ~1 year in the initial fetch).
    existing.length = 0;
    for (const r of byId.values()) existing.push(r);
    existing.sort((a, b) => String(b.counted_at || "").localeCompare(String(a.counted_at || "")));
  }
  return { added, updated };
}
function _ccMergeItemRows(rows) {
  if (!(DB && DB.cycleCounts && DB.cycleCounts.items instanceof Map)) return { touched: [] };
  const items = DB.cycleCounts.items;
  const touched = [];
  for (const r of rows) {
    if (!r || !r.id) continue;
    items.set(r.id, {
      id: r.id, assigned_date: r.assigned_date, tier: r.tier, reason: r.reason, pn: r.pn,
      system_qty_at_assign: Number(r.system_qty_at_assign) || 0,
      counted_qty: r.counted_qty == null ? null : Number(r.counted_qty),
      counted_by: r.counted_by || null, counted_at: r.counted_at || null,
      variance: r.variance == null ? null : Number(r.variance),
      status: r.status, recount_of: r.recount_of || null, note: r.note || null,
      created_at: r.created_at || null, updated_at: r.updated_at || null,
    });
    touched.push(r.id);
    if (r.updated_at && (!CC_STATE._itemsWatermark || r.updated_at > CC_STATE._itemsWatermark)) {
      CC_STATE._itemsWatermark = r.updated_at;
    }
  }
  return { touched };
}
function _ccApplyDelta({ addedLog, updatedLog, touchedItems }) {
  const feedTbody = document.getElementById("cc-feed-tbody");
  if (feedTbody) {
    // Prepend new rows.
    if (addedLog && addedLog.length > 0) {
      const lastSeen = CC_STATE._lastSeenLogAt || "";
      const html = addedLog.map(r => _ccRenderFeedTr(r, lastSeen)).join("");
      feedTbody.insertAdjacentHTML("afterbegin", html);
      // Trim to 60 <tr>s (main + breakdown counted separately;
      // breakdowns come next to their main row so we cap the
      // count and let the browser reflow).
      while (feedTbody.querySelectorAll("tr:not(.cc-breakdown-row)").length > 60) {
        feedTbody.deleteRow(feedTbody.rows.length - 1);
      }
    }
    // Replace updated rows in place (verifyLog stamps
    // reviewed_by / reviewed_at, changing the status pill).
    if (updatedLog && updatedLog.length > 0) {
      const lastSeen = CC_STATE._lastSeenLogAt || "";
      for (const id of updatedLog) {
        const oldTr = feedTbody.querySelector(`tr[data-log-id="${id}"]`);
        if (!oldTr) continue;
        const row = DB.cycleCounts.log.find(r => r.id === id);
        if (!row) continue;
        const holder = document.createElement("tbody");
        holder.innerHTML = _ccRenderFeedTr(row, lastSeen);
        const newTr = holder.querySelector(`tr[data-log-id="${id}"]`);
        if (newTr) oldTr.replaceWith(newTr);
        // Also refresh optional breakdown row.
        const oldBd = feedTbody.querySelector(`tr[data-log-id="${id}-bd"]`);
        if (oldBd) oldBd.remove();
        const newBd = holder.querySelector(`tr[data-log-id="${id}-bd"]`);
        if (newBd) newTr.after(newBd);
      }
    }
  }
  // Items changed OR log added -> refresh Needs Attention + Open
  // Queue summary + Summary strip inner HTML. Cheap: each is a
  // single innerHTML swap on a small chunk of DOM.
  if ((touchedItems && touchedItems.length > 0) || (addedLog && addedLog.length > 0)) {
    const attn = document.getElementById("cc-attn-block");
    if (attn) attn.innerHTML = _ccRenderNeedsAttention();
    const oqSum = document.getElementById("cc-open-queue-summary-text");
    if (oqSum) oqSum.textContent = _ccOpenQueueSummary();
    const sum = document.getElementById("cc-summary-strip");
    if (sum) sum.innerHTML = _ccRenderTightSummary(_ccSummary());
    // If open queue is expanded, re-render its body too.
    if (CC_STATE._openQueueExpanded) {
      const oqBody = document.getElementById("cc-open-queue-body");
      if (oqBody) oqBody.innerHTML = _ccRenderOpenQueueBody();
    }
  }
}

function _ccOnLiveEvent(source) {
  // State pings update just the pulse dot -- no fetch, no
  // re-render.
  if (source === "state") {
    const dot = document.querySelector(".cc-pulse-dot");
    if (dot) {
      const state = (typeof ccLiveState === "function") ? ccLiveState() : "connecting";
      dot.outerHTML = _ccPulseDot(state);
    }
    return;
  }
  // Only act on the supervisor tab (other routes ignore).
  if (typeof CURRENT_ROUTE !== "undefined" && CURRENT_ROUTE !== "cycle-counts") return;
  // Delta fetch both tables in parallel using the watermarks
  // populated by the last render / delta pass. Backstop the log
  // fetch with a 60-row limit so a first-ever call still lands
  // (no watermark yet -> falls back to the last 60 rows).
  const logSince = CC_STATE._logWatermark || null;
  const itemsSince = CC_STATE._itemsWatermark || null;
  const logP = _ccFetchLogDelta(logSince, logSince ? null : 60);
  const itemsP = itemsSince ? _ccFetchItemsDelta(itemsSince) : Promise.resolve([]);
  Promise.all([logP, itemsP]).then(([logRows, itemRows]) => {
    const { added, updated } = _ccMergeLogRows(logRows);
    const { touched } = _ccMergeItemRows(itemRows);
    if (added.length === 0 && updated.length === 0 && touched.length === 0) return;
    // Chime + advance last-seen only on genuinely new counts (not
    // status-only updates).
    if (added.length > 0) {
      _ccPlayChime();
      const newest = added[0] && added[0].counted_at;
      if (newest) _ccPersistLastSeen(newest);
    }
    _ccApplyDelta({ addedLog: added, updatedLog: updated, touchedItems: touched });
  }).catch(err => { console.warn("[cc-delta] apply failed:", err && err.message); });
}
function _ccEnsureLiveWiring() {
  if (CC_STATE._liveSubscribed) return;
  CC_STATE._liveSubscribed = true;
  if (typeof ccLiveSubscribe === "function") ccLiveSubscribe(_ccOnLiveEvent);
  // 60s poll fallback -- runs regardless of realtime state so a
  // silently-dropped socket still sees new counts within a minute.
  if (CC_STATE._pollTimer) clearInterval(CC_STATE._pollTimer);
  CC_STATE._pollTimer = setInterval(() => _ccOnLiveEvent("poll"), 60000);
}

/* ================================================================
   INVENTORY RECONCILIATION -- v-ir-1
   The Cycle Counts tab is now a self-auditing ledger. Every night,
   parts-onhand-snapshot.js writes one parts_onhand_snapshots row
   per Base BOM part comparing how on-hand actually moved against
   how it should have moved (receipts_qty - usage_est). The gap
   ("residual") is what we can't account for -- record-keeping
   error that tells us WHICH parts to count and WHY.
   ================================================================ */

const IR_STATE = {
  windowDays: 30,             // 7 | 30 | 60 | 90
  view: "main",               // "main" | "verify"
  search: "",
  classFilter: "",
  sortKey: "residualUsdAbs",  // residualUsdAbs | pn | onHand | daysLeft | lastCountedAt
  sortDir: "desc",
  // v-ir-tame: runway is a secondary panel now -- collapsed by default,
  // 15/30/60d threshold, cap display at 25.
  runwayExpanded: false,
  runwayThreshold: 15,        // 15 | 30 | 60
  runwayShowAll: false,
  expanded: new Set(),        // pns whose PO detail row is open
  poCache: new Map(),         // pn -> Array<{poNum, receiptDate, qty, vendor}>
  snaps: null,
  snapsLoadedFor: null,       // window in days
  snapsLoading: false,
  aggByPn: null,              // Map<pn, aggregation>
  lastSnapshotAt: null,
  recordFor: null,            // pn currently in inline "record count" form
  recordSaving: false,
  // v-ir-recmath: "Seems off -- receipts math" state. Independent
  // from snaps so this headline renders even on day 1 of the ledger.
  receipts90d: null,          // Array<{pn, receiptDate, qty, poNum, vendor, receiptNbr}>
  receipts90dLoading: false,
  receiptsMathExpanded: new Set(),
};

function _irInvalidate() { IR_STATE.aggByPn = null; }

function _irWorkdaysBetweenIso(prevIso, curIso) {
  if (!prevIso || !curIso || prevIso >= curIso) return 0;
  const [py, pm, pd] = prevIso.split("-").map(Number);
  const [cy, cm, cd] = curIso.split("-").map(Number);
  const start = new Date(py, pm - 1, pd); start.setHours(0, 0, 0, 0);
  const end = new Date(cy, cm - 1, cd); end.setHours(0, 0, 0, 0);
  let n = 0;
  const cur = new Date(start.getTime() + 24 * 3600 * 1000);
  while (cur.getTime() <= end.getTime()) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

async function _irLoadSnapshots(days) {
  if (IR_STATE.snapsLoading) return;
  // v-ir-freezefix: DO NOT early-return here on missing _supa
  // without setting snapsLoadedFor -- _irRouteEnter's .then(refresh)
  // would then re-render, re-call _irRouteEnter, and spin
  // synchronously in the microtask queue (that's what pegged CPU
  // on the first deploy). The route entry function now gates on
  // _supa being present before calling us; this is a
  // belt-and-suspenders that STILL sets snapsLoadedFor.
  if (typeof _supa === "undefined" || !_supa) {
    IR_STATE.snaps = [];
    IR_STATE.snapsLoadedFor = days;
    return;
  }
  IR_STATE.snapsLoading = true;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today.getTime() - days * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  try {
    // Chunked fetch -- 2k+ parts x 90 days can push past a single page.
    const all = [];
    const PAGE = 1000;
    let from = 0;
    const MAX_PAGES = 200;   // guard: at most ~200k rows
    let pageCount = 0;
    while (true) {
      const { data, error } = await _supa
        .from("parts_onhand_snapshots")
        .select("snapshot_date, pn, on_hand, daily_use, receipts_qty, receipts_count, usage_est, workdays_since_prev, prev_snapshot_date, prev_on_hand, residual, adjustment_applied, last_counted_at")
        .gte("snapshot_date", start)
        .order("snapshot_date", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      all.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
      if (++pageCount >= MAX_PAGES) { console.error("[ir] snapshot fetch hit MAX_PAGES=" + MAX_PAGES + "; truncating"); break; }
    }
    IR_STATE.snaps = all;
    IR_STATE.snapsLoadedFor = days;
    IR_STATE.lastSnapshotAt = all.length ? all[all.length - 1].snapshot_date : null;
    _irInvalidate();
  } catch (err) {
    console.warn("[ir] snapshot fetch failed:", err && err.message);
    IR_STATE.snaps = [];
    IR_STATE.snapsLoadedFor = days;
  }
  IR_STATE.snapsLoading = false;
}

// v-ir-freezefix: hard cap on total iterations across the two
// inner loops. 2k parts * 90d + overhead = ~200k comfortably; a
// cap at 2M means we bail well before hurting the event loop even
// on pathological input. Bail with console.error so a future
// regression is loud but non-fatal.
const IR_AGG_MAX_ITERATIONS = 2_000_000;
function _irAggregate() {
  if (IR_STATE.aggByPn) return IR_STATE.aggByPn;
  const t0 = (typeof performance !== "undefined") ? performance.now() : Date.now();
  const agg = new Map();
  const snaps = IR_STATE.snaps || [];
  let iterations = 0;
  // Anchor per pn -- latest counted / reconciled log row is the
  // reset date. Snapshots BEFORE that date stay stored but don't
  // accumulate into the headline residual.
  const log = (DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log)) ? DB.cycleCounts.log : [];
  const anchorByPn = new Map();
  for (const r of log) {
    if (++iterations > IR_AGG_MAX_ITERATIONS) {
      console.error("[ir] aggregation hit iteration cap in anchor pass -- bailing (snaps=" + snaps.length + " log=" + log.length + ")");
      IR_STATE.aggByPn = agg;
      return agg;
    }
    if (r.outcome !== "counted" && r.outcome !== "reconciled") continue;
    const prev = anchorByPn.get(r.pn);
    if (!prev || String(r.counted_at) > String(prev.counted_at)) anchorByPn.set(r.pn, r);
  }
  for (const s of snaps) {
    if (++iterations > IR_AGG_MAX_ITERATIONS) {
      console.error("[ir] aggregation hit iteration cap in snap pass -- bailing (snaps=" + snaps.length + " partsSeen=" + agg.size + ")");
      IR_STATE.aggByPn = agg;
      return agg;
    }
    const anchor = anchorByPn.get(s.pn);
    const anchorDate = anchor ? String(anchor.counted_at).slice(0, 10) : null;
    let a = agg.get(s.pn);
    if (!a) {
      a = {
        pn: s.pn,
        residualSum: 0,
        residualHistory: [],       // {date, r, adjusted}
        firstAccumDate: null,
        lastSnapDate: s.snapshot_date,
        onHand: s.on_hand,
        dailyUse: s.daily_use,
        receiptsSum: 0,
        lastCountedAt: anchor ? anchor.counted_at : null,
        lastCounter: anchor ? anchor.counted_by : null,
        adjustmentsExcluded: 0,
        driftRun: 0,
        driftLastSign: 0,
      };
      agg.set(s.pn, a);
    }
    // Update always-current fields (latest snapshot wins).
    a.onHand = s.on_hand;
    a.dailyUse = s.daily_use;
    a.lastSnapDate = s.snapshot_date;
    // Accumulate only from AFTER the anchor date (count resets ledger).
    if (anchorDate && s.snapshot_date <= anchorDate) continue;
    if (s.residual == null) continue;
    if (s.adjustment_applied) {
      a.adjustmentsExcluded++;
      a.residualHistory.push({ date: s.snapshot_date, r: Number(s.residual) || 0, adjusted: true });
      continue;
    }
    a.receiptsSum += Number(s.receipts_qty) || 0;
    const r = Number(s.residual) || 0;
    a.residualSum += r;
    a.residualHistory.push({ date: s.snapshot_date, r, adjusted: false });
    if (!a.firstAccumDate) a.firstAccumDate = s.snapshot_date;
    // drift: same-sign streak
    const sign = r > 0.5 ? 1 : r < -0.5 ? -1 : 0;
    if (sign !== 0 && sign === a.driftLastSign) a.driftRun++;
    else if (sign !== 0) a.driftRun = 1;
    a.driftLastSign = sign;
  }
  // Derived fields.
  const partsCache = _ccPartsCache();
  for (const a of agg.values()) {
    const p = partsCache.get(a.pn) || {};
    const cost = Number(p.cost) || 0;
    a.desc = p.desc || "";
    a.cls = p.cls || "";
    a.residualUsd = a.residualSum * cost;
    a.residualUsdAbs = Math.abs(a.residualUsd);
    a.absResidual = Math.abs(a.residualSum);
    a.residualPct = a.onHand > 0 ? (a.absResidual / a.onHand) : (a.residualSum === 0 ? 0 : 1);
    a.beyondThreshold = a.absResidual > Math.max(5, a.onHand * 0.10);
    a.driftFlag = a.driftRun >= 5 || a.beyondThreshold;
    // Ledger age (days of accumulation, not calendar days).
    a.ledgerDays = a.residualHistory.filter(h => !h.adjusted).length;
    a.leakPerDay = a.ledgerDays > 0 ? (a.residualSum / a.ledgerDays) : 0;
    a.leakPerWeekUsd = a.leakPerDay * 5 * cost;    // workweek
    a.daysLeft = a.dailyUse > 0 ? Math.floor(a.onHand / a.dailyUse) : Infinity;
    a.lastCountAgeDays = a.lastCountedAt
      ? Math.floor((Date.now() - new Date(a.lastCountedAt).getTime()) / (24 * 3600 * 1000))
      : null;
  }
  IR_STATE.aggByPn = agg;
  const t1 = (typeof performance !== "undefined") ? performance.now() : Date.now();
  if (t1 - t0 > 500) console.warn("[ir] aggregation took " + Math.round(t1 - t0) + "ms (snaps=" + snaps.length + " parts=" + agg.size + ")");
  return agg;
}

function _irOnPoByPn(pn) {
  // Sum of open PO quantities from DB.pos for this pn.
  if (!(DB && Array.isArray(DB.pos))) return 0;
  let total = 0;
  for (const po of DB.pos) {
    if (!po || !Array.isArray(po.lines)) continue;
    for (const l of po.lines) {
      if (!l || l.pn !== pn) continue;
      const remaining = Math.max(0, (Number(l.qty) || 0) - (Number(l.receivedQty) || 0));
      total += remaining;
    }
  }
  return total;
}

async function _irLoadPoDetailsFor(pn) {
  if (IR_STATE.poCache.has(pn)) return IR_STATE.poCache.get(pn);
  if (typeof _supa === "undefined" || !_supa) { IR_STATE.poCache.set(pn, []); return []; }
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startIso = new Date(start.getTime() - IR_STATE.windowDays * 24 * 3600 * 1000)
    .toISOString().slice(0, 10);
  try {
    const { data, error } = await _supa
      .from("po_receipts")
      .select("id, data")
      .eq("data->>pn", pn)
      .gte("data->>receiptDate", startIso)
      .order("data->>receiptDate", { ascending: false })
      .limit(200);
    if (error) throw error;
    const rows = (data || [])
      .map(r => r && r.data)
      .filter(d => d && (!d.status || String(d.status).trim() === "Released"))
      .map(d => ({
        poNum: d.poNum || "",
        receiptDate: String(d.receiptDate || "").slice(0, 10),
        qty: Number(d.qty) || 0,
        vendor: d.vendor || "",
        receiptNbr: d.receiptNbr || "",
      }));
    IR_STATE.poCache.set(pn, rows);
    return rows;
  } catch (err) {
    console.warn("[ir] PO detail fetch failed for", pn, err && err.message);
    IR_STATE.poCache.set(pn, []);
    return [];
  }
}

// -------- TOP STRIP --------------------------------------------------
function _irRenderTopStrip() {
  const agg = _irAggregate();
  const rows = [...agg.values()];
  const totalUsd = rows.reduce((s, r) => s + r.residualUsdAbs, 0);
  const beyondCount = rows.filter(r => r.beyondThreshold).length;
  let worst = null;
  for (const r of rows) if (!worst || Math.abs(r.leakPerWeekUsd) > Math.abs(worst.leakPerWeekUsd)) worst = r;
  const ledgerCoverage = rows.length > 0
    ? Math.round(rows.reduce((s, r) => s + r.ledgerDays, 0) / rows.length)
    : 0;
  const snapAgo = IR_STATE.lastSnapshotAt || "no snapshot yet";
  const usdFmt = (n) => "$" + Math.round(Math.abs(n)).toLocaleString();
  return `
    <div class="ir-strip">
      <div class="ir-stat">
        <div class="ir-stat-label">Total |residual| $ (${IR_STATE.windowDays}d)</div>
        <div class="ir-stat-value">${usdFmt(totalUsd)}</div>
        <div class="ir-stat-sub">across ${rows.length} parts</div>
      </div>
      <div class="ir-stat">
        <div class="ir-stat-label">Beyond max(10%, 5u)</div>
        <div class="ir-stat-value ${beyondCount > 0 ? "text-warn" : ""}">${beyondCount}</div>
        <div class="ir-stat-sub">parts flagged</div>
      </div>
      <div class="ir-stat">
        <div class="ir-stat-label">Worst leaker</div>
        <div class="ir-stat-value mono" style="font-size:16px">${worst ? esc(worst.pn) : "&mdash;"}</div>
        <div class="ir-stat-sub">${worst ? (usdFmt(worst.leakPerWeekUsd) + "/wk") : ""}</div>
      </div>
      <div class="ir-stat">
        <div class="ir-stat-label">Ledger coverage</div>
        <div class="ir-stat-value">${ledgerCoverage}d</div>
        <div class="ir-stat-sub" title="Average accumulated ledger days per part. Residuals are most reliable at 7d+.">avg &middot; reliable at 7d+</div>
      </div>
      <div class="ir-stat">
        <div class="ir-stat-label">Last snapshot</div>
        <div class="ir-stat-value" style="font-size:16px">${esc(snapAgo)}</div>
        <div class="ir-stat-sub">nightly at 05:50 UTC</div>
      </div>
    </div>
  `;
}

// -------- RUNWAY -----------------------------------------------------
function _irRunwayRows() {
  const agg = _irAggregate();
  const out = [];
  for (const a of agg.values()) {
    if (a.daysLeft === Infinity) continue;
    if (a.daysLeft > 60) continue;
    out.push(a);
  }
  out.sort((x, y) => x.daysLeft - y.daysLeft);
  return out;
}
// v-ir-tame: runway is a secondary panel now. Threshold-scoped
// list, needs-count pill gated on BOTH 45d-uncounted AND days-left
// under the threshold, cap display at worst 25 with "show all N".
function _irRenderRunway() {
  const threshold = Number(IR_STATE.runwayThreshold) || 15;
  const agg = _irAggregate();
  const all = [];
  for (const a of agg.values()) {
    if (a.daysLeft === Infinity) continue;
    if (a.daysLeft > threshold) continue;
    all.push(a);
  }
  all.sort((x, y) => x.daysLeft - y.daysLeft);
  const CAP = 25;
  const overflowed = all.length > CAP;
  const rows = IR_STATE.runwayShowAll ? all : all.slice(0, CAP);
  const body = rows.map(a => {
    const daysColor = a.daysLeft <= 15 ? "text-crit" : a.daysLeft <= 30 ? "text-warn" : "";
    const onPo = _irOnPoByPn(a.pn);
    const lastAge = a.lastCountAgeDays;
    // v-ir-tame: pill needs BOTH conditions -- prior version pilled
    // everything unverified in 45d, which stacked amber across every
    // healthy part on a young ledger. Now the pill only fires when
    // the runway threshold ALSO triggers.
    const needsCount = (lastAge == null || lastAge > 45) && a.daysLeft <= threshold;
    return `
      <tr class="ir-row" data-pn="${esc(a.pn)}" onclick="_irOpenPart('${esc(a.pn)}')">
        <td class="mono">${esc(a.pn)}</td>
        <td class="dim">${esc(a.desc)}</td>
        <td class="right num">${Math.round(a.onHand)}</td>
        <td class="right num">${(a.dailyUse || 0).toFixed(2)}</td>
        <td class="right num bold ${daysColor}">${a.daysLeft}</td>
        <td class="right num dim">${Math.round(onPo)}</td>
        <td class="dim tiny">${lastAge == null ? "never" : (lastAge + "d ago")}</td>
        <td>${needsCount ? '<span class="pill warn">needs count</span>' : ""}</td>
        <td><button class="btn xs" onclick="event.stopPropagation();_irBeginRecord('${esc(a.pn)}')">Record count</button></td>
      </tr>`;
  }).join("");
  const pilledCount = all.filter(r => (r.lastCountAgeDays == null || r.lastCountAgeDays > 45)).length;
  const expanded = IR_STATE.runwayExpanded;
  const chev = expanded ? "&#9662;" : "&#9656;";
  const thresholdOpts = [15, 30, 60].map(d => `<option value="${d}"${threshold === d ? " selected" : ""}>${d}d</option>`).join("");
  return `
    <div class="ir-collapse-hd" onclick="_irToggleRunway()" role="button" tabindex="0"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();_irToggleRunway();}">
      <span class="ir-chev">${chev}</span>
      <span>Runs out &le;<strong>${threshold}d</strong> (shelf only, POs excluded): <strong>${all.length}</strong></span>
      <span class="dim tiny" style="margin-left:auto">tap to ${expanded ? "collapse" : "expand"}</span>
    </div>
    ${expanded ? `
      <div class="row gap-sm" style="margin:8px 0;align-items:center;flex-wrap:wrap" onclick="event.stopPropagation()">
        <label class="row gap-sm" style="align-items:center">
          <span class="muted tiny">Threshold</span>
          <select class="input" style="width:80px" onchange="_irSetRunwayThreshold(this.value)">${thresholdOpts}</select>
        </label>
        <span class="dim tiny">Days-left = shelf on-hand &divide; daily use. On-PO info only. "Needs count" fires only when unverified &gt; 45d AND days-left &le; threshold.</span>
        ${pilledCount > 0 ? `<button class="btn xs" onclick="_irAddRunwayPilledToVerify()">Add all pilled to Verify list</button>` : ""}
      </div>
      <div class="tbl-wrap"><table class="tbl ir-runway-table">
        <thead><tr>
          <th>PN</th><th>Description</th><th class="right">On hand</th><th class="right">Daily use</th>
          <th class="right">Days left</th><th class="right">On PO</th><th>Last count</th><th></th><th></th>
        </tr></thead>
        <tbody>${body || `<tr><td colspan="9" class="empty tiny muted">Nothing runs out in the next ${threshold} workdays.</td></tr>`}</tbody>
      </table></div>
      ${overflowed ? `
        <div class="dim tiny" style="margin-top:6px">
          Showing worst ${rows.length} of ${all.length}.
          <button class="btn xs ghost" onclick="_irToggleRunwayShowAll()">${IR_STATE.runwayShowAll ? "Show worst 25 only" : "Show all " + all.length}</button>
        </div>` : ""}
    ` : ""}
  `;
}
function _irToggleRunway() { IR_STATE.runwayExpanded = !IR_STATE.runwayExpanded; if (typeof refresh === "function") refresh(); }
function _irSetRunwayThreshold(v) {
  IR_STATE.runwayThreshold = Number(v) || 15;
  IR_STATE.runwayShowAll = false;
  if (typeof refresh === "function") refresh();
}
function _irToggleRunwayShowAll() { IR_STATE.runwayShowAll = !IR_STATE.runwayShowAll; if (typeof refresh === "function") refresh(); }

// -------- SEEMS OFF -- receipts math ---------------------------------
// v-ir-recmath: bounds check using only po_receipts + on-hand + a
// workday-aware usage estimate. Independent of the nightly ledger
// so this renders correctly on day 1 (which is why it's the
// headline until residual accumulation matures).
//
// implied_prior(window) = on_hand_now - receipts_in_window + usage_est_in_window
//   flag (a) if implied_prior < -max(5, 10% * receipts): received
//              more than usage + on-hand can explain
//   flag (b) if implied_prior > daily_use * 365: implies over a
//              year of stock at window start
async function _irLoadReceipts90d() {
  if (IR_STATE.receipts90dLoading) return;
  if (IR_STATE.receipts90d != null) return;
  if (typeof _supa === "undefined" || !_supa) {
    IR_STATE.receipts90d = [];
    return;
  }
  IR_STATE.receipts90dLoading = true;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const startIso = new Date(start.getTime() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  try {
    const all = [];
    const PAGE = 1000;
    let from = 0;
    const MAX_PAGES = 50;   // 50k rows guard
    let pageCount = 0;
    while (true) {
      const { data, error } = await _supa
        .from("po_receipts")
        .select("id, data")
        .gte("data->>receiptDate", startIso)
        .range(from, from + PAGE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const r of data) {
        const d = r && r.data;
        if (!d || !d.pn || !d.receiptDate) continue;
        if (d.status && String(d.status).trim() !== "Released") continue;
        all.push({
          pn: String(d.pn),
          receiptDate: String(d.receiptDate).slice(0, 10),
          qty: Number(d.qty) || 0,
          poNum: d.poNum || "",
          vendor: d.vendor || "",
          receiptNbr: d.receiptNbr || "",
        });
      }
      if (data.length < PAGE) break;
      from += PAGE;
      if (++pageCount >= MAX_PAGES) { console.error("[ir] receipts90d fetch hit MAX_PAGES=" + MAX_PAGES + "; truncating"); break; }
    }
    IR_STATE.receipts90d = all;
  } catch (err) {
    console.warn("[ir] receipts90d fetch failed:", err && err.message);
    IR_STATE.receipts90d = [];
  }
  IR_STATE.receipts90dLoading = false;
}
function _irPhysicalOnHand(pn, part) {
  if (DB && DB.partLocations instanceof Map) {
    const locs = DB.partLocations.get(pn) || [];
    let sumNonSentinel = 0;
    let sentinel = null;
    let sawNonSentinel = false;
    for (const l of locs) {
      const q = Number(l.qty) || 0;
      if (String(l.location) === "__warehouse__") sentinel = q;
      else { sumNonSentinel += q; sawNonSentinel = true; }
    }
    if (sawNonSentinel) return sumNonSentinel;
    if (sentinel !== null) return sentinel;
  }
  return Number(part && part.onHand) || 0;
}
function _irDailyUse(part) {
  if (!part) return 0;
  if (typeof chainDisplayDaily === "function") {
    try {
      const c = chainDisplayDaily(part);
      if (c && Number.isFinite(Number(c.daily))) return Number(c.daily);
    } catch (_) {}
  }
  return Number(part.daily) || 0;
}
function _irReceiptsMathRows() {
  if (!Array.isArray(IR_STATE.receipts90d)) return [];
  if (!(DB && Array.isArray(DB.parts))) return [];
  const WINDOWS = [30, 60, 90];
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const todayIso = now.toISOString().slice(0, 10);
  const windowStartIso = WINDOWS.map(d => new Date(now.getTime() - d * 24 * 3600 * 1000).toISOString().slice(0, 10));
  const workdays = WINDOWS.map((_, i) => _irWorkdaysBetweenIso(windowStartIso[i], todayIso));
  // Group receipts by pn.
  const byPn = new Map();
  for (const r of IR_STATE.receipts90d) {
    let arr = byPn.get(r.pn);
    if (!arr) { arr = []; byPn.set(r.pn, arr); }
    arr.push(r);
  }
  const out = [];
  for (const p of DB.parts) {
    if (!p || !p.pn) continue;
    if (String(p.itemType || "").toLowerCase().trim() !== "base_bom") continue;
    const receipts = byPn.get(p.pn) || [];
    if (receipts.length === 0) continue;
    const onHand = _irPhysicalOnHand(p.pn, p);
    const daily = _irDailyUse(p);
    const cost = Number(p.cost) || 0;
    let trigger = null;
    for (let i = 0; i < WINDOWS.length; i++) {
      const receiptsInWindow = receipts.filter(r => r.receiptDate >= windowStartIso[i] && r.receiptDate <= todayIso);
      const rQty = receiptsInWindow.reduce((s, r) => s + r.qty, 0);
      if (rQty <= 0) continue;
      const usageEst = daily * workdays[i];
      const impliedPrior = onHand - rQty + usageEst;
      const lowThreshold = -Math.max(5, rQty * 0.10);
      const highThreshold = daily * 365;
      let flag = null;
      if (impliedPrior < lowThreshold) {
        const units = -impliedPrior;
        flag = { kind: "unaccounted", units, usd: units * cost };
      } else if (daily > 0 && impliedPrior > highThreshold) {
        const units = impliedPrior - highThreshold;
        flag = { kind: "excess", units, usd: units * cost };
      }
      if (flag) {
        trigger = {
          window: WINDOWS[i],
          receipts: receiptsInWindow,
          receiptsQty: rQty,
          usageEst,
          impliedPrior,
          flag,
        };
        break;   // first triggering window wins (shortest -> most immediate signal)
      }
    }
    if (!trigger) continue;
    out.push({
      pn: p.pn, desc: p.desc || "", cls: p.partClass || "",
      cost, onHand, daily,
      window: trigger.window,
      receipts: trigger.receipts,
      receiptsQty: trigger.receiptsQty,
      usageEst: trigger.usageEst,
      impliedPrior: trigger.impliedPrior,
      kind: trigger.flag.kind,
      units: trigger.flag.units,
      usd: trigger.flag.usd,
      absUsd: Math.abs(trigger.flag.usd),
    });
  }
  out.sort((a, b) => b.absUsd - a.absUsd);
  return out;
}
function _irRenderReceiptsMath() {
  const hdr = `<div class="dr-section" style="margin-top:12px">
      Seems off &mdash; receipts math
      <span class="dim tiny" style="margin-left:8px" title="One-sided bounds math: implied_prior = on_hand_now - receipts_in_window + usage_est_in_window (chain-aware daily x workdays). Flags cases where the paper trail can't explain what arrived. The nightly ledger supersedes this signal as residual coverage grows.">(bounds math &middot; headline until the ledger matures)</span>
    </div>`;
  if (IR_STATE.receipts90dLoading || IR_STATE.receipts90d == null) {
    return hdr + `<div class="empty tiny muted">Scanning last 90d of po_receipts...</div>`;
  }
  const rows = _irReceiptsMathRows();
  if (rows.length === 0) {
    return hdr + `<div class="empty tiny muted">No parts flagged in the 30/60/90d windows. Received quantities are explainable by usage + current on-hand within the honest bounds.</div>`;
  }
  const body = rows.map(r => {
    const expanded = IR_STATE.receiptsMathExpanded.has(r.pn);
    const usdColor = r.absUsd >= 5000 ? "text-crit" : r.absUsd >= 500 ? "text-warn" : "";
    const kindPill = r.kind === "unaccounted"
      ? `<span class="pill warn" title="Received more than usage + on-hand can explain">unaccounted</span>`
      : `<span class="pill" title="Implies over a year of stock at window start -- receipts, usage rate, or on-hand likely wrong">year+ implied</span>`;
    const signal = r.kind === "unaccounted"
      ? `received more than usage + on-hand can explain &mdash; ~${Math.round(r.units)} units ($${Math.round(r.absUsd).toLocaleString()}) unaccounted`
      : `implies over a year of stock at window start &mdash; receipts, usage rate, or on-hand likely wrong`;
    const detail = expanded ? `
      <tr class="ir-detail-row"><td colspan="9" onclick="event.stopPropagation()">
        <table class="tbl" style="margin:8px 0"><thead><tr>
          <th>PO</th><th>Receipt</th><th>Date</th><th class="right">Qty</th><th>Vendor</th>
        </tr></thead><tbody>${
          r.receipts.slice().sort((a, b) => b.receiptDate.localeCompare(a.receiptDate)).map(x => `
            <tr>
              <td class="mono">${esc(x.poNum)}</td>
              <td class="dim tiny">${esc(x.receiptNbr)}</td>
              <td>${esc(x.receiptDate)}</td>
              <td class="right num">${Math.round(x.qty)}</td>
              <td class="dim">${esc(x.vendor)}</td>
            </tr>`).join("")}
        </tbody></table>
      </td></tr>` : "";
    return `
      <tr class="ir-row" data-pn="${esc(r.pn)}" onclick="_irToggleReceiptsMath('${esc(r.pn)}')">
        <td>
          <div class="mono">${esc(r.pn)} ${kindPill}</div>
          <div class="dim tiny">${esc(r.desc)}${r.cls ? " &middot; " + esc(r.cls) : ""}</div>
        </td>
        <td class="right num">${r.window}d</td>
        <td class="right num">${Math.round(r.onHand)}</td>
        <td class="right num">${Math.round(r.receiptsQty)} <span class="dim tiny">${expanded ? "&#9662;" : "&#9656;"}</span></td>
        <td class="right num dim">${Math.round(r.usageEst)}</td>
        <td class="right num">${r.impliedPrior >= 0 ? "+" : ""}${Math.round(r.impliedPrior)}</td>
        <td class="right num ${usdColor}">${r.units >= 0 ? "" : "-"}${Math.round(Math.abs(r.units))} <span class="dim tiny">$${Math.round(r.absUsd).toLocaleString()}</span></td>
        <td class="dim tiny">${signal}</td>
        <td onclick="event.stopPropagation()"><button class="btn xs" onclick="_irBeginRecord('${esc(r.pn)}')">Record count</button></td>
      </tr>
      ${detail}`;
  }).join("");
  return hdr + `
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr>
        <th>PN / Desc</th><th class="right">Window</th><th class="right">On hand</th>
        <th class="right">Receipts</th><th class="right">Est. usage</th>
        <th class="right">Implied prior</th><th class="right">Unaccounted (units &middot; $)</th>
        <th>Signal</th><th></th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  `;
}
function _irToggleReceiptsMath(pn) {
  if (IR_STATE.receiptsMathExpanded.has(pn)) IR_STATE.receiptsMathExpanded.delete(pn);
  else IR_STATE.receiptsMathExpanded.add(pn);
  if (typeof refresh === "function") refresh();
}
if (typeof window !== "undefined") {
  Object.assign(window, {
    _irSetRunwayThreshold, _irToggleRunwayShowAll,
    _irToggleReceiptsMath,
  });
}

// -------- MAIN TABLE -------------------------------------------------
function _irSparkline(history) {
  if (!history || history.length === 0) return "";
  const values = history.filter(h => !h.adjusted).map(h => h.r);
  if (values.length === 0) return "";
  const w = 60, h = 18;
  const max = Math.max(1, ...values.map(v => Math.abs(v)));
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const pts = values.map((v, i) => {
    const x = i * step;
    const y = h / 2 - (v / max) * (h / 2 - 1);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" style="vertical-align:middle">
    <line x1="0" y1="${h / 2}" x2="${w}" y2="${h / 2}" stroke="currentColor" stroke-width="0.5" opacity="0.25"/>
    <polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.8"/>
  </svg>`;
}
function _irMainTableRows() {
  const agg = _irAggregate();
  const q = String(IR_STATE.search || "").toLowerCase().trim();
  const cls = IR_STATE.classFilter;
  let rows = [...agg.values()].filter(r => {
    if (cls && r.cls !== cls) return false;
    if (q) {
      const hay = (r.pn + " " + (r.desc || "")).toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
  const dir = IR_STATE.sortDir === "asc" ? 1 : -1;
  const key = IR_STATE.sortKey;
  rows.sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "string") return dir * av.localeCompare(bv);
    return dir * (av - bv);
  });
  return rows;
}
function _irRenderMainTable() {
  const rows = _irMainTableRows();
  const partsCache = _ccPartsCache();
  const classes = new Set();
  for (const p of partsCache.values()) if (p.cls) classes.add(p.cls);
  const classOpts = [...classes].sort().map(c => `<option value="${esc(c)}"${IR_STATE.classFilter === c ? " selected" : ""}>${esc(c)}</option>`).join("");
  const body = rows.map(a => {
    const expanded = IR_STATE.expanded.has(a.pn);
    const usd = a.residualUsd;
    const usdColor = Math.abs(usd) >= 500 ? "text-crit" : Math.abs(usd) >= 100 ? "text-warn" : "dim";
    const confidence = a.ledgerDays < IR_STATE.windowDays
      ? `<span class="pill" style="font-size:9px" title="This part's ledger is younger than the window; residual reads are still stabilizing.">ledger ${a.ledgerDays}d</span>`
      : "";
    const driftBadge = a.driftFlag
      ? `<span class="pill warn" style="font-size:9px" title="Systematic drift -- ${a.driftRun} consecutive same-direction residuals or accumulation beyond max(10%, 5u). Check BOM/backflush.">drift</span>`
      : "";
    const lastCount = a.lastCountedAt
      ? `<span class="dim tiny">${esc(a.lastCountedAt.slice(0, 10))}${a.lastCounter ? " &middot; " + esc(a.lastCounter) : ""}</span>`
      : `<span class="dim tiny">never</span>`;
    const mainRow = `
      <tr class="ir-row" data-pn="${esc(a.pn)}" onclick="_irToggleReceipts('${esc(a.pn)}')">
        <td>
          <div class="mono">${esc(a.pn)} ${confidence} ${driftBadge}</div>
          <div class="dim tiny">${esc(a.desc)}${a.cls ? " &middot; " + esc(a.cls) : ""}</div>
        </td>
        <td class="right num">${Math.round(a.onHand)}</td>
        <td class="right num">${(a.dailyUse || 0).toFixed(2)}</td>
        <td class="right num">${Math.round(a.receiptsSum)} <span class="dim tiny">${expanded ? "&#9662;" : "&#9656;"}</span></td>
        <td class="right num">${a.residualSum > 0 ? "+" : ""}${a.residualSum.toFixed(1)} <span class="dim tiny">${(a.residualPct * 100).toFixed(1)}%</span></td>
        <td class="right num ${usdColor}">${usd >= 0 ? "+" : "-"}$${Math.round(Math.abs(usd)).toLocaleString()}</td>
        <td>${_irSparkline(a.residualHistory)}</td>
        <td>${lastCount}</td>
        <td onclick="event.stopPropagation()">
          <button class="btn xs" onclick="_irBeginRecord('${esc(a.pn)}')">Record count</button>
          <button class="btn xs ghost" onclick="_irOpenPart('${esc(a.pn)}')">Open</button>
        </td>
      </tr>`;
    const recordRow = IR_STATE.recordFor === a.pn
      ? `<tr class="ir-record-row"><td colspan="9" onclick="event.stopPropagation()">${_irRenderRecordForm(a)}</td></tr>`
      : "";
    const detailRow = expanded
      ? `<tr class="ir-detail-row"><td colspan="9" onclick="event.stopPropagation()"><div id="ir-po-${esc(a.pn)}" class="ir-po-detail">Loading receipts...</div></td></tr>`
      : "";
    return mainRow + recordRow + detailRow;
  }).join("");
  const winOpts = [7, 30, 60, 90].map(d => `<option value="${d}"${IR_STATE.windowDays === d ? " selected" : ""}>${d}d</option>`).join("");
  return `
    <div class="ir-toolbar">
      <label class="row gap-sm" style="align-items:center">
        <span class="muted tiny">Window</span>
        <select class="input" style="width:80px" onchange="_irSetWindow(this.value)">${winOpts}</select>
      </label>
      <input class="input" placeholder="Search pn or description..." value="${esc(IR_STATE.search)}" oninput="_irSetSearch(this.value)" style="max-width:280px">
      <label class="row gap-sm" style="align-items:center">
        <span class="muted tiny">Class</span>
        <select class="input" style="width:140px" onchange="_irSetClassFilter(this.value)"><option value="">(all)</option>${classOpts}</select>
      </label>
      <span class="grow"></span>
      <span class="dim tiny">${rows.length} parts &middot; sorted by ${esc(IR_STATE.sortKey)} ${IR_STATE.sortDir}</span>
    </div>
    <div class="tbl-wrap"><table class="tbl ir-main-table">
      <thead><tr>
        <th onclick="_irSort('pn')">PN / Desc</th>
        <th class="right" onclick="_irSort('onHand')">On hand</th>
        <th class="right" onclick="_irSort('dailyUse')">Daily use</th>
        <th class="right" onclick="_irSort('receiptsSum')">Receipts (${IR_STATE.windowDays}d)</th>
        <th class="right" onclick="_irSort('residualSum')">Residual</th>
        <th class="right" onclick="_irSort('residualUsdAbs')">Residual $</th>
        <th>Trend</th>
        <th onclick="_irSort('lastCountedAt')">Last count</th>
        <th></th>
      </tr></thead>
      <tbody>${body || `<tr><td colspan="9" class="empty tiny muted">No snapshots yet -- the nightly job hasn't run, or nothing matches your filter.</td></tr>`}</tbody>
    </table></div>
  `;
}

function _irToggleReceipts(pn) {
  if (IR_STATE.expanded.has(pn)) { IR_STATE.expanded.delete(pn); if (typeof refresh === "function") refresh(); return; }
  IR_STATE.expanded.add(pn);
  if (typeof refresh === "function") refresh();
  // Lazy-fetch after DOM update.
  setTimeout(() => {
    _irLoadPoDetailsFor(pn).then(rows => {
      const el = document.getElementById("ir-po-" + pn);
      if (!el) return;
      if (rows.length === 0) { el.innerHTML = `<div class="empty tiny muted">No released receipts in this window.</div>`; return; }
      const tbody = rows.map(r => `
        <tr>
          <td class="mono">${esc(r.poNum)}</td>
          <td class="dim tiny">${esc(r.receiptNbr)}</td>
          <td>${esc(r.receiptDate)}</td>
          <td class="right num">${Math.round(r.qty)}</td>
          <td class="dim">${esc(r.vendor)}</td>
        </tr>`).join("");
      el.innerHTML = `
        <table class="tbl" style="margin:8px 0"><thead><tr>
          <th>PO</th><th>Receipt</th><th>Date</th><th class="right">Qty</th><th>Vendor</th>
        </tr></thead><tbody>${tbody}</tbody></table>`;
    });
  }, 30);
}

// -------- RECORD COUNT (inline) --------------------------------------
function _irRenderRecordForm(agg) {
  const name = _ccName();
  const locs = (DB && DB.partLocations instanceof Map) ? (DB.partLocations.get(agg.pn) || []) : [];
  // Filter out sentinel; if any bin rows remain, use per-bin inputs.
  const binRows = locs.filter(l => String(l.location) !== "__warehouse__");
  const multi = binRows.length > 0;
  const nameWarn = !name ? `<div class="banner warn tiny" style="margin-bottom:6px">Enter your name in the header first -- it's stamped on the count.</div>` : "";
  const inputs = multi
    ? `<div class="ir-bin-grid">${binRows.map((l, i) => `
        <label class="ir-bin">
          <span class="mono">${esc(l.location)}</span>
          <span class="dim tiny">sys ${Math.round(Number(l.qty) || 0)}</span>
          <input class="input" type="number" min="0" step="1" data-bin="${esc(l.location)}" id="ir-bin-${i}" placeholder="0" style="width:80px" oninput="_irBinSumUpdate('${esc(agg.pn)}')">
        </label>`).join("")}
      </div>
      <div class="dim tiny" style="margin-top:6px">Sum so far: <span id="ir-bin-sum-${esc(agg.pn)}">0</span></div>`
    : `<label class="row gap-sm" style="align-items:center">
        <span class="muted tiny">Counted qty</span>
        <input class="input" type="number" min="0" step="1" id="ir-adhoc-qty" placeholder="0" style="width:120px">
        <span class="dim tiny">system says <strong>${Math.round(agg.onHand)}</strong></span>
      </label>`;
  const disabled = !name || IR_STATE.recordSaving;
  return `
    <div class="ir-record-form">
      <div class="row gap-md" style="align-items:baseline"><strong>Record count for <span class="mono">${esc(agg.pn)}</span></strong>
        <span class="dim tiny">${esc(agg.desc)}</span></div>
      ${nameWarn}
      ${inputs}
      <div class="row gap-sm" style="margin-top:8px">
        <button class="btn primary" ${disabled ? "disabled" : ""} onclick="_irSubmitRecord('${esc(agg.pn)}', ${multi ? "true" : "false"})">${IR_STATE.recordSaving ? "Saving..." : "Submit count"}</button>
        <button class="btn ghost" onclick="_irCancelRecord()">Cancel</button>
      </div>
    </div>
  `;
}
function _irBeginRecord(pn) { IR_STATE.recordFor = pn; IR_STATE.recordSaving = false; if (typeof refresh === "function") refresh(); }
function _irCancelRecord() { IR_STATE.recordFor = null; IR_STATE.recordSaving = false; if (typeof refresh === "function") refresh(); }
function _irBinSumUpdate(pn) {
  const inputs = document.querySelectorAll("[id^='ir-bin-']");
  let sum = 0;
  inputs.forEach(i => sum += Math.max(0, Math.round(Number(i.value) || 0)));
  const s = document.getElementById("ir-bin-sum-" + pn);
  if (s) s.textContent = String(sum);
}
async function _irSubmitRecord(pn, multi) {
  const name = _ccName();
  if (!name) return;
  const agg = _irAggregate().get(pn);
  if (!agg) return;
  let counted, locations;
  if (multi) {
    const inputs = document.querySelectorAll("[id^='ir-bin-']");
    counted = 0;
    locations = [];
    inputs.forEach(i => {
      const q = Math.max(0, Math.round(Number(i.value) || 0));
      counted += q;
      locations.push({ location: i.getAttribute("data-bin"), counted_qty: q });
    });
  } else {
    const el = document.getElementById("ir-adhoc-qty");
    counted = Math.max(0, Math.round(Number(el && el.value) || 0));
  }
  IR_STATE.recordSaving = true;
  if (typeof refresh === "function") refresh();
  try {
    const body = {
      writes: [{
        op: "recordAdhocCount",
        pn,
        counted_qty: counted,
        counted_by: name,
        systemQtyNow: Math.round(agg.onHand),
        client_key: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : "ir-" + Date.now(),
        source: "IR workbench",
        locations,
      }],
    };
    const resp = await fetch("/.netlify/functions/cycle-count-write", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fs-edit-token": (typeof FS_EDIT_TOKEN_CLIENT !== "undefined") ? FS_EDIT_TOKEN_CLIENT : "",
        "x-app-build": String((typeof APP_BUILD !== "undefined") ? APP_BUILD : 0),
      },
      body: JSON.stringify(body),
    });
    const json = await resp.json();
    if (!resp.ok || !json.ok) { alert("Record count failed: " + (json && json.error || resp.status)); }
    else if (json.results && json.results[0] && json.results[0].ok === false) {
      alert("Record count rejected: " + (json.results[0].error || "unknown"));
    } else {
      IR_STATE.recordFor = null;
      // Refresh log so the accumulator picks up the new anchor.
      if (typeof _refetchCycleCounts === "function") await _refetchCycleCounts();
      _irInvalidate();
    }
  } catch (err) {
    alert("Record count failed: " + (err && err.message));
  }
  IR_STATE.recordSaving = false;
  if (typeof refresh === "function") refresh();
}
function _irOpenPart(pn) { if (typeof openPartDetail === "function") openPartDetail(pn); }

// -------- VERIFY LIST ------------------------------------------------
function _irVerifyList() {
  const agg = _irAggregate();
  const top20 = [...agg.values()]
    .filter(a => a.ledgerDays >= 7)
    .sort((a, b) => b.residualUsdAbs - a.residualUsdAbs)
    .slice(0, 20);
  const runway = _irRunwayRows().filter(r => r.lastCountAgeDays == null || r.lastCountAgeDays > 45);
  const stale = [...agg.values()].filter(a => a.lastCountAgeDays == null || a.lastCountAgeDays > 90);
  const seen = new Set();
  const combined = [];
  for (const list of [top20, runway, stale]) {
    for (const a of list) {
      if (seen.has(a.pn)) continue;
      seen.add(a.pn);
      combined.push(a);
    }
  }
  return combined;
}
function _irRenderVerifyList() {
  const list = _irVerifyList();
  // Blind checklist -- deliberately no system qty and no residual.
  const body = list.map(a => {
    const locs = (DB && DB.partLocations instanceof Map)
      ? (DB.partLocations.get(a.pn) || []).filter(l => String(l.location) !== "__warehouse__")
      : [];
    const binText = locs.length ? locs.map(l => esc(l.location)).join(", ") : "(no bin on file)";
    return `
      <tr>
        <td class="mono">${esc(a.pn)}</td>
        <td>${esc(a.desc)}</td>
        <td class="dim tiny">${binText}</td>
        <td class="ir-blank"></td>
      </tr>`;
  }).join("");
  return `
    <div class="row gap-sm" style="margin:8px 0" id="ir-verify-toolbar">
      <button class="btn primary" onclick="window.print()">Print</button>
      <button class="btn ghost" onclick="_irSetView('main')">Back to workbench</button>
      <span class="dim tiny">${list.length} parts &middot; blind checklist (no system qty on purpose)</span>
    </div>
    <div id="ir-verify-print">
      <h2 style="margin-bottom:4px">Cycle Count Verify List</h2>
      <div class="dim tiny">Generated ${new Date().toLocaleString()}</div>
      <table class="tbl ir-print-table" style="margin-top:12px">
        <thead><tr><th style="width:20%">PN</th><th style="width:45%">Description</th><th style="width:20%">Bin(s)</th><th style="width:15%">Counted</th></tr></thead>
        <tbody>${body || `<tr><td colspan="4" class="empty tiny muted">Nothing to verify.</td></tr>`}</tbody>
      </table>
    </div>
  `;
}
function _irAddRunwayPilledToVerify() { _irSetView("verify"); }

// -------- CONTROLS ---------------------------------------------------
function _irSetWindow(v) { IR_STATE.windowDays = Number(v) || 30; IR_STATE.snapsLoadedFor = null; IR_STATE.poCache = new Map(); _irInvalidate(); _irRouteEnter(); }
function _irSetSearch(v) { IR_STATE.search = String(v || ""); if (typeof refresh === "function") refresh(); }
function _irSetClassFilter(v) { IR_STATE.classFilter = String(v || ""); if (typeof refresh === "function") refresh(); }
function _irSetView(v) { IR_STATE.view = v; if (typeof refresh === "function") refresh(); }
function _irSort(key) {
  if (IR_STATE.sortKey === key) IR_STATE.sortDir = IR_STATE.sortDir === "asc" ? "desc" : "asc";
  else { IR_STATE.sortKey = key; IR_STATE.sortDir = (key === "pn" || key === "lastCountedAt") ? "asc" : "desc"; }
  if (typeof refresh === "function") refresh();
}
if (typeof window !== "undefined") {
  Object.assign(window, {
    _irSetWindow, _irSetSearch, _irSetClassFilter, _irSetView, _irSort,
    _irToggleRunway, _irBeginRecord, _irCancelRecord, _irBinSumUpdate,
    _irSubmitRecord, _irOpenPart, _irToggleReceipts, _irAddRunwayPilledToVerify,
  });
}

// Route entry -- kicks off the snapshot fetch and re-renders when done.
//
// v-ir-freezefix: the initial render can fire BEFORE cloudInit
// hydrates _supa (cloudInit runs 200ms after DOMContentLoaded via
// setTimeout; navigate() fires ON DOMContentLoaded). If we called
// _irLoadSnapshots immediately with no client, it would resolve
// its promise in the same microtask flush, .then(refresh) would
// re-render, _irRouteEnter would re-call load, promise resolves
// again -- a synchronous microtask loop that pegs CPU 100% (which
// is exactly what d949eed shipped).
//
// Fix: gate on _supa being ready. If it's not, schedule a delayed
// retry via setTimeout so the browser can process macrotasks
// (including cloudInit finishing). Retry is capped so a broken
// SDK load doesn't leave the tab retrying forever.
function _irRouteEnter() {
  // v-ir-recmath: snapshot load AND receipts-90d load are independent
  // async paths; both trigger refresh when they land. The freezefix
  // guards (snapsLoadedFor set on all exit paths; receipts90d != null
  // check) prevent either from re-firing after it settles.
  const snapsDone = IR_STATE.snapsLoadedFor === IR_STATE.windowDays;
  const receiptsDone = IR_STATE.receipts90d != null;
  if (snapsDone && receiptsDone) return;
  if (IR_STATE.snapsLoading && IR_STATE.receipts90dLoading) return;
  if (typeof _supa === "undefined" || !_supa) {
    IR_STATE._supaWaitAttempts = (IR_STATE._supaWaitAttempts || 0) + 1;
    if (IR_STATE._supaWaitAttempts > 40) {
      // 40 * 250ms = 10s. Give up so the skeleton stops spinning.
      console.error("[ir] gave up waiting for Supabase client after 10s -- workbench will show empty state");
      IR_STATE.snaps = [];
      IR_STATE.snapsLoadedFor = IR_STATE.windowDays;
      IR_STATE.receipts90d = [];
      if (typeof CURRENT_ROUTE !== "undefined" && CURRENT_ROUTE === "cycle-counts" && typeof refresh === "function") refresh();
      return;
    }
    setTimeout(() => {
      if (typeof CURRENT_ROUTE !== "undefined" && CURRENT_ROUTE === "cycle-counts") _irRouteEnter();
    }, 250);
    return;
  }
  IR_STATE._supaWaitAttempts = 0;
  if (!snapsDone && !IR_STATE.snapsLoading) {
    _irLoadSnapshots(IR_STATE.windowDays).then(() => {
      if (typeof CURRENT_ROUTE !== "undefined" && CURRENT_ROUTE === "cycle-counts" && typeof refresh === "function") refresh();
    });
  }
  if (!receiptsDone && !IR_STATE.receipts90dLoading) {
    _irLoadReceipts90d().then(() => {
      if (typeof CURRENT_ROUTE !== "undefined" && CURRENT_ROUTE === "cycle-counts" && typeof refresh === "function") refresh();
    });
  }
}

// -------- MAIN RENDER ------------------------------------------------
function renderCycleCounts() {
  const main = document.getElementById("main");
  if (!main) return;
  try { console.time("ir-render"); } catch (_) {}
  _ccInitLocalState();
  _ccEnsureLiveWiring();
  _irRouteEnter();
  const name = _ccName();
  const liveState = (typeof ccLiveState === "function") ? ccLiveState() : "connecting";
  const skeletonSnaps = !IR_STATE.snaps || IR_STATE.snapsLoading;
  const workbench = skeletonSnaps
    ? `<div class="ir-strip"><div class="ir-stat"><div class="ir-stat-label">Loading ledger...</div></div></div>
       <div class="empty tiny muted" style="margin-top:12px">Fetching parts_onhand_snapshots for the last ${IR_STATE.windowDays} days...</div>`
    : (IR_STATE.view === "verify"
        ? _irRenderVerifyList()
        : `${_irRenderReceiptsMath()}
           ${_irRenderTopStrip()}
           <div style="margin-top:16px">${_irRenderRunway()}</div>
           <div class="dr-section" style="margin-top:20px">Reconciliation ledger (${IR_STATE.windowDays}d)</div>
           ${_irRenderMainTable()}
           <div class="row gap-sm" style="margin-top:8px">
             <button class="btn" onclick="_irSetView('verify')">Open Verify List</button>
           </div>`);
  const feedBlock = (DB && DB.cycleCounts && DB.cycleCounts.loaded)
    ? `<div class="dr-section" style="margin-top:24px">Counts as they come in</div>
       ${_ccRenderLiveFeed()}
       <div class="dr-section" style="margin-top:20px">Accuracy</div>
       <div id="cc-summary-strip">${_ccRenderTightSummary(_ccSummary())}</div>`
    : `<div class="dim tiny" style="margin-top:24px">Live feed loading...</div>`;
  const html = `
    <style>
      @keyframes cc-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
      @keyframes cc-flash-in {
        0%   { background: color-mix(in srgb, var(--ok,#3a7) 25%, transparent); }
        100% { background: transparent; }
      }
      .cc-new-flash td { animation: cc-flash-in 3.5s ease-out forwards; }
      .cc-feed-table tr td { vertical-align: top; }
      .cc-feed-table tr.cc-breakdown-row td { padding: 0 !important; }
      /* IR workbench styles */
      .ir-strip { display: flex; gap: 12px; flex-wrap: wrap; }
      .ir-stat {
        flex: 1 1 180px;
        min-width: 180px;
        padding: 10px 12px;
        border: 1px solid var(--line, #cbd5e1);
        border-radius: 6px;
        background: var(--bg-2, transparent);
      }
      .ir-stat-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dim,#64748b); }
      .ir-stat-value { font-size: 22px; font-weight: 700; margin: 2px 0; }
      .ir-stat-sub { font-size: 11px; color: var(--dim,#64748b); }
      .ir-collapse-hd {
        display: flex; align-items: center; gap: 8px;
        padding: 8px 10px; border: 1px solid var(--line,#cbd5e1);
        border-radius: 6px; cursor: pointer; user-select: none;
        transition: background-color 120ms ease;
      }
      .ir-collapse-hd:hover { background: color-mix(in srgb, var(--ink,#0f172a) 5%, transparent); }
      .ir-chev { display: inline-block; width: 14px; text-align: center; }
      .ir-toolbar { display: flex; gap: 12px; align-items: center; margin: 12px 0; flex-wrap: wrap; }
      .ir-toolbar .grow { flex: 1; }
      .ir-main-table th { cursor: pointer; user-select: none; }
      .ir-main-table th:hover { background: color-mix(in srgb, var(--ink,#0f172a) 5%, transparent); }
      .ir-row { cursor: pointer; }
      .ir-row:hover td { background: color-mix(in srgb, var(--ink,#0f172a) 3%, transparent); }
      .ir-detail-row td, .ir-record-row td { background: color-mix(in srgb, var(--ink,#0f172a) 4%, transparent); }
      .ir-po-detail table { width: 100%; }
      .ir-record-form { padding: 10px 4px; }
      .ir-bin-grid { display: flex; flex-wrap: wrap; gap: 10px; }
      .ir-bin { display: flex; flex-direction: column; gap: 2px; align-items: flex-start; }
      /* Print styles for the Verify List */
      @media print {
        body * { visibility: hidden; }
        #ir-verify-print, #ir-verify-print * { visibility: visible; }
        #ir-verify-print { position: absolute; left: 0; top: 0; width: 100%; padding: 12px; }
        #ir-verify-toolbar { display: none; }
        .ir-print-table td, .ir-print-table th {
          border: 1px solid #999; padding: 4px 6px; font-size: 11px;
        }
        .ir-blank { border-bottom: 1px solid #333; min-width: 80px; }
        thead { display: table-header-group; }
        tr, td, th { page-break-inside: avoid; }
      }
    </style>
    <div class="page" data-page="cycle-counts">
      <div class="page-hd">
        <div>
          <h1>Inventory Reconciliation ${_ccPulseDot(liveState)}</h1>
          <p class="muted">Nightly ledger comparing how on-hand moved vs how it should have moved. Residual is the record-keeping gap we can't account for -- that's what to count and why.</p>
        </div>
        <div class="row gap-sm">
          <label class="row gap-sm" style="align-items:center;cursor:pointer">
            <span class="muted tiny">Chime on new count</span>
            <input type="checkbox" class="chk" ${CC_STATE._chimeOn ? "checked" : ""} onchange="_ccToggleChime()">
          </label>
          <label class="row gap-sm" style="align-items:center">
            <span class="muted tiny">Your name</span>
            <input class="input" id="cc-name-input" value="${esc(name)}" placeholder="e.g. Marisol" style="width:180px" onchange="_ccOnNameInput(this.value)">
          </label>
        </div>
      </div>
      ${!name ? `<div class="banner warn" style="margin-bottom:8px">Enter your name above before recording counts -- it's stamped on every count row.</div>` : ""}
      ${workbench}
      ${feedBlock}
    </div>
  `;
  main.innerHTML = html;
  const log = (DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log)) ? DB.cycleCounts.log : [];
  if (log[0] && log[0].counted_at) _ccPersistLastSeen(log[0].counted_at);
  try { console.timeEnd("ir-render"); } catch (_) {}
}
// v-ir-1: legacy renderer stub -- older callers that expected the
// pre-reconciliation supervisor tab now enter through renderCycleCounts
// above. Retained here so the "if not loaded, skeleton" branch below
// stays unreachable rather than deleted; keeps the diff shallow.
function _ccRenderCycleCountsLegacy_UNUSED() {
  if (false) {
  // Seed watermarks from what we already have so the FIRST
  // realtime tick fetches only genuinely new rows, not the
  // whole table.
  if (!CC_STATE._logWatermark && Array.isArray(DB.cycleCounts.log) && DB.cycleCounts.log[0]) {
    CC_STATE._logWatermark = DB.cycleCounts.log[0].counted_at || null;
  }
  if (!CC_STATE._itemsWatermark && DB.cycleCounts.items instanceof Map) {
    let maxU = null;
    for (const it of DB.cycleCounts.items.values()) {
      if (it && it.updated_at && (!maxU || it.updated_at > maxU)) maxU = it.updated_at;
    }
    CC_STATE._itemsWatermark = maxU;
  }
  const s = _ccSummary();
  const name = _ccName();
  const liveState = (typeof ccLiveState === "function") ? ccLiveState() : "connecting";
  const html = `
    <style>
      @keyframes cc-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.35 } }
      @keyframes cc-flash-in {
        0%   { background: color-mix(in srgb, var(--ok,#3a7) 25%, transparent); }
        100% { background: transparent; }
      }
      .cc-new-flash td { animation: cc-flash-in 3.5s ease-out forwards; }
      .cc-feed-table tr td { vertical-align: top; }
      .cc-feed-table tr.cc-breakdown-row td { padding: 0 !important; }
      /* Open Queue collapsible header -- obvious affordance so a
         supervisor scanning the page knows the row is interactive.
         Chevron rotates on toggle; hover/active add background so
         the pointer feedback is more than just the cursor. */
      .cc-oq-header {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        user-select: none;
        padding: 6px 8px;
        margin-left: -8px;
        margin-right: -8px;
        border-radius: 6px;
        transition: background-color 120ms ease;
      }
      .cc-oq-header:hover   { background: color-mix(in srgb, var(--ink,#0f172a) 6%, transparent); }
      .cc-oq-header:active  { background: color-mix(in srgb, var(--ink,#0f172a) 12%, transparent); }
      .cc-oq-header:focus-visible {
        outline: 2px solid var(--accent,#2563eb);
        outline-offset: 2px;
      }
      .cc-oq-chev {
        display: inline-block;
        width: 14px;
        text-align: center;
        transition: transform 160ms ease;
        font-size: 12px;
        line-height: 1;
        color: var(--ink-2, inherit);
      }
      .cc-oq-header.expanded .cc-oq-chev { transform: rotate(90deg); }
      .cc-oq-hint { color: var(--dim,#64748b); font-size: 12px; font-weight: normal; margin-left: auto; }
    </style>
    <div class="page" data-page="cycle-counts">
      <div class="page-hd">
        <div>
          <h1>Cycle Counts ${_ccPulseDot(liveState)}</h1>
          <p class="muted">Supervisor review of counts as they arrive. Counters submit through <a href="/count" target="_blank" rel="noopener">/count</a> on their phones.</p>
        </div>
        <div class="row gap-sm">
          <label class="row gap-sm" style="align-items:center;cursor:pointer">
            <span class="muted tiny">Chime on new count</span>
            <input type="checkbox" class="chk" ${CC_STATE._chimeOn ? "checked" : ""} onchange="_ccToggleChime()">
          </label>
          <label class="row gap-sm" style="align-items:center">
            <span class="muted tiny">Your name</span>
            <input class="input" id="cc-name-input" value="${esc(name)}" placeholder="e.g. Marisol" style="width:180px" onchange="_ccOnNameInput(this.value)">
          </label>
        </div>
      </div>

      <div id="cc-summary-strip">${_ccRenderTightSummary(s)}</div>

      ${!name ? `<div class="banner warn" style="margin-bottom:8px">Enter your name above before verifying counts -- it's stamped on every reviewed log row.</div>` : ""}

      <div class="dr-section" style="margin-top:16px">Needs attention</div>
      <div id="cc-attn-block">${_ccRenderNeedsAttention()}</div>

      <div class="dr-section" style="margin-top:20px">Counts as they come in</div>
      ${_ccRenderLiveFeed()}

      <div class="dr-section cc-oq-header${CC_STATE._openQueueExpanded ? " expanded" : ""}"
           style="margin-top:20px"
           role="button" tabindex="0" aria-expanded="${CC_STATE._openQueueExpanded ? "true" : "false"}" aria-controls="cc-open-queue-body"
           onclick="_ccToggleOpenQueue()"
           onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();_ccToggleOpenQueue();}">
        <span class="cc-oq-chev" aria-hidden="true">&#9656;</span>
        <span>Open queue: <span id="cc-open-queue-summary-text">${_ccOpenQueueSummary()}</span></span>
        <span class="cc-oq-hint">(tap to ${CC_STATE._openQueueExpanded ? "collapse" : "expand"})</span>
      </div>
      ${CC_STATE._openQueueExpanded ? `
        <p class="muted tiny">Supervisor override tools. Prefer /count on a phone for routine counting.</p>
        <div id="cc-open-queue-body">${_ccRenderOpenQueueBody()}</div>
      ` : ""}

      ${_ccMobileAppBlock()}
    </div>
  `;
  main.innerHTML = html;
  _ccRenderMobileQR();
  // Reconcile scan runs on route entry only -- not on every
  // realtime tick. Delta path handles ongoing updates.
  _ccScheduleReconcileScan();
  // Advance last-seen watermark after render so the next redraw's
  // flash class only lands on rows that arrived AFTER this one.
  const log = (DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log)) ? DB.cycleCounts.log : [];
  if (log[0] && log[0].counted_at) _ccPersistLastSeen(log[0].counted_at);
  try { console.timeEnd("cc-supervisor-render"); } catch (_) {}
  }   // close if(false)
}     // close _ccRenderCycleCountsLegacy_UNUSED
function _ccOnNameInput(v) { _ccSetName(v); if (typeof refresh === "function") refresh(); }
function _ccToggleCompleted() { CC_STATE._showCompleted = !CC_STATE._showCompleted; if (typeof refresh === "function") refresh(); }
if (typeof window !== "undefined") {
  window._ccOnNameInput = _ccOnNameInput;
  window._ccToggleCompleted = _ccToggleCompleted;
}

/* ============================================================
   PART-DRAWER HOOKS -- called from js/10-page-parts.js.
   ============================================================ */

// Render the "current locations" block above the count history.
// Returns "" if the pn has no part_locations rows -- keeps the
// drawer visually calm for aggregate-only parts. Reads from
// DB.partLocations populated by js/30 out of the part_locations
// table (populated by acumatica-sync's per-location pass).
function _ccRenderPartLocationsBlock(pn) {
  if (!(DB && DB.partLocations instanceof Map)) return "";
  const locs = DB.partLocations.get(pn) || [];
  if (locs.length === 0) return "";
  const syncedAt = locs.reduce((max, l) => (l.synced_at && (!max || l.synced_at > max)) ? l.synced_at : max, null);
  const total = locs.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const body = locs.map(l => `
    <tr>
      <td class="mono">${esc(l.location)}</td>
      <td class="dim">${esc(l.location_desc || "")}</td>
      <td class="right num">${Math.round(Number(l.qty) || 0)}</td>
    </tr>
  `).join("");
  // v-cc-loc-4 -- these numbers are PHYSICAL (QtyOnHandinLocation)
  // and can differ from parts.data.onHand (available), which is
  // what the planner uses. Note it in the caption so the buyer
  // isn't surprised by a mismatch.
  const availText = (typeof DB !== "undefined" && DB && Array.isArray(DB.parts))
    ? (() => { const p = DB.parts.find(x => x && x.pn === pn); return p ? Math.round(Number(p.onHand) || 0) : null; })()
    : null;
  return `
    <div class="dr-section">Current locations (${locs.length})</div>
    <div class="dim tiny" style="margin-bottom:6px">SHELF on-hand by bin (QtyOnHandinLocation) per the last Acumatica sync${syncedAt ? ` (${esc(syncedAt.slice(0, 16).replace("T", " "))})` : ""}. Shelf total = ${Math.round(total)}${availText != null && availText !== Math.round(total) ? ` &middot; planning-available = ${availText} (gap = reserved / allocated)` : ""}.</div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Location</th><th>Description</th><th class="right">Qty</th></tr></thead>
      <tbody>${body}</tbody>
    </table></div>
  `;
}

// Render the "last 5 counts" table for a part. When the most
// recent count carries a locations breakdown in the log's
// `locations` jsonb column, expand that row inline so the buyer
// sees the per-bin call. Returns "" only when BOTH the locations
// block AND the history are empty (js/10 hides the section then).
function _irMiniLedgerBlock(pn) {
  // Placeholder that fills in after a lazy per-pn fetch. Keeps the
  // drawer synchronous. Renders anchor -> receipts -> usage ->
  // expected-vs-actual + a compact daily residual list.
  const id = "ir-pd-ledger-" + pn;
  setTimeout(async () => {
    const el = document.getElementById(id);
    if (!el || typeof _supa === "undefined" || !_supa) return;
    try {
      const start = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const { data, error } = await _supa
        .from("parts_onhand_snapshots")
        .select("snapshot_date, on_hand, daily_use, receipts_qty, usage_est, prev_snapshot_date, prev_on_hand, residual, adjustment_applied, workdays_since_prev")
        .eq("pn", pn)
        .gte("snapshot_date", start)
        .order("snapshot_date", { ascending: true })
        .limit(60);
      if (error) throw error;
      const rows = data || [];
      if (rows.length === 0) { el.innerHTML = `<div class="dim tiny">No snapshot rows yet -- the nightly reconciliation ledger hasn't landed for this part.</div>`; return; }
      const latest = rows[rows.length - 1];
      const anchor = rows[0];
      const sumRes = rows.filter(r => r.residual != null && !r.adjustment_applied).reduce((s, r) => s + Number(r.residual), 0);
      const sumRecv = rows.reduce((s, r) => s + (Number(r.receipts_qty) || 0), 0);
      const sumUsage = rows.reduce((s, r) => s + (Number(r.usage_est) || 0), 0);
      const dailyList = rows.slice(-14).map(r => `
        <tr>
          <td class="dim tiny">${esc(r.snapshot_date)}</td>
          <td class="right num">${Math.round(r.on_hand)}</td>
          <td class="right num dim">${(r.receipts_qty || 0).toFixed(0)}</td>
          <td class="right num dim" title="Estimate: chain-aware daily use x workdays since previous snapshot">${(r.usage_est || 0).toFixed(1)}</td>
          <td class="right num ${r.residual == null ? "dim" : (r.adjustment_applied ? "dim" : Math.abs(r.residual) > 5 ? "text-warn" : "")}">
            ${r.residual == null ? "-" : (r.residual > 0 ? "+" : "") + Number(r.residual).toFixed(1)}
            ${r.adjustment_applied ? '<span class="pill" style="font-size:9px">adj</span>' : ""}
          </td>
        </tr>`).join("");
      el.innerHTML = `
        <div class="dim tiny" style="margin:6px 0 8px">
          Anchor ${esc(anchor.snapshot_date)}: on-hand <strong>${Math.round(anchor.on_hand)}</strong> &middot;
          received <strong>${Math.round(sumRecv)}</strong> &middot;
          usage estimate <strong>${sumUsage.toFixed(1)}</strong>
          <span title="Estimate; based on chain-aware daily use x workdays.">*</span> &middot;
          expected today <strong>${Math.round(anchor.on_hand + sumRecv - sumUsage)}</strong> vs actual <strong>${Math.round(latest.on_hand)}</strong>
          &rarr; residual <strong class="${Math.abs(sumRes) > 5 ? "text-warn" : ""}">${sumRes > 0 ? "+" : ""}${sumRes.toFixed(1)}</strong>
        </div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr>
          <th>Date</th><th class="right">On hand</th><th class="right">Received</th><th class="right">Usage (est)</th><th class="right">Residual</th>
        </tr></thead><tbody>${dailyList}</tbody></table></div>
      `;
    } catch (err) {
      el.innerHTML = `<div class="dim tiny">Ledger fetch failed: ${esc(err && err.message || "unknown")}</div>`;
    }
  }, 40);
  return `
    <div class="dr-section">Reconciliation ledger (last 30d)</div>
    <div id="${esc(id)}" class="dim tiny">Loading ledger...</div>
  `;
}

function renderPartCycleCountHistory(pn) {
  const locBlock = _ccRenderPartLocationsBlock(pn);
  const ledgerBlock = _irMiniLedgerBlock(pn);
  if (!(DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log))) return locBlock + ledgerBlock;
  const rows = DB.cycleCounts.log.filter(r => r && r.pn === pn).slice(0, 5);
  if (rows.length === 0) return locBlock + ledgerBlock;
  const drift = _ccDriftFor(pn);
  const driftLine = drift
    ? `<div class="banner warn tiny" style="margin-bottom:8px">Systematic drift detected -- ${drift.consecutive} consecutive ${drift.direction} counts, avg ${drift.avgPerCount.toFixed(1)}/count. Check BOM / backflush.</div>`
    : "";
  const body = rows.map(r => {
    const v = (typeof r.variance === "number") ? r.variance : null;
    const sign = (v == null) ? "" : (v > 0 ? "+" : "");
    const pct = (typeof r.variance_pct === "number") ? (Math.round(r.variance_pct * 1000) / 10) + "%" : "-";
    const locsBreak = (r.locations && Array.isArray(r.locations) && r.locations.length > 0)
      ? `<div class="dim tiny" style="margin-top:2px">${r.locations.map(l => `${esc(l.location)}=${Math.round(Number(l.counted_qty) || 0)}${l.foundElsewhere ? "*" : ""}`).join(", ")}</div>`
      : "";
    return `<tr>
      <td class="dim tiny">${esc((r.counted_at || "").slice(0, 16).replace("T", " "))}</td>
      <td>${esc(r.counted_by || "")}</td>
      <td class="dim tiny">${esc(r.tier || "")} ${esc(r.reason || "")}</td>
      <td class="right num">${r.system_qty_at_assign == null ? "-" : Math.round(r.system_qty_at_assign)}</td>
      <td class="right num">${r.counted_qty == null ? "-" : Math.round(r.counted_qty)}${locsBreak}</td>
      <td class="right num ${v != null && Math.abs(v) > CC_VAR_TOLERANCE_UNITS ? "text-warn" : "dim"}">${v == null ? "-" : (sign + v)} <span class="dim tiny">${pct}</span></td>
      <td>${_ccPill(r.outcome)}</td>
    </tr>`;
  }).join("");
  const historyBlock = `
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
  return locBlock + ledgerBlock + historyBlock;
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
   MOBILE APP CARD -- URL + Copy + QR (lib/qr-encoder.js).
   Renders one big card at the bottom of the supervisor tab so
   any counter can scan and land on /count without typing. QR
   drawn client-side to a plain canvas -- no CDN, no external
   image API. Copy button falls back to a hidden textarea +
   execCommand when navigator.clipboard is blocked.
   ============================================================ */
function _ccMobileAppBlock() {
  const origin = (typeof location !== "undefined" && location.origin) ? location.origin : "";
  const url = origin + "/count";
  return `
    <div class="dr-section" style="margin-top:24px">Mobile counting app</div>
    <div class="card" style="padding:16px;display:flex;gap:20px;align-items:center;flex-wrap:wrap">
      <canvas id="cc-mobile-qr" width="180" height="180" style="background:#fff;border:1px solid var(--border,#ddd);border-radius:8px;flex:0 0 auto"></canvas>
      <div style="flex:1;min-width:240px">
        <div class="mono" style="font-size:16px;font-weight:600;word-break:break-all;margin-bottom:8px">${esc(url)}</div>
        <div class="row gap-sm" style="margin-bottom:12px">
          <button class="btn" onclick="_ccCopyMobileUrl(this)">Copy URL</button>
          <a class="btn ghost" href="${esc(url)}" target="_blank" rel="noopener">Open</a>
        </div>
        <div class="muted tiny">Counters: scan with your phone camera, then Add to Home Screen.</div>
      </div>
    </div>
  `;
}
function _ccCopyMobileUrl(btn) {
  const origin = (typeof location !== "undefined" && location.origin) ? location.origin : "";
  const url = origin + "/count";
  const done = (ok) => {
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = ok ? "Copied!" : "Copy failed";
    setTimeout(() => { btn.textContent = orig; }, 1400);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(() => done(true)).catch(() => done(false));
    } else {
      const ta = document.createElement("textarea");
      ta.value = url; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand("copy"); ta.remove(); done(ok);
    }
  } catch (_) { done(false); }
}
function _ccRenderMobileQR() {
  if (typeof QREncoder === "undefined" || !QREncoder || typeof QREncoder.toCanvas !== "function") {
    console.warn("[cc] QREncoder not loaded (lib/qr-encoder.js) -- QR skipped");
    return;
  }
  const canvas = document.getElementById("cc-mobile-qr");
  if (!canvas) return;
  const origin = (typeof location !== "undefined" && location.origin) ? location.origin : "";
  try {
    QREncoder.toCanvas(canvas, origin + "/count", { moduleSize: 5, margin: 3 });
  } catch (err) {
    console.warn("[cc] QR render failed:", err && err.message);
  }
}
if (typeof window !== "undefined") {
  window._ccCopyMobileUrl = _ccCopyMobileUrl;
  window._ccRenderMobileQR = _ccRenderMobileQR;
}

/* ============================================================
   ROUTE REGISTRATION
   ============================================================ */
if (typeof registerRoute === "function") registerRoute("cycle-counts", renderCycleCounts);
