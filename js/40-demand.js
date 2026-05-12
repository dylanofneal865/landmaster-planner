/* =====================================================
   40-demand.js
   Service-parts demand engine.

   Reads DB.usage (imported sales orders + manual usage)
   and computes a per-part daily-use rate using an
   asymmetric blend:
     - if recent rate > baseline → use recent (catch surges fast)
     - if recent rate < baseline → 60/40 blend (soft landing on lulls)

   This file ONLY computes. It does not modify DB.parts.
   To apply: call applyDemandToParts() explicitly.
   ===================================================== */

const DEMAND_RECENT_DAYS = 30;
const DEMAND_BASELINE_DAYS = 180;
const DEMAND_HISTORY_DAYS = 365;

function computeDemand(pn) {
  const now = Date.now();
  const recentCutoff = now - DEMAND_RECENT_DAYS * 86400000;
  const baselineCutoff = now - DEMAND_BASELINE_DAYS * 86400000;
  const historyCutoff = now - DEMAND_HISTORY_DAYS * 86400000;

  let recentUnits = 0, baselineUnits = 0, totalUnits365 = 0;
  let lastOrderTs = 0;

  if (!Array.isArray(DB.usage)) return _emptyDemand();

  for (const u of DB.usage) {
    if (u.pn !== pn) continue;
    const t = new Date(u.ts).getTime();
    if (isNaN(t)) continue;
    const qty = Number(u.qty) || 0;
    if (qty <= 0) continue;
    if (t > historyCutoff) totalUnits365 += qty;
    if (t > baselineCutoff) baselineUnits += qty;
    if (t > recentCutoff) recentUnits += qty;
    if (t > lastOrderTs) lastOrderTs = t;
  }

  const recentRate = recentUnits / DEMAND_RECENT_DAYS;
  const baselineRate = baselineUnits / DEMAND_BASELINE_DAYS;

  let appliedDaily;
  if (recentRate > baselineRate) {
    appliedDaily = recentRate;
  } else {
    appliedDaily = 0.6 * recentRate + 0.4 * baselineRate;
  }

  const velocityPct = baselineRate > 0
    ? ((recentRate - baselineRate) / baselineRate) * 100
    : (recentRate > 0 ? 999 : 0);

  let velocity = "steady";
  if (velocityPct > 50) velocity = "surging";
  else if (velocityPct > 15) velocity = "up";
  else if (velocityPct < -50) velocity = "dying";
  else if (velocityPct < -15) velocity = "down";

  return {
    recentUnits,
    recentRate: Math.round(recentRate * 1000) / 1000,
    baselineUnits,
    baselineRate: Math.round(baselineRate * 1000) / 1000,
    appliedDaily: Math.round(appliedDaily * 1000) / 1000,
    velocity,
    velocityPct: Math.round(velocityPct),
    lastOrderDate: lastOrderTs > 0 ? new Date(lastOrderTs).toISOString() : null,
    totalUnits365,
  };
}

function _emptyDemand() {
  return {
    recentUnits: 0, recentRate: 0,
    baselineUnits: 0, baselineRate: 0,
    appliedDaily: 0, velocity: "steady", velocityPct: 0,
    lastOrderDate: null, totalUnits365: 0,
  };
}

// ----- Cached batch computation -----
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

/**
 * Apply computed daily rates onto DB.parts.
 * IMPORTANT: this is NOT called automatically. Only triggered
 * when user explicitly clicks Apply on the Service Usage page.
 * Returns count of parts updated.
 */
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

// Expose for console use and other modules
window.computeDemand = computeDemand;
window.getAllDemand = getAllDemand;
window.bumpDemandCache = bumpDemandCache;
window.applyDemandToParts = applyDemandToParts;
