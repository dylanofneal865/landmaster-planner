/* =====================================================
   03-calc.js
   Sections: FINISHED GOODS + BOM EXPLOSION, COMPUTATION ENGINE — alerts, days of cover, etc., AUDIT
   ===================================================== */

/* ============================================================
   FINISHED GOODS — the SKUs whose multi-level BOMs we explode to
   derive base-BOM demand. Edit this list directly to add/remove FGs.
   ============================================================ */
const FINISHED_GOODS = ["CA00135","CA00136","CA00138","CA00140","CA00141","CA00144","CA00145","CA00146","CA00147","CA00148","CA00149","CA00150","CA00151","CA00152","CA00190","CA00191","CA00197","CA00198","CA00200","CA00201","CA00202","CA00203","CA00205","CA00206","CA00207","CA00208","CA00210","CA00211","CA00212","CA00213","CA00214","CA00219","CA00415","CA00416","CA00417","CA00418","CA00419","CA25135","CA25136","CA25151","CA25180","CA25201","CA25205","CA25211","CA25219","CA25220","JA26001","JA26002","JA26003","JA26004","JA26005","JA26006","JA26007","JA26008","JA26009","JA26017","JA26018","JA26019","JA26020","JA26021","JA26022","JA26023","JA26024","JA26025","JA26026","JA26027","JA26028","JA26029","JA26030","JA26031","JA26032","JA26033","JA26034","JA26035","JA26036","JA26037","JA26038","JA26039","JA26040","JA26041","JA26042","JA27001","JA27002","JA27003","JA27004","JA27005","JA27006","JA27007","CA00137","CA00139","CA00142","CA00204","CA00215","CA00216","CA00217","CA00218","CA25217","CA25250","JA26010","JA26011","JA26012","JA26013","JA26014","JA26015","JA26016","CA00143"];

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

// Build a per-PN index of open PO lines. Each entry: { ln, remaining, po }.
// Built once at the top of partsWithStatus so projectOnHand/openPOQty don't
// rescan DB.pos for every part. External callers don't need this — the public
// fns below accept an optional precomputed lines array and fall back to a
// full scan when called without it. The `po` reference is carried so
// projectOnHand can attribute overdue receipts to a PO number.
function _buildOpenPOLineIndex() {
  const map = new Map();
  for (const po of (DB.pos || [])) {
    if (po.status === "received" || po.status === "closed" || po.status === "cancelled") continue;
    for (const ln of po.lines) {
      if (ln.status === "received" || ln.status === "cancelled") continue;
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
    if (po.status === "received" || po.status === "closed" || po.status === "cancelled") continue;
    for (const ln of po.lines) {
      if (ln.pn === pn && ln.status !== "received" && ln.status !== "cancelled") {
        total += Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
      }
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
      if (po.status === "received" || po.status === "closed" || po.status === "cancelled") continue;
      for (const ln of po.lines) {
        if (ln.pn !== part.pn) continue;
        if (ln.status === "received" || ln.status === "cancelled") continue;
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
function suggestedQty(part, onPO) {
  const lt = leadTimeDays(part);
  const safety = DB.settings.safetyDays || 0;
  const horizon = 30; // beyond reorder, target 30 days of stock after arrival
  const target = (lt + safety + horizon) * (part.daily || 0);
  // Minus what's already on order + on hand
  const onPOQty = (typeof onPO === "number") ? onPO : openPOQty(part.pn);
  const have = (part.onHand || 0) + onPOQty;
  let qty = Math.max(0, Math.ceil(target - have));
  if (part.moq && qty > 0) qty = Math.max(qty, part.moq);
  if (part.packSize && qty > 0) {
    qty = Math.ceil(qty / part.packSize) * part.packSize;
  }
  return qty;
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
    const status = partStatus(p, lines);
    const muted = isSupplierMuted(p.supplier);
    return {
      ...p,
      onPO,
      isKit: isKitVal,
      ...status,
      ...(muted ? { _muted: true, _rawStatus: status.status, status: "ok", urgency: 9999 } : {}),
      _suggestedQty: suggestedQty(p, onPO),
    };
  });
  _statusCache = out;
  return out;
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
