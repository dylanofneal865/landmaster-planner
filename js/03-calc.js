/* =====================================================
   03-calc.js
   Sections: FINISHED GOODS + BOM EXPLOSION, COMPUTATION ENGINE — alerts, days of cover, etc., AUDIT
   ===================================================== */

/* ============================================================
   FINISHED GOODS — the SKUs whose multi-level BOMs we explode to
   derive base-BOM demand. Edit this list directly to add/remove FGs.
   ============================================================ */
// Engineering's authoritative 91-SKU list, ordered by chassis pair
// (N6/T6, N7/U7, AMP/E7) with the shared base-chassis SKUs at the end.
// Descriptions preserved verbatim from the Engineering paste — do not
// spell-correct in place ("CLASSIS" for the two N6 4WD variants is
// intentional, matching how the drawings ship). Shape: array of
// { pn, desc } objects. Callers in js/13-page-settings.js and
// js/19-page-usage.js were updated to destructure .pn where needed.
const FINISHED_GOODS = [
  { pn: "CA00151", desc: "N6 CLASSIC - STD 2WD W/O EPS (POLY)" },
  { pn: "JA26001", desc: "T6 TRAIL CLASSIC - STD 2WD W/O EPS (POLY)" },
  { pn: "CA00416", desc: "N6 CLASSIC - STD 2WD EPS (POLY)" },
  { pn: "JA26039", desc: "T6 TRAIL EPS - STD 2WD (POLY)" },
  { pn: "CA00152", desc: "N6 CLASSIS - STD 4WD W/O EPS (POLY)" },
  { pn: "JA26002", desc: "T6 TRAIL CLASSIC - STD 4WD W/O EPS (POLY)" },
  { pn: "CA00417", desc: "N6 CLASSIS - STD 4WD EPS (POLY)" },
  { pn: "JA26040", desc: "T6 TRAIL EPS - STD 4WD (POLY)" },
  { pn: "CA00213", desc: "N7 CLASSIC - STD 2WD, W/O EPS (POLY)" },
  { pn: "JA26003", desc: "U7 TRAIL CLASSIC - STD 2WD, W/O EPS (POLY)" },
  { pn: "CA00214", desc: "N7 CLASSIC - STD 2WD, W/O EPS (STEEL)" },
  { pn: "JA26004", desc: "U7 TRAIL CLASSIC - STD 2WD, W/O EPS (STEEL)" },
  { pn: "CA00135", desc: "N7 CLASSIC - STD 4WD, W/O EPS (POLY)" },
  { pn: "JA26005", desc: "U7 TRAIL CLASSIC - STD 4WD, W/O EPS (POLY)" },
  { pn: "CA00212", desc: "N7 CLASSIC - STD 4WD, W/O EPS (STEEL)" },
  { pn: "JA26006", desc: "U7 TRAIL CLASSIC - STD 4WD, W/O EPS (STEEL)" },
  { pn: "CA00419", desc: "N7 CLASSIC - STD 4WD, W EPS (POLY)" },
  { pn: "JA26042", desc: "U7 TRAIL EPS - STD 4WD (POLY)" },
  { pn: "CA00415", desc: "N7 CLASSIC - STD 4WD, W EPS (STEEL)" },
  { pn: "JA26007", desc: "U7 TRAIL EPS - STD 4WD (STEEL)" },
  { pn: "CA00136", desc: "N7 TOURING - STD EPS" },
  { pn: "JA26038", desc: "U7 TRAIL EXPEDITION - STD" },
  { pn: "CA00138", desc: "N7 RANCH - STD" },
  { pn: "JA26008", desc: "U7 TRAIL OUTFITTER - STD 4WD" },
  { pn: "CA00141", desc: "N7 WILDERNESS, STD" },
  { pn: "JA26009", desc: "U7 TRAIL BACKCOUNTRY - STD" },
  { pn: "CA00215", desc: "N7 CLASSIC - CREW 2WD, POLY BED (EPS)" },
  { pn: "JA26010", desc: "U7 TRAIL EPS - CREW 2WD (POLY)" },
  { pn: "CA00216", desc: "N7 CLASSIC - CREW 2WD, STEEL BED (EPS)" },
  { pn: "JA26011", desc: "U7 TRAIL EPS - CREW 2WD (STEEL)" },
  { pn: "CA00217", desc: "N7 CLASSIC - CREW 4WD, POLY BED (EPS)" },
  { pn: "JA26012", desc: "U7 TRAIL EPS - CREW 4WD (POLY)" },
  { pn: "CA00218", desc: "N7 CLASSIC - CREW 4WD, STEEL BED (EPS)" },
  { pn: "JA26013", desc: "U7 TRAIL EPS - CREW 4WD (STEEL)" },
  { pn: "CA00137", desc: "N7 TOURING - CREW (EPS)" },
  { pn: "JA26014", desc: "U7 TRAIL EXPEDITION - CREW" },
  { pn: "CA00139", desc: "N7 RANCH - CREW (EPS)" },
  { pn: "JA26015", desc: "U7 TRAIL OUTFITTER - CREW" },
  { pn: "CA00142", desc: "N7 WILDERNESS - CREW (EPS)" },
  { pn: "JA26016", desc: "U7 TRAIL BACKCOUNTRY - CREW" },
  { pn: "CA00219", desc: "N7 CLASSIC - HD (EPS)" },
  { pn: "JA26017", desc: "U7 TRAIL EPS - HD" },
  { pn: "CA00140", desc: "N7 RANCH - HD" },
  { pn: "JA26018", desc: "U7 TRAIL OUTFITTER - HD" },
  { pn: "CA00143", desc: "AMP CLASSIC - STD 4WD W/O EPS - POLY BED" },
  { pn: "JA26019", desc: "E7 RANGE CLASSIC - STD 4WD (POLY)" },
  { pn: "CA00205", desc: "AMP CLASSIC - STD 2WD W/O EPS - POLY BED" },
  { pn: "JA26020", desc: "E7 RANGE CLASSIC - STD 2WD (POLY)" },
  { pn: "CA00206", desc: "AMP CLASSIC - STD 2WD, W/O EPS - STEEL BED" },
  { pn: "JA26021", desc: "E7 RANGE CLASSIC - STD 2WD (STEEL)" },
  { pn: "CA00210", desc: "AMP CLASSIC - STD 4WD W/O EPS - STEEL BED" },
  { pn: "JA26022", desc: "E7 RANGE CLASSIC - STD 4WD (STEEL)" },
  { pn: "CA00197", desc: "AMP - STD 2WD, EPS - STEEL BED" },
  { pn: "JA26023", desc: "E7 RANGE EPS - STD 2WD (STEEL)" },
  { pn: "CA00198", desc: "AMP - STD 2WD, EPS - POLY BED" },
  { pn: "JA26024", desc: "E7 RANGE EPS - STD 2WD (POLY)" },
  { pn: "CA00190", desc: "AMP - STD 4WD, EPS - STEEL BED" },
  { pn: "JA26025", desc: "E7 RANGE EPS - STD 4WD (STEEL)" },
  { pn: "CA00418", desc: "AMP - STD 4WD EPS (POLY)" },
  { pn: "JA26041", desc: "E7 RANGE EPS - STD 4WD (POLY)" },
  { pn: "CA00144", desc: "AMP TOURING - STANDARD (EPS)" },
  { pn: "JA26026", desc: "E7 RANGE EXPEDITION - STD" },
  { pn: "CA00146", desc: "AMP RANCH - STANDARD (EPS)" },
  { pn: "JA26027", desc: "E7 RANGE OUTFITTER - STD" },
  { pn: "CA00149", desc: "AMP WILDERNESS - STANDARD (EPS)" },
  { pn: "JA26028", desc: "RANGE BACKCOUNTRY - STD" },
  { pn: "CA00145", desc: "AMP TOURING - CREW (EPS)" },
  { pn: "JA26029", desc: "E7 RANGE EXPEDITION - CREW" },
  { pn: "CA00147", desc: "AMP RANCH - CREW (EPS)" },
  { pn: "JA26030", desc: "E7 RANGE OUTFITTER - CREW" },
  { pn: "CA00150", desc: "AMP WILDERNESS - CREW (EPS)" },
  { pn: "JA26031", desc: "E7 RANGE BACKCOUNTRY - CREW" },
  { pn: "CA00207", desc: "AMP CLASSIC - CREW 2WD, EPS - POLY BED" },
  { pn: "JA26032", desc: "E7 RANGE EPS CREW, 2WD (POLY)" },
  { pn: "CA00208", desc: "AMP CLASSIC - CREW 2WD, EPS - STEEL BED" },
  { pn: "JA26033", desc: "E7 RANGE EPS CREW, 2WD (STEEL)" },
  { pn: "CA00191", desc: "AMP - CREW 4WD, EPS - STEEL BED" },
  { pn: "JA26034", desc: "E7 RANGE EPS CREW, 4WD (STEEL)" },
  { pn: "CA00211", desc: "AMP - CREW 4WD, EPS (POLY)" },
  { pn: "JA26035", desc: "E7 RANGE EPS CREW, 4WD (POLY)" },
  { pn: "CA00201", desc: "AMP - CLASSIC HD 4WD, G7 (EPS)" },
  { pn: "JA26036", desc: "E7 RANGE EPS - HD" },
  { pn: "CA00148", desc: "AMP RANCH - HD (EPS)" },
  { pn: "JA26037", desc: "E7 RANGE OUTFITTER - HD" },
  { pn: "JA27001", desc: "N6-T6 STD BASE CHASSIS (GAS)" },
  { pn: "JA27002", desc: "N7-T7 STD BASE CHASSIS (GAS)" },
  { pn: "JA27003", desc: "N7-U7 CREW BASE CHASSIS (GAS)" },
  { pn: "JA27004", desc: "N7-U7 HD BASE CHASSIS (GAS)" },
  { pn: "JA27005", desc: "AMP-E7 STD BASE CHASSIS (EV)" },
  { pn: "JA27006", desc: "AMP-E7 CREW BASE CHASSIS (EV)" },
  { pn: "JA27007", desc: "AMP-E7 HD BASE CHASSIS (EV)" },
];

/* ============================================================
   BOM EXPLOSION ENGINE — walks DB.bomLinks from a finished-good
   SKU down through every sub-assembly to the rolled-up buyable
   leaf parts (multiplying qty through each level). Single-pass
   cycle guard, memoized parent→children index.
   ============================================================ */

// Memoized parent→children index built from DB.bomLinks. Rebuilds only when
// the underlying array reference changes (e.g. after cloud sync replaces it),
// so 16k+ links don't get re-grouped on every explodeBOM call.
let _bomIndex = null;
let _bomIndexSource = null;
function getBomChildrenIndex() {
  const src = (typeof DB !== "undefined" && Array.isArray(DB.bomLinks)) ? DB.bomLinks : [];
  if (_bomIndex && _bomIndexSource === src) return _bomIndex;
  const map = new Map();
  for (const ln of src) {
    if (!ln || !ln.parent || !ln.child) continue;
    let arr = map.get(ln.parent);
    if (!arr) { arr = []; map.set(ln.parent, arr); }
    arr.push({ child: ln.child, qty: Number(ln.qty) || 0, uom: ln.uom || "" });
  }
  _bomIndex = map;
  _bomIndexSource = src;
  return map;
}

// True iff `pn` appears as a parent in any BOM link (it's an assembly that
// explodes further). Anything else is treated as a buyable leaf — including
// PNs not in the catalog at all (they still get rolled up; the page flags
// them so engineering can decide whether they belong in DB.parts).
function isSubAssembly(pn) {
  return getBomChildrenIndex().has(pn);
}

// Walk the BOM tree from `fgSku` and return the rolled-up leaf list.
// Result shape:
//   {
//     leaves: [{ pn, qtyPerUnit, uom }] sorted by pn,
//     distinctLeafCount,
//     totalPieces,
//     warnings: [string],   // cycles or depth blow-outs
//   }
// Quantities multiply through every level: if FG → SubA (qty 2) → Leaf (qty 3),
// the leaf contributes 6 per FG unit. A leaf reached via multiple branches has
// its qtys summed in the final rollup.
function explodeBOM(fgSku) {
  const index = getBomChildrenIndex();
  if (!index.has(fgSku)) {
    return {
      leaves: [],
      distinctLeafCount: 0,
      totalPieces: 0,
      warnings: [`No BOM defined for ${fgSku} in bom_links`],
    };
  }

  const leafTotals = new Map();    // pn -> { qty, uom }
  const warnings = [];
  const MAX_DEPTH = 64;            // belt-and-suspenders on top of cycle detection

  function visit(parent, parentMultiplier, ancestors, depth) {
    if (depth > MAX_DEPTH) {
      warnings.push(`Max depth ${MAX_DEPTH} exceeded under ${fgSku} (at ${parent})`);
      return;
    }
    if (ancestors.has(parent)) {
      warnings.push(`Cycle detected: ${parent} appears in its own ancestry under ${fgSku}`);
      console.warn(`[bom] cycle under ${fgSku}: ${parent}`);
      return;
    }
    const children = index.get(parent);
    if (!children) return;
    ancestors.add(parent);
    for (const c of children) {
      const m = parentMultiplier * (Number(c.qty) || 0);
      if (index.has(c.child)) {
        visit(c.child, m, ancestors, depth + 1);
      } else {
        const prev = leafTotals.get(c.child);
        if (prev) {
          prev.qty += m;
          if (!prev.uom && c.uom) prev.uom = c.uom;
        } else {
          leafTotals.set(c.child, { qty: m, uom: c.uom || "" });
        }
      }
    }
    ancestors.delete(parent);
  }

  visit(fgSku, 1, new Set(), 0);

  const leaves = [];
  let totalPieces = 0;
  for (const [pn, { qty, uom }] of leafTotals.entries()) {
    leaves.push({ pn, qtyPerUnit: qty, uom });
    totalPieces += qty;
  }
  leaves.sort((a, b) => String(a.pn).localeCompare(String(b.pn)));

  return { leaves, distinctLeafCount: leaves.length, totalPieces, warnings };
}

/* ============================================================
   COMPUTATION ENGINE — alerts, days of cover, etc.
   ============================================================ */
// Lead time in days (using calendar days for stockout math; weeks→days via 7)
function leadTimeDays(part) {
  return Math.round((part.ltWeeks || 0) * 7);
}

/* ------------------------------------------------------------------
   WORKDAY → CALENDAR conversion (shared, single source of truth)

   dailyUse is a PER-WORKDAY rate (units consumed per working day — the usage
   page divides by workdays, not calendar days). So "(onHand + incoming) /
   dailyUse" is a count of WORKDAYS of cover, and it must be walked across the
   calendar skipping non-workdays to land on the real runout DATE — NOT added
   as calendar days (the bug) and NOT scaled by a 7/5 average (imprecise).

   workdaysPerWeek is ALWAYS read from settings through effectiveWorkdaysPerWeek
   — never hardcode 5 — so changing it visibly shifts every runout date.
   ------------------------------------------------------------------ */
function effectiveWorkdaysPerWeek() {
  const w = Number(DB.settings && DB.settings.workdaysPerWeek);
  return Math.min(7, Math.max(1, Number.isFinite(w) ? Math.round(w) : 5));
}

// Workdays are the first `wpw` days of the week counting from Monday:
//   wpw=5 → Mon–Fri, wpw=6 → Mon–Sat, wpw=4 → Mon–Thu, wpw=7 → every day.
function isWorkday(date, wpw = effectiveWorkdaysPerWeek()) {
  const mondayIdx = (date.getDay() + 6) % 7; // Mon=0 … Sun=6
  return mondayIdx < wpw;
}

// Convert a (possibly fractional) number of WORKDAYS of cover into CALENDAR
// days from `startDate`, anchored to startDate's actual weekday so the result
// is exact (not a 7/5 average). Stock runs out on the k-th workday, where
// k = ceil(coverWorkdays) — that workday's calendar offset is the runout date.
// O(1): whole weeks map 1:1 (any 7 consecutive calendar days hold exactly wpw
// workdays, regardless of phase), so we skip floor((k-1)/wpw) weeks in one
// step, then walk the final partial week (≤ ~7 iterations) across the calendar
// skipping non-workdays. The epsilon guards float noise (e.g. 15/3 = 5.0000001)
// from rounding the runout a day late.
function workdaysToCalendarDays(coverWorkdays, startDate = TODAY, wpw = effectiveWorkdaysPerWeek()) {
  if (!Number.isFinite(coverWorkdays) || coverWorkdays <= 0) return 0;
  if (wpw >= 7) return Math.ceil(coverWorkdays - 1e-9); // every calendar day is a workday
  const k = Math.ceil(coverWorkdays - 1e-9);            // runout occurs on the k-th workday
  if (k <= 0) return 0;
  const fullWeeks = Math.floor((k - 1) / wpw);          // complete weeks before the final partial
  let cursor = fullWeeks * 7;                            // wpw workdays ⇆ 7 calendar days
  let workdaysLeft = k - fullWeeks * wpw;                // in [1, wpw]
  while (workdaysLeft > 0) {
    cursor += 1;
    if (isWorkday(addDays(startDate, cursor), wpw)) workdaysLeft -= 1;
  }
  return cursor;
}

// ----- Shared "is this PO line actually open?" gate -------------------------
//
// The PO Lines GI was changed to also feed back received / closed lines so
// the planner can show receipts. As a side effect, "Completed" / "Closed"
// Acumatica POs can land in DB.pos carrying straggler lines that look open
// at the line level (qty > 0, qtyReceived < qty, ln.status === "open")
// because Acumatica never reconciled them — and our po-level rollup picks
// "Open" priority over "Completed", so po.acumStatus is "Open" too.
//
// `isLineOpen(po, ln)` is the single chokepoint for deciding whether a line
// should count toward open-PO supply math, transition-risk PO coverage, the
// supplier follow-up list, the dashboard's $ open PO KPI, the suppliers-page
// totals, and the part-drawer open-PO list. Be liberal — when ANY of these
// signals say it's done, treat as NOT open. Better to miss a follow-up than
// to chase a vendor about a PO they already shipped.
//
// A line is NOT open if:
//   - po.status is received / closed / cancelled / completed (case-insens.)
//   - po.acumStatus is Completed / Closed / Canceled / Cancelled / Rejected
//   - ln.status is received / closed / cancelled / completed
//   - ln.acumStatus is Completed / Closed / Canceled / Cancelled / Rejected
//   - ln.openQty is defined and <= 0
//   - qty is 0 (degenerate line)
//   - qtyReceived (or ln.recv) >= qty (fully received)
const _CLOSED_LINE_STATUSES = new Set([
  "received", "closed", "cancelled", "canceled", "completed",
]);
const _CLOSED_ACUM_STATUSES = new Set([
  "completed", "closed", "canceled", "cancelled", "rejected",
]);

// PO-level "is this PO still live?" gate. Exclude-list approach so any
// tenant's custom in-progress statuses (draft / submitted / in_transit /
// partial / etc.) all default to active — only the explicitly-terminal
// po.status and po.acumStatus values are filtered out. Used by:
//   - Purchase Orders nav badge count
//   - Dashboard "Open POs" KPI
//   - PO list "Active" / "Overdue" / "Closed" filter tabs
//   - isLineOpen (as the PO-level pre-check before the line-level rules)
// One definition, reused everywhere; no parallel filter chains.
function isActivePO(po) {
  if (!po) return false;
  const poStatus = String(po.status || "").toLowerCase().trim();
  if (_CLOSED_LINE_STATUSES.has(poStatus)) return false;
  const poAcum = String(po.acumStatus || "").toLowerCase().trim();
  if (poAcum && _CLOSED_ACUM_STATUSES.has(poAcum)) return false;
  return true;
}

// Blanket PO lines are release-against authorizations, not scheduled
// receipts. Acumatica's PO Line Type column carries "Normal" vs "Blanket";
// the sync writes it verbatim (title-cased) into ln.type. Only an EXPLICIT
// "blanket" (case-insensitive) counts — null / undefined / "" / "Normal"
// are all treated as scheduled supply. Missing type (64 of ~1874 lines in
// current data) is deliberately permissive per the field discovery — it
// most likely reflects legacy rows synced before the type-capture landed.
function isBlanketLine(ln) {
  return !!(ln && String(ln.type || "").trim().toLowerCase() === "blanket");
}

function isLineOpen(po, ln) {
  if (!isActivePO(po)) return false;
  if (!ln) return false;
  // Blanket = release-against authorization, not a scheduled receipt.
  // Gate here so every downstream supply-math consumer inherits the
  // exclusion for free: openPOQty, projectOnHand, and
  // _buildOpenPOLineIndex all route through isLineOpen. suggestedQty's
  // onPO param sources from openPOQty, so it's covered too.
  // PO drawer and PO list read DB.pos directly (not via isLineOpen),
  // so blanket lines still render in the UI — this is a SUPPLY-MATH
  // gate only.
  if (isBlanketLine(ln)) return false;
  const lnStatus = String(ln.status || "").toLowerCase().trim();
  if (_CLOSED_LINE_STATUSES.has(lnStatus)) return false;
  const lnAcum = String(ln.acumStatus || "").toLowerCase().trim();
  if (lnAcum && _CLOSED_ACUM_STATUSES.has(lnAcum)) return false;
  if (ln.openQty !== undefined && ln.openQty !== null && Number(ln.openQty) <= 0) return false;
  const qty = Number(ln.qty || 0);
  if (qty <= 0) return false;
  const recv = Number(ln.qtyReceived != null ? ln.qtyReceived : (ln.recv != null ? ln.recv : 0));
  if (recv >= qty) return false;
  return true;
}

// Build a per-PN index of open PO lines. Each entry: { ln, remaining, po }.
// Built once at the top of partsWithStatus so projectOnHand/openPOQty don't
// rescan DB.pos for every part. External callers don't need this — the public
// fns below accept an optional precomputed lines array and fall back to a
// full scan when called without it. The `po` reference is carried so
// projectOnHand can attribute overdue receipts to a PO number.
function _buildOpenPOLineIndex() {
  const map = new Map();
  for (const po of (DB.pos || [])) {
    for (const ln of (po.lines || [])) {
      if (!isLineOpen(po, ln)) continue;
      const remaining = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
      if (!remaining) continue;
      let arr = map.get(ln.pn);
      if (!arr) { arr = []; map.set(ln.pn, arr); }
      arr.push({ ln, remaining, po });
    }
  }
  return map;
}

// Total open PO qty for a part across all open POs.
// `lines` is the optional precomputed index entry for this PN.
function openPOQty(pn, lines) {
  if (lines) {
    let total = 0;
    for (const e of lines) total += e.remaining;
    return total;
  }
  let total = 0;
  for (const po of (DB.pos || [])) {
    for (const ln of (po.lines || [])) {
      if (ln.pn !== pn) continue;
      if (!isLineOpen(po, ln)) continue;
      total += Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
    }
  }
  return total;
}

// Project on-hand over the next N days, treating PO lines as receipts on their expected dates.
// `lines` is the optional precomputed index entry for this part.
// Past-due lines (genuine expected date < today) are still clamped to offset
// 0 — they continue to prop up the projection — but the units and source
// lines are surfaced via series.overdueUnits / series.overdueLines so the
// UI can flag the assumption without changing any math.
//
// `opts.ignoreOverdue` (default false): when true, past-due lines are NOT
// credited into receipts[] — the projection shows the "what if the late PO
// never lands" world. overdueUnits / overdueLines are still reported so
// callers can identify which lines drove the divergence. All existing
// callers pass no opts and see byte-identical behavior.
function projectOnHand(part, days = 365, lines, opts = {}) {
  const series = [];
  let oh = part.onHand || 0;
  const receipts = new Array(days + 1).fill(0);
  let overdueAtZero = 0;
  const overdueLines = [];
  const accumReceipt = (ln, remaining, po) => {
    let offset;
    let isOverdue = false;
    const expDate = ln.expectedDate ? new Date(ln.expectedDate) : null;
    if (!expDate || isNaN(expDate)) {
      // Missing/invalid date → assume arrival at the part's lead time from
      // today. NOT treated as overdue — we have no signal that it's late.
      offset = leadTimeDays(part);
    } else {
      expDate.setHours(0,0,0,0);
      offset = Math.round((expDate - TODAY) / DAY_MS);
      // Past expected date → treat as arriving today (don't drop the receipt)
      if (offset < 0) {
        isOverdue = true;
        offset = 0;
      }
    }
    // Credit the receipt UNLESS the caller asked to ignore overdue lines
    // AND this line is overdue. The overdue tracking below is unchanged so
    // callers can still see which lines were skipped.
    const skipCredit = opts.ignoreOverdue && isOverdue;
    if (offset <= days && !skipCredit) receipts[offset] += remaining;
    if (isOverdue) {
      overdueAtZero += remaining;
      overdueLines.push({
        pn: ln.pn,
        qty: remaining,
        expected: ln.expectedDate,
        po: po ? (po.num || null) : null,
      });
    }
  };
  if (lines) {
    for (const e of lines) accumReceipt(e.ln, e.remaining, e.po);
  } else {
    for (const po of (DB.pos || [])) {
      for (const ln of (po.lines || [])) {
        if (ln.pn !== part.pn) continue;
        if (!isLineOpen(po, ln)) continue;
        const remaining = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
        if (!remaining) continue;
        accumReceipt(ln, remaining, po);
      }
    }
  }
  // dailyUse is a PER-WORKDAY rate, so only deplete on workdays — the line
  // flatlines across weekends and the runout lands on the correct calendar
  // date. Receipts still land on their actual calendar offset (PO arrivals are
  // wall-clock). workdaysPerWeek read via the shared helper.
  //
  // CASE-A PRE-LAUNCH: if the part has a transitionStartDate in the FUTURE,
  // the projection HOLDS FLAT at onHand until that date — nothing consumes
  // the part before it phases in. On/after transitionStartDate, normal
  // workday depletion resumes. Guard: only fires when transitionStartDate
  // is set, parses, AND is strictly in the future; otherwise startMs stays
  // 0 and every existing (non-pre-launch) call path is byte-identical.
  // NOTE ON THE ONHAND INVARIANT: this function mutates a LOCAL `oh`
  // variable initialized from part.onHand at the top; it NEVER writes back
  // to part.onHand. dailyUse is projection-only. Grep confirms zero
  // `part.onHand = ...` in this file.
  let startMs = 0;
  if (part && part.transitionStartDate && typeof parseDateLocal === "function") {
    const s = parseDateLocal(part.transitionStartDate);
    if (s && s.getTime() > TODAY.getTime()) startMs = s.getTime();
  }
  const wpw = effectiveWorkdaysPerWeek();
  for (let i = 0; i <= days; i++) {
    const d = addDays(TODAY, i);
    // Skip depletion until we reach transitionStartDate. Receipts still
    // land on their real calendar offset — a PO scheduled to arrive
    // before phase-in bumps the flat pre-launch line up on its arrival
    // day, which is the correct behavior (stock accumulates before
    // consumption starts).
    const consuming = !startMs || d.getTime() >= startMs;
    if (i > 0 && consuming && isWorkday(d, wpw)) oh -= (part.daily || 0);
    oh += receipts[i];
    series.push({ d, oh: oh, recv: receipts[i] });
  }
  // Attach the overdue summary as plain properties on the array. Existing
  // callers (.map / .length / indexing / .findIndex) are unaffected.
  series.overdueUnits = overdueAtZero;
  series.overdueLines = overdueLines;
  return series;
}

// Days until stockout (CALENDAR days, without any new orders). Optional
// precomputed lines. dailyUse is per-workday, so cover is computed in workdays
// and converted to a calendar count through the shared helper — this is what
// makes changing workdaysPerWeek shift every runout date.
function daysUntilStockout(part, lines) {
  const daily = Number(part.daily) || 0;
  if (daily <= 0) return Infinity;
  const incoming = openPOQty(part.pn, lines);
  // No incoming receipts → exact O(1) workday→calendar conversion of the cover.
  // (onHand / dailyUse) = WORKDAYS of cover. Cap at the 365-day projection
  // horizon so slow movers read as Infinity (status "ok"), matching the
  // receipt-aware branch below.
  //
  // CASE-A PRE-LAUNCH: if transitionStartDate is in the future, the cover
  // runs from THERE, not today. The runway is flat at onHand until launch,
  // then depletes normally. Result = daysUntilStart + (workday cover
  // converted starting AT the launch date). Guard: only fires when
  // transitionStartDate parses AND is strictly in the future. Non-pre-
  // launch parts (start unset / past / bad) fall through to the original
  // (cover from TODAY) branch — byte-identical to pre-fix.
  if (incoming <= 0) {
    const coverWorkdays = (Number(part.onHand) || 0) / daily;
    let startD = TODAY;
    let daysUntilStart = 0;
    if (part && part.transitionStartDate && typeof parseDateLocal === "function") {
      const s = parseDateLocal(part.transitionStartDate);
      if (s && s.getTime() > TODAY.getTime()) {
        startD = s;
        daysUntilStart = Math.round((s.getTime() - TODAY.getTime()) / DAY_MS);
      }
    }
    const cal = daysUntilStart + workdaysToCalendarDays(coverWorkdays, startD);
    return cal > 365 ? Infinity : cal;
  }
  // Incoming POs exist → use the receipt-timing-aware projection (which now
  // also depletes on workdays via the same isWorkday helper) so a PO landing
  // too late still surfaces a stockout. Find the LAST day on-hand is still
  // positive — accounts for transient dips that recover when a PO lands.
  const series = projectOnHand(part, 365, lines);
  let lastPositive = -1;
  for (let i = 0; i < series.length; i++) {
    if (series[i].oh > 0) lastPositive = i;
  }
  if (lastPositive === -1) return 0;                       // never positive
  if (lastPositive === series.length - 1) return Infinity; // stays positive through end of window
  return lastPositive + 1;
}

// Compute status for a part. Optional precomputed lines.
function partStatus(part, lines) {
  const lt = leadTimeDays(part);
  const safety = DB.settings.safetyDays || 0;
  const warnDays = DB.settings.alertWarning ?? 14;
  const stockoutDay = daysUntilStockout(part, lines);
  const reorderBy = lt + safety; // we should have stock for at least lead time + safety days
  let status = "ok";
  let urgency = 9999;

  if (stockoutDay === Infinity) {
    status = "ok";
    urgency = 9999;
  } else if (stockoutDay <= reorderBy) {
    // Cover doesn't reach lead time + safety buffer — order today to keep the cushion.
    status = "critical";
    urgency = stockoutDay; // smaller = more urgent
  } else if (stockoutDay <= reorderBy + warnDays) {
    // Margin past lead time is at or under the configured warning threshold — order soon
    status = "warning";
    urgency = stockoutDay;
  } else {
    status = "ok";
    urgency = stockoutDay;
  }
  return { status, urgency, stockoutDay, leadDays: lt, reorderBy, daysOfCover: stockoutDay };
}

// Suggested order qty: cover lead time + safety + a target horizon (e.g., 30 days more).
// `onPO` is the optional precomputed open-PO qty — saves an openPOQty scan.
//
// PHASE-OUT short-circuit: parts marked part.phasingOut return 0 — they're
// being retired and we burn down existing stock. Everything else about the
// part (on-hand, days-of-cover, status color) stays real so the drawer can
// still show it depleting.
//
// PHASE 2 — CHAIN DEMAND ROUTING: when this part is the final hop of an
// actively-transitioning supersession chain, _supersessionDemandBoost gives
// us the anchor's daily rate and the chain's combined on-hand. We size the
// order against that combined supply so we don't reorder while a phased-out
// predecessor still has stock to burn down. See _supersessionDemandBoost.
function suggestedQty(part, onPO) {
  if (part && part.phasingOut) return 0;

  const boost = _supersessionDemandBoost(part);

  const lt = leadTimeDays(part);
  const safety = DB.settings.safetyDays || 0;
  const horizon = 30; // beyond reorder, target 30 days of stock after arrival

  // Daily rate. Edge case: if the final part already has its own non-zero
  // usage (real shipments on the new PN already), use the GREATER of
  // (its own daily, the anchor's copied daily) so we never under-order
  // during the cutover window.
  const dailyRate = boost
    ? Math.max(Number(part.daily) || 0, boost.dailyRate)
    : (part.daily || 0);
  const target = (lt + safety + horizon) * dailyRate;

  // Effective supply. When boosted, every predecessor's on-hand counts as
  // stock we'll consume first — only the final part has open POs that we
  // count (predecessor POs are excluded per spec; in practice they're
  // cancelled when a part phases out).
  const onPOQty = (typeof onPO === "number") ? onPO : openPOQty(part.pn);
  const have = boost
    ? boost.combinedOnHand + onPOQty
    : (part.onHand || 0) + onPOQty;

  let qty = Math.max(0, Math.ceil(target - have));
  if (part.moq && qty > 0) qty = Math.max(qty, part.moq);
  if (part.packSize && qty > 0) {
    qty = Math.ceil(qty / part.packSize) * part.packSize;
  }
  return qty;
}

/* ============================================================
   PART SUPERSESSION — old part → new part chains (multi-hop).
   Phase 1: data model + chain helpers + phase-out zeroing. Phase 2
   will route phased-part demand to the successor; not done here.
   ============================================================ */

// Forward walk from `pn` following part.supersededBy. Returns the ordered
// chain starting at `pn` (inclusive). Example: 19722.supersededBy = "CP00668",
// CP00668.supersededBy = "CP00945" → supersessionChain("19722") returns
// ["19722", "CP00668", "CP00945"]. Cycles are detected via a visited set —
// we stop, console.warn, and return the chain so far.
function supersessionChain(pn) {
  const start = pn ? String(pn).trim() : "";
  if (!start) return [];
  const chain = [start];
  const visited = new Set([start]);
  let cur = start;
  while (true) {
    const p = (DB.parts || []).find(x => x.pn === cur);
    const next = (p && p.supersededBy) ? String(p.supersededBy).trim() : "";
    if (!next) break;
    if (visited.has(next)) {
      console.warn(`[supersession] cycle detected at ${next} in chain starting ${start}`);
      break;
    }
    chain.push(next);
    visited.add(next);
    cur = next;
  }
  return chain;
}

// Terminal/live part for a supersession chain (the last hop). For
// 19722→CP00668→CP00945 this returns "CP00945" regardless of which PN you
// hand it. If `pn` itself has no successor, returns `pn`.
function currentPartOf(pn) {
  const chain = supersessionChain(pn);
  return chain.length ? chain[chain.length - 1] : (pn || "");
}

// Full lineage including predecessors — walks BACKWARD from `pn` (any part
// whose supersededBy points at me, transitively) then FORWARD via
// supersessionChain. Used by the drawer so viewing the latest part still
// shows the whole history. Same cycle guard via visited sets.
function supersessionLineage(pn) {
  const start = pn ? String(pn).trim() : "";
  if (!start) return [];
  const back = [];
  const seen = new Set([start]);
  let cur = start;
  while (true) {
    const pred = (DB.parts || []).find(x => x.supersededBy && String(x.supersededBy).trim() === cur);
    if (!pred) break;
    if (seen.has(pred.pn)) {
      console.warn(`[supersession] backward cycle hitting ${pred.pn} from ${start}`);
      break;
    }
    back.unshift(pred.pn);
    seen.add(pred.pn);
    cur = pred.pn;
  }
  const forward = supersessionChain(start); // [start, ...successors]
  return [...back, ...forward];
}

// Phase 2: sequential view of an actively-transitioning supersession chain
// for ANY member (anchor, intermediate, or final). Models the chain as parts
// consumed strictly in order at the anchor's daily rate: each part only
// begins depleting once the part before it hits zero. Returns null when the
// part isn't in such a chain, otherwise:
//   {
//     lineage,                       // ordered PN list from anchor → final
//     chainRate,                     // anchor's daily (copied, never stored)
//     anchorPn, anchor,
//     position,                      // index in lineage (0 = anchor)
//     isAnchor, isFinal,
//     predecessors, successors,      // ordered part objects either side of me
//     predecessorStockClamped,       // sum of max(0, p.onHand) for predecessors
//     ownClamped,                    // max(0, this part's onHand)
//     cumulativeStockThroughThis,    // predecessorStockClamped + ownClamped
//     totalChainStockClamped,        // sum of clamped on-hand across the whole chain
//   }
//
// Routing kicks in only when:
//   1. lineage.length >= 2 (part is in a chain), AND
//   2. At least one chain member has phasingOut === true (the chain is
//      "actively transitioning" — otherwise we leave every member alone).
//
// "Clamped" means a stocked-out predecessor (negative on-hand from a count
// error) contributes 0 to chain supply, not negative — the predecessor is
// gone, not somehow worsening the successor's runway.
function chainSequentialView(part) {
  if (!part || !part.pn) return null;
  const lineage = supersessionLineage(part.pn);
  if (lineage.length < 2) return null;

  const partsByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  const members = lineage.map(pn => partsByPn.get(pn)).filter(Boolean);
  if (members.length < 2) return null;

  const transitioning = members.some(m => m.phasingOut);
  if (!transitioning) return null;

  const anchorPn = lineage[0];
  const anchor = partsByPn.get(anchorPn) || null;
  const chainRate = anchor ? (Number(anchor.daily) || 0) : 0;

  const position = lineage.indexOf(part.pn);
  if (position < 0) return null;
  const isAnchor = position === 0;
  const isFinal = position === lineage.length - 1;

  const predecessors = members.slice(0, position);
  const successors = members.slice(position + 1);

  let predecessorStockClamped = 0;
  for (const p of predecessors) predecessorStockClamped += Math.max(0, Number(p.onHand) || 0);
  const ownClamped = Math.max(0, Number(part.onHand) || 0);
  const cumulativeStockThroughThis = predecessorStockClamped + ownClamped;

  let totalChainStockClamped = cumulativeStockThroughThis;
  for (const p of successors) totalChainStockClamped += Math.max(0, Number(p.onHand) || 0);

  return {
    lineage,
    chainRate,
    anchorPn,
    anchor,
    position,
    isAnchor,
    isFinal,
    predecessors,
    successors,
    predecessorStockClamped,
    ownClamped,
    cumulativeStockThroughThis,
    totalChainStockClamped,
  };
}

// Phase 2 demand-routing input for the FINAL part of an actively-transitioning
// chain. Thin wrapper over chainSequentialView so the existing suggestedQty
// shape stays stable. `combinedOnHand` is now the CLAMPED total (predecessors
// at max(0, onHand) + own clamped). Returns null for any non-final position.
function _supersessionDemandBoost(part) {
  const view = chainSequentialView(part);
  if (!view || !view.isFinal) return null;
  return {
    dailyRate: view.chainRate,
    combinedOnHand: view.totalChainStockClamped,
    anchorPn: view.anchorPn,
    anchor: view.anchor,
    predecessors: view.predecessors,
  };
}

// Chain-safety check for the FINAL part of an actively-transitioning chain.
// Returns false (or null) when no risk flag is warranted, or an object
// { runoutDays } when the chain will run dry before a replacement order
// arrives.
//
// Decision:
//   1. Only the FINAL part is eligible (rest of chain is phasing out → not in
//      the queue anyway after this commit).
//   2. Chain runs dry from today at chainRate, starting from the clamped
//      cumulative supply through the final part. runoutDays = supply/rate.
//   3. If an open PO line for the final part is expected to arrive on/before
//      that runout date, the chain is COVERED → no risk.
//   4. If suggestedQty is already 0 (math says we have what we need), no risk.
//   5. Otherwise AT RISK — the order hasn't been placed (or won't arrive in
//      time) and the predecessor stock will exhaust first.
//
// Reads open POs the same way the rest of the app does (status filter, line
// status filter, line.expectedDate falling back to po.expectedDate).
function chainTransitionRisk(part) {
  const view = chainSequentialView(part);
  if (!view || !view.isFinal) return false;
  if (view.chainRate <= 0) return false;

  const runoutDays = view.cumulativeStockThroughThis / view.chainRate;
  const today = new Date(TODAY); today.setHours(0, 0, 0, 0);
  const runoutMs = today.getTime() + runoutDays * DAY_MS;

  // Look for any covering PO line on the final part. Goes through the
  // same isLineOpen gate as the rest of the supply math so a "Completed"
  // PO from the Acumatica feed can't masquerade as a covering order.
  for (const po of (DB.pos || [])) {
    for (const ln of (po.lines || [])) {
      if (ln.pn !== part.pn) continue;
      if (!isLineOpen(po, ln)) continue;
      const remaining = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
      if (remaining <= 0) continue;
      const expRaw = ln.expectedDate || po.expectedDate;
      if (!expRaw) continue;
      const exp = new Date(expRaw);
      if (isNaN(exp)) continue;
      exp.setHours(0, 0, 0, 0);
      if (exp.getTime() <= runoutMs) return false; // covered
    }
  }

  // No covering PO. Risk only if an order is also actually needed.
  const sq = (typeof part._suggestedQty === "number") ? part._suggestedQty : suggestedQty(part);
  if (sq <= 0) return false;

  return { runoutDays: Math.ceil(runoutDays) };
}

// Phase 2 display helper. Returns the daily rate every chain member should
// SHOW in UI surfaces (drawer stat cell, parts catalog row, order queue row)
// so users see the same consumption rate on every link of the chain. The
// rate is the anchor's daily, copied (not stored) — the anchor remains the
// single source of truth and 19830's saved daily is never overwritten on
// CP00751 or JP00021.
//
// Same gating as _supersessionDemandBoost so the two stay consistent:
//   - lineage.length >= 2 (part is in a chain), AND
//   - at least one member of the chain is phasingOut (actively transitioning).
// Otherwise we return the part's own stored daily — normal parts unchanged.
//
// IMPORTANT: this is purely for display. suggestedQty / partStatus continue
// to read raw part.daily and apply their own max(part.daily, anchor.daily)
// where relevant — we don't double-apply here.
function chainDisplayDailySource(part) {
  const own = { daily: Number(part?.daily) || 0, anchorPn: null, transitioning: false, isAnchor: false };
  if (!part || !part.pn) return own;
  const lineage = supersessionLineage(part.pn);
  if (lineage.length < 2) return own;

  const partsByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  const transitioning = lineage.some(pn => {
    const p = partsByPn.get(pn);
    return !!(p && p.phasingOut);
  });
  const anchorPn = lineage[0];
  const isAnchor = (anchorPn === part.pn);
  if (!transitioning) return { ...own, anchorPn, isAnchor };

  const anchor = partsByPn.get(anchorPn);
  const daily = anchor ? (Number(anchor.daily) || 0) : (Number(part.daily) || 0);
  return { daily, anchorPn, transitioning: true, isAnchor };
}

function chainDisplayDaily(part) {
  return chainDisplayDailySource(part).daily;
}

/* ============================================================
   getChainInfo(pn) — SUPERSESSION-CHAIN MODEL (PHASE A)

   Single source of truth for chain-aware part numbers. Returns a
   combined view of a supersession chain's inventory, PO coverage,
   runout, status, and shortfall. Callers who need chain semantics
   read from here; callers who see `null` fall through to per-part
   logic (part is not in an actively-transitioning chain).

   PHASE A IS MODEL ONLY. No caller in the app reads this yet.
   Phase B will route Coverage Gaps, drawers, queues, dashboard
   through this function so the four views tell ONE story.

   DESIGN DECISIONS (locked with user):
     D3 CANONICAL RATE — chainRate = lineage[0].daily (the OLDEST
        predecessor, which is the part with real usage history and
        is currently phasing out). The successor's own stored daily
        is unreliable (little history) and is IGNORED for chain math.
     D4 ONE CHAIN RUNOUT — total chain supply / chainRate, from
        TODAY. Per-part per-pn runouts (as chainSequentialView
        currently produces them for the drawer's own view) are not
        used here.
     D2 CHAIN STATUS — applied to the combined chain runout against
        the SUCCESSOR's lead time (that's who we'll reorder from).
        A phasing-out predecessor that's covered by successor supply
        is NOT critical.

   TRAVERSAL: uses supersessionLineage (already in this file), which
   walks BACKWARD (predecessors via supersededBy pointing at me) and
   FORWARD (my own supersededBy chain). Any member of the chain
   returns the SAME chainInfo because the lineage is symmetric.

   ANCHOR IDENTIFICATION: lineage[0] is the oldest predecessor —
   matches chainSequentialView's existing convention. For a chain
   where the phasing-out part is NOT the anchor (e.g. mid-position),
   we still use the anchor's rate. If that's ever a problem in
   production data, revisit in Phase B.

   MULTI-HOP CHAINS: supported by construction — lineage.length can
   be > 2 and all members contribute to chainOnHand / chainOnPO.

   PRE-LAUNCH COMPOSITION: for a chain, we do NOT apply the
   pre-launch flat-hold. The chain is "actively transitioning"
   only when at least one member has phasingOut === true — meaning
   the predecessor IS currently consuming demand. Runout math uses
   TODAY as start regardless of the successor's transitionStartDate.
   The transitionStartDate is exposed on the returned `preLaunch`
   field for the drawer's banner text, but doesn't shift chain
   depletion timing. Standalone pre-launch parts (no phasing-out
   predecessor) get null from this function and fall through to
   preLaunchOrderBy(part).

   INVARIANTS:
     - Reads part.onHand and part.daily only. Never writes.
     - Reads DB.pos through isLineOpen; never mutates a PO line.
     - Overdue POs count as coverage (matches the shipped Coverage
       Gaps fix at commit abdabe9). The timing risk is a separate
       UI concern.

   RETURN SHAPE:
     null                        — pn not in a chain / chain not
                                    actively transitioning
     {
       chainParts: [pn, ...],    // ordered anchor → final
       anchorPn, anchor,         // lineage[0]
       finalPn, final,           // lineage[last]
       chainRate,                // anchor.daily
       chainOnHand,              // Σ max(0, member.onHand)
       chainOnPO,                // Σ open PO remaining across chain PNs
       chainPOLines: [           // per-line diagnostic
         { pn, poNum, poId, remaining, expectedDate, isOverdue }
       ],
       chainRunoutDate,          // combined supply / chainRate from today
       chainRunoutDays,          // calendar days from today (Infinity ok)
       chainStatus,              // "ok" | "warning" | "critical"
       chainStatusDetail: {
         leadDays,               // final member's lead time
         reorderBy,              // leadDays + safety
         warnDays,               // settings.alertWarning
         stockoutDay              // == chainRunoutDays
       },
       wantByDate,               // chainRunoutDate − 18 days (or TODAY)
       chainShort,               // clamped ≥ 0 units short by want-by
       preLaunch: null | {       // informational only for chains
         successorPn,
         transitionStartDate     // Date object
       }
     }
   ============================================================ */
function getChainInfo(pn) {
  if (!pn) return null;
  const target = String(pn).trim();
  if (!target) return null;
  const part = (DB.parts || []).find(p => p && p.pn === target);
  if (!part) return null;

  // Traversal — reuse the existing lineage walker (predecessors
  // backward via supersededBy pointing at me, successors forward).
  const lineage = (typeof supersessionLineage === "function")
    ? supersessionLineage(part.pn)
    : [];
  if (!lineage || lineage.length < 2) return null;

  const partsByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  const members = lineage.map(mpn => partsByPn.get(mpn)).filter(Boolean);
  if (members.length < 2) return null;

  // Active-transition gate — matches chainSequentialView's rule.
  const transitioning = members.some(m => m.phasingOut === true);
  if (!transitioning) return null;

  const anchor = members[0];
  const anchorPn = anchor.pn;
  const chainRate = Number(anchor.daily) || 0;
  const finalMember = members[members.length - 1];
  const finalPn = finalMember.pn;

  // Chain on-hand: sum of clamped on-hand across ALL members.
  // Clamped so a stocked-out (negative) member contributes 0.
  let chainOnHand = 0;
  for (const m of members) chainOnHand += Math.max(0, Number(m.onHand) || 0);

  // Chain on-PO: sum of open PO remaining across all chain PNs.
  // Overdue POs count as coverage (arrive-in-time in the abdabe9
  // semantic). isOverdue tracked per-line for downstream UI use.
  const chainPnSet = new Set(lineage);
  let chainOnPO = 0;
  const chainPOLines = [];
  for (const po of (DB.pos || [])) {
    for (const ln of (po.lines || [])) {
      if (!ln || !chainPnSet.has(ln.pn)) continue;
      if (typeof isLineOpen === "function" && !isLineOpen(po, ln)) continue;
      const remaining = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
      if (remaining <= 0) continue;
      const expRaw = ln.expectedDate || po.expectedDate;
      let expectedDate = null;
      let isOverdue = false;
      if (expRaw) {
        const parsed = (typeof parseDateLocal === "function")
          ? parseDateLocal(expRaw)
          : new Date(expRaw);
        if (parsed && !isNaN(parsed.getTime())) {
          expectedDate = parsed;
          isOverdue = parsed.getTime() < TODAY.getTime();
        }
      }
      chainOnPO += remaining;
      chainPOLines.push({
        pn: ln.pn,
        poNum: po.num,
        poId: po.id,
        remaining,
        expectedDate,
        isOverdue,
      });
    }
  }

  // Pre-launch composition (informational only for chains).
  let preLaunch = null;
  if (finalMember.transitionStartDate && typeof parseDateLocal === "function") {
    const s = parseDateLocal(finalMember.transitionStartDate);
    if (s && s.getTime() > TODAY.getTime()) {
      preLaunch = {
        successorPn: finalMember.pn,
        transitionStartDate: s,
      };
      // Note: no runout offset — chain is actively transitioning
      // (predecessor consuming today). See docstring rationale.
    }
  }

  // Chain runout — combined supply at chainRate, from today.
  const totalSupply = chainOnHand + chainOnPO;
  let chainRunoutDays = Infinity;
  let chainRunoutDate = null;
  if (chainRate <= 0) {
    chainRunoutDays = Infinity;
  } else if (totalSupply <= 0) {
    chainRunoutDays = 0;
    chainRunoutDate = new Date(TODAY);
  } else {
    const coverWorkdays = totalSupply / chainRate;
    const cal = workdaysToCalendarDays(coverWorkdays, TODAY);
    chainRunoutDays = cal > 365 ? Infinity : cal;
    if (chainRunoutDays !== Infinity) {
      chainRunoutDate = addDays(TODAY, chainRunoutDays);
    }
  }

  // Chain status — applied to the combined runout against the
  // successor's lead time (that's who we reorder from).
  const leadDays = (typeof leadTimeDays === "function")
    ? leadTimeDays(finalMember)
    : 0;
  const safety = (DB.settings && Number(DB.settings.safetyDays)) || 0;
  const warnDays = (DB.settings && (DB.settings.alertWarning ?? 14)) || 14;
  const reorderBy = leadDays + safety;
  let chainStatus = "ok";
  if (chainRunoutDays === Infinity) {
    chainStatus = "ok";
  } else if (chainRunoutDays <= reorderBy) {
    chainStatus = "critical";
  } else if (chainRunoutDays <= reorderBy + warnDays) {
    chainStatus = "warning";
  } else {
    chainStatus = "ok";
  }

  // Want-by — 18 days before chain runout, matching Coverage Gaps'
  // targetArrivalDate convention. If runout is < 18 days out (or
  // Infinity / unknown), want-by falls back to TODAY.
  let wantByDate = new Date(TODAY);
  if (chainRunoutDate && chainRunoutDays >= 18) {
    wantByDate = addDays(chainRunoutDate, -18);
  }

  // Chain short — demand accumulated from today through want-by
  // MINUS (chainOnHand + non-late-arriving coverage). Overdue POs
  // count as coverage. Clamped ≥ 0.
  const wpw = (typeof effectiveWorkdaysPerWeek === "function")
    ? effectiveWorkdaysPerWeek()
    : 5;
  const daysUntilWantBy = Math.max(0,
    Math.round((wantByDate.getTime() - TODAY.getTime()) / DAY_MS)
  );
  let workdaysToWantBy = 0;
  for (let i = 1; i <= daysUntilWantBy; i++) {
    const d = addDays(TODAY, i);
    if (typeof isWorkday === "function" && isWorkday(d, wpw)) workdaysToWantBy++;
  }
  const demandThroughWantBy = workdaysToWantBy * chainRate;
  let coverageInTime = 0;
  for (const l of chainPOLines) {
    if (l.isOverdue) { coverageInTime += l.remaining; continue; }
    if (!l.expectedDate) { coverageInTime += l.remaining; continue; }
    if (l.expectedDate.getTime() <= wantByDate.getTime()) coverageInTime += l.remaining;
  }
  const chainShort = Math.max(0, demandThroughWantBy - (chainOnHand + coverageInTime));

  return {
    chainParts: lineage.slice(),
    anchorPn,
    anchor,
    finalPn,
    final: finalMember,
    chainRate,
    chainOnHand,
    chainOnPO,
    chainPOLines,
    chainRunoutDate,
    chainRunoutDays,
    chainStatus,
    chainStatusDetail: {
      leadDays,
      reorderBy,
      warnDays,
      stockoutDay: chainRunoutDays,
    },
    wantByDate,
    chainShort,
    preLaunch,
  };
}

// PHASE A verification helper — console-callable to print a chain
// info block for a given PN. Diagnostic only; NOT read by any
// render code. Once Gate A passes and Phase B wires views through
// getChainInfo(), this printer can stay for future debugging.
function _printChainInfo(pn) {
  const info = getChainInfo(pn);
  if (!info) {
    console.log(`[chain] ${pn}: not in an actively-transitioning chain → per-part logic applies`);
    return null;
  }
  const iso = (d) => d ? d.toISOString().slice(0, 10) : "n/a";
  const lines = [
    `[chain] ${pn} (anchor ${info.anchorPn} → final ${info.finalPn}):`,
    `  chainParts:      [${info.chainParts.join(" → ")}]`,
    `  chainRate:       ${info.chainRate}/day (anchor ${info.anchorPn}.daily = ${info.anchor.daily})`,
    `  chainOnHand:     ${info.chainOnHand} (${info.chainParts.map(p => {
      const m = (DB.parts || []).find(x => x.pn === p);
      return `${p}=${m ? (m.onHand || 0) : "?"}`;
    }).join(", ")})`,
    `  chainOnPO:       ${info.chainOnPO}`,
  ];
  for (const l of info.chainPOLines) {
    lines.push(`     · ${l.pn} PO ${l.poNum}: ${l.remaining} units, exp ${iso(l.expectedDate)}${l.isOverdue ? " [OVERDUE]" : ""}`);
  }
  lines.push(
    `  chainRunoutDate: ${iso(info.chainRunoutDate)} (${info.chainRunoutDays === Infinity ? "∞" : info.chainRunoutDays + "d"})`,
    `  chainStatus:     ${info.chainStatus} (leadDays=${info.chainStatusDetail.leadDays}, reorderBy=${info.chainStatusDetail.reorderBy}, warnDays=${info.chainStatusDetail.warnDays})`,
    `  wantByDate:      ${iso(info.wantByDate)}`,
    `  chainShort:      ${info.chainShort}`,
    `  preLaunch:       ${info.preLaunch ? `successor ${info.preLaunch.successorPn} phases in ${iso(info.preLaunch.transitionStartDate)}` : "no"}`,
  );
  console.log(lines.join("\n"));
  return info;
}
window.getChainInfo = getChainInfo;
window._printChainInfo = _printChainInfo;

// Most recent PO line for this SKU. "Latest" = newest PO createdDate that is
// NOT in the future (guards the known future-dated createdDate typos); if all
// candidates are future/invalid, fall back to newest regardless.
function lastPOPrice(pn) {
  if (!pn || !Array.isArray(DB.pos)) return null;
  const cands = [];
  for (const po of DB.pos) {
    for (const ln of (po.lines || [])) {
      if (ln.pn !== pn) continue;
      const d = po.createdDate ? new Date(po.createdDate) : null;
      cands.push({ cost: ln.cost || 0, qty: ln.qty || 0, date: d, poNum: po.num || po.id });
    }
  }
  if (!cands.length) return null;
  const notFuture = cands.filter(c => c.date && !isNaN(c.date) && c.date <= TODAY);
  const pool = notFuture.length ? notFuture : cands;
  pool.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
  return pool[0]; // { cost, qty, date, poNum }
}

// Unit cost decision for SUGGESTED-ORDER pricing. Returns a full provenance
// record so the part drawer can show *which* side won and why. Two pricing
// sources compete:
//   • the manual cost in part.cost, stamped at edit time as part.costUpdatedAt
//   • the last PO line's unit cost (lastPOPrice(pn)), dated by PO createdDate
//
// Rule: NEWER WINS. Tie → manual (the user edited it just now, give them the
// benefit). If manual lacks a costUpdatedAt (legacy / never edited since this
// feature shipped), fall back to the prior behavior — last PO wins — so old
// parts keep pricing from purchase history until someone re-saves them.
//
// Returns { cost, source, date, poNum }:
//   source = "manual" | "po" | "none"
//   date   = Date | null   (the winning side's stamp, for the UI tag line)
//   poNum  = string | null (only populated when source === "po")
//
// On-hand inventory valuation and the inventory-value KPI still read raw
// part.cost — only the suggested-order math reaches through this.
function orderUnitCostSource(part) {
  const manualCost = Number(part?.cost) || 0;
  const manualDateRaw = part?.costUpdatedAt || null;
  const manualDate = manualDateRaw ? new Date(manualDateRaw) : null;
  const manualValid = !!manualDate && !isNaN(manualDate);

  const lp = lastPOPrice(part?.pn);
  const poCost = (lp && lp.cost > 0) ? lp.cost : 0;
  const poDate = (lp && lp.date && !isNaN(lp.date)) ? lp.date : null;

  // Both sides usable AND we have a manual edit date → compare recency.
  if (poCost > 0 && manualCost > 0 && manualValid && poDate) {
    if (manualDate.getTime() >= poDate.getTime()) {
      return { cost: manualCost, source: "manual", date: manualDate, poNum: null };
    }
    return { cost: poCost, source: "po", date: poDate, poNum: lp.poNum || null };
  }
  // Either no manual edit date or one side is zero — last-PO-wins fallback.
  if (poCost > 0) {
    return { cost: poCost, source: "po", date: poDate, poNum: lp.poNum || null };
  }
  if (manualCost > 0) {
    return { cost: manualCost, source: "manual", date: manualValid ? manualDate : null, poNum: null };
  }
  return { cost: 0, source: "none", date: null, poNum: null };
}

function orderUnitCost(part) {
  return orderUnitCostSource(part).cost;
}

// True when there's no usable purchase price (no PO history AND no stored
// cost). Mostly kit/FG SKUs that are built, not bought. Used to keep these
// out of suggested-value rollups and to flag them visually.
function hasNoOrderCost(part) {
  return orderUnitCost(part) <= 0;
}

// Snapshot all parts with computed status — heavy compute, cache?
let _statusCache = null;
let _statusCacheVer = 0;
function bumpStatusCache() { _statusCacheVer++; _statusCache = null; }

// Supplier mute — independent from itemType="do_not_order". A muted
// supplier's parts keep their TRUE computed status in _rawStatus, but their
// public-facing status is forced to "ok" so they fall out of every alert
// filter (header counts, dashboard tiles, queues, suggested-order $).
// Supplier-facing surfaces should read (p._rawStatus || p.status) instead.
//
// Comparison uses supplierKey() (js/02-utils.js) on BOTH sides so muting
// "FASTENAL COMPANY" also mutes parts/POs whose supplier field arrives
// from Acumatica as "Fastenal" or "Fastenal, Inc." The stored list keeps
// the ORIGINAL name as entered — normalization is compare-time only, so
// the Suppliers settings surface can still show the user what they typed.
function isSupplierMuted(name) {
  if (!name) return false;
  const list = (DB.settings && DB.settings.mutedSuppliers) || [];
  const k = supplierKey(name);
  if (!k) return false;
  return list.some(s => supplierKey(s) === k);
}

function toggleSupplierMute(name) {
  if (!name) return;
  if (!Array.isArray(DB.settings.mutedSuppliers)) DB.settings.mutedSuppliers = [];
  const list = DB.settings.mutedSuppliers;
  // Matching uses supplierKey() on BOTH sides so an unmute click on
  // "Fastenal" correctly targets a previously-stored "FASTENAL COMPANY"
  // (or any other spelling that folds to the same key). Without this,
  // the raw case-insensitive compare would miss and the else-branch
  // below would APPEND a duplicate — leaving the supplier permanently
  // muted with a dead unmute button.
  //
  // Unmute uses filter() (not splice-at-first-match) so a pre-existing
  // duplicated state — e.g. ["FASTENAL COMPANY", "Fastenal"] from a
  // pre-fix era where the buggy toggle appended variants — fully
  // clears in one click. One user intent = one operation, regardless
  // of how many equivalent entries were sitting in the list.
  //
  // On ADD, we still push the ORIGINAL `name` as entered so the stored
  // list reflects what the user typed; normalization is compare-time
  // only. Same rule isSupplierMuted follows.
  const targetKey = supplierKey(name);
  const wasMuted = list.some(s => supplierKey(s) === targetKey);
  if (wasMuted) {
    // In-place: strip every matching entry so any consumer holding the
    // array reference stays valid. Mutation invariant matches the rest
    // of DB.settings.* — assign length + push, never reassign.
    const kept = list.filter(s => supplierKey(s) !== targetKey);
    list.length = 0;
    for (const s of kept) list.push(s);
  } else {
    list.push(name);
  }
  saveDB();
  bumpStatusCache();
  logAudit("settings", `${wasMuted ? "Unmuted" : "Muted"} supplier alerts: ${name}`, { supplier: name });
  openSupplierDetail(name); // re-render drawer in new state
  refresh();                // re-render underlying page
}

function partsWithStatus() {
  if (_statusCache) return _statusCache;
  // Build the per-PN open-PO-line index ONCE and reuse it so we don't
  // rescan DB.pos for every part during the .map below.
  const lineIndex = _buildOpenPOLineIndex();
  const out = DB.parts.map(p => {
    const lines = lineIndex.get(p.pn);
    const onPO = lines ? openPOQty(p.pn, lines) : 0;
    const isKitVal = typeof isKit === "function" ? isKit(p) : false;

    // Phase 2: every member of an actively-transitioning chain gets an
    // effective view fed to partStatus, so the sequential burn-down shows up
    // in days-of-cover / status / runway for ALL of them — not just the
    // final part. cumulativeStockThroughThis is "everything ahead of me in
    // line plus what I have", so the anchor depletes first (0 if stocked
    // out), then each successor in order. Anchor's daily is the chain rate.
    const view = chainSequentialView(p);
    const effectiveForStatus = view
      ? { ...p, onHand: view.cumulativeStockThroughThis, daily: Math.max(Number(p.daily) || 0, view.chainRate) }
      : p;
    const status = partStatus(effectiveForStatus, lines);

    const muted = isSupplierMuted(p.supplier);
    // Pre-launch superseding parts are gated the same way muted-supplier parts
    // are: keep the TRUE computed status in _rawStatus, but force the public
    // status to "ok" so they fall out of every alert/queue surface (queues,
    // dashboard KPIs, nav badges, topbar). Order soon/behind for a pre-launch
    // part is computed relative to its start date on the Model Year page, not
    // here. Evaluated after mute so either condition silences the part.
    const preLaunch = isPreLaunch(p);
    // Compute the pre-launch order-by ONCE per pass so downstream
    // consumers (Parts Catalog row "ORDER NOW" pill, drawer banner,
    // any future dashboard aggregate) all read the same value from
    // the shared helper. undefined for non-pre-launch parts (0 memory).
    const preLaunchOB = preLaunch ? preLaunchOrderBy(p) : null;
    // CHAIN AWARENESS (Phase B): if the part is in an actively-
    // transitioning supersession chain, override status + daysOfCover
    // with combined chain values from getChainInfo(). Every downstream
    // consumer reading p.status (queueParts, dashboard KPIs, follow-ups
    // grouping) and p.daysOfCover automatically becomes chain-aware —
    // one source of truth, no per-view drift risk. The chain has ONE
    // status; a phasing-out predecessor covered by its successor is
    // NOT critical.
    //
    // Precedence: mute > chain > pre-launch. Muted is user-explicit
    // silence and always wins. Chain wins over pre-launch because a
    // chain is "actively transitioning" — the predecessor is currently
    // consuming, so the pre-launch flat-hold doesn't apply. Standalone
    // pre-launch parts (no phasing-out predecessor) return null from
    // getChainInfo and fall through to preLaunch logic unchanged.
    const chainInfo = (typeof getChainInfo === "function") ? getChainInfo(p.pn) : null;
    return {
      ...p,
      onPO,
      isKit: isKitVal,
      ...status,
      // MUTED-supplier override.
      ...(muted ? { _muted: true, _rawStatus: status.status, status: "ok", urgency: 9999 } : {}),
      // PRE-LAUNCH override — skipped when in an active chain (chain
      // wins). Standalone pre-launch (no chain) behaves exactly as
      // before the chain wiring.
      ...(preLaunch && !chainInfo ? {
        _preLaunch: true,
        status: "ok",
        urgency: 9999,
        _preLaunchOrderBy: preLaunchOB && preLaunchOB.orderByDate ? preLaunchOB.orderByDate : null,
        _preLaunchOrderByPassed: !!(preLaunchOB && preLaunchOB.orderByPassed),
      } : {}),
      // CHAIN override — the wiring for Phase B. Skipped when muted
      // (mute wins). Every field consumed by downstream views is
      // reassigned to the chain-level value; per-part values are
      // preserved on _perPartStatus / _perPartDaysOfCover for
      // drawer footnotes.
      //
      // Dedupe: _isChainRepresentative marks the successor (final)
      // as the representative for LIST views (Coverage Gaps). Other
      // members are silenced there so a chain shows once. Dashboard
      // counts naturally dedupe via queueParts's !p.phasingOut
      // filter (predecessors don't reach the queue).
      ...(chainInfo && !muted ? {
        _chainInfo: chainInfo,
        _isChainMember: true,
        _isChainAnchor: chainInfo.anchorPn === p.pn,
        _isChainFinal: chainInfo.finalPn === p.pn,
        _isChainRepresentative: chainInfo.finalPn === p.pn,
        _perPartStatus: status.status,
        _perPartDaysOfCover: status.daysOfCover,
        status: chainInfo.chainStatus,
        urgency: chainInfo.chainRunoutDays === Infinity ? 9999 : chainInfo.chainRunoutDays,
        daysOfCover: chainInfo.chainRunoutDays,
        stockoutDay: chainInfo.chainRunoutDays,
        leadDays: chainInfo.chainStatusDetail.leadDays,
        reorderBy: chainInfo.chainStatusDetail.reorderBy,
      } : {}),
      _suggestedQty: suggestedQty(p, onPO),
      ...(view && view.isFinal ? { _chainBoost: _supersessionDemandBoost(p) } : {}),
    };
  });
  _statusCache = out;
  return out;
}

/* ============================================================
   QUEUE ELIGIBILITY — single source of truth for "what parts
   show up in an order queue today". Used by the queue page, the
   topbar, the dashboard KPIs, and the nav badges so they can
   never drift apart.
   ============================================================ */

// True iff `part.itemType` is one of the three queue itemTypes
// (base_bom / options / service). Parts with a blank/undefined
// itemType — OR itemType === "do_not_order" — are NOT queue-eligible
// and don't get counted anywhere visible. The dashboard surfaces
// any critical parts that fall outside this set as "(+N untagged)"
// so they don't silently disappear.
const _QUEUE_ITEM_TYPES = new Set(["base_bom", "options", "service"]);
function isQueueEligible(part) {
  return !!(part && _QUEUE_ITEM_TYPES.has(part.itemType));
}

// TRUE when a part is intentionally excluded from reorder signals — either
// itemType === "do_not_order" (the ITEM TYPE dropdown in the part drawer;
// see js/10-page-parts.js) OR phasingOut === true (the "Stop reordering —
// burn down existing stock" checkbox on the same drawer). Both flags mean
// "no future PO should be placed for this part," so critical/warning
// counters on any supplier-facing / queue-facing surface should skip it.
//
// Single-place predicate so the composite rule doesn't drift. Existing
// call sites (Dashboard "untagged critical" safety net, nav badges,
// queueParts, order queue) inline the same two checks today and can be
// refactored to call this helper in a follow-up commit; this turn adds
// it and wires it into the Suppliers aggregation.
function isReorderSuppressed(part) {
  if (!part) return false;
  if (part.itemType === "do_not_order") return true;
  if (part.phasingOut) return true;
  return false;
}

// PRE-LAUNCH GATE — a superseding part carries a planner-owned
// transitionStartDate (the cut-in date it's allowed to go live). While that
// date is still in the FUTURE the part is "pre-launch": not real demand yet,
// so it must not throw purchasing signals (critical/warn, days-cover stockout,
// the three order queues, reorder-overdue copy) as if it were live.
//
// This is the single shared predicate. It's applied in ONE place that gates all
// of the above — partsWithStatus() forces a pre-launch part's public status to
// "ok" (the same mechanism supplier-mute already uses), so every status-driven
// surface (queues via queueParts, dashboard KPIs, nav badges, topbar counts)
// drops it without any of them forking their own date logic. The part drawer
// and the Model Year page read this predicate directly for their own copy.
//
// Returns false for a blank / invalid / today-or-past date, so parts without a
// start date — or already launched — behave exactly as before.
function isPreLaunch(part) {
  if (!part || !part.transitionStartDate) return false;
  const d = (typeof parseDateLocal === "function")
    ? parseDateLocal(part.transitionStartDate)
    : null;
  if (!d) return false;
  return d.getTime() > TODAY.getTime();
}

// PRE-LAUNCH ORDER-BY — deadline by which a replenishment must be placed
// for a pre-launch part. min() of two constraints, each conditionally
// applicable:
//
//   C1 (need stock BY launch, transitionStartDate − leadTime):
//       Applicable when EITHER C1 is still in the future OR on-hand at
//       launch is zero. If on-hand > 0 and C1 has passed, the part
//       already has SOME stock at launch — C1 is satisfied trivially
//       and provides no actionable deadline. Skipped.
//
//   C2 (need reorder BEFORE stockout, projectedRunout − leadTime):
//       Always applicable. Projected runout = transitionStartDate +
//       workdaysToCalendarDays(onHand / dailyUse, transitionStartDate).
//       Uses the same workday-conversion the rest of the runway math
//       uses, so C2's date agrees with the runway chart's slope.
//
// Returns { orderByDate, orderByPassed } — the EARLIER of the applicable
// constraints, and a flag when orderByDate is in the past. Returns null
// for parts that aren't pre-launch or lack daily/lead data.
//
// SINGLE SOURCE OF TRUTH: drawer banner + Parts Catalog "ORDER NOW" pill
// + partsWithStatus's _preLaunchOrderBy field all call this. Any surface
// showing a pre-launch order-by MUST come here (grep-verifiable).
function preLaunchOrderBy(part) {
  if (!part || !isPreLaunch(part)) return null;
  const startD = (typeof parseDateLocal === "function")
    ? parseDateLocal(part.transitionStartDate)
    : null;
  if (!startD) return null;
  const leadDays = leadTimeDays(part);
  const daily = Number(part.daily) || 0;
  const onHand = Number(part.onHand) || 0;
  const nowMs = TODAY.getTime();

  // C1: launch − lead. Actionable when future OR when on-hand at launch
  // is zero (nothing to bridge from — a fresh order must land ON launch).
  const c1 = addDays(startD, -leadDays);
  const c1Actionable = c1.getTime() >= nowMs || onHand <= 0;

  // C2: runout − lead. Requires daily > 0 to compute a finite runout.
  let c2 = null;
  if (daily > 0 && onHand > 0) {
    const coverWorkdays = onHand / daily;
    const coverCalendar = workdaysToCalendarDays(coverWorkdays, startD);
    const runoutD = addDays(startD, coverCalendar);
    c2 = addDays(runoutD, -leadDays);
  }

  const candidates = [];
  if (c1Actionable) candidates.push(c1);
  if (c2) candidates.push(c2);
  if (candidates.length === 0) return null;

  const orderByDate = candidates.reduce((a, b) => a.getTime() < b.getTime() ? a : b);
  const orderByPassed = orderByDate.getTime() < nowMs;
  return { orderByDate, orderByPassed };
}

// Returns the parts that would appear in an order queue before any
// toolbar/header filters are applied. Callers can narrow further
// (e.g. dashboard wants critical-only; queue applies search/supplier/
// buyer/days-cover filters on top of this).
//
// Rules — kept in lock-step with renderOrderQueueFor's needsOrder:
//   - itemType:
//       passed value  → exact match for that queue (base_bom/options/service)
//       null/undef    → union of all three real queues (isQueueEligible)
//   - !isKit              (kits are tracked separately; can't be ordered)
//   - !phasingOut         (no order to place for a phasing-out part;
//                          the chain's final successor still appears
//                          under its own itemType)
//   - status in { critical, warning }
//   - status here is the effective status from partsWithStatus, which
//     already forces muted-supplier parts to "ok" — so muted parts
//     naturally drop out without an extra check.
//
// queueParts() (no arg) === union of queueParts("base_bom"), queueParts("options"),
// queueParts("service") — same predicate, no untagged leakage.
function queueParts(itemType) {
  let stats = partsWithStatus();
  if (itemType) stats = stats.filter(p => p.itemType === itemType);
  else stats = stats.filter(p => isQueueEligible(p));
  stats = stats.filter(p => !p.isKit);
  return stats.filter(p =>
    (p.status === "critical" || p.status === "warning") &&
    !p.phasingOut
  );
}

/* ============================================================
   AUDIT
   ============================================================ */
function logAudit(type, msg, detail = {}) {
  DB.audit.unshift({
    id: "audit_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8),
    ts: new Date().toISOString(),
    type, msg, detail,
  });
  // cap audit log
  if (DB.audit.length > 2000) DB.audit.length = 2000;
}
