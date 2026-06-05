/* =====================================================
   03-calc.js
   Sections: COMPUTATION ENGINE — alerts, days of cover, etc., AUDIT
   ===================================================== */

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
