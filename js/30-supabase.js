/* =====================================================
   30-supabase.js
   Slice 1: Cloud-sync the parts table to Supabase
   ===================================================== */

const SUPABASE_URL = "https://rqvswdxfebhlyouozltk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxdnN3ZHhmZWJobHlvdW96bHRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1Mzk2MTQsImV4cCI6MjA5NDExNTYxNH0.VU1Ciuez8Dh4W4uGA8cgLSZuOPCGPwQXLc5J4y9-h04";

let _supa = null;
let _cloudReady = false;
let _lastCloudDraftHash = null;
let _lastCloudSettingsHash = null;
let _lastCloudKitBomsHash = null;

// Delta tracking — only push records that actually changed
const _dirtyParts = new Set();    // PNs of parts that changed locally
const _dirtyPos = new Set();      // PO IDs that changed
const _dirtyAudit = new Set();    // audit IDs (new entries only — audit is append-only)
const _dirtyUsage = new Set();    // usage IDs that changed
const _dirtyKitBoms = new Set();  // kit_pns that changed
let _settingsDirty = false;
const _partsSnapshot = new Map(); // last-pushed snapshot per PN (also stores audit_<id> markers and __settings__ blob)
const _posSnapshot = new Map();
const _usageSnapshot = new Map(); // separate to avoid overloading _partsSnapshot
const _kitBomsSnapshot = new Map();

// Wait for the main app to finish booting (DB must exist with parts)
async function _waitForDB() {
  let tries = 0;
  while ((typeof DB === "undefined" || !DB || !Array.isArray(DB.parts)) && tries < 100) {
    await new Promise(r => setTimeout(r, 50));
    tries++;
  }
  return typeof DB !== "undefined" && !!DB;
}

// Fetch ALL parts from Supabase, paging past the default 1000-row limit
async function _fetchAllParts() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("parts")
      .select("pn, data")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Fetch ALL POs from Supabase, paginated
async function _fetchAllPos() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("pos")
      .select("id, data")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] pos page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// BOM links — read-only from the browser's perspective. Server-side
// netlify/functions/acumatica-bom-sync.js owns writes (daily). One paged
// fetch on boot is enough; no realtime subscription, no push hooks.
async function _fetchAllBomLinks() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("bom_links")
      .select("id, data")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] bom_links page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function _fetchAllAudit() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("audit")
      .select("id, data")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] audit page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function cloudInit() {
  const ok = await _waitForDB();
  if (!ok) {
    console.error("[cloud] DB never became ready");
    return;
  }

  if (!window.supabase || !window.supabase.createClient) {
    console.error("[cloud] Supabase SDK not loaded");
    showToast("Cloud sync unavailable: SDK not loaded", "crit");
    return;
  }

  _supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // Pull current cloud parts (paginated to handle >1000 rows)
  const data = await _fetchAllParts();
  if (data === null) {
    showToast("Cloud sync failed during initial fetch", "crit");
    return;
  }

  console.log(`[cloud] cloud has ${data.length} parts, local has ${DB.parts.length}`);

  if (data.length === 0 && DB.parts.length > 0) {
    // First-time migration: push local up
    showToast(`Pushing ${DB.parts.length} parts to cloud (one-time)…`, "info", "Cloud sync");
    const success = await _pushAllParts();
    if (success) {
      showToast(`Migration complete: ${DB.parts.length} parts now in cloud`, "ok", "Cloud sync");
    }
  } else if (data.length > 0) {
    // Cloud has data → replace local
    const cloudParts = data.map(r => ({ pn: r.pn, ...r.data }));
    DB.parts = cloudParts;
    _origSaveDB ? _origSaveDB.call(window) : saveDB();
    if (typeof bumpStatusCache === "function") bumpStatusCache();
    if (typeof refresh === "function") refresh();
    showToast(`Synced ${cloudParts.length} parts from cloud`, "ok", "Cloud connected");
  }

  // ---- POs ----
  const cloudPos = await _fetchAllPos();
  if (cloudPos !== null) {
    if (cloudPos.length === 0 && DB.pos && DB.pos.length > 0) {
      showToast(`Pushing ${DB.pos.length} POs to cloud (one-time)…`, "info", "Cloud sync");
      await _pushAllPos();
      showToast(`Migrated ${DB.pos.length} POs to cloud`, "ok", "Cloud sync");
    } else if (cloudPos.length > 0) {
      DB.pos = cloudPos.map(r => ({ id: r.id, ...r.data }));
      _origSaveDB ? _origSaveDB.call(window) : saveDB();
      if (typeof bumpStatusCache === "function") bumpStatusCache();
      if (typeof refresh === "function") refresh();
      showToast(`Synced ${cloudPos.length} POs from cloud`, "ok");
    }
  }

  // ---- Draft Order ----
  const cloudDraft = await _fetchCloudDraft();
  if (cloudDraft !== null) {
    if (typeof DRAFT_ORDER !== "undefined") {
      if (cloudDraft.length === 0 && DRAFT_ORDER.length > 0) {
        await _pushDraft();
      } else if (cloudDraft.length > 0) {
        // Replace local with cloud
        DRAFT_ORDER.length = 0;
        DRAFT_ORDER.push(...cloudDraft);
        if (typeof draftOrderSave === "function") draftOrderSave();
        if (typeof updateDraftOrderPill === "function") updateDraftOrderPill();
      }
    }
    _lastCloudDraftHash = _hashDraft(typeof DRAFT_ORDER !== "undefined" ? DRAFT_ORDER : []);
  }

  // ---- Audit Log ----
  // Cloud-wins strategy (NOT merge): cloud is source of truth.
  // Local rows missing from cloud are treated as "deleted in cloud" and removed.
  const cloudAudit = await _fetchAllAudit();
  if (cloudAudit !== null) {
    if (cloudAudit.length === 0 && DB.audit && DB.audit.length > 0) {
      // Cloud is empty for the first time — push local up
      showToast(`Pushing ${DB.audit.length} audit entries to cloud (one-time)…`, "info", "Cloud sync");
      await _pushAllAudit();
    } else {
      // Cloud has data — replace local entirely with cloud
      DB.audit = cloudAudit.map(r => ({ id: r.id, ...r.data })).sort((a, b) => {
        const ta = a.ts || a.time || "";
        const tb = b.ts || b.time || "";
        return tb.localeCompare(ta); // newest first
      });
      _origSaveDB ? _origSaveDB.call(window) : saveDB();
    }
  }

  // ---- Settings ----
  const cloudSettings = await _fetchCloudSettings();
  if (cloudSettings !== null) {
    DB.settings = { ...DB.settings, ...cloudSettings };
    _origSaveDB ? _origSaveDB.call(window) : saveDB();
  } else if (DB.settings) {
    await _pushSettings();
  }
  _lastCloudSettingsHash = _hashSettings(DB.settings);

  // ---- Usage ----
  // Cloud-wins strategy (NOT merge): cloud is source of truth.
  // Local rows missing from cloud are treated as "deleted in cloud" and removed.
  const cloudUsage = await _fetchAllUsage();
  if (cloudUsage !== null) {
    if (cloudUsage.length === 0 && DB.usage && DB.usage.length > 0) {
      // Cloud is empty for the first time — push local up
      showToast(`Pushing ${DB.usage.length} usage entries to cloud (one-time)…`, "info", "Cloud sync");
      await _pushAllUsage();
    } else {
      // Cloud has data — replace local entirely with cloud
      DB.usage = cloudUsage.map(r => ({ id: r.id, ...r.data })).sort((a, b) => {
        const ta = a.ts || ""; const tb = b.ts || "";
        return tb.localeCompare(ta);
      });
      _origSaveDB ? _origSaveDB.call(window) : saveDB();
      if (cloudUsage.length > 0) {
        showToast(`Synced ${cloudUsage.length} usage entries from cloud`, "ok");
      }
    }
  }

  // ---- Kit BOMs ----
  // Cloud-wins strategy. In-place mutation of DB.kitBoms.
  const cloudKitBoms = await _fetchAllKitBoms();
  if (cloudKitBoms !== null) {
    if (!DB.kitBoms || typeof DB.kitBoms !== "object") DB.kitBoms = {};
    if (cloudKitBoms.length === 0 && Object.keys(DB.kitBoms).length > 0) {
      // Cloud is empty for the first time — push local up
      showToast(`Pushing ${Object.keys(DB.kitBoms).length} kit BOMs to cloud (one-time)…`, "info", "Cloud sync");
      await _pushAllKitBoms();
    } else {
      // Replace local entirely with cloud (in place)
      for (const k of Object.keys(DB.kitBoms)) delete DB.kitBoms[k];
      for (const r of cloudKitBoms) DB.kitBoms[r.kit_pn] = { kit_pn: r.kit_pn, ...r.data };
      _origSaveDB ? _origSaveDB.call(window) : saveDB();
      if (cloudKitBoms.length > 0) {
        showToast(`Synced ${cloudKitBoms.length} kit BOMs from cloud`, "ok");
      }
    }
    _lastCloudKitBomsHash = _hashKitBoms(DB.kitBoms);
  }

  // ---- BOM Links (read-only) ----
  // Slow-moving reference data; we pull once on boot and never push from the
  // browser. Stored as a flat array of { bomId, parent, child, qty, uom }.
  // NOT persisted via saveDB — re-fetched from cloud each session — and NOT
  // included in the realtime subscription set below.
  const cloudBomLinks = await _fetchAllBomLinks();
  if (cloudBomLinks !== null) {
    DB.bomLinks = cloudBomLinks.map(r => ({ id: r.id, ...r.data }));
    console.log(`[cloud] loaded ${DB.bomLinks.length} bom_links rows`);
    if (DB.bomLinks.length === 0) {
      console.warn("[cloud] bom_links is EMPTY — multi-level BOM explosion will return no leaves. Check Supabase table or daily Acumatica BOM sync.");
    }
    if (typeof refresh === "function") refresh();
  } else {
    // Fetch failed entirely — keep whatever's already on DB (likely undefined)
    // and warn so the page can surface it.
    console.warn("[cloud] bom_links fetch failed; DB.bomLinks may be unset");
    if (!Array.isArray(DB.bomLinks)) DB.bomLinks = [];
  }

  _cloudReady = true;
  // Prime snapshots so future _detectChanges() only flags real edits
  for (const p of DB.parts) _partsSnapshot.set(p.pn, JSON.stringify(p));
  for (const po of (DB.pos || [])) _posSnapshot.set(po.id, JSON.stringify(po));
  for (const a of (DB.audit || [])) if (a.id) _partsSnapshot.set("audit_" + a.id, "1");
  for (const u of (DB.usage || [])) if (u.id) _usageSnapshot.set(u.id, JSON.stringify(u));
  for (const [kit_pn, kit] of Object.entries(DB.kitBoms || {})) _kitBomsSnapshot.set(kit_pn, JSON.stringify(kit));
  _partsSnapshot.set("__settings__", JSON.stringify(DB.settings || {}));
  _hookSaveDB();
  _hookDraftSave();
  _showCloudIndicator(true);
  _setupRealtimeSubscriptions();
}

let _realtimeChannel = null;
let _suppressNextLocalChange = false; // prevents echo: don't re-push what we just received

function _setupRealtimeSubscriptions() {
  if (_realtimeChannel) return; // already subscribed
  if (!_supa) return;

  _realtimeChannel = _supa
    .channel("landmaster-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "parts" }, (payload) => {
      _handleRealtimePart(payload);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "pos" }, (payload) => {
      _handleRealtimePO(payload);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "draft_order" }, (payload) => {
      _handleRealtimeDraft(payload);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "audit" }, (payload) => {
      _handleRealtimeAudit(payload);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "settings" }, (payload) => {
      _handleRealtimeSettings(payload);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "usage" }, (payload) => {
      _handleRealtimeUsage(payload);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "kit_boms" }, (payload) => {
      _handleRealtimeKitBoms(payload);
    })
    .subscribe((status) => {
      console.log("[cloud] realtime status:", status);
    });
}

let _redrawTimer = null;
let _scrollRestoreRAF = null;
function _applyAndRefresh() {
  _suppressNextLocalChange = true;
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  _suppressNextLocalChange = false;
  if (typeof bumpStatusCache === "function") bumpStatusCache();
  // Debounce redraws so a burst of realtime events causes one re-render, not many
  clearTimeout(_redrawTimer);
  _redrawTimer = setTimeout(() => {
    // Realtime re-renders shouldn't snap the page back to the top. navigate()
    // intentionally resets main.scrollTop for user-initiated route changes,
    // so we capture the position around the call and restore it once the new
    // DOM is laid out. Cancel any prior pending restore so a stale snapshot
    // from an earlier burst can't clobber the user's current scroll position.
    if (_scrollRestoreRAF !== null) cancelAnimationFrame(_scrollRestoreRAF);
    const main = document.getElementById("main");
    const savedScrollTop = main ? main.scrollTop : 0;
    const currentRoute = document.querySelector(".nav-item.active")?.dataset?.route;
    if (currentRoute && typeof navigate === "function") {
      navigate(currentRoute);
    } else if (typeof refresh === "function") {
      refresh();
    }
    if (main) {
      _scrollRestoreRAF = requestAnimationFrame(() => {
        main.scrollTop = savedScrollTop;
        _scrollRestoreRAF = null;
      });
    }
  }, 150);
}

function _handleRealtimePart(payload) {
  const { eventType, new: row, old } = payload;
  if (eventType === "DELETE") {
    const i = DB.parts.findIndex(p => p.pn === old.pn);
    if (i >= 0) DB.parts.splice(i, 1);
  } else {
    const merged = { pn: row.pn, ...row.data };
    const i = DB.parts.findIndex(p => p.pn === row.pn);
    if (i >= 0) DB.parts[i] = merged;
    else DB.parts.push(merged);
  }
  _applyAndRefresh();
}

function _handleRealtimePO(payload) {
  const { eventType, new: row, old } = payload;
  if (eventType === "DELETE") {
    const i = DB.pos.findIndex(p => p.id === old.id);
    if (i >= 0) DB.pos.splice(i, 1);
  } else {
    const merged = { id: row.id, ...row.data };
    const i = DB.pos.findIndex(p => p.id === row.id);
    if (i >= 0) DB.pos[i] = merged;
    else DB.pos.push(merged);
  }
  _applyAndRefresh();
}

function _handleRealtimeDraft(payload) {
  const { new: row } = payload;
  const items = row?.data?.items || [];
  if (typeof DRAFT_ORDER !== "undefined") {
    DRAFT_ORDER.length = 0;
    DRAFT_ORDER.push(...items);
    if (typeof draftOrderSave === "function") {
      _suppressNextLocalChange = true;
      draftOrderSave();
      _suppressNextLocalChange = false;
    }
    if (typeof updateDraftOrderPill === "function") updateDraftOrderPill();
  }
  _lastCloudDraftHash = _hashDraft(typeof DRAFT_ORDER !== "undefined" ? DRAFT_ORDER : []);
}

function _handleRealtimeAudit(payload) {
  const { eventType, new: row, old } = payload;
  if (eventType === "DELETE") {
    const i = DB.audit.findIndex(a => a.id === old.id);
    if (i >= 0) DB.audit.splice(i, 1);
  } else {
    const merged = { id: row.id, ...row.data };
    const i = DB.audit.findIndex(a => a.id === row.id);
    if (i >= 0) DB.audit[i] = merged;
    else DB.audit.unshift(merged); // newest first
  }
  _applyAndRefresh();
}

function _handleRealtimeSettings(payload) {
  const { new: row } = payload;
  if (row?.data) {
    DB.settings = { ...DB.settings, ...row.data };
    _lastCloudSettingsHash = _hashSettings(DB.settings);
    _applyAndRefresh();
  }
}

function _handleRealtimeUsage(payload) {
  const { eventType, new: row, old } = payload;
  if (!DB.usage) DB.usage = [];
  if (eventType === "DELETE") {
    const i = DB.usage.findIndex(u => u.id === old.id);
    if (i >= 0) DB.usage.splice(i, 1);
  } else {
    const merged = { id: row.id, ...row.data };
    const i = DB.usage.findIndex(u => u.id === row.id);
    if (i >= 0) DB.usage[i] = merged;
    else DB.usage.push(merged);
  }
  _applyAndRefresh();
}

function _handleRealtimeKitBoms(payload) {
  const { eventType, new: row, old } = payload;
  if (!DB.kitBoms || typeof DB.kitBoms !== "object") DB.kitBoms = {};
  if (eventType === "DELETE") {
    delete DB.kitBoms[old.kit_pn];
  } else {
    DB.kitBoms[row.kit_pn] = { kit_pn: row.kit_pn, ...row.data };
  }
  _lastCloudKitBomsHash = _hashKitBoms(DB.kitBoms);
  _applyAndRefresh();
}

async function _pushAllParts() {
  if (!_supa) return false;
  if (DB.parts.length === 0) return true;

  const rows = DB.parts.map(p => {
    const { pn, ...rest } = p;
    return { pn, data: rest };
  });

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await _supa.from("parts").upsert(batch);
    if (error) {
      console.error("[cloud] batch upsert failed:", error);
      showToast("Cloud push failed: " + error.message, "crit");
      return false;
    }
  }
  return true;
}

async function _pushAllPos() {
  if (!_supa) return false;
  if (!DB.pos || DB.pos.length === 0) return true;

  const rows = DB.pos.map(p => {
    const { id, ...rest } = p;
    return { id, data: rest };
  });

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await _supa.from("pos").upsert(batch);
    if (error) {
      console.error("[cloud] pos batch upsert failed:", error);
      showToast("Cloud push failed: " + error.message, "crit");
      return false;
    }
  }
  return true;
}

async function _pushAllAudit() {
  if (!_supa) return false;
  if (!DB.audit || DB.audit.length === 0) return true;

  // Backfill missing IDs on legacy entries (created before id was added at creation time)
  for (const a of DB.audit) {
    if (!a.id) {
      a.id = "audit_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    }
  }

  const rows = DB.audit.map(a => {
    const { id, ...rest } = a;
    return { id, data: rest };
  });

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await _supa.from("audit").upsert(batch);
    if (error) {
      console.error("[cloud] audit batch upsert failed:", error);
      showToast("Cloud push failed: " + error.message, "crit");
      return false;
    }
  }
  return true;
}

async function _fetchCloudSettings() {
  if (!_supa) return null;
  const { data, error } = await _supa.from("settings").select("data").eq("id", "current").maybeSingle();
  if (error) { console.error("[cloud] settings fetch failed:", error); return null; }
  return data?.data || null;
}

async function _pushSettings() {
  if (!_supa) return false;
  const { error } = await _supa.from("settings").upsert({ id: "current", data: DB.settings || {} });
  if (error) { console.error("[cloud] settings push failed:", error); return false; }
  return true;
}

async function _fetchAllUsage() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa.from("usage").select("id, data").range(from, from + PAGE - 1);
    if (error) { console.error("[cloud] usage page fetch failed:", error); return null; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function _pushAllUsage() {
  if (!_supa) return false;
  if (!DB.usage || DB.usage.length === 0) return true;
  let backfilled = 0;
  for (const u of DB.usage) {
    if (!u.id) {
      u.id = "usage_" + (u.ts || Date.now()) + "_" + Math.random().toString(36).slice(2, 8);
      backfilled++;
    }
  }
  if (backfilled > 0) console.log("[cloud] backfilled " + backfilled + " usage IDs");
  const rows = DB.usage.map(u => {
    const { id, ...rest } = u;
    return { id, data: rest };
  });
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await _supa.from("usage").upsert(batch);
    if (error) { console.error("[cloud] usage batch upsert failed:", error); showToast("Cloud push failed: " + error.message, "crit"); return false; }
  }
  return true;
}

async function _pushDirtyParts() {
  if (_dirtyParts.size === 0) return true;
  const byPn = new Map(DB.parts.map(p => [p.pn, p]));
  const rows = [];
  for (const pn of _dirtyParts) {
    const p = byPn.get(pn);
    if (p) {
      const { pn: _, ...rest } = p;
      rows.push({ pn, data: rest });
    }
  }
  if (rows.length === 0) { _dirtyParts.clear(); return true; }
  const { error } = await _supa.from("parts").upsert(rows);
  if (error) { console.error("[cloud] dirty parts push failed:", error); return false; }
  _dirtyParts.clear();
  return true;
}

async function _pushDirtyPos() {
  if (_dirtyPos.size === 0) return true;
  const byId = new Map((DB.pos || []).map(p => [p.id, p]));
  const rows = [];
  for (const id of _dirtyPos) {
    const po = byId.get(id);
    if (po) {
      const { id: _, ...rest } = po;
      rows.push({ id, data: rest });
    }
  }
  if (rows.length === 0) { _dirtyPos.clear(); return true; }
  const { error } = await _supa.from("pos").upsert(rows);
  if (error) { console.error("[cloud] dirty pos push failed:", error); return false; }
  _dirtyPos.clear();
  return true;
}

async function _pushDirtyAudit() {
  if (_dirtyAudit.size === 0) return true;
  const byId = new Map((DB.audit || []).map(a => [a.id, a]));
  const rows = [];
  for (const id of _dirtyAudit) {
    const a = byId.get(id);
    if (a) {
      const { id: _, ...rest } = a;
      rows.push({ id, data: rest });
    }
  }
  if (rows.length === 0) { _dirtyAudit.clear(); return true; }
  const { error } = await _supa.from("audit").upsert(rows);
  if (error) { console.error("[cloud] dirty audit push failed:", error); return false; }
  _dirtyAudit.clear();
  return true;
}

async function _pushDirtyUsage() {
  if (_dirtyUsage.size === 0) return true;
  const byId = new Map((DB.usage || []).map(u => [u.id, u]));
  const rows = [];
  for (const id of _dirtyUsage) {
    const u = byId.get(id);
    if (u) {
      const { id: _, ...rest } = u;
      rows.push({ id, data: rest });
    }
  }
  if (rows.length === 0) { _dirtyUsage.clear(); return true; }
  const { error } = await _supa.from("usage").upsert(rows);
  if (error) { console.error("[cloud] dirty usage push failed:", error); return false; }
  _dirtyUsage.clear();
  return true;
}

function _hashSettings(s) {
  try { return JSON.stringify(s || {}).length; } catch (e) { return 0; }
}
function _hashKitBoms(k) {
  try { return Object.keys(k || {}).length + ":" + JSON.stringify(k || {}).length; } catch (e) { return "?"; }
}

async function _fetchAllKitBoms() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa.from("kit_boms").select("kit_pn, data").range(from, from + PAGE - 1);
    if (error) { console.error("[cloud] kit_boms page fetch failed:", error); return null; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function _pushAllKitBoms() {
  if (!_supa) return false;
  const kits = DB.kitBoms || {};
  const entries = Object.entries(kits);
  if (entries.length === 0) return true;

  const rows = entries.map(([kit_pn, kit]) => {
    const { kit_pn: _, ...rest } = kit;
    return { kit_pn, data: rest };
  });

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await _supa.from("kit_boms").upsert(batch);
    if (error) {
      console.error("[cloud] kit_boms batch upsert failed:", error);
      showToast("Cloud push failed: " + error.message, "crit");
      return false;
    }
  }
  return true;
}

async function _pushDirtyKitBoms() {
  if (_dirtyKitBoms.size === 0) return true;
  const rows = [];
  for (const kit_pn of _dirtyKitBoms) {
    const kit = DB.kitBoms?.[kit_pn];
    if (kit) {
      const { kit_pn: _, ...rest } = kit;
      rows.push({ kit_pn, data: rest });
    }
  }
  if (rows.length === 0) { _dirtyKitBoms.clear(); return true; }
  const { error } = await _supa.from("kit_boms").upsert(rows);
  if (error) { console.error("[cloud] dirty kit_boms push failed:", error); return false; }
  _dirtyKitBoms.clear();
  return true;
}

function _detectChanges() {
  // Parts: find pns whose JSON has changed since last push
  for (const p of DB.parts) {
    const json = JSON.stringify(p);
    if (_partsSnapshot.get(p.pn) !== json) {
      _dirtyParts.add(p.pn);
      _partsSnapshot.set(p.pn, json);
    }
  }
  // POs
  for (const po of (DB.pos || [])) {
    const json = JSON.stringify(po);
    if (_posSnapshot.get(po.id) !== json) {
      _dirtyPos.add(po.id);
      _posSnapshot.set(po.id, json);
    }
  }
  // Audit: any new entries (append-only, compare by Set membership)
  for (const a of (DB.audit || [])) {
    if (a.id && !_partsSnapshot.has("audit_" + a.id)) {
      _dirtyAudit.add(a.id);
      _partsSnapshot.set("audit_" + a.id, "1");
    }
  }
  // Usage: per-id JSON comparison
  for (const u of (DB.usage || [])) {
    if (!u.id) continue;
    const json = JSON.stringify(u);
    if (_usageSnapshot.get(u.id) !== json) {
      _dirtyUsage.add(u.id);
      _usageSnapshot.set(u.id, json);
    }
  }
  // Settings: single blob comparison
  const settingsJson = JSON.stringify(DB.settings || {});
  if (_partsSnapshot.get("__settings__") !== settingsJson) {
    _settingsDirty = true;
    _partsSnapshot.set("__settings__", settingsJson);
  }
  // Kit BOMs: per-kit JSON comparison
  for (const [kit_pn, kit] of Object.entries(DB.kitBoms || {})) {
    const json = JSON.stringify(kit);
    if (_kitBomsSnapshot.get(kit_pn) !== json) {
      _dirtyKitBoms.add(kit_pn);
      _kitBomsSnapshot.set(kit_pn, json);
    }
  }
}

function _hashDraft(arr) {
  try { return (arr?.length || 0) + ":" + JSON.stringify(arr || []).length; }
  catch (e) { return (arr?.length || 0) + ":?"; }
}

async function _fetchCloudDraft() {
  if (!_supa) return null;
  const { data, error } = await _supa
    .from("draft_order")
    .select("data")
    .eq("id", "current")
    .maybeSingle();
  if (error) {
    console.error("[cloud] draft fetch failed:", error);
    return null;
  }
  return data?.data?.items || null;
}

async function _pushDraft() {
  if (!_supa) return false;
  const items = (typeof DRAFT_ORDER !== "undefined" && Array.isArray(DRAFT_ORDER)) ? DRAFT_ORDER : [];
  const { error } = await _supa.from("draft_order").upsert({
    id: "current",
    data: { items },
  });
  if (error) {
    console.error("[cloud] draft push failed:", error);
    return false;
  }
  return true;
}

let _cloudPushTimer = null;
function _schedulePush() {
  if (!_cloudReady) return;
  if (_suppressNextLocalChange) return;
  _detectChanges();
  if (_dirtyParts.size === 0 && _dirtyPos.size === 0 && _dirtyAudit.size === 0 && _dirtyUsage.size === 0 && _dirtyKitBoms.size === 0 && !_settingsDirty) return;

  clearTimeout(_cloudPushTimer);
  _showCloudIndicator(false, "syncing");
  _cloudPushTimer = setTimeout(async () => {
    let allOk = true;
    const promises = [];
    if (_dirtyParts.size > 0)   promises.push(_pushDirtyParts().then(ok => !ok && (allOk = false)));
    if (_dirtyPos.size > 0)     promises.push(_pushDirtyPos().then(ok => !ok && (allOk = false)));
    if (_dirtyAudit.size > 0)   promises.push(_pushDirtyAudit().then(ok => !ok && (allOk = false)));
    if (_dirtyUsage.size > 0)   promises.push(_pushDirtyUsage().then(ok => !ok && (allOk = false)));
    if (_dirtyKitBoms.size > 0) promises.push(_pushDirtyKitBoms().then(ok => !ok && (allOk = false)));
    if (_settingsDirty) {
      promises.push(_pushSettings().then(ok => { if (ok) _settingsDirty = false; else allOk = false; }));
    }
    await Promise.all(promises);
    _showCloudIndicator(allOk, allOk ? undefined : "error");
  }, 250);  // FAST debounce: 250ms instead of 1200ms
}

let _origSaveDB = null;
function _hookSaveDB() {
  if (_origSaveDB) return;
  _origSaveDB = window.saveDB;
  window.saveDB = function () {
    _origSaveDB.apply(this, arguments);
    _schedulePush();
  };
}

let _origDraftOrderSave = null;
function _hookDraftSave() {
  if (_origDraftOrderSave) return;
  if (typeof draftOrderSave !== "function") return;
  _origDraftOrderSave = window.draftOrderSave;
  window.draftOrderSave = function () {
    _origDraftOrderSave.apply(this, arguments);
    _scheduleDraftPush();
  };
}

let _draftPushTimer = null;
function _scheduleDraftPush() {
  if (!_cloudReady) return;
  if (_suppressNextLocalChange) return;
  const h = _hashDraft(typeof DRAFT_ORDER !== "undefined" ? DRAFT_ORDER : []);
  if (h === _lastCloudDraftHash) return;
  clearTimeout(_draftPushTimer);
  _showCloudIndicator(false, "syncing");
  _draftPushTimer = setTimeout(async () => {
    const ok = await _pushDraft();
    if (ok) {
      _lastCloudDraftHash = _hashDraft(typeof DRAFT_ORDER !== "undefined" ? DRAFT_ORDER : []);
      _showCloudIndicator(true);
    } else {
      _showCloudIndicator(false, "error");
    }
  }, 250);
}

function _showCloudIndicator(ready, state) {
  let el = document.getElementById("cloud-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "cloud-indicator";
    el.style.cssText = "position:fixed;bottom:10px;left:12px;z-index:9999;width:10px;height:10px;border-radius:50%;transition:background .2s,box-shadow .2s;cursor:default";
    document.body.appendChild(el);
  }
  let color, label;
  if (state === "syncing")    { color = "#e6c84f"; label = "Cloud: syncing…"; }
  else if (state === "error") { color = "#e25555"; label = "Cloud: sync error"; }
  else if (ready)             { color = "var(--accent)"; label = "Cloud: connected"; }
  else                        { color = "#777"; label = "Cloud: connecting…"; }
  el.style.background = color;
  el.style.boxShadow = "0 0 6px " + color;
  el.title = label;
}

window.cloudForcePush = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  _showCloudIndicator(false, "syncing");
  const ok = await _pushAllParts();
  if (ok) {
    _showCloudIndicator(true);
    console.log("Force-pushed " + DB.parts.length + " parts");
  }
};

window.cloudForcePull = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const data = await _fetchAllParts();
  if (data === null) { console.error("Force pull failed"); return; }
  DB.parts = data.map(r => ({ pn: r.pn, ...r.data }));
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  if (typeof bumpStatusCache === "function") bumpStatusCache();
  if (typeof refresh === "function") refresh();
  console.log("Pulled " + DB.parts.length + " parts from cloud");
};

window.cloudForcePushPos = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  _showCloudIndicator(false, "syncing");
  const ok = await _pushAllPos();
  if (ok) {
    _showCloudIndicator(true);
    console.log("Force-pushed " + (DB.pos?.length || 0) + " POs");
  }
};

window.cloudForcePullPos = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const data = await _fetchAllPos();
  if (data === null) { console.error("Force pull failed"); return; }
  DB.pos = data.map(r => ({ id: r.id, ...r.data }));
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  if (typeof bumpStatusCache === "function") bumpStatusCache();
  if (typeof refresh === "function") refresh();
  console.log("Pulled " + DB.pos.length + " POs from cloud");
};

window.cloudForcePullAudit = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const data = await _fetchAllAudit();
  if (data === null) { console.error("Force pull failed"); return; }
  DB.audit = data.map(r => ({ id: r.id, ...r.data })).sort((a, b) => {
    const ta = a.ts || a.time || "";
    const tb = b.ts || b.time || "";
    return tb.localeCompare(ta);
  });
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  console.log("Pulled " + DB.audit.length + " audit entries from cloud");
};

window.cloudForcePullDraft = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const items = await _fetchCloudDraft();
  if (items === null) { console.log("Pull failed"); return; }
  if (typeof DRAFT_ORDER !== "undefined") {
    DRAFT_ORDER.length = 0;
    DRAFT_ORDER.push(...items);
    if (typeof draftOrderSave === "function") draftOrderSave();
    if (typeof updateDraftOrderPill === "function") updateDraftOrderPill();
    _lastCloudDraftHash = _hashDraft(DRAFT_ORDER);
    console.log("Pulled " + items.length + " draft items from cloud");
  }
};

window.cloudForcePullBomLinks = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const data = await _fetchAllBomLinks();
  if (data === null) { console.error("Force pull failed"); return; }
  DB.bomLinks = data.map(r => ({ id: r.id, ...r.data }));
  if (typeof refresh === "function") refresh();
  console.log("Pulled " + DB.bomLinks.length + " bom_links from cloud");
};

window.cloudForcePullKitBoms = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const data = await _fetchAllKitBoms();
  if (data === null) { console.error("Force pull failed"); return; }
  if (!DB.kitBoms || typeof DB.kitBoms !== "object") DB.kitBoms = {};
  for (const k of Object.keys(DB.kitBoms)) delete DB.kitBoms[k];
  for (const r of data) DB.kitBoms[r.kit_pn] = { kit_pn: r.kit_pn, ...r.data };
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  _lastCloudKitBomsHash = _hashKitBoms(DB.kitBoms);
  console.log("Pulled " + data.length + " kit BOMs from cloud");
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(cloudInit, 200));
} else {
  setTimeout(cloudInit, 200);
}
