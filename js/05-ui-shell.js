/* =====================================================
   05-ui-shell.js
   Sections: TOASTS, DRAWER (slide-over), MODAL, ROUTER, TOP BAR / NAV BADGES
   ===================================================== */

/* ============================================================
   TOASTS
   ============================================================ */
function showToast(msg, kind = "", title = null, ms = 4500) {
  const stack = $("#toast-stack");
  const t = document.createElement("div");
  t.className = "toast " + kind;
  t.innerHTML = `${title ? `<div class="ti">${esc(title)}</div>` : ""}<div class="tm">${esc(msg)}</div>`;
  stack.appendChild(t);
  setTimeout(() => {
    t.style.transition = "opacity 0.25s ease, transform 0.25s ease";
    t.style.opacity = 0; t.style.transform = "translateX(20px)";
    setTimeout(() => t.remove(), 260);
  }, ms);
}

/* ============================================================
   DRAWER (slide-over)
   ============================================================ */
function openDrawer(html, opts = {}) {
  const bd = $("#drawer-bd");
  const dr = $("#drawer");
  dr.className = "drawer" + (opts.wide ? " wide" : "");
  dr.innerHTML = html;
  bd.classList.add("open");
  // close on backdrop click
  bd.onclick = (e) => { if (e.target === bd) closeDrawer(); };
  // bind any [data-close]
  $$("[data-close]", dr).forEach(el => el.onclick = closeDrawer);
}
function closeDrawer() { $("#drawer-bd").classList.remove("open"); }

/* ============================================================
   MODAL
   ============================================================ */
function openModal(html) {
  const bd = $("#modal-bd");
  const m = $("#modal");
  m.innerHTML = html;
  bd.classList.add("open");
  bd.onclick = (e) => { if (e.target === bd) closeModal(); };
  $$("[data-close]", m).forEach(el => el.onclick = closeModal);
}
function closeModal() { $("#modal-bd").classList.remove("open"); }

/* ============================================================
   ROUTER
   ============================================================ */
const ROUTES = {};
let CURRENT_ROUTE = null;

function registerRoute(name, renderer) { ROUTES[name] = renderer; }

function navigate(route, params = {}) {
  CURRENT_ROUTE = route;
  // Update active nav
  $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.route === route));
  const main = $("#main");
  main.scrollTop = 0;
  if (ROUTES[route]) {
    ROUTES[route](params);
    localStorage.setItem("landmaster.lastRoute", route);
  } else {
    main.innerHTML = `<div class="page"><div class="empty"><div class="empty-title">Not found</div></div></div>`;
  }
}

function refresh() {
  bumpStatusCache();
  updateTopBar();
  updateNavBadges();
  updateDraftOrderPill();
  navigate(CURRENT_ROUTE || "dashboard");
}

/* ============================================================
   TOP BAR / NAV BADGES
   ============================================================ */
function updateTopBar() {
  const stats = partsWithStatus();
  const crit = stats.filter(p => p.status === "critical" && !p.isKit).length;
  const warn = stats.filter(p => p.status === "warning" && !p.isKit).length;
  $("#top-stat-date").textContent = TODAY.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
  $("#top-stat-crit").innerHTML = `<span class="dot">●</span> ${crit} CRITICAL`;
  $("#top-stat-warn").innerHTML = `<span class="dot">●</span> ${warn} WARN`;
  if (crit === 0) $("#top-stat-crit").style.opacity = 0.4; else $("#top-stat-crit").style.opacity = 1;
  if (warn === 0) $("#top-stat-warn").style.opacity = 0.4; else $("#top-stat-warn").style.opacity = 1;
}

function updateNavBadges() {
  const stats = partsWithStatus();
  const openPOs = DB.pos.filter(p => p.status === "draft" || p.status === "submitted" || p.status === "in_transit").length;
  const poBadge = $("#badge-pos");
  if (poBadge) poBadge.textContent = openPOs;

  const setQueueBadge = (sel, cohort) => {
    const el = $(sel);
    if (!el) return;
    const needs = cohort.filter(p => (p.status === "critical" || p.status === "warning") && !p.isKit).length;
    const crit  = cohort.filter(p => p.status === "critical" && !p.isKit).length;
    el.textContent = needs;
    el.className = "badge " + (needs > 0 ? (crit > 0 ? "crit" : "warn") : "");
  };
  setQueueBadge("#badge-base-bom-queue", stats.filter(p => p.itemType === "base_bom"));
  setQueueBadge("#badge-options-queue",  stats.filter(p => p.itemType === "options"));
  setQueueBadge("#badge-service-queue",  stats.filter(p => p.itemType === "service"));
  // Backup — legacy badge for the unlinked order-queue route, if anything ever re-adds it.
  setQueueBadge("#badge-orderqueue", stats);
}
