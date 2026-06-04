/* =====================================================
   01-config.js
   Sections: CONSTANTS & STORAGE
   ===================================================== */

/* ============================================================
   CONSTANTS & STORAGE
   ============================================================ */
const STORAGE_KEY = "landmaster.inv.v3";  // v3 — data now includes 4-month usage history
const LEGACY_KEYS = ["landmaster.inv.v2", "landmaster.inv.v1", "helix.inv.v1"];
const TODAY = new Date(); TODAY.setHours(0,0,0,0);
const DAY_MS = 86400000;

const DEFAULTS = {
  settings: {
    safetyDays: 7,           // safety buffer beyond lead time
    workdaysPerWeek: 5,      // weeks → days conversion (using 5 = workdays)
    alertCritical: 0,        // days of cover below this = critical (will stockout before reorder arrives)
    alertWarning: 14,        // days margin at/under this = warning
    defaultBuyer: "Buyer",
    currency: "USD",
    poPrefix: "PO-",
    poNumStart: 47120,
    autoSyncExcel: true,     // auto-write linked Excel files on every change
    usageWindowDays: 120,    // how many days of usage history to compute daily-avg from (4 months covers our YTD data)
    mutedSuppliers: [],      // supplier names whose parts are excluded from alert/queue surfaces
  },
  parts: [],
  pos: [],
  audit: [],
  usage: [],                 // transaction log: {id, ts, pn, qty, buildLine, reason, user, notes}
  kitBoms: {},               // map of kit_pn -> { kit_pn, kit_desc, components: [{pn, qty, desc, isStock}] }
  poNum: 47120,
  meta: { lastImport: null, dataSource: "sample", loaded: null, welcomed: false, lastSalesOrderImport: null },
};

let DB = null;

function loadDB() {
  try {
    // Clean up legacy keys — we don't migrate; want a fresh bootstrap with embedded data
    for (const k of LEGACY_KEYS) {
      if (localStorage.getItem(k)) {
        localStorage.removeItem(k);
        console.log("Cleared legacy storage:", k);
      }
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Stale-sample sanity check
    const looksLikeOldSample =
      parsed.meta?.dataSource === "sample" ||
      (Array.isArray(parsed.parts) && parsed.parts.length > 0 &&
       parsed.parts.length < 100 &&
       parsed.parts.every(p => typeof p.pn === "string" && /^LM-[A-Z]{2}-\d+$/.test(p.pn)));
    if (looksLikeOldSample) {
      console.log("Stale sample data detected — clearing for fresh bootstrap");
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return { ...DEFAULTS, ...parsed,
      settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
      meta: { ...DEFAULTS.meta, ...(parsed.meta || {}) },
      usage: Array.isArray(parsed.usage) ? parsed.usage : [],
      kitBoms: (parsed.kitBoms && typeof parsed.kitBoms === "object" && !Array.isArray(parsed.kitBoms)) ? parsed.kitBoms : {},
    };
  } catch (e) { console.warn("loadDB failed", e); return null; }
}

// Backfill any missing IDs on POs / lines / usage so the UI's
// Open/Edit/Receive buttons work even on data loaded before this fix.
function ensureIds() {
  if (!DB) return;
  let touched = 0;
  for (const po of (DB.pos || [])) {
    if (!po.id) { po.id = "po_" + (po.num || (po.id = uid("po"))); touched++; }
    if (Array.isArray(po.lines)) {
      po.lines.forEach((ln, idx) => {
        if (!ln.id) { ln.id = po.id + "_l" + idx; touched++; }
      });
    }
  }
  for (const u of (DB.usage || [])) {
    if (!u.id) { u.id = uid("us"); touched++; }
  }
  if (touched > 0) {
    console.log(`Backfilled ${touched} missing IDs`);
    saveDB();
  }
}

function saveDB() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(DB)); }
  catch (e) { showToast("Storage full or blocked: " + e.message, "crit", "Save Failed"); }
  // Auto-mirror to linked Excel files (debounced internally)
  try { autoSyncExcel(); } catch (e) { /* don't break save */ }
}

function resetDB() {
  localStorage.removeItem(STORAGE_KEY);
  DB = null;
}
