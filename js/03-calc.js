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

// Total open PO qty for a part across all open POs
function openPOQty(pn) {
  let total = 0;
  for (const po of DB.pos) {
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
function projectOnHand(part, days = 365) {
  const series = [];
  let oh = part.onHand || 0;
  // Build receipts map by date offset
  const receipts = new Array(days + 1).fill(0);
  for (const po of DB.pos) {
    if (po.status === "received" || po.status === "closed" || po.status === "cancelled") continue;
    for (const ln of po.lines) {
      if (ln.pn !== part.pn) continue;
      if (ln.status === "received" || ln.status === "cancelled") continue;
      const remaining = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
      if (!remaining) continue;
      const expDate = ln.expectedDate ? new Date(ln.expectedDate) : null;
      if (!expDate || isNaN(expDate)) continue;
      expDate.setHours(0,0,0,0);
      const offset = Math.round((expDate - TODAY) / DAY_MS);
      if (offset >= 0 && offset <= days) receipts[offset] += remaining;
    }
  }
  for (let i = 0; i <= days; i++) {
    if (i > 0) oh -= (part.daily || 0);
    oh += receipts[i];
    series.push({ d: addDays(TODAY, i), oh: oh, recv: receipts[i] });
  }
  return series;
}

// Days until stockout (without any new orders)
function daysUntilStockout(part) {
  if (!part.daily || part.daily <= 0) return Infinity;
  // Project with current PO receipts factored in
  const series = projectOnHand(part, 365);
  for (let i = 0; i < series.length; i++) {
    if (series[i].oh <= 0) return i;
  }
  return Infinity;
}

// Compute status for a part
function partStatus(part) {
  const lt = leadTimeDays(part);
  const safety = DB.settings.safetyDays || 0;
  const warnDays = DB.settings.alertWarning ?? 14;
  const stockoutDay = daysUntilStockout(part);
  const reorderBy = lt + safety; // we should have stock for at least lead time + safety days
  let status = "ok";
  let urgency = 9999;

  if (stockoutDay === Infinity) {
    status = "ok";
    urgency = 9999;
  } else if (stockoutDay <= lt) {
    // We will stockout before any new order could arrive
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

// Suggested order qty: cover lead time + safety + a target horizon (e.g., 30 days more)
function suggestedQty(part) {
  const lt = leadTimeDays(part);
  const safety = DB.settings.safetyDays || 0;
  const horizon = 30; // beyond reorder, target 30 days of stock after arrival
  const target = (lt + safety + horizon) * (part.daily || 0);
  // Minus what's already on order + on hand
  const have = (part.onHand || 0) + openPOQty(part.pn);
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

function partsWithStatus() {
  if (_statusCache) return _statusCache;
  const out = DB.parts.map(p => ({
    ...p,
    onPO: openPOQty(p.pn),
    isKit: typeof isKit === "function" ? isKit(p.pn) : false,
    ...partStatus(p),
  }));
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
