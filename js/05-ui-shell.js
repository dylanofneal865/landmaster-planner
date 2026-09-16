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

/* ------------------------------------------------------------------
   RENDER RE-ENTRANCY GUARD -- v-boot-guard.

   Twice now a route renderer has called refresh() from INSIDE its own
   render (d949eed: a microtask loop; b7a21e2: _lcPaintTable calling
   refresh() when its tbody was absent). refresh() calls navigate(),
   navigate() calls the renderer, the renderer calls refresh() -- a
   synchronous cycle that never yields. Each level also runs
   bumpStatusCache() and the badge updates over every part, so the tab
   pegs the CPU and freezes long before a stack overflow could reach
   the console. What the user sees: shell and sidebar drawn, counters
   at 0, no page content, and an EMPTY console -- nothing ever threw.

   The fix at the call site is one line. The fix here is for the
   class: while a render is on the stack, refresh() no longer recurses.
   It coalesces into ONE deferred refresh on a macrotask, so the
   current render completes, the event loop runs, and the re-render
   happens once. A renderer can still be wrong, but it can no longer
   take the planner down with it -- and the deferral is logged, so the
   wrong call site is named rather than hidden.
   ------------------------------------------------------------------ */
let _renderDepth = 0;
let _refreshDeferred = false;
let _refreshDeferrals = 0;
let _refreshBurstStart = 0;
const REFRESH_DEFER_LIMIT = 25;

function navigate(route, params = {}) {
  CURRENT_ROUTE = route;
  // Update active nav
  $$(".nav-item").forEach(n => n.classList.toggle("active", n.dataset.route === route));
  const main = $("#main");
  main.scrollTop = 0;
  _renderDepth++;
  try {
    if (ROUTES[route]) {
      ROUTES[route](params);
      localStorage.setItem("landmaster.lastRoute", route);
    } else {
      main.innerHTML = `<div class="page"><div class="empty"><div class="empty-title">Not found</div></div></div>`;
    }
  } finally {
    _renderDepth--;
  }
}

function refresh() {
  // Called from inside a render? Do NOT recurse. Coalesce into one
  // deferred refresh so the current render finishes and the event loop
  // gets a turn. See the re-entrancy note above navigate().
  if (_renderDepth > 0) {
    // Circuit breaker. Deferring turns a synchronous freeze into an
    // async loop; a renderer that calls refresh() on EVERY render would
    // then re-render once per tick forever -- responsive, but burning
    // CPU. After a burst of deferrals the breaker stops re-scheduling:
    // the page stays as last rendered, and the console says which
    // route to fix. Resets on the next clean (non-deferred) refresh.
    const now = Date.now();
    if (now - _refreshBurstStart > 2000) { _refreshBurstStart = now; _refreshDeferrals = 0; }
    _refreshDeferrals++;
    if (_refreshDeferrals > REFRESH_DEFER_LIMIT) {
      if (_refreshDeferrals === REFRESH_DEFER_LIMIT + 1) {
        console.error(`[render] route "${CURRENT_ROUTE}" calls refresh() on every render — ${REFRESH_DEFER_LIMIT} deferrals in 2s, breaker tripped. Page left as last rendered. Fix the renderer.`);
      }
      return;
    }
    if (!_refreshDeferred) {
      _refreshDeferred = true;
      if (_refreshDeferrals === 1) {
        console.warn(`[render] refresh() called during render of "${CURRENT_ROUTE}" — deferred instead of recursing (fix the renderer; this would have frozen the tab)`);
      }
      setTimeout(() => { _refreshDeferred = false; refresh(); }, 0);
    }
    return;
  }
  // (No counter reset here on purpose: the deferred re-render IS a clean
  // refresh, and resetting on it would let an every-render caller dodge
  // the breaker forever. The 2s window above is the reset.)
  bumpStatusCache();
  // Queue-entry stamp detector — one pass per refresh cycle, right after
  // the status cache is invalidated so queueParts() reflects fresh
  // status. Fire-and-forget: steady-state costs zero writes (guarded by
  // _stampedPns Set); a new queue entry triggers one INSERT with
  // onConflict:ignoreDuplicates so concurrent sessions can't overwrite
  // an existing stamp. See js/30-supabase.js _detectQueueEntries.
  if (typeof _detectQueueEntries === "function") _detectQueueEntries();
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

  // Follow-Ups badge — overdue open-PO lines (daysPastDue > 1). Same
  // computeFollowUps predicate and same fixed floor as the Follow-Ups
  // page (both pass 1), so badge === page header count by construction.
  const fuBadge = $("#badge-followups");
  if (fuBadge) {
    const late = (typeof followUpCount === "function") ? followUpCount() : 0;
    fuBadge.textContent = late;
    fuBadge.className = "badge " + (late > 0 ? "warn" : "");
  }

  // Coverage Gaps badge — at-risk parts (normal gap OR overdue-PO risk).
  // Uses the same computeCoverageGaps predicate as the page so badge ==
  // page header count. "crit" styling (not "warn") because a coverage
  // gap is a genuine stockout risk, not just a chase.
  const cgBadge = $("#badge-coverage-gaps");
  if (cgBadge) {
    const risk = (typeof coverageGapCount === "function") ? coverageGapCount() : 0;
    cgBadge.textContent = risk;
    cgBadge.className = "badge " + (risk > 0 ? "crit" : "");
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
