/* =====================================================
   03-calc.js
   Sections: FINISHED GOODS + BOM EXPLOSION, COMPUTATION ENGINE — alerts, days of cover, etc., AUDIT
   ===================================================== */

/* ============================================================
   FINISHED GOODS — the SKUs whose multi-level BOMs we explode to
   derive base-BOM demand. Edit this list directly to add/remove FGs.
   ============================================================ */
const FINISHED_GOODS = ["CA00135","CA00136","CA00137","CA00138","CA00139","CA00140","CA00141","CA00142","CA00143","CA00144","CA00145","CA00146","CA00147","CA00148","CA00149","CA00150","CA00151","CA00152","CA00190","CA00191","CA00197","CA00198","CA00201","CA00205","CA00206","CA00207","CA00208","CA00210","CA00211","CA00212","CA00213","CA00214","CA00215","CA00216","CA00217","CA00218","CA00219","CA00415","CA00416","CA00417","CA00418","CA00419","JA26001","JA26002","JA26003","JA26004","JA26005","JA26006","JA26007","JA26008","JA26009","JA26010","JA26011","JA26012","JA26013","JA26014","JA26015","JA26016","JA26017","JA26018","JA26019","JA26020","JA26021","JA26022","JA26023","JA26024","JA26025","JA26026","JA26027","JA26028","JA26029","JA26030","JA26031","JA26032","JA26033","JA26034","JA26035","JA26036","JA26037","JA26038","JA26039","JA26040","JA26041","JA26042","JA27001","JA27002","JA27003","JA27004","JA27005","JA27006","JA27007"];

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
function isLineOpen(po, ln) {
  if (!po || !ln) return false;
  const poStatus = String(po.status || "").toLowerCase().trim();
  if (_CLOSED_LINE_STATUSES.has(poStatus)) return false;
  const poAcum = String(po.acumStatus || "").toLowerCase().trim();
  if (poAcum && _CLOSED_ACUM_STATUSES.has(poAcum)) return false;
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
function projectOnHand(part, days = 365, lines) {
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
    if (offset <= days) receipts[offset] += remaining;
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
  for (let i = 0; i <= days; i++) {
    if (i > 0) oh -= (part.daily || 0);
    oh += receipts[i];
    series.push({ d: addDays(TODAY, i), oh: oh, recv: receipts[i] });
  }
  // Attach the overdue summary as plain properties on the array. Existing
  // callers (.map / .length / indexing / .findIndex) are unaffected.
  series.overdueUnits = overdueAtZero;
  series.overdueLines = overdueLines;
  return series;
}

// Days until stockout (without any new orders). Optional precomputed lines.
function daysUntilStockout(part, lines) {
  if (!part.daily || part.daily <= 0) return Infinity;
  // Project with current PO receipts factored in
  const series = projectOnHand(part, 365, lines);
  // Find the LAST day on-hand is still positive — accounts for transient dips
  // that recover when an incoming PO lands.
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
function isSupplierMuted(name) {
  if (!name) return false;
  const list = (DB.settings && DB.settings.mutedSuppliers) || [];
  const n = name.toLowerCase();
  return list.some(s => (s || "").toLowerCase() === n);
}

function toggleSupplierMute(name) {
  if (!name) return;
  if (!Array.isArray(DB.settings.mutedSuppliers)) DB.settings.mutedSuppliers = [];
  const list = DB.settings.mutedSuppliers;
  const i = list.findIndex(s => (s || "").toLowerCase() === name.toLowerCase());
  const wasMuted = i >= 0;
  if (wasMuted) list.splice(i, 1); else list.push(name);
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
    const isKitVal = typeof isKit === "function" ? isKit(p.pn) : false;

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
    return {
      ...p,
      onPO,
      isKit: isKitVal,
      ...status,
      ...(muted ? { _muted: true, _rawStatus: status.status, status: "ok", urgency: 9999 } : {}),
      _suggestedQty: suggestedQty(p, onPO),
      ...(view && view.isFinal ? { _chainBoost: _supersessionDemandBoost(p) } : {}),
    };
  });
  _statusCache = out;
  return out;
}

/* ============================================================
   QUEUE ELIGIBILITY — single source of truth for "what parts
   show up in an order queue today". Used by the queue page AND
   the dashboard's Critical/Order Today count so the two can
   never drift apart again.
   ============================================================ */

// Returns the parts that would appear in an order queue before any
// toolbar/header filters are applied. Callers can narrow further
// (e.g. dashboard wants critical-only; queue applies search/supplier/
// buyer/days-cover filters on top of this).
//
// Rules — kept in lock-step with renderOrderQueueFor's needsOrder:
//   - itemType:
//       passed value  → exact match for that queue (base_bom/options/service)
//       null/undef    → union of all three real queues (anything NOT do_not_order)
//   - !isKit              (kits are tracked separately; can't be ordered)
//   - !phasingOut         (no order to place for a phasing-out part;
//                          the chain's final successor still appears
//                          under its own itemType)
//   - status in { critical, warning }
//   - status here is the effective status from partsWithStatus, which
//     already forces muted-supplier parts to "ok" — so muted parts
//     naturally drop out without an extra check.
function queueParts(itemType) {
  let stats = partsWithStatus();
  if (itemType) stats = stats.filter(p => p.itemType === itemType);
  else stats = stats.filter(p => p.itemType !== "do_not_order");
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
