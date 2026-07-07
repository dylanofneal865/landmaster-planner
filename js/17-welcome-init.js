/* =====================================================
   17-welcome-init.js
   Sections: WELCOME / FIRST RUN, INITIALIZATION — wires everything together on DOM ready
   ===================================================== */

/* ============================================================
   WELCOME / FIRST RUN
   ============================================================ */
function showCriticalNotification() {
  const stats = partsWithStatus();
  const crit = stats.filter(p => p.status === "critical" && p.itemType !== "do_not_order").length;
  const warn = stats.filter(p => p.status === "warning" && p.itemType !== "do_not_order").length;
  if (crit > 0) {
    showToast(`${crit} part${crit===1?'':'s'} will run out before reorder arrives — check the Order Queue.`, "crit", "⚠ Action required");
  }
  if (warn > 0) {
    setTimeout(() => {
      showToast(`${warn} part${warn===1?'':'s'} approaching reorder threshold.`, "warn", "Heads-up");
    }, 800);
  }
}

/* ============================================================
   INITIALIZATION — wires everything together on DOM ready
   ============================================================ */
async function initApp() {
  try {
    // ----- Boot DB: cache → embedded bootstrap → defaults fallback -----
    //
    // The fresh-visitor failure mode this guards against:
    //
    //   1. loadDB() returns null (no IDB blob, no legacy localStorage).
    //   2. bootstrapSample() sets DB directly AND calls saveDB(), but
    //      saveDB() is debounced 250ms, so the IDB write hasn't landed
    //      yet. Calling loadDB() again immediately after would read an
    //      empty cache and clobber the bootstrap with null — that was
    //      the original bug (DB.meta crash at line 62).
    //
    // The fix: bootstrapSample already mutates the global DB, so trust
    // it. Only re-load is removed. A final defaults-clone safety net
    // covers the case where bootstrap itself failed silently (no embedded
    // data, network down, decompression error swallowed). After this
    // block, DB is GUARANTEED non-null and shape-safe.
    DB = await loadDB();
    if (!DB) {
      try {
        await bootstrapSample();
      } catch (e) {
        console.warn("[Landmaster] bootstrapSample threw — falling back to empty defaults:", e);
      }
    }
    if (!DB) {
      DB = JSON.parse(JSON.stringify(DEFAULTS));
      DB.meta.dataSource = "empty";
      DB.meta.loaded = new Date().toISOString();
    }
    // Shape guards — older cached blobs may be missing newer top-level
    // fields. Never let downstream code read nested props off a missing
    // root. cloudInit (js/30-supabase.js) waits on Array.isArray(DB.parts)
    // so the parts: [] default unblocks its hydration path too.
    if (!DB.meta || typeof DB.meta !== "object") DB.meta = { ...DEFAULTS.meta };
    if (!DB.settings || typeof DB.settings !== "object") DB.settings = { ...DEFAULTS.settings };
    if (!Array.isArray(DB.parts)) DB.parts = [];
    if (!Array.isArray(DB.pos)) DB.pos = [];
    if (!Array.isArray(DB.audit)) DB.audit = [];
    if (!Array.isArray(DB.usage)) DB.usage = [];
    // Tombstone store: Map<pn, {deletedAt, deletedBy, snapshot}>. NEVER
    // reassigned — mutate via .set()/.delete()/.clear() only (same rule
    // as window.followMarks). Persisted as {} through saveDB's JSON
    // round-trip; the Supabase `deleted_parts` table is source-of-
    // truth and cloudInit repopulates from it on every boot. This
    // shape-guard resets any object that came back as {} on load.
    if (!(DB.deletedParts instanceof Map)) DB.deletedParts = new Map();

    ensureIds();

    // Wire sidebar nav clicks
    $$(".nav-item").forEach(n => {
      n.onclick = () => navigate(n.dataset.route);
    });

    // Restore expand/collapse state for nestable sidebar groups
    initNavGroups();

    // Wire top-bar Draft Order button
    $("#btn-draft-order").onclick = openDraftOrderDrawer;

    // Boot Draft Order
    draftOrderLoad();
    updateDraftOrderPill();

    // Wire file input
    $("#file-input").onchange = (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) handleFileImport(f);
      e.target.value = ""; // allow re-import of same file later
    };

    // Wire welcome dialog
    const welcome = $("#welcome");
    $("#welcome-explore").onclick = () => welcome.classList.add("hidden");
    $("#welcome-import").onclick = () => { welcome.classList.add("hidden"); $("#file-input").click(); };
    // Show welcome on first run only. DB.meta is guaranteed by the shape
    // guards above, so this is safe.
    if (!DB.meta.welcomed) {
      welcome.classList.remove("hidden");
      DB.meta.welcomed = true;
      saveDB();
    }

    // Keyboard shortcuts
    setupKeyboardShortcuts();

    // Load Excel file handles (async, non-blocking)
    loadFileHandles().then(() => updateSyncIndicator()).catch(() => {});

    // Initial render — restore last route if still valid, else default to dashboard
    const savedRoute = localStorage.getItem("landmaster.lastRoute");
    const initialRoute = (typeof savedRoute === "string" && Object.prototype.hasOwnProperty.call(ROUTES, savedRoute))
      ? savedRoute
      : "dashboard";
    navigate(initialRoute);
    refresh();

    // Critical notifications
    setTimeout(showCriticalNotification, 700);
  } catch (err) {
    // Last-resort boot error surface. Anything thrown out of the try
    // above leaves the user with a visible message and console detail,
    // rather than a blank main panel.
    console.error("[Landmaster] Boot failed:", err);
    const main = document.getElementById("main");
    if (main) {
      const safeMsg = (typeof esc === "function")
        ? esc((err && err.message) || String(err) || "Unknown error")
        : ((err && err.message) || "Unknown error");
      main.innerHTML = `
        <div class="page">
          <div class="empty">
            <div class="empty-title">Something went wrong loading</div>
            <div class="empty-msg">Check the browser console for details, then hard-refresh (Ctrl+Shift+R). If this persists, report it.</div>
            <div class="muted tiny mono" style="margin-top:14px;max-width:640px;margin-left:auto;margin-right:auto;text-align:left;background:var(--bg-2);padding:12px;border-radius:6px;overflow:auto;border:1px solid var(--line)">${safeMsg}</div>
          </div>
        </div>`;
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
