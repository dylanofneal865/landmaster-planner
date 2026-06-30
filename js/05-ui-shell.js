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
  // navigate() always resets main.scrollTop=0 (correct for real route changes),
  // but refresh() is an in-place re-render — capture scroll around it so edits
  // like savePartFromDetail don't jump the underlying list to the top.
  const main = document.getElementById("main");
  const savedScrollTop = main ? main.scrollTop : 0;
  navigate(CURRENT_ROUTE || "dashboard");
  if (main && savedScrollTop > 0) requestAnimationFrame(() => { main.scrollTop = savedScrollTop; });
}

/* ============================================================
   SIDEBAR NAV GROUPS — expand/collapse persistence
   Single source of truth for nestable nav rows. Each key maps to the
   localStorage flag that persists its expanded state across reloads.
   ============================================================ */
const NAV_GROUP_KEYS = {
  bb: "landmaster.nav.bbExpanded",
};

function applyNavGroupState(key, expanded) {
  const row = document.querySelector(`.nav-row[data-nav-group="${key}"]`);
  const children = document.getElementById(`nav-children-${key}`);
  const caret = document.getElementById(`nav-caret-${key}`);
  if (row) row.classList.toggle("expanded", !!expanded);
  if (children) children.hidden = !expanded;
  if (caret) caret.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function toggleNavGroup(key) {
  const storageKey = NAV_GROUP_KEYS[key];
  if (!storageKey) return;
  const next = !(localStorage.getItem(storageKey) === "1");
  try { localStorage.setItem(storageKey, next ? "1" : "0"); } catch (e) {}
  applyNavGroupState(key, next);
}

function initNavGroups() {
  for (const [key, storageKey] of Object.entries(NAV_GROUP_KEYS)) {
    const expanded = localStorage.getItem(storageKey) === "1";
    applyNavGroupState(key, expanded);
  }
}

/* ============================================================
   TOP BAR / NAV BADGES
   ============================================================ */
function updateTopBar() {
  // Topbar must equal the dashboard "Will Stockout" / "Approaching Threshold"
  // KPIs and the sum of critical/warning rows across the three queues.
  // queueParts() is the single source of truth: queue-eligible itemType +
  // !isKit + !phasingOut + status in {critical, warning}.
  const eligible = queueParts();
  let crit = 0, warn = 0;
  for (const p of eligible) {
    if (p.status === "critical") crit++;
    else if (p.status === "warning") warn++;
  }
  $("#top-stat-date").textContent = TODAY.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toUpperCase();
  $("#top-stat-crit").innerHTML = `<span class="dot">●</span> ${crit} CRITICAL`;
  $("#top-stat-warn").innerHTML = `<span class="dot">●</span> ${warn} WARN`;
  if (crit === 0) $("#top-stat-crit").style.opacity = 0.4; else $("#top-stat-crit").style.opacity = 1;
  if (warn === 0) $("#top-stat-warn").style.opacity = 0.4; else $("#top-stat-warn").style.opacity = 1;
}

function updateNavBadges() {
  const stats = partsWithStatus();
  // Purchase Orders nav badge — uses isActivePO so it equals the Dashboard
  // "Open POs" KPI and the PO list "Active" filter tab count. Exclude
  // received/closed/cancelled (plus the Acumatica-side Completed/Rejected/
  // Canceled rollups) rather than whitelisting, so draft/submitted/
  // in_transit/partial/etc. all count without being enumerated.
  const openPOs = DB.pos.filter(isActivePO).length;
  const poBadge = $("#badge-pos");
  if (poBadge) poBadge.textContent = openPOs;

  // Follow-Ups badge — late open-PO lines (overdue > threshold). Uses the same
  // computeFollowUps predicate as the Follow-Ups page so the badge equals the
  // page header count.
  const fuBadge = $("#badge-followups");
  if (fuBadge) {
    const late = (typeof followUpCount === "function") ? followUpCount() : 0;
    fuBadge.textContent = late;
    fuBadge.className = "badge " + (late > 0 ? "warn" : "");
  }

  // Single-pass tally of needs/crit per itemType bucket, plus an aggregate
  // (excluding DNO) for the legacy generic order-queue badge.
  const tally = {
    base_bom: { needs: 0, crit: 0 },
    options:  { needs: 0, crit: 0 },
    service:  { needs: 0, crit: 0 },
    _agg:     { needs: 0, crit: 0 },
  };
  for (const p of stats) {
    if (p.isKit) continue;
    // Phasing-out parts are hidden from queues — keep badges consistent with
    // the queue lists so the count never overpromises rows that aren't there.
    // (The final part of the chain isn't phasingOut, so it still tallies.)
    if (p.phasingOut) continue;
    const isCrit = p.status === "critical";
    const isNeeds = isCrit || p.status === "warning";
    if (!isNeeds) continue;
    if (p.itemType !== "do_not_order") {
      tally._agg.needs++;
      if (isCrit) tally._agg.crit++;
    }
    const bucket = tally[p.itemType];
    if (bucket) {
      bucket.needs++;
      if (isCrit) bucket.crit++;
    }
  }
  const applyBadge = (sel, b) => {
    const el = $(sel);
    if (!el) return;
    el.textContent = b.needs;
    el.className = "badge " + (b.needs > 0 ? (b.crit > 0 ? "crit" : "warn") : "");
  };
  applyBadge("#badge-base-bom-queue", tally.base_bom);
  applyBadge("#badge-options-queue",  tally.options);
  applyBadge("#badge-service-queue",  tally.service);
  // Backup — legacy badge for the unlinked order-queue route, if anything ever re-adds it.
  applyBadge("#badge-orderqueue",     tally._agg);
}
