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
  // Boot DB
  DB = await loadDB();
  if (!DB) {
    await bootstrapSample();
    DB = await loadDB();
  }
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
  // Show welcome on first run only
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
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
