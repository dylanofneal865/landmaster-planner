/* =====================================================
   01-config.js
   Sections: CONSTANTS & STORAGE
   ===================================================== */

/* ============================================================
   CONSTANTS & STORAGE
   ============================================================ */
const STORAGE_KEY = "landmaster.inv.v3";  // v3 — data now includes 4-month usage history
const LEGACY_KEYS = ["landmaster.inv.v2", "landmaster.inv.v1", "helix.inv.v1"];
// The boot-cache moved off localStorage (5 MB ceiling) onto IndexedDB. The
// blob is stored as a JSON STRING under this key in its own DB/store so this
// module is load-order-independent of 18-excel-sync.js. Supabase remains the
// source of truth — this is only the local hydration cache.
const IDB_DB_KEY = "db.v3";
function _cacheOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("landmaster-cache", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function _cacheGet(k){ return _cacheOpen().then(db=>new Promise((res,rej)=>{const t=db.transaction("kv","readonly");const r=t.objectStore("kv").get(k);r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error);})); }
function _cacheSet(k,v){ return _cacheOpen().then(db=>new Promise((res,rej)=>{const t=db.transaction("kv","readwrite");t.objectStore("kv").put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);})); }
function _cacheDel(k){ return _cacheOpen().then(db=>new Promise((res,rej)=>{const t=db.transaction("kv","readwrite");t.objectStore("kv").delete(k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error);})); }
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
    // Per-supplier order-cycle config — some suppliers only accept orders on
    // a fixed cadence, so the natural reorder-by must snap back to the last
    // eligible cycle date. Keys are supplierKey(name) — the normalized form
    // (js/02-utils.js) that survives capitalization + legal-suffix drift
    // across feeds. Values: { anchor: "YYYY-MM-DD", intervalDays: number,
    // displayName?: string }. Seed contains Sensourcing Trading Co.
    // (supplierKey → "sensourcing trading") on a 42-day cycle anchored at
    // 2026-07-24. Merged into DB.settings via the same DEFAULTS-merge path
    // as every other setting; org-shared through Supabase (correct — this
    // is a fact about the supplier, not a per-user preference).
    supplierCycles: {
      "sensourcing trading": {
        anchor: "2026-07-24",
        intervalDays: 42,
        leadInDays: 11,   // pill + filter surface this many days before the next cycle date
        displayName: "Sensourcing Trading Co.",
      },
    },
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

async function loadDB() {
  try {
    // Clean up legacy keys — we don't migrate; want a fresh bootstrap with embedded data
    for (const k of LEGACY_KEYS) {
      if (localStorage.getItem(k)) {
        localStorage.removeItem(k);
        console.log("Cleared legacy storage:", k);
      }
    }
    // Prefer IDB. On the first run after this change, migrate any existing
    // localStorage blob into IDB and free the 5 MB localStorage slot.
    let raw = null;
    try { raw = await _cacheGet(IDB_DB_KEY); } catch (e) { console.warn("IDB read failed", e); }
    if (!raw) {
      const ls = localStorage.getItem(STORAGE_KEY);
      if (ls) {
        raw = ls;
        try { await _cacheSet(IDB_DB_KEY, ls); console.log("Migrated DB cache from localStorage → IndexedDB"); } catch (e) { /* fall through */ }
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
      }
    }
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
      try { await _cacheDel(IDB_DB_KEY); } catch (e) { /* ignore */ }
      try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
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

// IDB writes are async and serializing a 1600-part DB isn't cheap — debounce
// so a burst of edits coalesces into a single write. Falls back to
// localStorage only if IDB is unreachable (private browsing, etc).
let _cacheTimer = null;
let _cachePending = false;
function saveDB() {
  _cachePending = true;
  if (!_cacheTimer) {
    _cacheTimer = setTimeout(async () => {
      _cacheTimer = null;
      if (!_cachePending) return;
      _cachePending = false;
      try {
        await _cacheSet(IDB_DB_KEY, JSON.stringify(DB));
      } catch (e) {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(DB)); }
        catch (e2) { showToast("Local cache error: " + e2.message, "warn", "Cache"); }
      }
    }, 250);
  }
  // Auto-mirror to linked Excel files (debounced internally)
  try { autoSyncExcel(); } catch (e) { /* don't break save */ }
}

