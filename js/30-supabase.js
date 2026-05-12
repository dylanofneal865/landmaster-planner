/* =====================================================
   30-supabase.js
   Slice 1: Cloud-sync the parts table to Supabase
   ===================================================== */

const SUPABASE_URL = "https://rqvswdxfebhlyouozltk.supabase.co";
const SUPABASE_KEY = "sb_publishable_ZKpVjpCIqANzi3suDX8SIQ_KeNyfsjr";

let _supa = null;
let _cloudReady = false;
let _lastCloudPartsHash = null;
let _lastCloudPosHash = null;
let _lastCloudDraftHash = null;

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
    _lastCloudPosHash = _hashPos(DB.pos || []);
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

  _cloudReady = true;
  _lastCloudPartsHash = _hashParts(DB.parts);
  _hookSaveDB();
  _hookDraftSave();
  _showCloudIndicator(true);
}

function _hashParts(parts) {
  try {
    return parts.length + ":" + JSON.stringify(parts).length;
  } catch (e) {
    return parts.length + ":?";
  }
}

function _hashPos(pos) {
  try {
    return pos.length + ":" + JSON.stringify(pos).length;
  } catch (e) {
    return pos.length + ":?";
  }
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
  const partsHash = _hashParts(DB.parts);
  const posHash = _hashPos(DB.pos || []);
  const partsChanged = partsHash !== _lastCloudPartsHash;
  const posChanged = posHash !== _lastCloudPosHash;
  if (!partsChanged && !posChanged) return;

  clearTimeout(_cloudPushTimer);
  _showCloudIndicator(false, "syncing");
  _cloudPushTimer = setTimeout(async () => {
    let allOk = true;
    if (partsChanged) {
      const ok = await _pushAllParts();
      if (ok) _lastCloudPartsHash = _hashParts(DB.parts);
      else allOk = false;
    }
    if (posChanged) {
      const ok = await _pushAllPos();
      if (ok) _lastCloudPosHash = _hashPos(DB.pos || []);
      else allOk = false;
    }
    _showCloudIndicator(allOk, allOk ? undefined : "error");
  }, 1200);
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
  }, 800);
}

function _showCloudIndicator(ready, state) {
  let el = document.getElementById("cloud-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "cloud-indicator";
    el.style.cssText = "position:fixed;bottom:8px;right:12px;z-index:9999;font:11px ui-monospace,monospace;padding:4px 8px;border-radius:4px;background:rgba(0,0,0,0.7);color:#fff;pointer-events:none";
    document.body.appendChild(el);
  }
  if (state === "syncing") {
    el.textContent = "☁ syncing…";
    el.style.background = "rgba(80,80,40,0.85)";
  } else if (state === "error") {
    el.textContent = "☁ sync error";
    el.style.background = "rgba(140,40,40,0.85)";
  } else if (ready) {
    el.textContent = "☁ cloud OK";
    el.style.background = "rgba(40,80,40,0.85)";
  } else {
    el.textContent = "☁ connecting…";
    el.style.background = "rgba(60,60,60,0.85)";
  }
}

window.cloudForcePush = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  _showCloudIndicator(false, "syncing");
  const ok = await _pushAllParts();
  if (ok) {
    _lastCloudPartsHash = _hashParts(DB.parts);
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
  _lastCloudPartsHash = _hashParts(DB.parts);
  console.log("Pulled " + DB.parts.length + " parts from cloud");
};

window.cloudForcePushPos = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  _showCloudIndicator(false, "syncing");
  const ok = await _pushAllPos();
  if (ok) {
    _lastCloudPosHash = _hashPos(DB.pos || []);
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
  _lastCloudPosHash = _hashPos(DB.pos);
  console.log("Pulled " + DB.pos.length + " POs from cloud");
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

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(cloudInit, 200));
} else {
  setTimeout(cloudInit, 200);
}
