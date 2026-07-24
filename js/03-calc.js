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
   WORKDAY ⇄ CALENDAR conversion (shared, single source of truth)

   dailyUse is a PER-WORKDAY rate (units consumed per working day — the usage
   page divides by workdays, not calendar days). So "(onHand + incoming) /
   dailyUse" is a count of WORKDAYS of cover, and it must be walked across the
   calendar skipping non-workdays to land on the real runout DATE — NOT added
   as calendar days (the bug) and NOT scaled by a 7/5 average (imprecise).

   The INVERSE direction has the SAME anti-average rule: given a calendar-day
   window (lead + safety + horizon), the workdays of demand it accumulates
   depends on which weekday the anchor falls on. calendarDaysToWorkdays walks
   the partial week via isWorkday for exactness — same shape as its forward
   sibling — so a 30-day horizon starting Tue-Wed and starting Fri-Sat give
   different (correct) workday counts.

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

// Convert a number of CALENDAR days (starting from `startDate + 1`, matching
// workdaysToCalendarDays's cursor convention) into the count of WORKDAYS that
// fall inside that interval. Same anchor-and-partial-week shape as its
// sibling: whole 7-day weeks contribute exactly wpw workdays each
// (independent of phase, because any 7 consecutive calendar days hold wpw
// workdays), then the remaining ≤6 days are walked via isWorkday. O(1) up
// to a fixed small constant.
//
// Round-trip property: workdaysToCalendarDays(calendarDaysToWorkdays(n)) ≤ n
// for every n. The equality holds when day n lands on a workday; when day n
// lands on a weekend the forward sibling snaps back to the nearest earlier
// workday (never a later day). See _printQtyImpact's round-trip block for
// the full 1..200 check.
function calendarDaysToWorkdays(calDays, startDate = TODAY, wpw = effectiveWorkdaysPerWeek()) {
  if (!Number.isFinite(calDays) || calDays <= 0) return 0;
  if (wpw >= 7) return Math.floor(calDays);
  const n = Math.floor(calDays);
  if (n <= 0) return 0;
  const fullWeeks = Math.floor(n / 7);
  let workdays = fullWeeks * wpw;
  const anchorOffset = fullWeeks * 7;
  const remainder = n - anchorOffset;   // 0..6
  for (let i = 1; i <= remainder; i++) {
    if (isWorkday(addDays(startDate, anchorOffset + i), wpw)) workdays += 1;
  }
  return workdays;
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

// Sensourcing-blanket supply gate. Same body as isLineOpen except that
// blanket lines PASS when (a) the PO's supplier is on a cycle (Sensourcing
// today via getSupplierCycle) AND (b) the line has a valid expectedDate
// AND (c) the line's blanketOpenQty is > 0. Missing expectedDate is NOT
// backfilled — we never invent an arrival day for a blanket receipt.
//
// This is a SUPPLY gate: it answers "does this line count as incoming
// stock on a specific day?" NOT "is this a normal PO in flight?" The
// latter is isLineOpen's job and remains blanket-blind — RELEASE reads
// openPOQty (isLineOpen) and must keep firing when only a blanket exists.
//
// Consumers: projectOnHand (drawer-chart path, opts.includeBlanketSupply)
// and the blanketIncomingQty() sibling helper that feeds suggestedQty /
// cycleAwareSuggestedQty's `have`. Nothing else routes through this.
function isLineIncomingSupply(po, ln) {
  if (!isActivePO(po)) return false;
  if (!ln) return false;
  const lnStatus = String(ln.status || "").toLowerCase().trim();
  if (_CLOSED_LINE_STATUSES.has(lnStatus)) return false;
  const lnAcum = String(ln.acumStatus || "").toLowerCase().trim();
  if (lnAcum && _CLOSED_ACUM_STATUSES.has(lnAcum)) return false;
  if (isBlanketLine(ln)) {
    // Sensourcing-only promotion. Non-cycled suppliers' blankets stay
    // out of every supply consumer (byte-identical to today).
    const cycle = (typeof getSupplierCycle === "function") ? getSupplierCycle(po.supplier) : null;
    if (!cycle) return false;
    if (!ln.expectedDate) return false;   // no invented arrival date
    if (Math.max(0, Number(ln.blanketOpenQty || 0)) <= 0) return false;
    return true;
  }
  // Normal line — same checks isLineOpen applies past its blanket gate.
  if (ln.openQty !== undefined && ln.openQty !== null && Number(ln.openQty) <= 0) return false;
  const qty = Number(ln.qty || 0);
  if (qty <= 0) return false;
  const recv = Number(ln.qtyReceived != null ? ln.qtyReceived : (ln.recv != null ? ln.recv : 0));
  if (recv >= qty) return false;
  return true;
}

// Per-line "remaining" resolver for supply consumers. Blanket lines
// read blanketOpenQty (post-releases remaining); normal lines read the
// classic qty-minus-qtyReceived delta. Called by _buildSupplyLineIndex
// and projectOnHand's supply-gate full-scan branch.
function _lineIncomingRemaining(ln) {
  if (isBlanketLine(ln)) {
    return Math.max(0, Number(ln.blanketOpenQty || 0));
  }
  return Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
}

// Companion to _buildOpenPOLineIndex for supply-inclusive consumers.
// Same { ln, remaining, po } shape so callers can pass slices to
// projectOnHand's precomputed-lines branch without shape adaptation.
// Sensourcing blanket lines land in this index; every other blanket
// line stays out, matching isLineIncomingSupply's gate.
function _buildSupplyLineIndex() {
  const map = new Map();
  for (const po of (DB.pos || [])) {
    for (const ln of (po.lines || [])) {
      if (!isLineIncomingSupply(po, ln)) continue;
      const remaining = _lineIncomingRemaining(ln);
      if (!remaining) continue;
      let arr = map.get(ln.pn);
      if (!arr) { arr = []; map.set(ln.pn, arr); }
      arr.push({ ln, remaining, po });
    }
  }
  return map;
}

// Sum of Sensourcing-blanket remaining supply for one pn. Feeds
// suggestedQty / cycleAwareSuggestedQty's `have` — nets the blanket
// against target-window demand so a blanket-covered Sensourcing part
// stops asking for a full-size order. NOT time-phased: the netting
// happens regardless of arrival date. Callers still need to name the
// stockout-before-arrival gap when reporting the sized qty.
function blanketIncomingQty(pn) {
  const target = String(pn || "").trim();
  if (!target) return 0;
  let total = 0;
  for (const po of (DB.pos || [])) {
    if (!isActivePO(po)) continue;
    for (const ln of (po.lines || [])) {
      if (String(ln.pn || "").trim() !== target) continue;
      if (!isBlanketLine(ln)) continue;
      if (!isLineIncomingSupply(po, ln)) continue;
      total += Math.max(0, Number(ln.blanketOpenQty || 0));
    }
  }
  return total;
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
    // opts.includeBlanketSupply routes the full-scan through
    // isLineIncomingSupply, which admits Sensourcing blanket lines with
    // a valid expectedDate and reads their remaining via
    // _lineIncomingRemaining (blanketOpenQty). Default is
    // isLineOpen — byte-identical to the pre-split scan so Coverage
    // Gaps, dashboard KPIs, and every other caller that does NOT set
    // the opt behave as they did today.
    const useSupplyGate = !!opts.includeBlanketSupply;
    for (const po of (DB.pos || [])) {
      for (const ln of (po.lines || [])) {
        if (ln.pn !== part.pn) continue;
        if (useSupplyGate) {
          if (!isLineIncomingSupply(po, ln)) continue;
        } else {
          if (!isLineOpen(po, ln)) continue;
        }
        const remaining = useSupplyGate
          ? _lineIncomingRemaining(ln)
          : Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
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
  // HARD CUT-IN chart mode (opts.hardCutin) — when the caller (drawer chart
  // for a chain successor) passes hardCutin state, we plot predecessor stock
  // depleting during phase 1, then strand any leftover at the cut-in day
  // (visible cliff), then phase 2 depletion of ownStock + own PO receipts.
  // Absent opts.hardCutin → this branch is inert and behavior is byte-
  // identical for every other caller.
  const hardCutin = opts && opts.hardCutin ? opts.hardCutin : null;
  const cutinMs = hardCutin && hardCutin.hardCutinDate
    ? hardCutin.hardCutinDate.getTime() : null;
  const precutinRate = hardCutin ? (Number(hardCutin.chainRate) || 0) : 0;
  let predStock = hardCutin ? Math.max(0, Number(hardCutin.predecessorStock) || 0) : 0;
  const wpw = effectiveWorkdaysPerWeek();
  for (let i = 0; i <= days; i++) {
    const d = addDays(TODAY, i);
    const dMs = d.getTime();
    const beforeCutin = hardCutin && cutinMs && dMs < cutinMs;
    // Skip depletion until we reach transitionStartDate. Receipts still
    // land on their real calendar offset — a PO scheduled to arrive
    // before phase-in bumps the flat pre-launch line up on its arrival
    // day, which is the correct behavior (stock accumulates before
    // consumption starts).
    const consuming = !startMs || d.getTime() >= startMs;
    if (i > 0 && isWorkday(d, wpw)) {
      if (beforeCutin && predStock > 0) {
        // Phase 1: burn predecessor at chainRate (per workday).
        predStock = Math.max(0, predStock - precutinRate);
      } else if (consuming) {
        // Phase 2 or non-hardCutin path: existing per-workday depletion.
        oh -= (part.daily || 0);
      }
    }
    oh += receipts[i];
    // Series `oh` during phase 1 (hardCutin active) — three cases:
    //   predStock > 0 : predStock + oh  (predecessor is the live coverage;
    //                    own stock physically present via early receipts is
    //                    added to the chart honestly. At cut-in predStock
    //                    drops out and displayOh becomes `oh` — cliff of
    //                    EXACTLY strandedPredecessorQty.)
    //   predStock == 0 (predecessor EXHAUSTED PRE-CUT-IN) : 0
    //                    The chain is out of coverage. Own stock still
    //                    physically accumulates in `oh` but is not
    //                    consumable yet — displaying it as coverage would
    //                    be false (the successor is not live). The runout
    //                    day, computed independently by _chainHardCutinSupply
    //                    (workdaysToCalendarDays(predecessorStock/chainRate)),
    //                    lands on the same day the chart line first touches
    //                    zero here, so header text and chart agree.
    //   phase 2 : oh    (successor is live; own + receipts deplete normally)
    // Non-hardCutin path unchanged because beforeCutin is false — falls
    // straight through to `oh`.
    const displayOh = beforeCutin
      ? (predStock > 0 ? predStock + oh : 0)
      : oh;
    series.push({ d, oh: displayOh, recv: receipts[i] });
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

// Sensourcing-scoped first-zero variant of daysUntilStockout. Scans the
// projection day-by-day and returns the FIRST index where on-hand crosses
// to <= 0, or Infinity if it never does. This is deliberately NOT the
// lastPositive+1 shape of daysUntilStockout: blanket receipts create
// gap-then-refill projections (part runs dry, blanket lands, oh recovers),
// exactly the pattern lastPositive+1 mishandles by reporting the ULTIMATE
// stockout day and hiding the real gap.
//
// Called by partStatusBlanketAware (Sensourcing branch of partsWithStatus)
// with a supply-inclusive lines slice. daysUntilStockout stays untouched
// so every other consumer of it (non-Sensourcing parts, Coverage Gaps,
// dashboard KPIs, drawer, etc.) is byte-identical.
function daysUntilFirstZero(part, supplyLines) {
  const daily = Number(part.daily) || 0;
  if (daily <= 0) return Infinity;
  // No supply → workday cover from onHand only (byte-identical shape to
  // daysUntilStockout's no-incoming branch so a Sensourcing part with no
  // open PO AND no blanket resolves the same way).
  if (!supplyLines || supplyLines.length === 0) {
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
  const series = projectOnHand(part, 365, supplyLines);
  for (let i = 0; i < series.length; i++) {
    if (series[i].oh <= 0) return i;
  }
  return Infinity;
}

// Sensourcing-scoped status wrapper. Same shape as partStatus (same
// return fields) but reads daysUntilFirstZero instead of
// daysUntilStockout so blanket receipts count as supply and gap-then-
// refill patterns still surface the gap. partStatus stays untouched
// for every non-Sensourcing caller.
function partStatusBlanketAware(part, supplyLines) {
  const lt = leadTimeDays(part);
  const safety = DB.settings.safetyDays || 0;
  const warnDays = DB.settings.alertWarning ?? 14;
  const stockoutDay = daysUntilFirstZero(part, supplyLines);
  const reorderBy = lt + safety;
  let status = "ok";
  let urgency = 9999;
  if (stockoutDay === Infinity) {
    status = "ok";
    urgency = 9999;
  } else if (stockoutDay <= reorderBy) {
    status = "critical";
    urgency = stockoutDay;
  } else if (stockoutDay <= reorderBy + warnDays) {
    status = "warning";
    urgency = stockoutDay;
  } else {
    status = "ok";
    urgency = stockoutDay;
  }
  return { status, urgency, stockoutDay, leadDays: lt, reorderBy, daysOfCover: stockoutDay };
}

// Shared min-triggerDate helper. Extracted from the row-map so
// partsWithStatus (force-admit predicate) and renderOrderQueueFor
// (RELEASE badge decision) resolve triggerDate the same way, and any
// future consumer inherits it. Returns { triggerDate, daysToTrigger,
// inWindow } given a runoutDaysOfCover (any calendar-days number,
// finite = a valid runout, Infinity or non-finite = no runout) and
// an optional transitionStartDate string. inWindow uses the 21-day
// calendar threshold.
function _computeTriggerFromRunoutAndTransition(runoutDaysOfCover, transitionStartDate) {
  let runoutDate = null;
  if (Number.isFinite(runoutDaysOfCover) && typeof addDays === "function") {
    runoutDate = addDays(TODAY, runoutDaysOfCover);
  }
  let transitionDate = null;
  if (transitionStartDate && typeof parseDateLocal === "function") {
    const parsed = parseDateLocal(transitionStartDate);
    if (parsed && !isNaN(parsed.getTime())) transitionDate = parsed;
  }
  let triggerDate = null;
  if (runoutDate && transitionDate) {
    triggerDate = runoutDate.getTime() <= transitionDate.getTime() ? runoutDate : transitionDate;
  } else if (runoutDate) {
    triggerDate = runoutDate;
  } else if (transitionDate) {
    triggerDate = transitionDate;
  }
  const daysToTrigger = triggerDate
    ? Math.round((triggerDate.getTime() - TODAY.getTime()) / DAY_MS) : null;
  const inWindow = daysToTrigger !== null && daysToTrigger <= 21;
  return { triggerDate, daysToTrigger, inWindow };
}

// Shared window→demand conversion. Given a CALENDAR-day window and a
// PER-WORKDAY consumption rate, returns the units demanded across the
// window. Calendar days are walked into workdays via calendarDaysToWorkdays
// so the mixed-units bug (calendar × per-workday) doesn't happen at any
// call site. suggestedQty and cycleAwareSuggestedQty both call this.
// startDate defaults to TODAY, matching the runway/days-cover convention.
function _windowDemandUnits(calendarWindowDays, dailyRatePerWorkday, startDate = TODAY) {
  const rate = Number(dailyRatePerWorkday) || 0;
  if (rate <= 0) return 0;
  const workdays = calendarDaysToWorkdays(calendarWindowDays, startDate);
  return workdays * rate;
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
//
// UNITS: (lt + safety + horizon) is CALENDAR days; part.daily / chainRate is
// PER-WORKDAY. `target = window × rate` is only correct after the calendar
// window is converted into workdays. _windowDemandUnits does that via
// calendarDaysToWorkdays (same anchor-and-partial-week walker style as
// workdaysToCalendarDays). The prior formula multiplied calendar × per-
// workday directly, inflating every suggested qty by ~7/wpw (~40% at
// wpw=5) — see _printQtyImpact for the per-part before/after delta.
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
  const target = _windowDemandUnits(lt + safety + horizon, dailyRate);

  // Effective supply. When boosted, every predecessor's on-hand counts as
  // stock we'll consume first — only the final part has open POs that we
  // count (predecessor POs are excluded per spec; in practice they're
  // cancelled when a part phases out).
  const onPOQty = (typeof onPO === "number") ? onPO : openPOQty(part.pn);
  // Sensourcing-blanket incoming supply nets into `have` so a
  // blanket-covered part doesn't get sized for a full order. NOT
  // time-phased — the blanket qty offsets target-window demand
  // regardless of arrival date. The stockout-before-arrival gap must
  // be surfaced separately by any caller reporting the sized qty.
  const blanketIncoming = (typeof blanketIncomingQty === "function") ? blanketIncomingQty(part.pn) : 0;
  const have = boost
    ? boost.combinedOnHand + onPOQty + blanketIncoming
    : (part.onHand || 0) + onPOQty + blanketIncoming;

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
// HARD CUT-IN — single source of truth for the "predecessor stock is stranded
// at transitionStartDate" rule. Both getChainInfo (chain rollup) and
// chainSequentialView (drawer chart) route through this so status / runout /
// order-by / suggested-qty / chart all agree.
//
// Returns null when the final chain member has no valid transitionStartDate.
// The null return signals "use legacy fully-combined math, byte-identical to
// today." A cut-in date that has ALREADY PASSED still applies (predecessor
// stock stranded from that date on).
//
// Otherwise returns:
//   {
//     hardCutinDate,              // Date, parsed from finalMember.transitionStartDate
//     predecessorStock,           // sum of clamped predecessor on-hand (units)
//     ownStock,                   // finalMember's clamped on-hand (units)
//     chainRate,                  // anchor.daily (per WORKDAY)
//     phase1WorkdayCount,         // workdays from tomorrow through cutin-1
//                                 // (or 0 when cutin has passed)
//     phase1DemandUnits,          // phase1WorkdayCount * chainRate
//     predecessorCoversPhase1,    // predecessorStock ≥ phase1DemandUnits
//     strandedPredecessorQty,     // units left over at cutin (≥ 0). Only >0
//                                 // when phase 1 was covered.
//     runoutDate,                 // real chain runout under the cut-in rule.
//                                 // If predecessor exhausts before cutin →
//                                 // runout = today + workdaysToCalendarDays(
//                                 //   predecessorStock/chainRate, TODAY).
//                                 // If phase 1 covered and ownStock+POs empty
//                                 //   after cutin → runoutDate = cutin.
//                                 // Otherwise → walk phase 2 ledger.
//     runoutDays,                 // integer calendar days from TODAY; Infinity
//                                 // when beyond the 365-day horizon.
//   }
// Never mutates part or member records; never writes to onHand.
function _chainHardCutinSupply(members, chainOnPOLines) {
  if (!Array.isArray(members) || members.length < 2) return null;
  const finalMember = members[members.length - 1];
  if (!finalMember || !finalMember.transitionStartDate) return null;
  const parsed = (typeof parseDateLocal === "function")
    ? parseDateLocal(finalMember.transitionStartDate)
    : null;
  if (!parsed || isNaN(parsed.getTime())) return null;
  // Gate is on presence of a valid transitionStartDate, past OR future — a
  // cut-in that already happened still strands predecessor stock.
  const hardCutinDate = new Date(parsed.getTime());
  hardCutinDate.setHours(0, 0, 0, 0);

  const anchor = members[0] || null;
  const chainRate = anchor ? (Number(anchor.daily) || 0) : 0;
  const predecessors = members.slice(0, -1);
  const predecessorStock = predecessors.reduce(
    (s, m) => s + Math.max(0, Number(m && m.onHand) || 0), 0
  );
  const ownStock = Math.max(0, Number(finalMember.onHand) || 0);

  const today = new Date(TODAY.getTime());
  today.setHours(0, 0, 0, 0);
  const wpw = (typeof effectiveWorkdaysPerWeek === "function")
    ? effectiveWorkdaysPerWeek() : 5;

  const cutinOffset = Math.max(0, Math.round((hardCutinDate.getTime() - today.getTime()) / DAY_MS));

  // Pre-cutin BLANKET-only receipts on the final member. Feeds getChainInfo's
  // byCutin C1 rule (Sensourcing branch): a Sensourcing part with a blanket
  // landing before cut-in has bridge stock at cut-in day → byCutin does not
  // fire. Blanket-blind non-Sensourcing chainPOLines carry isBlanket=false
  // for every entry (blanket lines never get through their branch of the
  // gather in getChainInfo), so this sum is 0 → ownStockAtCutinBlanketOnly
  // = ownStock, byte-identical to production behavior on that path.
  let ownStockAtCutinBlanketOnly = ownStock;
  for (const l of (chainOnPOLines || [])) {
    if (!l || l.pn !== finalMember.pn) continue;
    if (!l.isBlanket) continue;
    if (!l.expectedDate) continue;
    const qty = Number(l.remaining) || 0;
    if (qty <= 0) continue;
    const offset = Math.round((l.expectedDate.getTime() - today.getTime()) / DAY_MS);
    if (offset < 0 || offset >= cutinOffset) continue;
    ownStockAtCutinBlanketOnly += qty;
  }

  // Count workdays in phase 1 — from tomorrow (i=1) up to but not including
  // hardCutinDate. When cutin is today or past, phase 1 is empty.
  let phase1WorkdayCount = 0;
  for (let i = 1; i <= 365; i++) {
    const d = (typeof addDays === "function")
      ? addDays(today, i) : new Date(today.getTime() + i * DAY_MS);
    if (d.getTime() >= hardCutinDate.getTime()) break;
    if (typeof isWorkday === "function" && isWorkday(d, wpw)) phase1WorkdayCount++;
  }
  const phase1DemandUnits = phase1WorkdayCount * chainRate;
  const predecessorCoversPhase1 = predecessorStock >= phase1DemandUnits;

  // Phase 1 exhaustion → chain runs out during phase 1 at the workday when
  // predecessor hits zero. workdaysToCalendarDays converts predecessor's own
  // burn-rate cover to calendar days, matching the projection convention.
  if (chainRate > 0 && !predecessorCoversPhase1) {
    const predWorkdayCover = predecessorStock / chainRate;
    const cal = (typeof workdaysToCalendarDays === "function")
      ? workdaysToCalendarDays(predWorkdayCover, today)
      : Math.round(predWorkdayCover);
    const runoutDays = cal > 365 ? Infinity : cal;
    const runoutDate = runoutDays === Infinity
      ? null
      : ((typeof addDays === "function") ? addDays(today, runoutDays) : new Date(today.getTime() + runoutDays * DAY_MS));
    return {
      hardCutinDate, predecessorStock, ownStock, chainRate,
      phase1WorkdayCount, phase1DemandUnits, predecessorCoversPhase1,
      strandedPredecessorQty: 0,
      runoutDate, runoutDays,
      ownStockAtCutinBlanketOnly,
    };
  }

  // Phase 1 covered → strand leftover, transition to phase 2 with ownStock.
  const strandedPredecessorQty = Math.max(0, predecessorStock - phase1DemandUnits);
  // Phase 2 ledger: walk day-by-day from cutinDate forward. Add PO receipts
  // for the final member (blanket-blind, matches isLineOpen filter enforced
  // by the caller when it built chainOnPOLines). POs arriving BEFORE cutin
  // still accumulate on ownStock at time 0 — they wait for phase 2
  // consumption to start.
  let selfStock = ownStock;
  const receiptsByDay = new Map();
  for (const l of (chainOnPOLines || [])) {
    if (!l || l.pn !== finalMember.pn) continue;
    const qty = Number(l.remaining) || 0;
    if (qty <= 0) continue;
    // Bucket by day offset from today. Undated / overdue clamp to today's
    // pile (matches projectOnHand's offset=0 clamp for overdue receipts).
    let offset = 0;
    if (l.expectedDate) {
      offset = Math.round((l.expectedDate.getTime() - today.getTime()) / DAY_MS);
      if (offset < 0) offset = 0;
    }
    if (offset > 365) continue;
    receiptsByDay.set(offset, (receiptsByDay.get(offset) || 0) + qty);
  }
  // Accumulate any POs that arrive before cutin onto selfStock now (they
  // sit unused until cutin, then consumption starts). cutinOffset was
  // computed earlier for the ownStockAtCutinBlanketOnly accumulator.
  for (const [offset, qty] of receiptsByDay.entries()) {
    if (offset < cutinOffset) selfStock += qty;
  }

  // Walk from cutinDate forward. Consume on workdays; add PO receipts on
  // their exact day. Runout = first day selfStock < 0 after consumption.
  let runoutDays = Infinity;
  for (let i = cutinOffset; i <= 365; i++) {
    // PO receipts arrive first (matches projectOnHand's oh += receipts[i]).
    if (i >= cutinOffset && receiptsByDay.has(i) && i !== cutinOffset) {
      // (Pre-cutin POs already accumulated above; only add on their true day
      // for offsets ≥ cutinOffset. Cutin day's own PO already handled by the
      // pre-loop accumulator if it arrived at exactly cutinOffset — no, wait,
      // pre-loop accumulator uses `offset < cutinOffset`, so cutinOffset's
      // arrival IS added here, right on cutin.)
      selfStock += receiptsByDay.get(i);
    } else if (i === cutinOffset && receiptsByDay.has(i)) {
      selfStock += receiptsByDay.get(i);
    }
    if (i > 0) {
      const d = (typeof addDays === "function") ? addDays(today, i) : new Date(today.getTime() + i * DAY_MS);
      if (typeof isWorkday === "function" && isWorkday(d, wpw)) {
        selfStock -= chainRate;
      }
    }
    if (selfStock < 0) {
      runoutDays = i;
      break;
    }
  }
  const runoutDate = runoutDays === Infinity
    ? null
    : ((typeof addDays === "function") ? addDays(today, runoutDays) : new Date(today.getTime() + runoutDays * DAY_MS));

  return {
    hardCutinDate, predecessorStock, ownStock, chainRate,
    phase1WorkdayCount, phase1DemandUnits, predecessorCoversPhase1,
    strandedPredecessorQty,
    runoutDate, runoutDays,
    ownStockAtCutinBlanketOnly,
  };
}

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

  // HARD CUT-IN pointer — same helper the getChainInfo rollup uses. When
  // finalMember has a valid transitionStartDate, this is non-null and carries
  // hardCutinDate / predecessorStock / ownStock / strandedPredecessorQty for
  // the drawer's chart-projector. When absent, view stays byte-identical to
  // its pre-fix shape (every field still populated the same way).
  const hardCutin = _chainHardCutinSupply(members, null);

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
    hardCutin,
  };
}

// Phase 2 demand-routing input for the FINAL part of an actively-transitioning
// chain. Thin wrapper over chainSequentialView so the existing suggestedQty
// shape stays stable. `combinedOnHand` is now the CLAMPED total (predecessors
// at max(0, onHand) + own clamped). Returns null for any non-final position.
function _supersessionDemandBoost(part) {
  const view = chainSequentialView(part);
  if (!view || !view.isFinal) return null;
  // HARD CUT-IN: predecessor stock is stranded at transitionStartDate — the
  // successor's replenishment order can only rely on ownStock + POs after
  // that date. `have` in suggestedQty (= combinedOnHand + onPO) therefore
  // drops to ownStock alone when the fix is active, driving the suggested
  // qty up so the successor covers phase-2 demand from arrival forward.
  // When there is no transitionStartDate, view.hardCutin is null and
  // combinedOnHand stays at totalChainStockClamped — byte-identical to today.
  const combinedOnHand = view.hardCutin
    ? view.hardCutin.ownStock
    : view.totalChainStockClamped;
  return {
    dailyRate: view.chainRate,
    combinedOnHand,
    anchorPn: view.anchorPn,
    anchor: view.anchor,
    predecessors: view.predecessors,
    // Passed through for the drawer's "+X in chain" tile so it can still
    // display the raw predecessor pool even though the ordering math no
    // longer credits it. null when no hardCutin — tile fallback path.
    _hardCutin: view.hardCutin || null,
    _predecessorStockRaw: view.totalChainStockClamped - view.ownClamped,
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
  const partsByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  const part = partsByPn.get(target);
  if (!part) return null;

  // BIDIRECTIONAL TRAVERSAL — self-contained here rather than delegating to
  // supersessionLineage(). Chain detection must resolve the SAME complete
  // chain from ANY member (anchor, middle, final). Both walks are guarded
  // by a shared visited-set to prevent infinite loops on data cycles
  // (A→B→A) or self-loops (A.supersededBy === A).
  //
  // Assembly: [oldest predecessor, …, target, …, newest successor].
  // For 19961→JP00051, getChainInfo("19961") and getChainInfo("JP00051")
  // both produce ["19961","JP00051"], so anchor + chainRate + chainOnHand
  // + status are identical no matter which member you query.
  const visited = new Set([target]);

  // Backward: follow (x.supersededBy === current) chain to the oldest.
  // Compares as strings, tolerating numeric or padded stored values.
  const back = [];
  {
    let cur = target;
    while (true) {
      const pred = (DB.parts || []).find(x =>
        x && x.supersededBy && String(x.supersededBy).trim() === cur
      );
      if (!pred) break;
      if (visited.has(pred.pn)) {
        console.warn(`[chain] backward cycle at ${pred.pn} from ${target} — stopping walk`);
        break;
      }
      visited.add(pred.pn);
      back.unshift(pred.pn);
      cur = pred.pn;
    }
  }

  // Forward: follow current.supersededBy → next PN until it dead-ends.
  const fwd = [];
  {
    let cur = target;
    while (true) {
      const curPart = partsByPn.get(cur);
      const nextPn = (curPart && curPart.supersededBy)
        ? String(curPart.supersededBy).trim() : "";
      if (!nextPn) break;
      if (visited.has(nextPn)) {
        console.warn(`[chain] forward cycle at ${nextPn} from ${target} — stopping walk`);
        break;
      }
      if (!partsByPn.has(nextPn)) break;
      visited.add(nextPn);
      fwd.push(nextPn);
      cur = nextPn;
    }
  }

  const lineage = [...back, target, ...fwd];
  if (lineage.length < 2) return null;

  const members = lineage.map(mpn => partsByPn.get(mpn)).filter(Boolean);
  if (members.length < 2) return null;

  // Active-transition gate — matches chainSequentialView's rule (truthy,
  // not strict `=== true`). Handles phasingOut stored as boolean true,
  // string "true", number 1, or any other truthy shape from legacy data.
  // The strict === true was the deployed-Phase-B failure mode: a chain
  // whose phasingOut was truthy-but-not-literal-boolean silently failed
  // this gate → getChainInfo returned null → status/coverage overrides
  // no-oped → 19961 stayed falsely CRITICAL. chainSequentialView (the
  // older API) used a truthy check so the drawer CHART worked while the
  // status PILL didn't — masking the real cause.
  const transitioning = members.some(m => !!m.phasingOut);
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
    // Per-PO admission gate: cycled-supplier POs (Sensourcing today) route
    // through isLineIncomingSupply so their blanket lines land as scheduled
    // supply on the blanket's expectedDate — same rule that e66ab6c already
    // applies to projectOnHand and suggestedQty via includeBlanketSupply /
    // blanketIncomingQty. Non-cycled suppliers stay on isLineOpen — BYTE-
    // IDENTICAL to production. This closes the gap where the chart credits
    // a Sensourcing blanket to phase 2 while the chain-runout math ignored
    // it, producing two runout numbers for one part (e.g. JP00021, CP00945).
    const _poCycle = (typeof getSupplierCycle === "function") ? getSupplierCycle(po.supplier) : null;
    const _useSupplyGate = !!_poCycle;
    for (const ln of (po.lines || [])) {
      if (!ln || !chainPnSet.has(ln.pn)) continue;
      if (_useSupplyGate) {
        if (typeof isLineIncomingSupply !== "function" || !isLineIncomingSupply(po, ln)) continue;
      } else {
        if (typeof isLineOpen === "function" && !isLineOpen(po, ln)) continue;
      }
      const remaining = _useSupplyGate
        ? (typeof _lineIncomingRemaining === "function"
            ? _lineIncomingRemaining(ln)
            : Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0)))
        : Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
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
        // Plumbing for _chainHardCutinSupply's ownStockAtCutinBlanketOnly
        // computation: byCutin's C1 rule needs to know which pre-cutin
        // receipts are blanket-type so it credits Sensourcing blanket
        // supply against the "successor has no bridge stock at cutin" test.
        isBlanket: (typeof isBlanketLine === "function") ? isBlanketLine(ln) : false,
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

  // HARD CUT-IN piecewise math when the final member has a transitionStartDate
  // (past or future). Predecessor stock only counts up to that date; anything
  // left over strands. Phase 2 starts with own stock + POs. When there is NO
  // transitionStartDate the helper returns null and we fall through to the
  // legacy combined runout — byte-identical to today for every non-cut-in part.
  const hardCutin = _chainHardCutinSupply(members, chainPOLines);

  // Chain runout — piecewise when hardCutin present, else combined at chainRate
  // from today (legacy).
  let chainRunoutDays = Infinity;
  let chainRunoutDate = null;
  if (hardCutin) {
    chainRunoutDays = hardCutin.runoutDays;
    chainRunoutDate = hardCutin.runoutDate;
  } else {
    const totalSupply = chainOnHand + chainOnPO;
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
  }

  // Chain reorder-by point — the LAST calendar day we can place the
  // successor's order and still have stock arrive before the chain runs
  // out. Uses the successor's lead time + safety buffer (same shape as
  // partStatus's reorderBy DURATION, but expressed here as a first-class
  // calendar DATE so downstream views can surface it directly).
  //
  // chainReorderByDays: integer days from today to reorder-by. Negative
  //   when reorder-by has already passed. Infinity when runout is beyond
  //   the 365-day horizon (nothing actionable to compute).
  // chainReorderByDate: matching calendar Date (null when Infinity).
  // chainReorderByPassed: true when reorder-by day is today or earlier.
  const leadDays = (typeof leadTimeDays === "function")
    ? leadTimeDays(finalMember)
    : 0;
  const safety = (DB.settings && Number(DB.settings.safetyDays)) || 0;
  const warnDays = (DB.settings && (DB.settings.alertWarning ?? 14)) || 14;
  const reorderBy = leadDays + safety; // duration, preserved for chainStatusDetail back-compat
  // Order-by = min(byCutin, byRunout) − leadDays − safetyDays.
  //   byRunout: chainRunoutDays (already hardCutin-corrected when applicable)
  //   byCutin:  days from today to hardCutinDate (only when hardCutin present)
  // C1 semantics from preLaunchOrderBy: byCutin is applicable when it's still
  // future OR when ownStock is 0 (no bridge stock at cutin — need supply on
  // that day). Matches the pattern in preLaunchOrderBy so behavior is
  // consistent across chain and standalone pre-launch surfaces.
  const byRunoutDays = (chainRunoutDays === Infinity)
    ? Infinity
    : chainRunoutDays - leadDays - safety;
  let byCutinDays = Infinity;
  if (hardCutin && hardCutin.hardCutinDate) {
    const cutinFromToday = Math.round(
      (hardCutin.hardCutinDate.getTime() - TODAY.getTime()) / DAY_MS
    );
    // C1 applicability — Sensourcing-scoped rewrite.
    //   Cycled supplier (Sensourcing): byCutin fires only when the
    //     successor has NO bridge stock at cut-in — INCLUDING pre-cutin
    //     Sensourcing blanket receipts (ownStockAtCutinBlanketOnly).
    //     Closes the JP00021-style false-PASSED alerts when a blanket
    //     lands before cut-in.
    //   Non-cycled: preserved bit-for-bit — the `cutinFromToday >= 0`
    //     short-circuit stays (documented as a separate ticket; scope-
    //     preserved this pass).
    const _finalCycle = (typeof getSupplierCycle === "function") ? getSupplierCycle(finalMember.supplier) : null;
    let c1Applicable;
    if (_finalCycle) {
      c1Applicable = (Number(hardCutin.ownStockAtCutinBlanketOnly) || 0) <= 0;
    } else {
      c1Applicable = cutinFromToday >= 0 || hardCutin.ownStock <= 0;
    }
    if (c1Applicable) byCutinDays = cutinFromToday - leadDays - safety;
  }
  const chainReorderByDays = Math.min(byRunoutDays, byCutinDays);
  const chainReorderByDate = (chainReorderByDays !== Infinity)
    ? addDays(TODAY, chainReorderByDays)
    : null;
  const chainReorderByPassed = chainReorderByDays !== Infinity && chainReorderByDays <= 0;

  // Chain status ladder — expressed directly against chainReorderByDays
  // so the code matches the mental model: escalate as the last-order
  // moment approaches, hit CRITICAL when it passes.
  //   OK       reorder-by is comfortably future     (days > warnDays)
  //   WARNING  reorder-by is within warn window     (0 < days ≤ warnDays)
  //   CRITICAL reorder-by has arrived or passed     (days ≤ 0)
  // Algebraically identical to the older `chainRunoutDays <= leadDays+safety`
  // test — same output for every input — but the naming makes intent
  // grep-legible and one-to-one with partStatus's ladder.
  let chainStatus = "ok";
  if (chainReorderByDays === Infinity) {
    chainStatus = "ok";
  } else if (chainReorderByDays <= 0) {
    chainStatus = "critical";
  } else if (chainReorderByDays <= warnDays) {
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
  // MINUS (usable stock + non-late-arriving coverage). Overdue POs
  // count as coverage. Clamped ≥ 0.
  //
  // HARD CUT-IN: predecessor units that STRAND at the cut-in are not
  // usable coverage. Effective usable stock is
  //   (predecessorStock − strandedPredecessorQty) + ownStock
  // = the predecessor units actually consumed pre-cut-in PLUS the
  // successor's own on-hand. Falls back to raw chainOnHand when
  // hardCutin is null (byte-identical to today).
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
  const usableChainStock = hardCutin
    ? Math.max(0, hardCutin.predecessorStock - hardCutin.strandedPredecessorQty) + hardCutin.ownStock
    : chainOnHand;
  const chainShort = Math.max(0, demandThroughWantBy - (usableChainStock + coverageInTime));

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
    chainReorderByDate,
    chainReorderByDays,
    chainReorderByPassed,
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
    // HARD CUT-IN block — null when the successor has no transitionStartDate
    // (fully legacy behavior). Non-null when the cut-in rule is active; carries
    // strandedPredecessorQty for banner display, hardCutinDate for the
    // reorder-by calculation, and predecessor/own stock split for diagnostics.
    hardCutin,
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
    `  chainReorderBy:  ${iso(info.chainReorderByDate)} (${info.chainReorderByDays === Infinity ? "∞" : info.chainReorderByDays + "d"})${info.chainReorderByPassed ? " ← PASSED" : ""}`,
    `  chainStatus:     ${info.chainStatus} (leadDays=${info.chainStatusDetail.leadDays}, reorderBy=${info.chainStatusDetail.reorderBy}, warnDays=${info.chainStatusDetail.warnDays})`,
    `  wantByDate:      ${iso(info.wantByDate)}`,
    `  chainShort:      ${info.chainShort}`,
    `  preLaunch:       ${info.preLaunch ? `successor ${info.preLaunch.successorPn} phases in ${iso(info.preLaunch.transitionStartDate)}` : "no"}`,
  );
  console.log(lines.join("\n"));

  // Symmetry self-check: every chain member must resolve the SAME chain.
  // Prints one line per member with its key fields; mismatches jump out.
  if (Array.isArray(info.chainParts) && info.chainParts.length > 1) {
    console.log(`[chain] symmetry check — every member should resolve identical values:`);
    for (const mpn of info.chainParts) {
      const mi = getChainInfo(mpn);
      if (!mi) {
        console.log(`  ${mpn}: NULL  ← BROKEN symmetry`);
        continue;
      }
      console.log(`  ${mpn}: anchor=${mi.anchorPn} rate=${mi.chainRate} onHand=${mi.chainOnHand} onPO=${mi.chainOnPO} status=${mi.chainStatus} short=${mi.chainShort} parts=[${mi.chainParts.join("→")}]`);
    }
  }
  return info;
}
window.getChainInfo = getChainInfo;
window._printChainInfo = _printChainInfo;

/* ============================================================
   SUPPLIER ORDER-CYCLE MODEL (Phase A — model + verification only)

   Some suppliers only accept orders on a fixed cadence (Sensourcing:
   anchor 2026-07-24, then every 42 days). This model provides the
   supporting math so downstream views can snap a natural order-by date
   back to the last eligible cycle date, compute cycle-aware suggested
   quantities, and flag missed windows — WITHOUT any view/status/qty
   changes in this pass. Wiring lands in Phase B.

   Config lives on DB.settings.supplierCycles, keyed by supplierKey()
   (the normalized form that survives capitalization + legal-suffix
   drift across feeds). Seeded via DEFAULTS.settings in js/01-config.js
   so a fresh install and a Supabase-hydrated install both see the same
   entries; org-shared through the same settings-row path (correct —
   supplier cadence is a fact about the supplier, not per-user).
   ============================================================ */

// Read supplier-cycle config for a supplier name. Returns
//   { anchor: Date, intervalDays: number, displayName: string|null }
// or null when the supplier has no cycle configured (which is >99% of
// suppliers today). Parses anchor via parseDateLocal so a "2026-07-24"
// stored string comes back as a local-midnight Date consistent with
// every other date in the app.
function getSupplierCycle(supplierName) {
  const cycles = (DB && DB.settings && DB.settings.supplierCycles) || null;
  if (!cycles || typeof cycles !== "object") return null;
  const key = (typeof supplierKey === "function") ? supplierKey(supplierName) : "";
  if (!key) return null;
  const cfg = cycles[key];
  if (!cfg || !cfg.anchor || !cfg.intervalDays) return null;
  const anchor = (typeof parseDateLocal === "function") ? parseDateLocal(cfg.anchor) : new Date(cfg.anchor);
  const interval = Math.round(Number(cfg.intervalDays));
  if (!anchor || isNaN(anchor.getTime()) || !Number.isFinite(interval) || interval <= 0) return null;
  // leadInDays: how many days BEFORE the next cycle date the queue-side pill
  // + filter control should surface. Outside the lead-in window, the cycle
  // is invisible to the buyer (the queue reads exactly as it does today).
  // Optional — a supplier with no leadInDays configured yields leadInDays=0,
  // meaning "never surface." Callers that don't consult leadInDays keep
  // working; only cycleLeadIn / the future wiring branches on it.
  const leadIn = Math.max(0, Math.round(Number(cfg.leadInDays) || 0));
  return { anchor, intervalDays: interval, leadInDays: leadIn, displayName: cfg.displayName || null };
}

// Next n cycle dates ≥ fromDate. Cycle dates are anchor + k*intervalDays
// for k ≥ 0. When fromDate ≤ anchor, the first returned date is the
// anchor itself. When fromDate falls exactly on a cycle date, that date
// counts as "eligible" and is included as the first entry. Handles
// integer overflow by ceil-then-verify rather than trusting floating-
// point k.
function nextCycleDates(cycle, fromDate, n) {
  if (!cycle || !cycle.anchor || !cycle.intervalDays || !fromDate) return [];
  const count = Math.max(0, Math.floor(Number(n) || 0));
  if (count === 0) return [];
  const anchorMs = cycle.anchor.getTime();
  const fromMs = fromDate.getTime();
  const intervalMs = cycle.intervalDays * DAY_MS;
  let k = 0;
  if (fromMs > anchorMs) {
    k = Math.ceil((fromMs - anchorMs) / intervalMs);
    // Correct for float drift — walk forward until the computed date is
    // genuinely ≥ fromMs.
    while ((anchorMs + k * intervalMs) < fromMs) k++;
  }
  const out = [];
  for (let i = 0; i < count; i++) out.push(new Date(anchorMs + (k + i) * intervalMs));
  return out;
}

// Lead-in window helper. Returns
//   {
//     nextCycleDate,   // first cycle date ≥ today (null when cycle invalid)
//     daysUntil,       // whole calendar days from today to nextCycleDate
//                      // (0 when today IS the cycle date; negative should
//                      // never occur since nextCycleDate is ≥ today)
//     inLeadIn,        // true when 0 ≤ daysUntil ≤ cycle.leadInDays — the
//                      // window where the queue-side pill + filter surface.
//                      // With leadInDays=0 or missing, inLeadIn only fires
//                      // on the exact cycle date; before that day the queue
//                      // reads exactly as it does today.
//   }
// Wiring rule (Phase B): queue pill + filter render iff inLeadIn === true.
// Draft/PDF cycle header renders whenever the draft contains cycled parts,
// regardless of the lead-in window — the buyer already committed to acting.
// For Sensourcing (leadInDays=11, next cycle 2026-07-24): inLeadIn goes
// true on 2026-07-13, stays true through 2026-07-24, then flips to false
// on 2026-07-25 (when nextCycleDate advances to 2026-09-04 and daysUntil
// jumps to 42, out of window). Same shape every 42-day cycle after that.
function cycleLeadIn(cycle, today) {
  if (!cycle) return { nextCycleDate: null, daysUntil: null, inLeadIn: false };
  const anchorDay = today ? new Date(today.getTime()) : new Date(TODAY.getTime());
  anchorDay.setHours(0, 0, 0, 0);
  const upcoming = nextCycleDates(cycle, anchorDay, 1);
  const nextCycleDate = upcoming[0] || null;
  if (!nextCycleDate) return { nextCycleDate: null, daysUntil: null, inLeadIn: false };
  const daysUntil = Math.max(0, Math.round((nextCycleDate.getTime() - anchorDay.getTime()) / DAY_MS));
  const leadIn = Number(cycle.leadInDays) || 0;
  const inLeadIn = daysUntil <= leadIn;
  return { nextCycleDate, daysUntil, inLeadIn };
}

// Distinguish BEHIND (order it, accept the gap) from UNRECOVERABLE (a cycle
// order won't save this part — needs expedite / air freight / supplier call).
// Returns
//   {
//     cycleArrivalDate,   // nextCycleDate + leadTimeDays for the ordered
//                         // part. Chain successors are the parts that get
//                         // ordered so leadTimeDays(part) is the correct
//                         // source (same convention used by the PDF's
//                         // arrival-vs-runout flag).
//     runoutDate,         // chain-aware, blanket-blind:
//                         //   chain member → chainInfo.chainRunoutDate
//                         //   non-chain    → today + partStatus.daysOfCover
//                         //   no projected stockout → null
//     gapDays,            // cycleArrivalDate − runoutDate in whole days.
//                         // Positive = stocked out this many days BEFORE
//                         // the cycle order arrives. Null when runoutDate
//                         // is null (nothing to compare).
//     unrecoverable,      // gapDays > 0. When true, the buyer needs to
//                         // act OUTSIDE the cycle (the cycle order is too
//                         // late even if placed on the next cycle date).
//   }
// Blanket qty is not counted as inbound supply in either runout path (the
// isLineOpen chokepoint at ~line 342 filters blanket lines), so a part
// with 450 blanket units authorized but no scheduled receipts will still
// show the real runout — matches the semantic "blanket = capacity to
// release against, not stock arriving."
function cycleArrivalGap(part, cycle) {
  if (!part || !cycle) return null;
  const today = new Date(TODAY.getTime());
  today.setHours(0, 0, 0, 0);
  const upcoming = nextCycleDates(cycle, today, 1);
  const nextCycleDate = upcoming[0] || null;
  if (!nextCycleDate) return null;
  const lt = leadTimeDays(part);
  const cycleArrivalDate = (typeof addDays === "function")
    ? addDays(nextCycleDate, lt)
    : new Date(nextCycleDate.getTime() + lt * DAY_MS);
  // Runout: chain-aware, blanket-blind.
  const chainInfo = (typeof getChainInfo === "function") ? getChainInfo(part.pn) : null;
  let runoutDate = null;
  if (chainInfo && chainInfo.chainRunoutDate) {
    runoutDate = chainInfo.chainRunoutDate;
  } else {
    const stat = (typeof partStatus === "function") ? partStatus(part) : null;
    if (stat && stat.daysOfCover !== Infinity && Number.isFinite(stat.daysOfCover)) {
      runoutDate = (typeof addDays === "function")
        ? addDays(TODAY, stat.daysOfCover)
        : new Date(TODAY.getTime() + stat.daysOfCover * DAY_MS);
    }
  }
  if (!runoutDate) {
    return { cycleArrivalDate, runoutDate: null, gapDays: null, unrecoverable: false };
  }
  const gapDays = Math.round((cycleArrivalDate.getTime() - runoutDate.getTime()) / DAY_MS);
  const unrecoverable = gapDays > 0;
  return { cycleArrivalDate, runoutDate, gapDays, unrecoverable };
}

// Snap a natural order-by date to the supplier's cycle. Returns
//   {
//     snappedDate,          // last cycle date that's ≤ naturalOrderBy AND ≥ today
//                           // (the LAST opportunity to still meet the deadline);
//                           // null when no such date exists.
//     nextCycleDate,        // first cycle date ≥ today (always populated when
//                           // cycle is valid).
//     mustOrderThisCycle,   // true when snappedDate === nextCycleDate — the
//                           // upcoming cycle is the last chance to still meet
//                           // the natural deadline.
//     missedWindow,         // true when naturalOrderBy < nextCycleDate — even
//                           // the next cycle is too late; every choice is
//                           // expedite territory.
//   }
// Edge cases:
//   - naturalOrderBy exactly ON a cycle date → that date counts as makeable
//     (≤ comparison) so it can be the snappedDate.
//   - naturalOrderBy before the anchor → snappedDate = null (no eligible cycle
//     yet); missedWindow depends on where anchor falls vs naturalOrderBy.
//   - naturalOrderBy far in the future → snappedDate is the appropriate
//     later cycle, not the anchor; mustOrderThisCycle = false (multiple
//     cycles available, not urgent).
function cycleSnapOrderBy(naturalOrderByDate, cycle) {
  if (!cycle || !naturalOrderByDate) return null;
  const today = new Date(TODAY.getTime());
  today.setHours(0, 0, 0, 0);
  const upcoming = nextCycleDates(cycle, today, 1);
  const nextCycleDate = upcoming[0] || null;
  const naturalMs = naturalOrderByDate.getTime();
  const missedWindow = !!nextCycleDate && naturalMs < nextCycleDate.getTime();

  let snappedDate = null;
  if (nextCycleDate && naturalMs >= nextCycleDate.getTime()) {
    // Walk forward from nextCycleDate as long as the NEXT hop still lands
    // on-or-before naturalOrderBy; the last valid cursor is the snap point.
    const intervalMs = cycle.intervalDays * DAY_MS;
    let cursor = nextCycleDate.getTime();
    let last = cursor;
    while ((cursor + intervalMs) <= naturalMs) {
      cursor += intervalMs;
      last = cursor;
    }
    snappedDate = new Date(last);
  } else if (missedWindow && nextCycleDate) {
    // Gate-A fix: a natural order-by that's ALREADY PAST the next cycle
    // date doesn't disqualify the part — it makes ordering MORE urgent,
    // not less. The upcoming cycle is still the right place to put it
    // (there is no earlier eligible option). Without this branch the six
    // most-overdue parts fall out of cycle selection entirely, which is
    // exactly backwards. Snap to the next cycle date; missedWindow stays
    // true as the urgency modifier.
    snappedDate = new Date(nextCycleDate.getTime());
  }
  // mustOrderThisCycle now means "belongs on the upcoming cycle order"
  // (the SELECTION predicate). Fires whenever snappedDate === the next
  // cycle — either because the natural deadline lands in this cycle
  // window, OR because we've already missed the window entirely and the
  // upcoming cycle is the earliest possible ship. missedWindow stays a
  // separate urgency flag callers can use to escalate display.
  const mustOrderThisCycle = !!snappedDate && !!nextCycleDate
    && snappedDate.getTime() === nextCycleDate.getTime();
  return { snappedDate, nextCycleDate, mustOrderThisCycle, missedWindow };
}

// Cycle-aware suggested qty. When the part's supplier has no cycle
// configured, this returns exactly what suggestedQty() would return —
// byte-identical fallback for non-cycled suppliers (>99% of parts).
//
// When the supplier IS cycled, we swap the 30-day post-arrival horizon
// for the cycle's intervalDays: an order placed at cycle C arrives at
// C + leadTime and must cover demand through C + intervalDays + leadTime
// (i.e. through the NEXT cycle's arrival). Rest of the composition —
// chain successor's combined on-hand (via _supersessionDemandBoost),
// pre-launch flat-hold (implicit in the demand rate), phasing-out
// short-circuit — carries through unchanged from suggestedQty().
//
// Not yet consumed by any view; called only from the verification
// helper below in Phase A. suggestedQty() is untouched.
function cycleAwareSuggestedQty(part, onPO) {
  if (part && part.phasingOut) return 0;
  const cycle = getSupplierCycle(part && part.supplier);
  if (!cycle) return (typeof suggestedQty === "function") ? suggestedQty(part, onPO) : 0;

  const boost = (typeof _supersessionDemandBoost === "function") ? _supersessionDemandBoost(part) : null;
  const lt = leadTimeDays(part);
  const safety = (DB.settings && Number(DB.settings.safetyDays)) || 0;
  const horizon = cycle.intervalDays; // ← the only real difference vs suggestedQty
  const dailyRate = boost
    ? Math.max(Number(part.daily) || 0, boost.dailyRate)
    : (Number(part.daily) || 0);
  // Calendar-window → workday-demand conversion via the shared helper.
  // Same fix as suggestedQty — the previous formula multiplied calendar
  // days × per-workday rate directly, over-ordering by ~7/wpw.
  const target = _windowDemandUnits(lt + safety + horizon, dailyRate);
  const onPOQty = (typeof onPO === "number")
    ? onPO
    : ((typeof openPOQty === "function") ? openPOQty(part.pn) : 0);
  // Sensourcing-blanket incoming supply nets into `have` (same policy
  // as suggestedQty). This is the production writer of _suggestedQty
  // via partsWithStatus — so this is the netting the "+ Order N" pill
  // actually reads. NOT time-phased.
  const blanketIncoming = (typeof blanketIncomingQty === "function") ? blanketIncomingQty(part.pn) : 0;
  const have = boost
    ? boost.combinedOnHand + onPOQty + blanketIncoming
    : (Number(part.onHand) || 0) + onPOQty + blanketIncoming;
  let qty = Math.max(0, Math.ceil(target - have));
  if (part.moq && qty > 0) qty = Math.max(qty, Number(part.moq));
  if (part.packSize && qty > 0) qty = Math.ceil(qty / Number(part.packSize)) * Number(part.packSize);
  return qty;
}

// Resolve the "natural" order-by date for a part — the pre-cycle
// deadline that gets fed into cycleSnapOrderBy. Composition priority
// (matches Phase B's stated composition rules):
//   1. Chain member with an actively-transitioning chain → the chain's
//      chainReorderByDate (already computed by getChainInfo). Chain
//      status math wins because the whole chain shares one deadline.
//   2. Pre-launch part (no chain) → preLaunchOrderBy(part).orderByDate,
//      which is min(by-launch, by-runout) with the C1/C2 semantics we
//      already ship.
//   3. Regular part → today + daysOfCover − leadTime − safety, computed
//      from stat.daysOfCover. Returns null when daysOfCover is Infinity
//      (no projected stockout, no natural deadline).
function naturalOrderByForPart(part) {
  if (!part) return null;
  const chainInfo = (typeof getChainInfo === "function") ? getChainInfo(part.pn) : null;
  if (chainInfo && chainInfo.chainReorderByDate) return chainInfo.chainReorderByDate;
  const preLaunch = (typeof isPreLaunch === "function") && isPreLaunch(part);
  if (preLaunch && typeof preLaunchOrderBy === "function") {
    const pl = preLaunchOrderBy(part);
    if (pl && pl.orderByDate) return pl.orderByDate;
  }
  const stat = (typeof partStatus === "function") ? partStatus(part) : null;
  if (!stat || stat.daysOfCover === Infinity) return null;
  const lt = leadTimeDays(part);
  const safety = (DB.settings && Number(DB.settings.safetyDays)) || 0;
  const daysToReorderBy = stat.daysOfCover - lt - safety;
  return (typeof addDays === "function") ? addDays(TODAY, daysToReorderBy) : null;
}

// Console-callable audit for a cycled supplier. Prints:
//   - the cycle config + next 4 cycle dates from today
//   - a per-part table for every part whose supplier resolves to the same
//     supplierKey: pn / desc / naturalOrderBy / snappedDate / nextCycleDate
//     / mustOrderThisCycle / missedWindow / currentSuggestedQty / cycleAwareQty
// Read-only. Not consumed by any view. Gate A verification only.
function _printSupplierCycleAudit(supplierName) {
  const target = supplierName || "Sensourcing Trading Co.";
  const cycle = getSupplierCycle(target);
  if (!cycle) {
    console.warn(`[cycle] no cycle config for "${target}" — check settings.supplierCycles`);
    return null;
  }
  const targetKey = supplierKey(target);
  const iso = d => d && d.toISOString ? d.toISOString().slice(0, 10) : (d || "-");
  console.log(`=== SUPPLIER CYCLE AUDIT: ${cycle.displayName || target} ===`);
  console.log(`  key: "${targetKey}" · anchor: ${iso(cycle.anchor)} · intervalDays: ${cycle.intervalDays} · leadInDays: ${cycle.leadInDays}`);
  const upcoming = nextCycleDates(cycle, TODAY, 4);
  console.log(`  next cycle dates from today: ${upcoming.map(iso).join(", ")}`);
  const li = cycleLeadIn(cycle, TODAY);
  console.log(`  lead-in window: next=${iso(li.nextCycleDate)} · daysUntil=${li.daysUntil} · inLeadIn=${li.inLeadIn} · pill would ${li.inLeadIn ? "SHOW" : "HIDE"} today`);
  const rows = [];
  for (const p of (DB.parts || [])) {
    if (!p || supplierKey(p.supplier) !== targetKey) continue;
    const natural = naturalOrderByForPart(p);
    const snap = natural ? cycleSnapOrderBy(natural, cycle) : null;
    const arrival = cycleArrivalGap(p, cycle);
    const currentSq = (typeof suggestedQty === "function") ? suggestedQty(p) : 0;
    const cycledSq = cycleAwareSuggestedQty(p);
    rows.push({
      pn: p.pn,
      desc: (p.desc || "").slice(0, 30),
      supplier: p.supplier,
      onHand: Number(p.onHand) || 0,
      daily: Number(p.daily) || 0,
      naturalOrderBy: natural ? iso(natural) : "(none)",
      snappedDate: snap && snap.snappedDate ? iso(snap.snappedDate) : "-",
      nextCycleDate: snap && snap.nextCycleDate ? iso(snap.nextCycleDate) : "-",
      mustOrderThisCycle: snap ? snap.mustOrderThisCycle : "-",
      missedWindow: snap ? snap.missedWindow : "-",
      cycleArrivalDate: arrival && arrival.cycleArrivalDate ? iso(arrival.cycleArrivalDate) : "-",
      runoutDate: arrival && arrival.runoutDate ? iso(arrival.runoutDate) : "-",
      gapDays: arrival ? (arrival.gapDays == null ? "-" : arrival.gapDays) : "-",
      unrecoverable: arrival ? arrival.unrecoverable : "-",
      currentSuggestedQty: currentSq,
      cycleAwareQty: cycledSq,
    });
  }
  rows.sort((a, b) => String(a.pn).localeCompare(String(b.pn)));
  console.table(rows);
  const mustCount = rows.filter(r => r.mustOrderThisCycle === true).length;
  const shortCount = rows.filter(r => r.mustOrderThisCycle === true && r.unrecoverable === true).length;
  console.log(`  ${rows.length} parts for supplier key "${targetKey}" · ${mustCount} on upcoming cycle · ${shortCount} unrecoverable (SHORT)`);
  return rows;
}

// LEGACY DIAGNOSTIC — combined-runout formula from before the hard-cut-in
// fix. VERBATIM STRUCTURAL COPY of the pre-fix code block from
// js/03-calc.js.bak-hardcutin (getChainInfo lines 1097-1113): totalSupply
// = chainOnHand + chainOnPO, cover in workdays via workdaysToCalendarDays,
// horizon-capped at 365. Only diffs from pre-fix are param plumbing —
// values that were closure-scoped in getChainInfo are function params here.
function _legacyChainCombinedRunout(chainOnHand, chainOnPO, chainRate) {
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
  return { runoutDays: chainRunoutDays, runoutDate: chainRunoutDate };
}

// LEGACY DIAGNOSTIC — status ladder from before the fix. VERBATIM
// STRUCTURAL COPY of the pre-fix code block from
// js/03-calc.js.bak-hardcutin (getChainInfo lines 1132-1158): reorder-by
// duration derived from runoutDays−leadDays−safety, then bucketed against
// warnDays. Returns the same four fields the pre-fix code produced
// (chainReorderByDays / chainReorderByDate / chainReorderByPassed /
// chainStatus), plumbed via function params instead of closure vars.
function _legacyChainStatus(chainRunoutDays, chainRunoutDate, leadDays, safety, warnDays) {
  const chainReorderByDays = (chainRunoutDays === Infinity)
    ? Infinity
    : chainRunoutDays - leadDays - safety;
  const chainReorderByDate = (chainRunoutDate && chainReorderByDays !== Infinity)
    ? addDays(TODAY, chainReorderByDays)
    : null;
  const chainReorderByPassed = chainReorderByDays !== Infinity && chainReorderByDays <= 0;

  let chainStatus = "ok";
  if (chainReorderByDays === Infinity) {
    chainStatus = "ok";
  } else if (chainReorderByDays <= 0) {
    chainStatus = "critical";
  } else if (chainReorderByDays <= warnDays) {
    chainStatus = "warning";
  } else {
    chainStatus = "ok";
  }
  return {
    status: chainStatus,
    reorderByDays: chainReorderByDays,
    reorderByDate: chainReorderByDate,
    reorderByPassed: chainReorderByPassed,
  };
}

// LEGACY DIAGNOSTIC — verbatim byte-for-byte copy of the pre-fix
// _supersessionDemandBoost body from js/03-calc.js.bak-hardcutin lines
// 766-776. Only the function name changed to distinguish it. Reads
// view.totalChainStockClamped which is UNCHANGED on the current
// chainSequentialView return (the fix added `hardCutin` alongside; the
// existing fields still compute the same values). This is what the audit
// audits against — the exact boost the pre-fix code produced.
function _legacySupersessionDemandBoost(part) {
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

// LEGACY DIAGNOSTIC — verbatim byte-for-byte copy of the pre-fix
// suggestedQty body from js/03-calc.js.bak-hardcutin lines 587-620. Only
// two changes: (a) function name, (b) call _legacySupersessionDemandBoost
// instead of _supersessionDemandBoost (the live one now returns hardCutin-
// aware combinedOnHand — the whole reason we need a retained copy).
function _legacyChainSuggestedQty(part, onPO) {
  if (part && part.phasingOut) return 0;

  const boost = _legacySupersessionDemandBoost(part);

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

// HARD-CUTIN IMPACT AUDIT — returns ONE string via .map().join('\n') so
// DevTools doesn't collapse it. Attached to window because module-scoped
// functions are unreachable from the console. Header carries
// DB.settings.safetyDays so the reader can verify the byCutin math has
// the same safety subtraction as byRunout.
// Columns: pn | cutinDate | inChain | oldRunout | newRunout | oldOrderBy
// | newOrderBy | oldStatus | newStatus | oldSuggestedQty | newSuggestedQty
// | strandedPredecessorQty
// OLD values come from the retained _legacyChain* helpers above (called
// against the same chainOnHand+chainOnPO+chainRate the current
// getChainInfo still exposes). NEW values come from getChainInfo itself.
function _printHardCutinImpact() {
  const iso = d => (d && d.toISOString) ? d.toISOString().slice(0, 10) : "-";
  const safety = (DB.settings && Number(DB.settings.safetyDays)) || 0;
  const rows = [];
  for (const p of (DB.parts || [])) {
    if (!p || !p.transitionStartDate) continue;
    const parsed = (typeof parseDateLocal === "function")
      ? parseDateLocal(p.transitionStartDate) : null;
    if (!parsed || isNaN(parsed.getTime())) continue;
    const cutinIso = iso(parsed);
    const info = getChainInfo(p.pn);
    const inChain = !!info;
    // NEW (post-fix) values, straight off getChainInfo.
    const newRunout = info ? iso(info.chainRunoutDate) : "-";
    const newOrderBy = info ? iso(info.chainReorderByDate) : "-";
    const newStatus = info ? info.chainStatus : "-";
    const strandedQty = info && info.hardCutin
      ? Math.round(info.hardCutin.strandedPredecessorQty)
      : 0;
    // OLD values via retained legacy helpers.
    let oldRunout = "-", oldOrderBy = "-", oldStatus = "-", oldSuggestedQty = "-";
    if (info) {
      const leg = _legacyChainCombinedRunout(info.chainOnHand, info.chainOnPO, info.chainRate);
      const legSt = _legacyChainStatus(leg.runoutDays, leg.runoutDate, info.chainStatusDetail.leadDays, safety, info.chainStatusDetail.warnDays);
      oldRunout = iso(leg.runoutDate);
      oldOrderBy = iso(legSt.reorderByDate);
      oldStatus = legSt.status;
      try { oldSuggestedQty = _legacyChainSuggestedQty(p); }
      catch (e) { oldSuggestedQty = "err"; }
    }
    // NEW suggested qty via the live suggestedQty (which now reads the
    // hardCutin-aware boost). For a non-chain part with no boost, this
    // returns the same number _legacyChainSuggestedQty would have — the
    // audit still shows both columns for clarity.
    let newSuggestedQty = "-";
    try { newSuggestedQty = suggestedQty(p); } catch (e) { newSuggestedQty = "err"; }
    if (!info) oldSuggestedQty = newSuggestedQty;
    rows.push({
      pn: p.pn, cutinDate: cutinIso, inChain,
      oldRunout, newRunout, oldOrderBy, newOrderBy,
      oldStatus, newStatus,
      oldSuggestedQty, newSuggestedQty,
      strandedPredecessorQty: strandedQty,
    });
  }
  rows.sort((a, b) => String(a.pn).localeCompare(String(b.pn)));
  const header = `[hardcutin audit] safetyDays=${safety} · rule: order-by = min(byCutin, byRunout) − leadDays − safetyDays applied to BOTH branches`;
  const columns = "pn | cutinDate | inChain | oldRunout | newRunout | oldOrderBy | newOrderBy | oldStatus | newStatus | oldSuggestedQty | newSuggestedQty | strandedPredecessorQty";
  const sep = "-".repeat(columns.length);
  const body = rows.map(r =>
    `${r.pn} | ${r.cutinDate} | ${r.inChain} | ${r.oldRunout} | ${r.newRunout} | ${r.oldOrderBy} | ${r.newOrderBy} | ${r.oldStatus} | ${r.newStatus} | ${r.oldSuggestedQty} | ${r.newSuggestedQty} | ${r.strandedPredecessorQty}`
  ).join("\n");
  return [header, columns, sep, body, `(${rows.length} part(s) with a valid transitionStartDate)`].join("\n");
}
window._legacyChainCombinedRunout = _legacyChainCombinedRunout;
window._legacyChainStatus = _legacyChainStatus;
window._legacyChainSuggestedQty = _legacyChainSuggestedQty;
window._legacySupersessionDemandBoost = _legacySupersessionDemandBoost;
window._printHardCutinImpact = _printHardCutinImpact;
// DAY_MS is a top-level `const` (js/01-config.js:28); classic scripts do
// not auto-attach const/let to window. Explicit attach so console snippets
// referencing `window.DAY_MS` resolve.
if (typeof DAY_MS === "number") window.DAY_MS = DAY_MS;

// SPOT-CHECK — one part, one string, everything resolved IN-FILE so the
// console call is just copy(_printChainSpotCheck("JP00021")). Every
// symbol (DB, suggestedQty, DAY_MS, chainSequentialView, getChainInfo,
// the three _legacy* helpers) is in this module's scope — no bare-name
// resolution risk in the console. Returns one string via
// [...].filter(Boolean).join('\n'). Guards every dereference for null.
function _printChainSpotCheck(pn) {
  const target = pn == null ? "" : String(pn).trim();
  if (!target) return "spot-check: no PN provided";
  const p = (typeof DB !== "undefined" && DB && Array.isArray(DB.parts))
    ? DB.parts.find(x => x && x.pn === target) : null;
  if (!p) return `${target}: not in DB.parts`;
  const info = getChainInfo(target);
  if (!info) return `${target}: getChainInfo returned null (no chain)`;
  const s = (DB.settings && Number(DB.settings.safetyDays)) || 0;
  const iso = d => (d && d.toISOString) ? d.toISOString().slice(0, 10) : "-";
  const detail = info.chainStatusDetail || {};
  const leg = _legacyChainCombinedRunout(info.chainOnHand, info.chainOnPO, info.chainRate);
  const legSt = _legacyChainStatus(leg.runoutDays, leg.runoutDate, detail.leadDays, s, detail.warnDays);
  let legSq = "err", newSq = "err";
  try { legSq = _legacyChainSuggestedQty(p); } catch (e) { legSq = "err:" + (e && e.message || e); }
  try { newSq = suggestedQty(p); } catch (e) { newSq = "err:" + (e && e.message || e); }
  const hc = info.hardCutin || null;
  // Coverage resume date — first PO landing strictly after chain runout.
  // chainPOLines element shape (verified from source at getChainInfo
  // construction): { pn, poNum, poId, remaining, expectedDate, isOverdue }
  // where expectedDate is Date-or-null. Guarded here for safety.
  let resumeDate = null;
  if (hc && info.chainRunoutDate && Array.isArray(info.chainPOLines)) {
    const rm = info.chainRunoutDate.getTime();
    for (const l of info.chainPOLines) {
      if (!l || !l.expectedDate || !l.remaining) continue;
      const em = l.expectedDate.getTime();
      if (em <= rm) continue;
      if (resumeDate === null || em < resumeDate.getTime()) resumeDate = l.expectedDate;
    }
  }
  const gapDays = resumeDate && info.chainRunoutDate
    ? Math.round((resumeDate.getTime() - info.chainRunoutDate.getTime()) / DAY_MS)
    : null;
  const hcLine = hc
    ? `    cutinDate=${iso(hc.hardCutinDate)} · predecessorStock=${hc.predecessorStock} · ownStock=${hc.ownStock} · strandedPredecessorQty=${Math.round(hc.strandedPredecessorQty)} · predecessorCoversPhase1=${hc.predecessorCoversPhase1}`
    : "";
  const resumeLine = resumeDate
    ? `${iso(resumeDate)} (gap ${gapDays} calendar days)`
    : "(no PO after runout)";
  return [
    `${target} spot-check`,
    `  safetyDays=${s} · leadDays=${detail.leadDays} · warnDays=${detail.warnDays} · chainRate=${info.chainRate}`,
    `  chainOnHand=${info.chainOnHand} · chainOnPO=${info.chainOnPO} · chainPOLines.length=${(info.chainPOLines || []).length}`,
    `  hardCutin: ${hc ? "active" : "null"}`,
    hcLine,
    `  OLD: runout=${iso(leg.runoutDate)} · orderBy=${iso(legSt.reorderByDate)} · status=${legSt.status} · sq=${legSq}`,
    `  NEW: runout=${iso(info.chainRunoutDate)} · orderBy=${iso(info.chainReorderByDate)} · status=${info.chainStatus} · sq=${newSq}`,
    `  coverage resume: ${resumeLine}`,
  ].filter(Boolean).join("\n");
}
window._printChainSpotCheck = _printChainSpotCheck;

// LEGACY DIAGNOSTIC — verbatim byte-for-byte copy of the pre-fix suggestedQty
// body from js/03-calc.js.bak-workday lines 664-697. Only two changes:
// (a) function name, (b) internal call to `_supersessionDemandBoost(part)`
// remains — that live function is UNCHANGED by this workday fix (it still
// returns `{ dailyRate: view.chainRate, combinedOnHand: view.totalChainStockClamped, ... }`
// exactly as before), so its output here matches pre-fix output. The
// hardCutin work made _supersessionDemandBoost's `combinedOnHand` return
// `hardCutin.ownStock` instead of `totalChainStockClamped` when hardCutin
// is active, but that's the CORRECT current behavior — the "pre-workday"
// legacy this helper mirrors is the state right before the workday fix,
// which was AFTER hardCutin. So this reads live _supersessionDemandBoost.
function _legacySuggestedQtyPreWorkday(part, onPO) {
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
window._legacySuggestedQtyPreWorkday = _legacySuggestedQtyPreWorkday;

// Impact audit for the calendar→workday fix in suggestedQty. Returns ONE
// string via .map(...).join('\n'). Every part whose oldQty != newQty
// (excluding kits and phasing-out returns of 0/0), sorted by absolute delta
// descending. Also runs a 1..200 round-trip sanity check on
// calendarDaysToWorkdays↔workdaysToCalendarDays anchored on TODAY, and
// picks one part whose (lt + safety + horizon) is not a multiple of 7 to
// verify the walker on a non-aligned window.
function _printQtyImpact() {
  const s = (DB.settings && Number(DB.settings.safetyDays)) || 0;
  const horizon = 30;
  const wpw = (typeof effectiveWorkdaysPerWeek === "function") ? effectiveWorkdaysPerWeek() : 5;
  // Round-trip sanity: 1..200. Report any n where wtc(ctw(n)) > n.
  const violations = [];
  for (let n = 1; n <= 200; n++) {
    const back = workdaysToCalendarDays(calendarDaysToWorkdays(n));
    if (back > n) violations.push(`n=${n} → ${back}`);
  }
  // Non-multiple-of-7 sample: pick the first part whose window is not %7==0.
  let sampleLine = "  non-multiple-of-7 window: (no candidate part found — all lt+s+h are 7-aligned)";
  for (const p of (DB.parts || [])) {
    if (!p || !p.pn) continue;
    const lt = leadTimeDays(p);
    const win = lt + s + horizon;
    if (win % 7 === 0) continue;
    const wd = calendarDaysToWorkdays(win);
    const startDow = TODAY.getDay(); // 0=Sun..6=Sat
    const startName = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][startDow];
    sampleLine =
      `  non-multiple-of-7 window sample: pn=${p.pn} · ltWeeks=${p.ltWeeks||0} · window=${win} cal (from ${startName}) → workdays=${wd}`;
    break;
  }
  // Per-part impact.
  const rows = [];
  let sumOld = 0, sumNew = 0;
  for (const p of (DB.parts || [])) {
    if (!p || !p.pn) continue;
    if (typeof isKit === "function" && isKit(p.pn)) continue;
    let oldQty, newQty;
    try { oldQty = _legacySuggestedQtyPreWorkday(p); } catch (e) { oldQty = null; }
    try { newQty = suggestedQty(p); } catch (e) { newQty = null; }
    if (oldQty == null || newQty == null) continue;
    if (oldQty === newQty) continue;
    rows.push({
      pn: p.pn,
      supplier: p.supplier || "",
      daily: (Number(p.daily) || 0),
      leadDays: leadTimeDays(p),
      onHand: Number(p.onHand) || 0,
      onPO: (typeof openPOQty === "function") ? openPOQty(p.pn) : 0,
      oldQty, newQty,
      delta: newQty - oldQty,
    });
    sumOld += oldQty;
    sumNew += newQty;
  }
  rows.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const columns = "pn | supplier | daily | leadDays | onHand | onPO | oldQty | newQty | delta";
  const sep = "-".repeat(columns.length);
  const header = `[qty-impact] safetyDays=${s} · horizon=${horizon} · workdaysPerWeek=${wpw}`;
  const roundTripLine = violations.length === 0
    ? `  round-trip 1..200 (wtc∘ctw ≤ n): OK, no violations`
    : `  round-trip 1..200: ${violations.length} violation(s) — ${violations.slice(0, 5).join(", ")}${violations.length > 5 ? " …" : ""}`;
  const summary = `(${rows.length} part(s) changed · total oldQty=${sumOld} · total newQty=${sumNew} · net delta=${sumNew - sumOld})`;
  const body = rows.map(r =>
    `${r.pn} | ${r.supplier} | ${r.daily} | ${r.leadDays} | ${r.onHand} | ${r.onPO} | ${r.oldQty} | ${r.newQty} | ${r.delta}`
  ).join("\n");
  return [header, roundTripLine, sampleLine, columns, sep, body, summary].join("\n");
}
window._printQtyImpact = _printQtyImpact;
window.calendarDaysToWorkdays = calendarDaysToWorkdays;

window.getSupplierCycle = getSupplierCycle;
window.nextCycleDates = nextCycleDates;
window.cycleLeadIn = cycleLeadIn;
window.cycleArrivalGap = cycleArrivalGap;
window.cycleSnapOrderBy = cycleSnapOrderBy;
window.cycleAwareSuggestedQty = cycleAwareSuggestedQty;
window.naturalOrderByForPart = naturalOrderByForPart;
window._printSupplierCycleAudit = _printSupplierCycleAudit;

// CYCLE-QTY COMPARE — for every part whose supplier resolves to a
// getSupplierCycle, print (pn | daily | onHand | onPO | suggestedQty |
// cycleAwareQty | delta). Sensourcing is the only configured supplier
// today; any others added later automatically appear. Returns ONE string.
function _printCycleQtyCompare() {
  const rows = [];
  let sumStd = 0, sumCyc = 0;
  for (const p of (DB.parts || [])) {
    if (!p || !p.pn) continue;
    const cyc = (typeof getSupplierCycle === "function") ? getSupplierCycle(p.supplier) : null;
    if (!cyc) continue;
    let sq = "err", cq = "err";
    try { sq = suggestedQty(p); } catch (e) { sq = "err"; }
    try { cq = cycleAwareSuggestedQty(p); } catch (e) { cq = "err"; }
    const delta = (typeof sq === "number" && typeof cq === "number") ? (cq - sq) : "-";
    if (typeof sq === "number") sumStd += sq;
    if (typeof cq === "number") sumCyc += cq;
    rows.push({
      pn: p.pn,
      supplier: p.supplier || "",
      daily: (Number(p.daily) || 0),
      onHand: Number(p.onHand) || 0,
      onPO: (typeof openPOQty === "function") ? openPOQty(p.pn) : 0,
      sq, cq, delta,
    });
  }
  rows.sort((a, b) => {
    const da = typeof a.delta === "number" ? Math.abs(a.delta) : -1;
    const db = typeof b.delta === "number" ? Math.abs(b.delta) : -1;
    return db - da;
  });
  const columns = "pn | daily | onHand | onPO | suggestedQty | cycleAwareQty | delta";
  const sep = "-".repeat(columns.length);
  const body = rows.map(r =>
    `${r.pn} | ${r.daily} | ${r.onHand} | ${r.onPO} | ${r.sq} | ${r.cq} | ${r.delta}`
  ).join("\n");
  const summary = `(${rows.length} cycled-supplier part(s) · total suggestedQty=${sumStd} · total cycleAwareQty=${sumCyc} · net delta=${sumCyc - sumStd})`;
  return [`[cycle-qty compare]`, columns, sep, body, summary].join("\n");
}
window._printCycleQtyCompare = _printCycleQtyCompare;

// DRAFT-QTY AUDIT — every item currently in DRAFT_ORDER, showing
// storedQty (persisted at add-time) vs currentCycleAwareQty (what a
// fresh add today would compute). qtySource is "cycle" / "standard" /
// "legacy" (last for pre-cyclewire items with no qtySource field).
// Returns ONE string.
function _printDraftQtyAudit() {
  const rows = [];
  const draft = (typeof DRAFT_ORDER !== "undefined") ? DRAFT_ORDER : [];
  let sumStored = 0, sumCurrent = 0, changedCount = 0;
  for (const item of draft) {
    if (!item || !item.pn) continue;
    const p = (DB.parts || []).find(x => x && x.pn === item.pn);
    if (!p) continue;
    let currentCq = "err";
    try {
      const forQty = { ...p, onPO: (typeof openPOQty === "function") ? openPOQty(p.pn) : 0, daily: p.daily };
      currentCq = (typeof cycleAwareSuggestedQty === "function")
        ? cycleAwareSuggestedQty(forQty)
        : (typeof suggestedQty === "function" ? suggestedQty(forQty) : 0);
    } catch (e) { currentCq = "err"; }
    const storedQty = Number(item.qty) || 0;
    const delta = typeof currentCq === "number" ? (currentCq - storedQty) : "-";
    const qtySource = item.qtySource || "legacy";
    if (typeof currentCq === "number") sumCurrent += currentCq;
    sumStored += storedQty;
    if (typeof delta === "number" && delta !== 0) changedCount++;
    rows.push({
      pn: item.pn,
      supplier: p.supplier || "",
      storedQty,
      currentCq,
      delta,
      qtySource,
      addedAt: item.addedAt || "(unset)",
    });
  }
  rows.sort((a, b) => {
    const da = typeof a.delta === "number" ? Math.abs(a.delta) : -1;
    const db = typeof b.delta === "number" ? Math.abs(b.delta) : -1;
    return db - da;
  });
  const columns = "pn | supplier | storedQty | currentCycleAwareQty | delta | qtySource | addedAt";
  const sep = "-".repeat(columns.length);
  const body = rows.map(r =>
    `${r.pn} | ${r.supplier} | ${r.storedQty} | ${r.currentCq} | ${r.delta} | ${r.qtySource} | ${r.addedAt}`
  ).join("\n");
  const summary = `(${rows.length} draft item(s) · ${changedCount} differ from current · total stored=${sumStored} · total currentCycleAware=${sumCurrent})`;
  return [`[draft-qty audit]`, columns, sep, body, summary].join("\n");
}
window._printDraftQtyAudit = _printDraftQtyAudit;

// QUEUE FLAG AUDIT — reproduces the RELEASE / NO PO decision the queue row
// renderer applies at js/07-page-orders.js, per part. Sensourcing scope
// only (getSupplierCycle non-null). Returns ONE string.
// Columns: pn | supplier | hasBlanket | blanketCount | openPOQty |
//   cutinDate | runoutDate | triggerDate | daysToTrigger | flag
// Trigger date sourcing matches the queue: transitionStartDate wins (past
// or future); else chain-aware runout via getChainInfo, else per-part
// runout via partStatus daysOfCover.
function _printQueueFlagAudit() {
  const iso = d => (d && d.toISOString) ? d.toISOString().slice(0, 10) : "-";
  const rows = [];
  let relCount = 0, noPoCount = 0;
  for (const p of (DB.parts || [])) {
    if (!p || !p.pn) continue;
    const cycle = (typeof getSupplierCycle === "function") ? getSupplierCycle(p.supplier) : null;
    if (!cycle) continue; // Sensourcing-only scope
    if (typeof isKit === "function" && isKit(p.pn)) continue;
    const blk = (typeof findOpenBlanketForPart === "function") ? findOpenBlanketForPart(p.pn) : null;
    const blanketCount = (typeof findOpenBlanketsForPart === "function")
      ? findOpenBlanketsForPart(p.pn).length : 0;
    const openPO = (typeof openPOQty === "function") ? openPOQty(p.pn) : 0;
    // Cut-in date (past or future).
    let cutinDate = null;
    if (p.transitionStartDate && typeof parseDateLocal === "function") {
      const parsed = parseDateLocal(p.transitionStartDate);
      if (parsed && !isNaN(parsed.getTime())) cutinDate = parsed;
    }
    // Runout: chain-aware first, then per-part daysOfCover.
    const chainInfo = (typeof getChainInfo === "function") ? getChainInfo(p.pn) : null;
    let runoutDate = null;
    if (chainInfo && chainInfo.chainRunoutDate) {
      runoutDate = chainInfo.chainRunoutDate;
    } else {
      const stat = (typeof partStatus === "function") ? partStatus(p) : null;
      if (stat && Number.isFinite(stat.daysOfCover) && stat.daysOfCover !== Infinity) {
        runoutDate = addDays(TODAY, stat.daysOfCover);
      }
    }
    const triggerDate = cutinDate || runoutDate;
    const daysToTrigger = triggerDate
      ? Math.round((triggerDate.getTime() - TODAY.getTime()) / DAY_MS) : null;
    const inWindow = daysToTrigger !== null && daysToTrigger <= 21;
    let flag = "none";
    // Both flags require a valid triggerDate — a Sensourcing part with no
    // runout and no cutin has no demand signal, so surfacing NO PO on it
    // is a false positive. Matches the queue row's gate at
    // js/07-page-orders.js.
    if (blk && openPO === 0 && inWindow) flag = "RELEASE";
    else if (!blk && openPO === 0 && triggerDate) flag = "NO PO";
    if (flag === "RELEASE") relCount++;
    else if (flag === "NO PO") noPoCount++;
    rows.push({
      pn: p.pn,
      supplier: p.supplier || "",
      hasBlanket: !!blk,
      blanketCount,
      openPOQty: openPO,
      cutinDate: iso(cutinDate),
      runoutDate: iso(runoutDate),
      triggerDate: iso(triggerDate),
      daysToTrigger: daysToTrigger == null ? "-" : daysToTrigger,
      flag,
    });
  }
  rows.sort((a, b) => {
    const rank = f => f === "RELEASE" ? 0 : f === "NO PO" ? 1 : 2;
    const dr = rank(a.flag) - rank(b.flag);
    if (dr !== 0) return dr;
    const at = a.daysToTrigger === "-" ? 9999 : a.daysToTrigger;
    const bt = b.daysToTrigger === "-" ? 9999 : b.daysToTrigger;
    return at - bt;
  });
  const columns = "pn | supplier | hasBlanket | blanketCount | openPOQty | cutinDate | runoutDate | triggerDate | daysToTrigger | flag";
  const sep = "-".repeat(columns.length);
  const body = rows.map(r =>
    `${r.pn} | ${r.supplier} | ${r.hasBlanket} | ${r.blanketCount} | ${r.openPOQty} | ${r.cutinDate} | ${r.runoutDate} | ${r.triggerDate} | ${r.daysToTrigger} | ${r.flag}`
  ).join("\n");
  const summary = `(${rows.length} cycled-supplier part(s) · RELEASE=${relCount} · NO PO=${noPoCount} · none=${rows.length - relCount - noPoCount})`;
  return [`[queue-flag audit]`, columns, sep, body, summary].join("\n");
}
window._printQueueFlagAudit = _printQueueFlagAudit;

// MISSING-CUTIN AUDIT — every part that is a chain successor (some other
// part points at it via supersededBy AND that predecessor has phasingOut
// truthy) BUT has no valid transitionStartDate. These are the parts most
// likely to have lost a cutin to the drawer save bug — a chain
// successor needs a cutin to gate the hard-cutin math; without one, the
// chain falls back to the pre-fix combined runout. Returns ONE string.
function _printMissingCutins() {
  const rows = [];
  const partsByPn = new Map((DB.parts || []).map(p => [p && p.pn, p]));
  for (const p of (DB.parts || [])) {
    if (!p || !p.pn) continue;
    // Find any predecessor pointing at THIS part via supersededBy AND
    // phasingOut truthy — matches the getChainInfo transitioning-chain
    // gate (line 1246, `!!m.phasingOut`).
    let phasingPred = null;
    for (const other of (DB.parts || [])) {
      if (!other || !other.supersededBy) continue;
      if (String(other.supersededBy).trim() !== p.pn) continue;
      if (!other.phasingOut) continue;
      phasingPred = other;
      break;
    }
    if (!phasingPred) continue;
    // Does this successor have a valid transitionStartDate?
    let hasValid = false;
    if (p.transitionStartDate && typeof parseDateLocal === "function") {
      const parsed = parseDateLocal(p.transitionStartDate);
      hasValid = !!(parsed && !isNaN(parsed.getTime()));
    }
    if (hasValid) continue;
    // Anchor for reporting — walk back via supersessionLineage if available.
    const chainInfo = (typeof getChainInfo === "function") ? getChainInfo(p.pn) : null;
    rows.push({
      pn: p.pn,
      desc: (p.desc || "").slice(0, 40),
      supplier: p.supplier || "",
      transitionStartDate: JSON.stringify(p.transitionStartDate),
      inChain: !!chainInfo,
      chainAnchor: chainInfo ? chainInfo.anchorPn : phasingPred.pn,
      phasingOut: !!p.phasingOut,
    });
  }
  rows.sort((a, b) => String(a.pn).localeCompare(String(b.pn)));
  const columns = "pn | desc | supplier | transitionStartDate | inChain | chainAnchor | phasingOut";
  const sep = "-".repeat(columns.length);
  const body = rows.map(r =>
    `${r.pn} | ${r.desc} | ${r.supplier} | ${r.transitionStartDate} | ${r.inChain} | ${r.chainAnchor} | ${r.phasingOut}`
  ).join("\n");
  const summary = `(${rows.length} chain successor(s) missing a valid transitionStartDate)`;
  return [`[missing-cutin audit]`, columns, sep, body, summary].join("\n");
}
window._printMissingCutins = _printMissingCutins;

// QUEUE-vs-CYCLE audit — every queued part's OLD (standard suggestedQty)
// vs NEW (cycleAwareSuggestedQty, now the writer of _suggestedQty).
// Cycled parts should show a delta; non-cycled parts should show delta=0
// (byte-identical delegation). Returns ONE string via .map(...).join('\n').
function _printQueueVsCycle() {
  const rows = [];
  let sumOld = 0, sumNew = 0, cycledCount = 0;
  const stats = (typeof queueParts === "function") ? queueParts() : [];
  for (const p of stats) {
    if (!p || !p.pn) continue;
    const cyc = (typeof getSupplierCycle === "function") ? getSupplierCycle(p.supplier) : null;
    const isCycled = !!cyc;
    // Compute OLD (standard) inline via suggestedQty — the pre-swap writer.
    // Same onPO the row already carries so both values operate on the same
    // supply picture. `newQty` = p._suggestedQty, which is now cycle-aware
    // (Option-A writer swap).
    const onPO = Number(p.onPO) || 0;
    let oldQty = "err", newQty = "err";
    try { oldQty = (typeof suggestedQty === "function") ? suggestedQty(p, onPO) : 0; } catch (e) { oldQty = "err"; }
    try { newQty = Number(p._suggestedQty) || 0; } catch (e) { newQty = "err"; }
    if (typeof oldQty === "number") sumOld += oldQty;
    if (typeof newQty === "number") sumNew += newQty;
    if (isCycled) cycledCount++;
    rows.push({
      pn: p.pn,
      supplier: p.supplier || "",
      oldSuggestedQty: oldQty,
      newSuggestedQty: newQty,
      isCycled,
    });
  }
  // Sort: cycled first (largest positive delta first), then non-cycled by pn.
  rows.sort((a, b) => {
    if (a.isCycled !== b.isCycled) return a.isCycled ? -1 : 1;
    if (a.isCycled) {
      const da = (typeof a.newSuggestedQty === "number" && typeof a.oldSuggestedQty === "number")
        ? Math.abs(a.newSuggestedQty - a.oldSuggestedQty) : -1;
      const db = (typeof b.newSuggestedQty === "number" && typeof b.oldSuggestedQty === "number")
        ? Math.abs(b.newSuggestedQty - b.oldSuggestedQty) : -1;
      return db - da;
    }
    return String(a.pn).localeCompare(String(b.pn));
  });
  const columns = "pn | supplier | oldSuggestedQty | newSuggestedQty | isCycled";
  const sep = "-".repeat(columns.length);
  const body = rows.map(r =>
    `${r.pn} | ${r.supplier} | ${r.oldSuggestedQty} | ${r.newSuggestedQty} | ${r.isCycled}`
  ).join("\n");
  const nonCycledDrift = rows.filter(r => !r.isCycled && typeof r.oldSuggestedQty === "number" && typeof r.newSuggestedQty === "number" && r.oldSuggestedQty !== r.newSuggestedQty).length;
  const summary = `(${rows.length} queued part(s) · ${cycledCount} cycled · sum old=${sumOld} new=${sumNew} · non-cycled parts with drift=${nonCycledDrift} [must be 0])`;
  return [`[queue-vs-cycle qty]`, columns, sep, body, summary].join("\n");
}
window._printQueueVsCycle = _printQueueVsCycle;

// PRE-LAUNCH ROLLUP audit — reads the side channel that
// computeCoverageGaps stashes on window._preLaunchRollupActions. Triggers
// a fresh aggregator run (computeCoverageGaps) to guarantee the side
// channel matches the current DB state. Returns ONE string.
// Columns: suppressedPn | demandMember | overduePoNum | daysPastDue | action
// where action ∈ { merged, synthesized, "skipped: not in a chain",
// "skipped: no demand-carrying predecessor", "no overdue lines" }.
function _printPreLaunchRollup() {
  if (typeof computeCoverageGaps === "function") {
    try { computeCoverageGaps(); } catch (e) { /* ignore — audit still prints last */ }
  }
  const actions = (typeof window !== "undefined" && Array.isArray(window._preLaunchRollupActions))
    ? window._preLaunchRollupActions : [];
  actions.sort((a, b) => {
    // Merged / synthesized first (real routing), then skipped, then no-overdue.
    const rank = a => a.action === "merged" ? 0
      : a.action === "synthesized" ? 1
      : String(a.action).startsWith("skipped") ? 2
      : 3;
    const dr = rank(a) - rank(b);
    if (dr !== 0) return dr;
    return String(a.suppressedPn || "").localeCompare(String(b.suppressedPn || ""));
  });
  const columns = "suppressedPn | demandMember | overduePoNum | daysPastDue | action";
  const sep = "-".repeat(columns.length);
  const body = actions.map(a =>
    `${a.suppressedPn} | ${a.demandMember} | ${a.overduePoNum} | ${a.daysPastDue} | ${a.action}`
  ).join("\n");
  const merged = actions.filter(a => a.action === "merged").length;
  const synthesized = actions.filter(a => a.action === "synthesized").length;
  const skipped = actions.filter(a => String(a.action).startsWith("skipped")).length;
  const noOverdue = actions.filter(a => a.action === "no overdue lines").length;
  const summary = `(${actions.length} pre-launch part(s) processed · merged=${merged} · synthesized=${synthesized} · skipped=${skipped} · no-overdue=${noOverdue})`;
  return [`[pre-launch rollup]`, columns, sep, body, summary].join("\n");
}
window._printPreLaunchRollup = _printPreLaunchRollup;

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

// Every vendor that has ever supplied `pn`, from PO history in DB.pos.
// Mirrors lastPOPrice's walk (all PO statuses — received/closed included
// via the sync's additive retention; per-supplier future-date guard so a
// typo-dated PO doesn't crown a vendor's "last cost" with a future date).
// Returns [{ supplier, lastCost, lastDate, poNum, orderCount }] sorted
// most-recent-first. Empty array when no PO history exists for the pn.
//
// Consumers: draft-order supplier input (per-part datalist + cost-lookup
// on pick). Nothing else in the app reads this today. Never writes.
function suppliersForPart(pn) {
  if (!pn || !Array.isArray(DB.pos)) return [];
  const groups = new Map();  // supplier → [{cost, qty, date, poNum, status}]
  for (const po of DB.pos) {
    const supplier = String(po.supplier || "").trim();
    if (!supplier) continue;
    for (const ln of (po.lines || [])) {
      if (String(ln.pn || "").trim() !== pn) continue;
      const d = po.createdDate ? new Date(po.createdDate) : null;
      if (!groups.has(supplier)) groups.set(supplier, []);
      groups.get(supplier).push({
        cost: Number(ln.cost) || 0,
        qty: Number(ln.qty) || 0,
        date: d,
        poNum: po.num || po.id,
        status: po.status || ln.status || "",
      });
    }
  }
  const results = [];
  for (const [supplier, cands] of groups.entries()) {
    // Per-supplier future-date guard: prefer non-future dates when any exist,
    // fall back to newest regardless when every candidate is future/invalid.
    const notFuture = cands.filter(c => c.date && !isNaN(c.date) && c.date <= TODAY);
    const pool = notFuture.length ? notFuture : cands;
    pool.sort((a, b) => (b.date ? b.date.getTime() : 0) - (a.date ? a.date.getTime() : 0));
    const latest = pool[0];
    results.push({
      supplier,
      lastCost: latest.cost,
      lastDate: latest.date,
      poNum: latest.poNum,
      orderCount: cands.length,
    });
  }
  results.sort((a, b) => (b.lastDate ? b.lastDate.getTime() : 0) - (a.lastDate ? a.lastDate.getTime() : 0));
  return results;
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
  // Sensourcing-blanket-aware supply index — same shape, admits blanket
  // lines that pass isLineIncomingSupply. Only Sensourcing parts route
  // through this; non-Sensourcing parts continue to read lineIndex.
  const supplyIndex = (typeof _buildSupplyLineIndex === "function") ? _buildSupplyLineIndex() : new Map();
  const out = DB.parts.map(p => {
    const lines = lineIndex.get(p.pn);
    const onPO = lines ? openPOQty(p.pn, lines) : 0;
    const isKitVal = typeof isKit === "function" ? isKit(p) : false;
    // Cycled-supplier scope (Sensourcing today). Non-null → route status
    // through partStatusBlanketAware; null → byte-identical to production.
    const _cycleForStatus = (typeof getSupplierCycle === "function") ? getSupplierCycle(p.supplier) : null;
    const _supplySlice = _cycleForStatus ? (supplyIndex.get(p.pn) || []) : null;

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
    // Sensourcing branch: status is computed against the SUPPLY-inclusive
    // slice, so a blanket landing that keeps oh > 0 through the horizon
    // yields status OK. Non-Sensourcing branch: partStatus with the OPEN
    // slice — byte-identical to production. _openStatus is retained on
    // Sensourcing parts as the pre-blanket runout, used by the force-admit
    // predicate (a covered part still needs a RELEASE CTA when its raw
    // runout falls inside the 21-day trigger window).
    const _openStatus = _cycleForStatus
      ? partStatus(effectiveForStatus, lines)
      : null;
    const status = _cycleForStatus
      ? partStatusBlanketAware(effectiveForStatus, _supplySlice)
      : partStatus(effectiveForStatus, lines);

    // Force-admit predicates: Sensourcing base_bom parts with an open
    // blanket and no normal PO. Two tiers:
    //   RELEASE:  fires within 21d of min(cut-in, blanket-aware runout).
    //             Trigger basis for chain parts is chainRunoutDays
    //             (blanket-aware post commit acc3321), not _openDaysOfCover
    //             (which for a chain successor reads predecessor stock and
    //             misrepresents the buyer's actual coverage horizon).
    //   PLANNING: fires when we're at/past (cut-in - leadDays - safety) —
    //             the "release-by-planning" deadline — but cut-in is still
    //             ahead AND RELEASE hasn't fired yet. Closes the silence
    //             gap when the byCutin C1 fix pushes the chain out of
    //             critical status while cut-in is still weeks away.
    let _forceAdmitAsRelease = false;
    let _forceAdmitDaysToTrigger = null;
    let _forceAdmitAsPlanning = false;
    let _forceAdmitPlanningDaysToTrigger = null;
    if (_cycleForStatus
        && String(p.itemType || "").toLowerCase().trim() === "base_bom"
        && status.status === "ok"
        && onPO === 0
        && (typeof findOpenBlanketForPart === "function") && findOpenBlanketForPart(p.pn)) {
      const _chainInfoForForceAdmit = (typeof getChainInfo === "function") ? getChainInfo(p.pn) : null;
      // Runout basis: chain parts use blanket-aware chainRunoutDays; non-
      // chain parts fall back to _openDaysOfCover (blanket-blind — matches
      // pre-fix single-part semantic).
      const runoutBasis = (_chainInfoForForceAdmit && Number.isFinite(_chainInfoForForceAdmit.chainRunoutDays))
        ? _chainInfoForForceAdmit.chainRunoutDays
        : (_openStatus ? _openStatus.daysOfCover : Infinity);
      const trig = _computeTriggerFromRunoutAndTransition(runoutBasis, p.transitionStartDate);
      if (trig.inWindow) {
        _forceAdmitAsRelease = true;
        _forceAdmitDaysToTrigger = trig.daysToTrigger;
      } else if (p.transitionStartDate && typeof parseDateLocal === "function") {
        // Planning tier: cut-in - leadDays - safety <= 0 AND cut-in still ahead.
        const cutinDate = parseDateLocal(p.transitionStartDate);
        if (cutinDate && !isNaN(cutinDate.getTime())) {
          const cutinFromToday = Math.round((cutinDate.getTime() - TODAY.getTime()) / DAY_MS);
          const leadDaysForPlan = (typeof leadTimeDays === "function") ? leadTimeDays(p) : 0;
          const safetyDaysForPlan = (DB.settings && Number(DB.settings.safetyDays)) || 0;
          const planningDaysToDeadline = cutinFromToday - leadDaysForPlan - safetyDaysForPlan;
          if (planningDaysToDeadline <= 0 && cutinFromToday >= 0) {
            _forceAdmitAsPlanning = true;
            _forceAdmitPlanningDaysToTrigger = cutinFromToday;
          }
        }
      }
    }

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
      // Sensourcing force-admit: written for every cycled Sensourcing
      // part (default false). Read by queueParts to force-admit an OK
      // row as a RELEASE call-to-action, and by the order-queue row map
      // to pick the release-styled visual + daysToTrigger display.
      ...(_cycleForStatus ? {
        _forceAdmitAsRelease,
        _forceAdmitDaysToTrigger,
        _forceAdmitAsPlanning,
        _forceAdmitPlanningDaysToTrigger,
        _openDaysOfCover: _openStatus ? _openStatus.daysOfCover : null,
      } : {}),
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
      _suggestedQty: cycleAwareSuggestedQty(p, onPO),
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
  // Route-param compare normalized on both sides so case/whitespace variants
  // (e.g. a part tagged "Service") still route to the intended queue.
  const _wantType = String(itemType || "").toLowerCase().trim();
  if (_wantType) stats = stats.filter(p => String(p.itemType || "").toLowerCase().trim() === _wantType);
  else stats = stats.filter(p => isQueueEligible(p));
  stats = stats.filter(p => !p.isKit);
  // Admission: critical / warning as always, PLUS Sensourcing base_bom
  // rows force-admitted as RELEASE (blanket-aware runout inside 21d
  // trigger, blanket present, no normal PO) or as PLANNING (cut-in
  // - lead - safety already passed, cut-in still ahead — planning window
  // for the buyer to release the blanket before cut-in). Both flags are
  // populated only for cycled Sensourcing rows in partsWithStatus.
  return stats.filter(p =>
    (p.status === "critical" || p.status === "warning"
      || p._forceAdmitAsRelease || p._forceAdmitAsPlanning)
    && !p.phasingOut
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
