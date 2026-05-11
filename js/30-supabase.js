/* =====================================================
   30-supabase.js
   Slice 1: Cloud-sync the parts table to Supabase
   ===================================================== */

const SUPABASE_URL = "https://rqvswdxfebhlyouozltk.supabase.co";
const SUPABASE_KEY = "sb_publishable_ZKpVjpCIqANzi3suDX8SIQ_KeNyfsjr";

let _supa = null;
let _cloudReady = false;
let _lastCloudPartsHash = null;

// Wait for the main app to finish booting (DB must exist with parts)
async function _waitForDB() {
  let tries = 0;
  while ((!window.DB || !Array.isArray(window.DB.parts)) && tries < 100) {
    await new Promise(r => setTimeout(r, 50));
    tries++;
  }
  return !!window.DB;
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

  // Pull current cloud parts
  const { data, error } = await _supa.from("parts").select("pn, data");
  if (error) {
    console.error("[cloud] initial fetch failed:", error);
    showToast("Cloud sync failed: " + error.message, "crit");
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

  _cloudReady = true;
  _lastCloudPartsHash = _hashParts(DB.parts);
  _hookSaveDB();
  _showCloudIndicator(true);
}

function _hashParts(parts) {
  try {
    return parts.length + ":" + JSON.stringify(parts).length;
  } catch (e) {
    return parts.length + ":?";
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

let _cloudPushTimer = null;
function _schedulePush() {
  if (!_cloudReady) return;
  const currentHash = _hashParts(DB.parts);
  if (currentHash === _lastCloudPartsHash) return;
  clearTimeout(_cloudPushTimer);
  _showCloudIndicator(false, "syncing");
  _cloudPushTimer = setTimeout(async () => {
    const ok = await _pushAllParts();
    if (ok) {
      _lastCloudPartsHash = _hashParts(DB.parts);
      _showCloudIndicator(true);
    } else {
      _showCloudIndicator(false, "error");
    }
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
  const { data, error } = await _supa.from("parts").select("pn, data");
  if (error) { console.error(error); return; }
  DB.parts = data.map(r => ({ pn: r.pn, ...r.data }));
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  if (typeof bumpStatusCache === "function") bumpStatusCache();
  if (typeof refresh === "function") refresh();
  _lastCloudPartsHash = _hashParts(DB.parts);
  console.log("Pulled " + DB.parts.length + " parts from cloud");
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(cloudInit, 200));
} else {
  setTimeout(cloudInit, 200);
}
