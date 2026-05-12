/* =====================================================
   40-demand.js
   Service-parts demand engine — simple 180-day average.

   Reads DB.usage (imported sales orders + manual usage)
   and computes per-part daily-use rate as:

     daily = units shipped in last 180 days / 180

   No surge detection. No blending. Just average per day.
   Does NOT modify DB.parts unless applyDemandToParts() called.
   ===================================================== */

const DEMAND_WINDOW_DAYS = 180;

function computeDemand(pn) {
  const now = Date.now();
  const cutoff = now - DEMAND_WINDOW_DAYS * 86400000;

  let units = 0;
  let lastOrderTs = 0;

  if (!Array.isArray(DB.usage)) return _emptyDemand();

  for (const u of DB.usage) {
    if (u.pn !== pn) continue;
    const t = new Date(u.ts).getTime();
    if (isNaN(t)) continue;
    const qty = Number(u.qty) || 0;
    if (qty <= 0) continue;
    if (t > cutoff) units += qty;
    if (t > lastOrderTs) lastOrderTs = t;
  }

  const appliedDaily = units / DEMAND_WINDOW_DAYS;

  return {
    units,
    appliedDaily: Math.round(appliedDaily * 1000) / 1000,
    lastOrderDate: lastOrderTs > 0 ? new Date(lastOrderTs).toISOString() : null,
  };
}

function _emptyDemand() {
  return { units: 0, appliedDaily: 0, lastOrderDate: null };
}

let _demandCache = null;
let _demandCacheKey = null;

function _usageCacheKey() {
  return ((DB.usage || []).length) + ":" + (DB.meta?.lastImport || "");
}

function getAllDemand() {
  const key = _usageCacheKey();
  if (_demandCache && _demandCacheKey === key) return _demandCache;

  const map = new Map();
  const pns = new Set();
  for (const u of (DB.usage || [])) {
    if (u.pn) pns.add(u.pn);
  }
  for (const pn of pns) {
    map.set(pn, computeDemand(pn));
  }
  _demandCache = map;
  _demandCacheKey = key;
  return map;
}

function bumpDemandCache() {
  _demandCache = null;
  _demandCacheKey = null;
}

function applyDemandToParts() {
  const demand = getAllDemand();
  let updated = 0;
  for (const part of DB.parts) {
    const d = demand.get(part.pn);
    if (!d) continue;
    const newDaily = d.appliedDaily;
    const oldDaily = Number(part.daily) || 0;
    if (Math.abs(newDaily - oldDaily) > Math.max(0.05, oldDaily * 0.05)) {
      part.daily = newDaily;
      updated++;
    }
  }
  return updated;
}

window.computeDemand = computeDemand;
window.getAllDemand = getAllDemand;
window.bumpDemandCache = bumpDemandCache;
window.applyDemandToParts = applyDemandToParts;
