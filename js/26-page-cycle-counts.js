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

      ${_ccMobileLinksBlock()}
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
  return `
    <div class="dr-section">Current locations (${locs.length})</div>
    <div class="dim tiny" style="margin-bottom:6px">On-hand by bin per the last Acumatica sync${syncedAt ? ` (${esc(syncedAt.slice(0, 16).replace("T", " "))})` : ""}. Aggregate on-hand = ${Math.round(total)}.</div>
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
function renderPartCycleCountHistory(pn) {
  const locBlock = _ccRenderPartLocationsBlock(pn);
  if (!(DB && DB.cycleCounts && Array.isArray(DB.cycleCounts.log))) return locBlock;
  const rows = DB.cycleCounts.log.filter(r => r && r.pn === pn).slice(0, 5);
  if (rows.length === 0) return locBlock;
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
  return locBlock + historyBlock;
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
   MOBILE LINKS HELPER
   Renders a small "counter links" block on the supervisor tab
   listing each per-counter mobile URL with copy buttons. The
   COUNTERS constant lives in js/count-mobile.js (single source
   of truth); this list is duplicated here so js/26 has zero
   runtime dependency on the mobile bundle (mobile page must
   stay isolated).
   ============================================================ */
const CC_COUNTER_LINKS = [
  { token: "c1-marisol", name: "Marisol" },
  { token: "c2-james",   name: "James" },
  { token: "c3-alex",    name: "Alex" },
  { token: "c4-taylor",  name: "Taylor" },
];
function _ccMobileLinksBlock() {
  const origin = (typeof location !== "undefined" && location.origin) ? location.origin : "";
  const rows = CC_COUNTER_LINKS.map(c => {
    const url = `${origin}/count?c=${encodeURIComponent(c.token)}`;
    return `
      <tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td class="mono tiny dim" style="word-break:break-all">${esc(url)}</td>
        <td class="right" style="white-space:nowrap">
          <button class="btn xs" onclick="_ccCopyLink('${esc(url)}', this)">Copy</button>
          <a class="btn xs ghost" href="${esc(url)}" target="_blank" rel="noopener">Open</a>
        </td>
      </tr>`;
  }).join("");
  return `
    <div class="dr-section" style="margin-top:24px">Mobile counter links (attribution, not auth)</div>
    <p class="muted tiny">One URL per counter. Bookmark the right one on the tablet / phone each person carries; the token pre-fills and locks their name. See <span class="mono">js/count-mobile.js</span> COUNTERS to change names.</p>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Counter</th><th>URL</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  `;
}
function _ccCopyLink(url, btn) {
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
if (typeof window !== "undefined") window._ccCopyLink = _ccCopyLink;

/* ============================================================
   ROUTE REGISTRATION
   ============================================================ */
if (typeof registerRoute === "function") registerRoute("cycle-counts", renderCycleCounts);
