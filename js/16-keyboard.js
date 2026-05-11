/* =====================================================
   16-keyboard.js
   Sections: KEYBOARD SHORTCUTS
   ===================================================== */

/* ============================================================
   KEYBOARD SHORTCUTS
   ============================================================ */
let _gModeTimer = null;
let _gMode = false;

function setupKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Cmd/Ctrl+K — command palette
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (CMD_PAL.open) closeCommandPalette(); else openCommandPalette();
      return;
    }
    // Esc — close drawer/modal/palette
    if (e.key === "Escape") {
      if (CMD_PAL.open) { closeCommandPalette(); return; }
      if ($("#modal-bd").classList.contains("open")) { closeModal(); return; }
      if ($("#drawer-bd").classList.contains("open")) { closeDrawer(); return; }
    }

    // Inside palette
    if (CMD_PAL.open) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        CMD_PAL.active = Math.min(CMD_PAL.items.length - 1, CMD_PAL.active + 1);
        renderCommandPalette();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        CMD_PAL.active = Math.max(0, CMD_PAL.active - 1);
        renderCommandPalette();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = CMD_PAL.items[CMD_PAL.active];
        if (item) item.run();
      }
      return;
    }

    // If user is typing in a field, only honor Cmd/Ctrl shortcuts
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input","textarea","select"].includes(tag) || e.target.isContentEditable) return;

    // Single-letter shortcuts
    const k = e.key.toLowerCase();
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (_gMode) {
      _gMode = false;
      clearTimeout(_gModeTimer);
      const route = { d: "dashboard", q: "order-queue", p: "pos", o: "onhand", c: "parts", s: "suppliers", a: "audit", t: "settings" }[k];
      if (route) { e.preventDefault(); navigate(route); }
      return;
    }
    if (k === "g") {
      _gMode = true;
      _gModeTimer = setTimeout(() => { _gMode = false; }, 1200);
      return;
    }
    if (k === "u") { e.preventDefault(); openOnHandQuickModal(); return; }
    if (k === "/") { e.preventDefault(); openCommandPalette(); return; }
    if (k === "?") { e.preventDefault(); navigate("settings"); return; }
  });

  // Live filtering for cmdpal input
  document.addEventListener("input", (e) => {
    if (e.target.id === "cmdpal-input") {
      CMD_PAL.query = e.target.value;
      CMD_PAL.active = 0;
      renderCommandPalette();
    }
  });

  // Click backdrop to close palette
  $("#cmdpal-bd").addEventListener("click", (e) => {
    if (e.target.id === "cmdpal-bd") closeCommandPalette();
  });
}
