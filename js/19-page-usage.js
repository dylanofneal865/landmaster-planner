/* =====================================================
   19-page-usage.js
   Sections: USAGE TRACKING — transactions decrement on-hand and feed daily-avg
   ===================================================== */

/* ============================================================
   USAGE TRACKING — transactions decrement on-hand and feed daily-avg
   ============================================================ */
let USAGE_STATE = { search: "", part: "", buildLine: "", days: 30 };

function renderUsageFor(itemType) {
  const titleMap = { "base_bom": "Base BOM Usage", "options": "Options Usage", "service": "Service Usage" };
  const pageTitle = (itemType && titleMap[itemType]) || "Usage Tracking";
  if (!Array.isArray(DB.usage)) DB.usage = [];

  // Filter
  const cutoff = addDays(TODAY, -USAGE_STATE.days);
  let txns = DB.usage.filter(u => new Date(u.ts) >= cutoff);
  if (itemType) {
    const allowedPNs = new Set(DB.parts.filter(p => p.itemType === itemType).map(p => p.pn));
    txns = txns.filter(u => allowedPNs.has(u.pn));
  }
  if (USAGE_STATE.search) {
    const q = USAGE_STATE.search.toLowerCase();
    txns = txns.filter(u => {
      const part = DB.parts.find(p => p.pn === u.pn);
      return u.pn.toLowerCase().includes(q) || (part?.desc||"").toLowerCase().includes(q);
    });
  }
  if (USAGE_STATE.part) txns = txns.filter(u => u.pn === USAGE_STATE.part);
  if (USAGE_STATE.buildLine) txns = txns.filter(u => u.buildLine === USAGE_STATE.buildLine);
  txns.sort((a,b) => new Date(b.ts) - new Date(a.ts));

  // Aggregate stats
  const totalQty = txns.reduce((s,u) => s + (u.qty||0), 0);
  const uniqueParts = new Set(txns.map(u => u.pn)).size;
  const totalValue = txns.reduce((s,u) => {
    const part = DB.parts.find(p => p.pn === u.pn);
    return s + (u.qty||0) * (part?.cost||0);
  }, 0);
  const workdaysInWindow = USAGE_STATE.days * (DB.settings.workdaysPerWeek/7);
  const avgPerDay = totalQty / Math.max(1, workdaysInWindow);

  // Top 5 parts
  const byPart = {};
  for (const u of txns) byPart[u.pn] = (byPart[u.pn] || 0) + (u.qty || 0);
  const topParts = Object.entries(byPart).sort((a,b) => b[1] - a[1]).slice(0, 5);

  // Build lines
  const buildLines = [...new Set(DB.usage.map(u => u.buildLine).filter(Boolean))].sort();

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">${esc(pageTitle)}</div>
          <div class="page-sub mono">${txns.length} TRANSACTIONS · LAST ${USAGE_STATE.days} DAYS · DECREMENTS ON-HAND, FEEDS DAILY-USE RATE</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="openBulkUsageModal()">⇪ Bulk paste</button>
          <button class="btn" onclick="recomputeDailyFromUsage()">⟲ Recalc daily-use rates</button>
          <button class="btn primary" onclick="openLogUsageModal()">+ Log usage</button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi"><div class="kpi-label">Total Used</div><div class="kpi-value">${fmtNum(totalQty)}</div><div class="kpi-foot">${USAGE_STATE.days}-day window</div></div>
        <div class="kpi"><div class="kpi-label">Unique Parts</div><div class="kpi-value">${uniqueParts}</div><div class="kpi-foot">distinct PNs</div></div>
        <div class="kpi"><div class="kpi-label">Avg Daily</div><div class="kpi-value">${fmtNum(avgPerDay, 1)}</div><div class="kpi-foot">units / workday</div></div>
        <div class="kpi"><div class="kpi-label">$ Consumed</div><div class="kpi-value">${fmtMoney(totalValue)}</div><div class="kpi-foot">at unit cost</div></div>
      </div>

      <div class="two-col">
        <div>
          <div class="panel">
            <div class="filterbar">
              <div class="search-input">
                <input class="input" placeholder="Search part # or description…" value="${esc(USAGE_STATE.search)}" onchange="USAGE_STATE.search = this.value; refresh()" onkeydown="if(event.key === 'Enter'){ USAGE_STATE.search = this.value; refresh(); }">
              </div>
              <select class="select" onchange="USAGE_STATE.days = parseInt(this.value); refresh()">
                <option value="7"   ${USAGE_STATE.days===7?'selected':''}>Last 7 days</option>
                <option value="30"  ${USAGE_STATE.days===30?'selected':''}>Last 30 days</option>
                <option value="90"  ${USAGE_STATE.days===90?'selected':''}>Last 90 days</option>
                <option value="365" ${USAGE_STATE.days===365?'selected':''}>Last 365 days</option>
              </select>
              ${buildLines.length > 0 ? `
                <select class="select" onchange="USAGE_STATE.buildLine = this.value; refresh()">
                  <option value="">All build lines</option>
                  ${buildLines.map(b => `<option value="${esc(b)}" ${USAGE_STATE.buildLine===b?'selected':''}>${esc(b)}</option>`).join("")}
                </select>
              ` : ""}
              <div class="grow"></div>
            </div>
            <div class="panel-body flush">
              ${txns.length === 0 ? `
                <div class="empty">
                  <div class="empty-title">No usage logged</div>
                  <div class="empty-msg">Click <strong>+ Log usage</strong> to record consumption. This decrements on-hand and improves daily-use rates.</div>
                </div>
              ` : `
                <div class="tbl-wrap">
                  <table class="tbl">
                    <thead><tr>
                      <th>Date</th>
                      <th>Part</th>
                      <th>Description</th>
                      <th class="right">Qty</th>
                      <th>Build</th>
                      <th>Reason</th>
                      <th>User</th>
                      <th></th>
                    </tr></thead>
                    <tbody>
                      ${txns.slice(0, 500).map(u => {
                        const part = DB.parts.find(p => p.pn === u.pn);
                        return `
                          <tr>
                            <td class="num dim">${fmtTime(u.ts)}</td>
                            <td class="pn clickable" onclick="openPartDetail('${esc(u.pn)}')">${esc(u.pn)}</td>
                            <td>${esc(part?.desc||"—")}</td>
                            <td class="right num bold">${fmtNum(u.qty)}</td>
                            <td class="dim">${esc(u.buildLine||"—")}</td>
                            <td class="dim">${esc(u.reason||"—")}</td>
                            <td class="dim">${esc(u.user||"—")}</td>
                            <td><button class="btn sm ghost" onclick="confirmDeleteUsage('${esc(u.id)}')" title="Delete">×</button></td>
                          </tr>
                        `;
                      }).join("")}
                    </tbody>
                  </table>
                  ${txns.length > 500 ? `<div class="muted center tiny" style="padding:14px">Showing first 500 of ${txns.length}.</div>` : ""}
                </div>
              `}
            </div>
          </div>
        </div>

        <div>
          <div class="panel">
            <div class="panel-head">
              <div class="panel-title">Top consumed parts</div>
              <div class="panel-sub">${USAGE_STATE.days}-day window</div>
            </div>
            <div class="panel-body flush">
              ${topParts.length === 0 ? `<div class="empty"><div class="empty-msg">No data.</div></div>` : `
                <div class="tbl-wrap">
                  <table class="tbl">
                    <tbody>
                      ${topParts.map(([pn, q]) => {
                        const part = DB.parts.find(p => p.pn === pn);
                        return `
                          <tr class="clickable" onclick="openPartDetail('${esc(pn)}')">
                            <td class="pn">${esc(pn)}</td>
                            <td>${esc(part?.desc||"—")}</td>
                            <td class="right num bold">${fmtNum(q)}</td>
                          </tr>
                        `;
                      }).join("")}
                    </tbody>
                  </table>
                </div>
              `}
            </div>
          </div>

          <div class="panel">
            <div class="panel-head"><div class="panel-title">How usage works</div></div>
            <div class="panel-body" style="font-size:12px;color:var(--t2);line-height:1.6">
              <p>Each usage row records consumption: <strong>date, part, qty, build line</strong>.</p>
              <p>When you log usage, on-hand drops automatically (unless you uncheck the box).</p>
              <p>Click <span class="cmd-kbd">⟲ Recalc daily-use rates</span> to overwrite the static daily-use field on every part with its actual recent average. This makes stockout projections reflect reality.</p>
              <p>If your Usage workbook is connected, every transaction is mirrored to Excel automatically.</p>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}
/* ============================================================
   USAGE PASSWORD GATE — casual gate on the three Usage routes.
   Per-tab unlock via sessionStorage; closing the tab re-locks.
   ============================================================ */
const _USAGE_PASSWORD = "4616";

function _isUsageUnlocked() {
  try { return sessionStorage.getItem("usage_unlocked") === "1"; }
  catch (e) { return false; }
}

// Returns true if the route handler should continue rendering. If false, a
// "Locked" placeholder is shown in #main and the password modal is opened;
// on correct password the routeName is re-navigated so the original handler
// runs cleanly with the gate now open.
function _usageGate(routeName) {
  if (_isUsageUnlocked()) return true;
  $("#main").innerHTML = `
    <div class="page">
      <div class="empty">
        <div class="empty-title">Locked</div>
        <div class="empty-msg">Enter the password to view this page.</div>
      </div>
    </div>`;
  _openUsagePasswordModal(routeName);
  return false;
}

function _openUsagePasswordModal(routeName) {
  window._pendingUsageRoute = routeName;
  openModal(`
    <div class="modal-head">
      <div class="head-sm">Enter password</div>
    </div>
    <div class="modal-body">
      <p class="muted tiny" style="margin-bottom:10px">These pages are restricted. Please enter the password to continue.</p>
      <input class="input lg" type="password" id="usage-pw-input"
        onkeydown="if(event.key==='Enter'){event.preventDefault();_submitUsagePassword();}">
      <div id="usage-pw-error" class="text-crit tiny" style="margin-top:8px;display:none">Incorrect.</div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="_cancelUsagePassword()">Cancel</button>
      <button class="btn primary" onclick="_submitUsagePassword()">Unlock</button>
    </div>
  `);
  // Override backdrop click — dismissing must navigate away, otherwise the
  // user sits on the "Locked" placeholder with no obvious next step.
  const bd = document.getElementById("modal-bd");
  if (bd) bd.onclick = (e) => { if (e.target === bd) _cancelUsagePassword(); };
  setTimeout(() => { const i = document.getElementById("usage-pw-input"); if (i) i.focus(); }, 30);
}

function _submitUsagePassword() {
  const inp = document.getElementById("usage-pw-input");
  if (!inp) return;
  if (inp.value === _USAGE_PASSWORD) {
    try { sessionStorage.setItem("usage_unlocked", "1"); } catch (e) {}
    const route = window._pendingUsageRoute;
    window._pendingUsageRoute = null;
    closeModal();
    if (route) navigate(route);
  } else {
    const err = document.getElementById("usage-pw-error");
    if (err) err.style.display = "";
    inp.value = "";
    inp.focus();
  }
}

function _cancelUsagePassword() {
  window._pendingUsageRoute = null;
  closeModal();
  navigate("dashboard");
}

registerRoute("usage",          () => renderUsageFor(null));
registerRoute("base-bom-usage", () => { if (!_usageGate("base-bom-usage")) return; renderBaseBomUsage(); });
registerRoute("options-usage",  () => { if (!_usageGate("options-usage")) return; renderUsageFor("options"); });

// Multi Level BOM — read-only explorer over DB.bomLinks. Left rail lists
// FINISHED_GOODS (search-filterable); right pane shows the picked FG's
// rolled-up leaf-parts list via explodeBOM(). Page-locked behind the same
// _usageGate as the three sibling usage pages — once any of them is
// unlocked for the session, all four are accessible (shared
// sessionStorage "usage_unlocked" flag).
registerRoute("multi-level-bom", () => {
  if (!_usageGate("multi-level-bom")) return;
  renderMultiLevelBom();
});

let MLB_STATE = {
  search: "",
  selectedFg: null,
};

function mlbSelectFg(pn) {
  MLB_STATE.selectedFg = pn;
  refresh();
}

// Typing in the FG search box used to call refresh() on every keystroke,
// which rebuilds the whole #main innerHTML — including the <input> the user
// is typing into — so focus (and caret position) was lost after every char.
// Two changes to fix continuous typing:
//   1) Never re-render the input on filter. Update state immediately, then
//      swap ONLY the list container + count element by id (see
//      _mlbRerenderList). The <input> node is never touched, so focus and
//      selection persist natively.
//   2) Debounce the (potentially large) list re-render at 150ms of quiet
//      so we don't rebuild the full FG list on every keydown.
let _mlbSearchTimer = null;
function mlbSetSearch(q) {
  MLB_STATE.search = q || "";
  if (_mlbSearchTimer) clearTimeout(_mlbSearchTimer);
  _mlbSearchTimer = setTimeout(() => {
    _mlbSearchTimer = null;
    _mlbRerenderList();
  }, 150);
}

/* ============================================================
   MISSING-COMPONENTS BADGE — for each finished good, count how many
   distinct exploded leaf PNs aren't in DB.parts. Zero → no badge.
   Flags FGs whose builds reference parts the planner isn't tracking
   so engineering can decide whether they belong in the catalog.

   Reuses explodeBOM (js/03-calc.js:157) — no second explosion path.
   PN comparison follows the app convention: strict `===` on p.pn,
   matching openPOQty / partByPn / every other DB.parts.find site.

   Cache: 91 FGs × recursive explosion over 13k+ links is heavy for
   every render, so results live in a Map(fgPn → count) and only
   rebuild when either the BOM data reference or the parts version
   changes. bumpStatusCache() (js/03-calc.js:889) bumps
   _statusCacheVer on every DB.parts mutation, and the BOM index
   auto-invalidates when DB.bomLinks is replaced by cloud sync.
   ============================================================ */
let _mlbMissingCache = null;
let _mlbMissingCacheKey = null;
function _mlbMissingKeyNow() {
  return {
    bomSrc: (typeof DB !== "undefined" && Array.isArray(DB.bomLinks)) ? DB.bomLinks : null,
    partsVer: (typeof _statusCacheVer !== "undefined") ? _statusCacheVer : 0,
  };
}
function _mlbBuildMissingCache() {
  const partsSet = new Set(
    ((typeof DB !== "undefined" && Array.isArray(DB.parts)) ? DB.parts : [])
      .map(p => p && p.pn)
      .filter(Boolean)
  );
  const fgs = (typeof FINISHED_GOODS === "object" && Array.isArray(FINISHED_GOODS)) ? FINISHED_GOODS : [];
  const cache = new Map();
  for (const fg of fgs) {
    const pn = (fg && typeof fg === "object") ? fg.pn : (typeof fg === "string" ? fg : null);
    if (!pn) continue;
    const seenLeafPns = new Set();
    let missing = 0;
    try {
      const result = (typeof explodeBOM === "function") ? explodeBOM(pn) : null;
      const leaves = (result && Array.isArray(result.leaves)) ? result.leaves : [];
      for (const l of leaves) {
        if (!l || !l.pn) continue;
        if (seenLeafPns.has(l.pn)) continue;
        seenLeafPns.add(l.pn);
        if (!partsSet.has(l.pn)) missing++;
      }
    } catch (e) {
      console.warn(`[mlb-missing] explodeBOM failed for ${pn}`, e);
    }
    cache.set(pn, missing);
  }
  _mlbMissingCache = cache;
  _mlbMissingCacheKey = _mlbMissingKeyNow();
  // One summary log per cache rebuild — user can sanity-check totals
  // against reality without opening 91 rows individually.
  const withMissing = [...cache.entries()].filter(([, n]) => n > 0);
  if (withMissing.length) {
    const top3 = withMissing.sort((a, b) => b[1] - a[1]).slice(0, 3);
    console.info(
      `[mlb-missing] ${withMissing.length} finished good(s) with ≥1 missing component; ` +
      `top 3: ${top3.map(([pn, n]) => `${pn}=${n}`).join(", ")}`
    );
  } else {
    console.info(`[mlb-missing] All ${cache.size} finished good(s) have every component in DB.parts`);
  }
}
function missingComponentCount(fgPn) {
  if (!fgPn) return 0;
  const key = _mlbMissingKeyNow();
  if (!_mlbMissingCache
      || !_mlbMissingCacheKey
      || _mlbMissingCacheKey.bomSrc !== key.bomSrc
      || _mlbMissingCacheKey.partsVer !== key.partsVer) {
    _mlbBuildMissingCache();
  }
  return _mlbMissingCache.get(fgPn) || 0;
}

function renderMultiLevelBom() {
  const partByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  // FINISHED_GOODS is now an array of { pn, desc } objects. Catalog desc
  // wins when the part is in DB.parts; Engineering's authoritative desc
  // (from the constant) is the fallback when the catalog is missing —
  // strict improvement over the old empty-string fallback.
  const fgRows = (typeof FINISHED_GOODS === "object" && Array.isArray(FINISHED_GOODS) ? FINISHED_GOODS : []).map(fg => {
    const pn = fg.pn;
    const cat = partByPn.get(pn);
    const desc = (cat && cat.desc) || fg.desc || "";
    return { pn, desc, inCatalog: !!cat };
  });

  const q = MLB_STATE.search.trim().toLowerCase();
  const filteredFgs = q
    ? fgRows.filter(r => r.pn.toLowerCase().includes(q) || (r.desc || "").toLowerCase().includes(q))
    : fgRows;

  const bomLinksLoaded = Array.isArray(DB.bomLinks);
  const linkCount = bomLinksLoaded ? DB.bomLinks.length : 0;
  const parentCount = bomLinksLoaded
    ? (typeof getBomChildrenIndex === "function" ? getBomChildrenIndex().size : 0)
    : 0;

  // If we have zero links loaded, the entire engine is dead — surface that
  // up front rather than letting users click finished goods to empty tables.
  if (bomLinksLoaded && linkCount === 0) {
    $("#main").innerHTML = `
      <div class="page">
        ${_mlbPageHead(fgRows.length, linkCount, parentCount)}
        <div class="panel">
          <div class="panel-body">
            <div class="empty">
              <div class="empty-title">No BOM links loaded</div>
              <div class="empty-msg">
                The <code>bom_links</code> table is empty or the cloud fetch returned no rows.
                Wait for the next daily Acumatica BOM sync (06:00 UTC) or run the
                <code>acumatica-bom-sync</code> function manually from the Netlify dashboard.
              </div>
            </div>
          </div>
        </div>
      </div>`;
    return;
  }

  // Loading state — DB.bomLinks is undefined until cloudInit finishes its
  // paged fetch. Cloud sync calls refresh() after the load completes.
  if (!bomLinksLoaded) {
    $("#main").innerHTML = `
      <div class="page">
        ${_mlbPageHead(fgRows.length, 0, 0)}
        <div class="panel">
          <div class="panel-body">
            <div class="empty">
              <div class="empty-title">Loading BOM data…</div>
              <div class="empty-msg">Fetching <code>bom_links</code> from Supabase. This page will populate automatically.</div>
            </div>
          </div>
        </div>
      </div>`;
    return;
  }

  // FINISHED_GOODS is [{pn, desc}, ...] — check pn membership via .some.
  const sel = MLB_STATE.selectedFg && FINISHED_GOODS.some(fg => fg.pn === MLB_STATE.selectedFg) ? MLB_STATE.selectedFg : null;
  const expl = sel ? explodeBOM(sel) : null;

  $("#main").innerHTML = `
    <div class="page">
      ${_mlbPageHead(fgRows.length, linkCount, parentCount)}

      <div style="display:grid;grid-template-columns:340px 1fr;gap:16px;align-items:flex-start">
        <!-- ===== FG selector ===== -->
        <div class="panel">
          <div class="panel-head">
            <div class="panel-title">Finished goods</div>
            <div class="panel-sub" id="mlb-fg-count">${filteredFgs.length} of ${fgRows.length}</div>
          </div>
          <div class="filterbar" style="padding:8px 12px">
            <div class="search-input flex-1">
              <input class="input" id="mlb-fg-search" placeholder="Search PN or description…" value="${esc(MLB_STATE.search)}"
                oninput="mlbSetSearch(this.value)">
            </div>
          </div>
          <div class="panel-body flush" id="mlb-fg-list" style="max-height:70vh;overflow-y:auto">
            ${_mlbListHtml(filteredFgs, sel)}
          </div>
        </div>

        <!-- ===== Exploded leaves ===== -->
        <div class="panel">
          ${sel ? _mlbExplodedPanel(sel, expl, partByPn) : `
            <div class="panel-head">
              <div class="panel-title">Exploded BOM</div>
              <div class="panel-sub">pick a finished good</div>
            </div>
            <div class="panel-body">
              <div class="empty">
                <div class="empty-title">Select a finished good</div>
                <div class="empty-msg">Pick an SKU from the list to see its exploded buyable-parts list.</div>
              </div>
            </div>
          `}
        </div>
      </div>
    </div>`;
}

// List-markup helper shared by the initial render and the partial re-render
// on filter. Only the list-body branch below moves — everything outside the
// #mlb-fg-list container (page head, panel head, search input, exploded
// panel) stays untouched by _mlbRerenderList so the user's typing focus
// and caret position survive.
function _mlbListHtml(filteredFgs, sel) {
  if (filteredFgs.length === 0) {
    return `
      <div class="empty">
        <div class="empty-msg">No finished goods match the search.</div>
      </div>
    `;
  }
  return `
    <div class="tbl-wrap">
      <table class="tbl">
        <tbody>
          ${filteredFgs.map(fg => {
            const isSel = fg.pn === sel;
            // Sidebar always shows the resolved description. fg.desc was
            // built at map-time as `catalog.desc || FINISHED_GOODS desc ||
            // ""`, so every FG with an Engineering description renders it
            // here. The old "not in catalog" label was misleading for FG
            // sidebar rows — FGs are demand drivers, not purchased parts,
            // and aren't expected to have a DB.parts record.
            //
            // Missing-components badge: red pill count of exploded leaves
            // that aren't in DB.parts. `.badge crit` styling is nav-scoped
            // so we reuse the global `.pill.crit` (same red the Coverage
            // Gaps rows use for "PO Nd overdue") with inline sizing to
            // match a count badge. Zero → no badge, per spec.
            const missing = (typeof missingComponentCount === "function") ? missingComponentCount(fg.pn) : 0;
            const missingBadge = missing > 0
              ? ` <span class="pill crit mono" style="font-size:10px; padding:1px 5px; margin-left:4px; border-width:0" title="${missing} component${missing === 1 ? '' : 's'} not in parts catalog">${missing}</span>`
              : "";
            return `
              <tr class="clickable" onclick="mlbSelectFg('${esc(fg.pn)}')"
                  style="${isSel ? 'background:var(--bg-3);' : ''}">
                <td>
                  <div class="pn">${esc(fg.pn)}${missingBadge}</div>
                  <div class="muted tiny">${esc(fg.desc || '—')}</div>
                </td>
              </tr>
            `;
          }).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// Partial re-render used by the debounced search handler. Recomputes the
// filtered FG list from current state and swaps only the list container's
// innerHTML + the count element's textContent. Does NOT touch the <input>,
// so focus and caret position are preserved across the update.
function _mlbRerenderList() {
  const listEl = document.getElementById("mlb-fg-list");
  if (!listEl) return;  // user navigated away before the debounce fired

  const partByPn = new Map((DB.parts || []).map(p => [p.pn, p]));
  const fgRows = (typeof FINISHED_GOODS === "object" && Array.isArray(FINISHED_GOODS) ? FINISHED_GOODS : []).map(fg => {
    const pn = fg.pn;
    const cat = partByPn.get(pn);
    const desc = (cat && cat.desc) || fg.desc || "";
    return { pn, desc, inCatalog: !!cat };
  });
  const q = MLB_STATE.search.trim().toLowerCase();
  const filteredFgs = q
    ? fgRows.filter(r => r.pn.toLowerCase().includes(q) || (r.desc || "").toLowerCase().includes(q))
    : fgRows;
  const sel = MLB_STATE.selectedFg && FINISHED_GOODS.some(fg => fg.pn === MLB_STATE.selectedFg) ? MLB_STATE.selectedFg : null;

  listEl.innerHTML = _mlbListHtml(filteredFgs, sel);
  const countEl = document.getElementById("mlb-fg-count");
  if (countEl) countEl.textContent = `${filteredFgs.length} of ${fgRows.length}`;
}

function _mlbPageHead(fgCount, linkCount, parentCount) {
  const subParts = [`${fgCount} FINISHED GOODS`];
  if (linkCount > 0) subParts.push(`${fmtNum(linkCount)} BOM LINKS`);
  if (parentCount > 0) subParts.push(`${fmtNum(parentCount)} PARENT ASSEMBLIES`);
  return `
    <div class="page-head">
      <div>
        <div class="page-title">Multi Level BOM</div>
        <div class="page-sub mono">${subParts.join(" · ")} · EACH UTV'S EXPLODED COMPONENT LIST WILL DRIVE BASE-BOM DEMAND</div>
      </div>
    </div>
  `;
}

function _mlbExplodedPanel(fgPn, expl, partByPn) {
  const { leaves, distinctLeafCount, totalPieces, warnings } = expl;
  const fgPart = partByPn.get(fgPn);
  const fgDesc = fgPart?.desc || "";

  if (!leaves.length) {
    return `
      <div class="panel-head">
        <div>
          <div class="panel-title">${esc(fgPn)}${fgDesc ? ` — ${esc(fgDesc)}` : ''}</div>
          <div class="panel-sub">no rolled-up leaves</div>
        </div>
      </div>
      <div class="panel-body">
        <div class="empty">
          <div class="empty-title">No BOM data for ${esc(fgPn)}</div>
          <div class="empty-msg">
            ${warnings.length ? esc(warnings[0]) : `This finished good isn't a parent in any bom_links row. Either the BOM hasn't been published in Acumatica, or the GI didn't include it.`}
          </div>
        </div>
      </div>
    `;
  }

  const totalPiecesNum = Number.isInteger(totalPieces) ? totalPieces : Math.round(totalPieces * 1000) / 1000;
  const headerLine = `${esc(fgPn)}${fgDesc ? ` — ${esc(fgDesc)}` : ''} · ${distinctLeafCount} distinct parts, ${fmtNum(totalPiecesNum)} total pieces per unit`;

  return `
    <div class="panel-head">
      <div>
        <div class="panel-title">${headerLine}</div>
        <div class="panel-sub">multiplied through every sub-assembly</div>
      </div>
    </div>
    ${warnings.length ? `
      <div class="filterbar" style="padding:8px 12px;background:var(--warn-soft);color:var(--warn)">
        ⚠ ${esc(warnings.join(" · "))}
      </div>
    ` : ""}
    <div class="panel-body flush">
      <div class="tbl-wrap">
        <table class="tbl">
          <thead><tr>
            <th>Part</th>
            <th>Description</th>
            <th>Supplier</th>
            <th class="right">Qty per Unit</th>
            <th>UOM</th>
          </tr></thead>
          <tbody>
            ${leaves.map(l => {
              const cat = partByPn.get(l.pn);
              const desc = cat?.desc || "";
              const supplier = cat?.supplier || "";
              const noCat = !cat;
              const qtyDisplay = Number.isInteger(l.qtyPerUnit) ? fmtNum(l.qtyPerUnit) : fmtNum(l.qtyPerUnit, 3);
              return `
                <tr ${cat ? `class="clickable" onclick="openPartDetail('${esc(l.pn)}')"` : ''}>
                  <td class="pn">${esc(l.pn)}${noCat ? ' <span class="pill warn" style="margin-left:6px">NOT IN CATALOG</span>' : ''}</td>
                  <td>${esc(desc)}</td>
                  <td class="dim">${esc(supplier)}</td>
                  <td class="right num bold">${qtyDisplay}</td>
                  <td class="dim">${esc(l.uom || "")}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ============================================================
   BASE BOM USAGE — rate-management surface (not a transaction tracker)
   Edits part.daily on base_bom parts only; feeds the Base BOM Queue.
   ============================================================ */
let BBU_STATE = {
  search: "",
  supplier: "",
  sortBy: "missing",       // missing | mostUsed | leastUsed | alpha
  displayMode: "daily",    // daily | monthly
};

function bbuBaseBomParts() {
  return partsWithStatus().filter(p => p.itemType === "base_bom" && !p.isKit);
}

function renderBaseBomUsage() {
  const parts = bbuBaseBomParts();

  // Filter
  let rows = parts.slice();
  if (BBU_STATE.search) {
    const q = BBU_STATE.search.toLowerCase();
    rows = rows.filter(p => p.pn.toLowerCase().includes(q) || (p.desc || "").toLowerCase().includes(q));
  }
  if (BBU_STATE.supplier) rows = rows.filter(p => p.supplier === BBU_STATE.supplier);

  // Effective-daily resolver. Sort, KPIs, displayed cell value, and the
  // MISSING RATE flag all read from this so they can never disagree —
  // chain successors with stored 0 but an inherited anchor rate (e.g.
  // CP00558 → 3.81) get the inherited rate everywhere on the page, not
  // a blank cell paired with a MISSING flag. Falls back to part.daily
  // when chainDisplayDaily isn't defined (defensive — same module, but
  // belt-and-braces in case of load-order quirks).
  const _bbuEffDaily = (p) => {
    if (typeof chainDisplayDaily === "function") {
      return Number(chainDisplayDaily(p)) || 0;
    }
    return Number(p?.daily) || 0;
  };

  // Sort
  rows.sort((a, b) => {
    const aDaily = _bbuEffDaily(a);
    const bDaily = _bbuEffDaily(b);
    switch (BBU_STATE.sortBy) {
      case "missing": {
        const aHas = aDaily > 0 ? 1 : 0;
        const bHas = bDaily > 0 ? 1 : 0;
        if (aHas !== bHas) return aHas - bHas;   // missing (0) sorts first
        return String(a.pn).localeCompare(String(b.pn));
      }
      case "mostUsed":  return bDaily - aDaily;
      case "leastUsed": return aDaily - bDaily;
      case "alpha":
      default:          return String(a.pn).localeCompare(String(b.pn));
    }
  });

  // Stats over the unfiltered base_bom set — same effective-rate basis as
  // the row-level MISSING flag so With/Without/Avg KPIs match the visible
  // pill counts.
  const total = parts.length;
  const rated = parts.filter(p => _bbuEffDaily(p) > 0);
  const withRate = rated.length;
  const withoutRate = total - withRate;
  const avgDaily = withRate > 0 ? rated.reduce((s, p) => s + _bbuEffDaily(p), 0) / withRate : 0;

  const suppliers = [...new Set(parts.map(p => p.supplier).filter(Boolean))].sort();
  const isMonthly = BBU_STATE.displayMode === "monthly";

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Base BOM Usage</div>
          <div class="page-sub mono">DAILY-USE RATES FOR BASE BOM PARTS · FEEDS THE BASE BOM QUEUE AND STOCKOUT PROJECTIONS</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="bbuOpenImportModal()">📥 Import rates</button>
          <button class="btn" onclick="bbuOpenPasteModal()">📋 Paste rates</button>
          <button class="btn" onclick="bbuExportRates()">📤 Export current rates</button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi">
          <div class="kpi-label">Total Base BOM Parts</div>
          <div class="kpi-value">${total}</div>
          <div class="kpi-foot">in catalog</div>
        </div>
        <div class="kpi ${withRate > 0 ? 'ok' : ''}">
          <div class="kpi-label">With Rate</div>
          <div class="kpi-value">${withRate}</div>
          <div class="kpi-foot">daily &gt; 0</div>
        </div>
        <div class="kpi ${withoutRate > 0 ? 'warn' : ''}">
          <div class="kpi-label">Without Rate</div>
          <div class="kpi-value">${withoutRate}</div>
          <div class="kpi-foot">need seeding</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">Avg Daily</div>
          <div class="kpi-value">${fmtNum(avgDaily, 2)}</div>
          <div class="kpi-foot">across rated parts</div>
        </div>
      </div>

      <div class="panel">
            <div class="filterbar">
              <div class="search-input">
                <input class="input" placeholder="Search part # or description…" value="${esc(BBU_STATE.search)}"
                  onchange="BBU_STATE.search = this.value; refresh()"
                  onkeydown="if(event.key === 'Enter'){ BBU_STATE.search = this.value; refresh(); }">
              </div>
              <select class="select" onchange="BBU_STATE.supplier = this.value; refresh()">
                <option value="">All suppliers</option>
                ${suppliers.map(s => `<option value="${esc(s)}" ${BBU_STATE.supplier === s ? 'selected' : ''}>${esc(s)}</option>`).join("")}
              </select>
              <select class="select" onchange="BBU_STATE.sortBy = this.value; refresh()">
                <option value="missing"   ${BBU_STATE.sortBy === 'missing'   ? 'selected' : ''}>No-rate first</option>
                <option value="mostUsed"  ${BBU_STATE.sortBy === 'mostUsed'  ? 'selected' : ''}>Most-used</option>
                <option value="leastUsed" ${BBU_STATE.sortBy === 'leastUsed' ? 'selected' : ''}>Least-used</option>
                <option value="alpha"     ${BBU_STATE.sortBy === 'alpha'     ? 'selected' : ''}>Alphabetical</option>
              </select>
              <div class="grow"></div>
              <span class="muted tiny">Show as:</span>
              <select class="select" onchange="BBU_STATE.displayMode = this.value; refresh()">
                <option value="daily"   ${!isMonthly ? 'selected' : ''}>Daily</option>
                <option value="monthly" ${isMonthly  ? 'selected' : ''}>Monthly (×30)</option>
              </select>
            </div>
            <div class="panel-body flush">
              ${rows.length === 0 ? `
                <div class="empty">
                  <div class="empty-title">${total === 0 ? 'No base BOM parts in catalog' : 'No matches'}</div>
                  <div class="empty-msg">${total === 0
                    ? 'Set <strong>Item Type = Base BOM</strong> on a part via the part detail drawer to populate this page.'
                    : 'Adjust search, supplier filter, or sort to see rows.'}</div>
                </div>
              ` : `
                <div class="tbl-wrap">
                  <table class="tbl">
                    <thead><tr>
                      <th>Part</th>
                      <th>Description</th>
                      <th>Supplier</th>
                      <th class="right">On Hand</th>
                      <th class="right">${isMonthly ? 'Monthly Rate' : 'Daily Rate'}</th>
                      <th></th>
                    </tr></thead>
                    <tbody>
                      ${rows.slice(0, 500).map(p => {
                        // Resolve effective rate via chainDisplayDailySource so
                        // chain successors (e.g. CP00558) show their inherited
                        // anchor rate AND don't flag as MISSING. Display value,
                        // MISSING pill, sort, and KPIs all agree because they
                        // pull from the same effective source.
                        const dailySrc = (typeof chainDisplayDailySource === "function")
                          ? chainDisplayDailySource(p)
                          : { daily: Number(p.daily) || 0, anchorPn: null, transitioning: false, isAnchor: false };
                        const dailyInherited = dailySrc.transitioning && !dailySrc.isAnchor;
                        const d = Number(dailySrc.daily) || 0;
                        const missing = d <= 0;
                        const shown = isMonthly ? d * 30 : d;
                        return `
                          <tr>
                            <td class="pn clickable" onclick="openPartDetail('${esc(p.pn)}')">${esc(p.pn)}</td>
                            <td class="clickable" onclick="openPartDetail('${esc(p.pn)}')">${esc(p.desc || '')}</td>
                            <td class="dim clickable" onclick="openPartDetail('${esc(p.pn)}')">${esc(p.supplier || '')}</td>
                            <td class="right num clickable" onclick="openPartDetail('${esc(p.pn)}')">${fmtNum(p.onHand)}</td>
                            <td class="right">
                              <input class="input num" type="number" min="0" step="0.01"
                                value="${missing ? '' : shown}"
                                placeholder="—"
                                onclick="event.stopPropagation()"
                                ${dailyInherited
                                  ? `disabled title="Inherited from chain anchor ${esc(dailySrc.anchorPn || '')} — edit there"`
                                  : `onblur="bbuApplyRateFromInput('${esc(p.pn)}', this.value)" onkeydown="if(event.key==='Enter'){this.blur()}"`}
                                style="width:100px;text-align:right${dailyInherited ? ';opacity:0.55;cursor:not-allowed' : ''}">
                            </td>
                            <td>${missing ? '<span class="pill warn">MISSING RATE</span>' : ''}</td>
                          </tr>
                        `;
                      }).join("")}
                    </tbody>
                  </table>
                  ${rows.length > 500 ? `<div class="muted center tiny" style="padding:14px">Showing first 500 of ${rows.length}. Use search to narrow.</div>` : ""}
                </div>
              `}
            </div>
      </div>
    </div>`;
}

function bbuApplyRateFromInput(pn, raw) {
  const part = DB.parts.find(p => p.pn === pn);
  if (!part) return;
  const value = String(raw).trim();
  let newDaily;
  if (value === "") {
    newDaily = 0;
  } else {
    const num = parseFloat(value);
    if (!isFinite(num) || num < 0) { showToast(`Invalid rate for ${pn}`, "warn"); return; }
    newDaily = BBU_STATE.displayMode === "monthly" ? num / 30 : num;
  }
  const old = Number(part.daily) || 0;
  if (Math.abs(newDaily - old) < 0.0001) return; // no-op — avoids spurious audit/sync
  // Daily-use edit gate. Same 4616 / same prompt as delete actions.
  if (!gateEdit()) return;
  part.daily = newDaily;
  logAudit("daily-edit", `${pn}: daily ${old.toFixed(3)} → ${newDaily.toFixed(3)} (Base BOM Usage)`, { pn, oldDaily: old, newDaily });
  saveDB();
  bumpStatusCache();
  // No refresh() — keeps focus available for rapid multi-row entry.
  // Stats and MISSING pills update on the next manual refresh / navigation.
}

function bbuOpenImportModal() {
  openModal(`
    <div class="modal-head">
      <div class="head-sm">Import base BOM rates</div>
      <div class="muted tiny mt-xs">CSV or XLSX with a PN column and a daily-rate (or monthly-rate) column. Only updates existing base_bom parts; no new parts created.</div>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>File</label>
        <input type="file" id="bbu-import-file" accept=".csv,.xlsx,.xls">
      </div>
      <div style="margin-top:10px">
        <label class="row gap-sm mb-xs"><input type="radio" name="bbu-imp-mode" value="daily" checked> <span>Rate column is <strong>daily</strong> (units / day)</span></label>
        <label class="row gap-sm"><input type="radio" name="bbu-imp-mode" value="monthly"> <span>Rate column is <strong>monthly</strong> (will divide by 30)</span></label>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" onclick="bbuApplyImport()">Read file</button>
    </div>
  `);
}

// Header normalizer: lowercase, strip all non-alphanumeric.
// "Part #" → "part", "Monthly Rate" → "monthlyrate".
const _bbuNormHeader = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

const _BBU_PN_HEADERS = new Set([
  "partnumber", "partno", "part", "pn", "sku", "item", "itemnumber", "material",
]);
const _BBU_RATE_HEADERS = new Set([
  "monthlyrate", "dailyrate", "rate",
  "monthlyaverage", "averagemonthlydemand",
  "monthlydemand", "monthlyusage",
  "averagemonthly", "daily", "monthly",
]);

function bbuDetectPnColumn(sampleRow) {
  for (const k of Object.keys(sampleRow)) {
    if (_BBU_PN_HEADERS.has(_bbuNormHeader(k))) return k;
  }
  return null;
}

function bbuDetectRateColumn(sampleRow) {
  for (const k of Object.keys(sampleRow)) {
    if (_BBU_RATE_HEADERS.has(_bbuNormHeader(k))) return k;
  }
  return null;
}

function bbuApplyImport() {
  const fileInput = $("#bbu-import-file");
  const file = fileInput?.files?.[0];
  if (!file) { showToast("Pick a file first", "warn"); return; }
  const mode = document.querySelector('input[name="bbu-imp-mode"]:checked')?.value || "daily";
  const divisor = mode === "monthly" ? 30 : 1;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array", cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const sheetRows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
      if (!sheetRows.length) { showToast("Sheet is empty", "warn"); return; }

      const pnCol = bbuDetectPnColumn(sheetRows[0]);
      const rateCol = bbuDetectRateColumn(sheetRows[0]);
      if (!pnCol || !rateCol) {
        showToast(`Couldn't detect ${!pnCol ? 'PN' : 'rate'} column. Headers: ${Object.keys(sheetRows[0]).join(", ")}`, "crit", "Import failed", 8000);
        return;
      }

      // Bucket every row by what we'll do with it.
      const buckets = {
        newlyClassified: [],   // null/empty itemType → set base_bom + write daily
        reRated: [],           // already base_bom → write daily only
        skippedOtherType: [],  // service / options / do_not_order / kit → skip
        notInCatalog: [],      // pn not in DB.parts
        invalidRate: [],       // unparseable / negative rate
      };

      for (const row of sheetRows) {
        const pn = String(row[pnCol] || "").trim();
        if (!pn) continue;
        const rawCell = row[rateCol];
        const raw = parseFloat(String(rawCell || "").replace(/[^0-9.\-]/g, ""));
        if (!isFinite(raw) || raw < 0) {
          buckets.invalidRate.push({ pn, raw: rawCell });
          continue;
        }
        const newDaily = raw / divisor;
        const part = DB.parts.find(p => p.pn === pn);
        if (!part) { buckets.notInCatalog.push({ pn }); continue; }
        if (isKit(pn)) { buckets.skippedOtherType.push({ pn, part, itemType: "kit" }); continue; }
        const itemType = part.itemType;
        if (itemType === "base_bom") {
          buckets.reRated.push({ pn, part, oldDaily: Number(part.daily) || 0, newDaily });
        } else if (!itemType) {
          buckets.newlyClassified.push({ pn, part, oldDaily: Number(part.daily) || 0, newDaily });
        } else {
          buckets.skippedOtherType.push({ pn, part, itemType });
        }
      }

      bbuShowImportPreview(buckets, mode, file.name, sheetRows.length, pnCol, rateCol);
    } catch (err) {
      console.error("BBU import failed:", err);
      showToast("Import failed: " + err.message, "crit");
    }
  };
  reader.onerror = () => showToast("Failed to read file", "crit");
  reader.readAsArrayBuffer(file);
}

function bbuShowImportPreview(buckets, mode, filename, totalRows, pnCol, rateCol) {
  // Stash so the Apply button can commit without re-parsing.
  window._bbuPendingImport = { buckets, mode, filename };

  const SAMPLE = 20;
  const skippedTypeList = buckets.skippedOtherType.slice(0, SAMPLE);
  const notInCatList = buckets.notInCatalog.slice(0, SAMPLE);
  const willApply = buckets.newlyClassified.length + buckets.reRated.length;

  openModal(`
    <div class="modal-head">
      <div class="head-sm">Import preview · ${esc(filename)}</div>
      <div class="muted tiny mt-xs">${totalRows} file row${totalRows === 1 ? '' : 's'} · PN col: <span class="mono">${esc(pnCol)}</span> · rate col: <span class="mono">${esc(rateCol)}</span> · mode: <strong>${esc(mode)}</strong>${mode === 'monthly' ? ' (÷30)' : ''}</div>
    </div>
    <div class="modal-body">
      <div class="stat-strip" style="margin-bottom:14px">
        <div class="stat"><div class="stat-label">Newly classified</div><div class="stat-value ok">${buckets.newlyClassified.length}</div></div>
        <div class="stat"><div class="stat-label">Re-rated</div><div class="stat-value">${buckets.reRated.length}</div></div>
        <div class="stat"><div class="stat-label">Different type</div><div class="stat-value ${buckets.skippedOtherType.length > 0 ? 'warn' : ''}">${buckets.skippedOtherType.length}</div></div>
        <div class="stat"><div class="stat-label">Not in catalog</div><div class="stat-value ${buckets.notInCatalog.length > 0 ? 'warn' : ''}">${buckets.notInCatalog.length}</div></div>
      </div>

      <p class="muted tiny" style="margin:0 0 14px">
        Apply will: set <strong>itemType = base_bom</strong> AND write daily on ${buckets.newlyClassified.length} part${buckets.newlyClassified.length === 1 ? '' : 's'},
        and update daily on ${buckets.reRated.length} existing base_bom part${buckets.reRated.length === 1 ? '' : 's'}.
        Other buckets are left untouched.
      </p>

      ${buckets.skippedOtherType.length > 0 ? `
        <div class="dr-section">Skipped — already classified (${buckets.skippedOtherType.length})</div>
        <div class="tbl-wrap" style="max-height:200px;overflow-y:auto;margin-bottom:10px">
          <table class="tbl">
            <thead><tr><th>Part</th><th>Description</th><th>Current Type</th></tr></thead>
            <tbody>
              ${skippedTypeList.map(b => `
                <tr><td class="pn">${esc(b.pn)}</td><td>${esc(b.part?.desc || '—')}</td><td class="dim">${esc(b.itemType)}</td></tr>
              `).join("")}
              ${buckets.skippedOtherType.length > SAMPLE ? `<tr><td colspan="3" class="muted center tiny" style="padding:6px">…and ${buckets.skippedOtherType.length - SAMPLE} more</td></tr>` : ""}
            </tbody>
          </table>
        </div>
        <p class="muted tiny" style="margin:0 0 14px">These parts already have an item type set. Change them manually via the part detail drawer if you want them on Base BOM.</p>
      ` : ""}

      ${buckets.notInCatalog.length > 0 ? `
        <div class="dr-section">Skipped — not in catalog (${buckets.notInCatalog.length})</div>
        <div class="tag-row" style="margin-bottom:10px">
          ${notInCatList.map(b => `<span class="tag">${esc(b.pn)}</span>`).join("")}
          ${buckets.notInCatalog.length > SAMPLE ? `<span class="muted tiny" style="margin-left:8px">…and ${buckets.notInCatalog.length - SAMPLE} more</span>` : ""}
        </div>
        <p class="muted tiny" style="margin:0 0 14px">These PNs aren't in the catalog. Add them via Parts Catalog → + Add part if you want them rated.</p>
      ` : ""}

      ${buckets.invalidRate.length > 0 ? `
        <div class="dr-section">Skipped — invalid rate (${buckets.invalidRate.length})</div>
        <p class="muted tiny" style="margin:0 0 14px">${buckets.invalidRate.length} row${buckets.invalidRate.length === 1 ? '' : 's'} had an unparseable or negative rate value.</p>
      ` : ""}
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" onclick="bbuCommitImport()" ${willApply === 0 ? 'disabled' : ''}>
        Apply ${willApply} row${willApply === 1 ? '' : 's'}
      </button>
    </div>
  `);
}

function bbuCommitImport() {
  const pending = window._bbuPendingImport;
  if (!pending) { showToast("Nothing to apply", "warn"); return; }
  // Bulk daily-use writes — gate once before applying the whole batch.
  if (!gateEdit()) return;
  const { buckets, mode, filename } = pending;

  let newlyClassifiedApplied = 0;
  let reRatedApplied = 0;
  let reRatedUnchanged = 0;

  for (const b of buckets.newlyClassified) {
    const part = b.part;
    if (!part) continue;
    part.itemType = "base_bom";
    part.daily = b.newDaily;
    newlyClassifiedApplied++;
  }
  for (const b of buckets.reRated) {
    const part = b.part;
    if (!part) continue;
    const old = Number(part.daily) || 0;
    if (Math.abs(b.newDaily - old) < 0.0001) { reRatedUnchanged++; continue; }
    part.daily = b.newDaily;
    reRatedApplied++;
  }

  logAudit(
    "daily-bulk-edit",
    `Base BOM rate import (${filename}): ${newlyClassifiedApplied} newly classified as base_bom + rated, ${reRatedApplied} re-rated, ${reRatedUnchanged} unchanged, ${buckets.skippedOtherType.length} skipped (other type), ${buckets.notInCatalog.length} skipped (not in catalog), ${buckets.invalidRate.length} invalid`,
    {
      source: filename, mode,
      newlyClassified: newlyClassifiedApplied,
      reRated: reRatedApplied,
      unchanged: reRatedUnchanged,
      skippedOtherType: buckets.skippedOtherType.length,
      notInCatalog: buckets.notInCatalog.length,
      invalidRate: buckets.invalidRate.length,
    }
  );
  saveDB();
  bumpStatusCache();
  closeModal();
  window._bbuPendingImport = null;

  const tail = [];
  if (reRatedUnchanged) tail.push(`${reRatedUnchanged} unchanged`);
  if (buckets.skippedOtherType.length) tail.push(`${buckets.skippedOtherType.length} other type`);
  if (buckets.notInCatalog.length) tail.push(`${buckets.notInCatalog.length} not in catalog`);
  if (buckets.invalidRate.length) tail.push(`${buckets.invalidRate.length} invalid`);

  const totalApplied = newlyClassifiedApplied + reRatedApplied;
  showToast(`Applied: ${newlyClassifiedApplied} classified, ${reRatedApplied} re-rated${tail.length ? ' · ' + tail.join(' · ') : ''}`, totalApplied > 0 ? "ok" : "warn");
  refresh();
}

function bbuOpenPasteModal() {
  openModal(`
    <div class="modal-head">
      <div class="head-sm">Paste base BOM rates</div>
      <div class="muted tiny mt-xs">One row per line: <span class="mono">PART_NUMBER &lt;TAB&gt; RATE</span> (comma also accepted). Only updates existing base_bom parts.</div>
    </div>
    <div class="modal-body">
      <div style="margin-bottom:10px">
        <label class="row gap-sm mb-xs"><input type="radio" name="bbu-paste-mode" value="daily" checked> <span>Rate is <strong>daily</strong></span></label>
        <label class="row gap-sm"><input type="radio" name="bbu-paste-mode" value="monthly"> <span>Rate is <strong>monthly</strong> (will divide by 30)</span></label>
      </div>
      <div class="field"><label>Paste rows</label>
        <textarea class="paste-area" id="bbu-paste-area" autofocus placeholder="LM-FR-1000\t0.5&#10;LM-FR-1001\t1.2"></textarea>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" onclick="bbuApplyPaste()">Apply</button>
    </div>
  `);
}

function bbuApplyPaste() {
  const txt = $("#bbu-paste-area")?.value || "";
  if (!txt.trim()) { showToast("Paste some rows first", "warn"); return; }
  // Bulk daily-use writes — gate once before applying the whole paste batch.
  if (!gateEdit()) return;
  const mode = document.querySelector('input[name="bbu-paste-mode"]:checked')?.value || "daily";
  const divisor = mode === "monthly" ? 30 : 1;
  const baseBomPns = new Set(DB.parts.filter(p => p.itemType === "base_bom" && !isKit(p)).map(p => p.pn));
  const lines = txt.split(/\r?\n/);
  let updated = 0, skippedNotBaseBom = 0, skippedInvalid = 0, unchanged = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const cells = line.split(/\t|,/).map(s => s.trim());
    if (cells.length < 2) continue;
    const pn = cells[0];
    if (!pn || !baseBomPns.has(pn)) { if (pn) skippedNotBaseBom++; continue; }
    const raw = parseFloat(cells[1].replace(/[^0-9.\-]/g, ""));
    if (!isFinite(raw) || raw < 0) { skippedInvalid++; continue; }
    const newDaily = raw / divisor;
    const part = DB.parts.find(p => p.pn === pn);
    const old = Number(part.daily) || 0;
    if (Math.abs(newDaily - old) < 0.0001) { unchanged++; continue; }
    part.daily = newDaily;
    updated++;
  }
  logAudit("daily-bulk-edit", `Base BOM rates pasted: ${updated} updated, ${unchanged} unchanged, ${skippedNotBaseBom} not base_bom, ${skippedInvalid} invalid`, { mode });
  saveDB();
  bumpStatusCache();
  closeModal();
  const tail = [];
  if (unchanged) tail.push(`${unchanged} unchanged`);
  if (skippedNotBaseBom) tail.push(`${skippedNotBaseBom} not base_bom`);
  if (skippedInvalid) tail.push(`${skippedInvalid} invalid`);
  showToast(`Updated ${updated} rate${updated === 1 ? '' : 's'}${tail.length ? ' · ' + tail.join(' · ') : ''}`, updated > 0 ? "ok" : "warn");
  refresh();
}

function bbuExportRates() {
  const parts = bbuBaseBomParts();
  const headers = ["Part #", "Description", "Supplier", "On Hand", "Daily Rate", "Monthly Rate"];
  const out = [headers];
  for (const p of parts) {
    const d = Number(p.daily) || 0;
    out.push([p.pn, p.desc || "", p.supplier || "", p.onHand || 0, d, d * 30]);
  }
  const csv = out.map(r => r.map(c => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n");
  downloadFile(csv, `base-bom-rates-${isoDate(TODAY)}.csv`, "text/csv");
  showToast(`Exported ${parts.length} base BOM part${parts.length === 1 ? '' : 's'}`, "ok");
}
let SERVICE_USAGE_STATE = {
  search: "",
  sortBy: "units",  // units | daily | diff | last
};

let _svcUsageSearchTimer = null;
function _svcUsageSearchInput(value) {
  SERVICE_USAGE_STATE.search = value;
  clearTimeout(_svcUsageSearchTimer);
  _svcUsageSearchTimer = setTimeout(() => {
    refresh();
    // Restore focus and cursor position after re-render
    const inp = document.getElementById("svc-usage-search");
    if (inp) {
      inp.focus();
      inp.setSelectionRange(value.length, value.length);
    }
  }, 200);
}

registerRoute("service-usage", () => {
  if (!_usageGate("service-usage")) return;
  // "Sort: biggest difference" was removed alongside the hidden Δ column.
  // Self-heal any in-session state that still pointed at it so the
  // dropdown isn't blank-selected and the sort doesn't silently rank by
  // an invisible value.
  if (SERVICE_USAGE_STATE.sortBy === "diff") SERVICE_USAGE_STATE.sortBy = "units";
  const demand = getAllDemand();
  const txCount = (DB.usage || []).length;

  let rows = [];
  for (const [pn, d] of demand.entries()) {
    const part = DB.parts.find(p => p.pn === pn);
    const storedDaily = Number(part?.daily) || 0;
    const diff = d.appliedDaily - storedDaily;
    rows.push({
      pn, part, demand: d,
      storedDaily,
      computedDaily: d.appliedDaily,
      diff,
    });
  }

  if (SERVICE_USAGE_STATE.search) {
    const q = SERVICE_USAGE_STATE.search.toLowerCase();
    rows = rows.filter(r =>
      r.pn.toLowerCase().includes(q) ||
      (r.part?.desc || "").toLowerCase().includes(q)
    );
  }

  rows.sort((a, b) => {
    switch (SERVICE_USAGE_STATE.sortBy) {
      case "daily": return b.computedDaily - a.computedDaily;
      case "diff": return Math.abs(b.diff) - Math.abs(a.diff);
      case "last":
        return (b.demand.lastOrderDate || "").localeCompare(a.demand.lastOrderDate || "");
      case "units":
      default: return b.demand.units - a.demand.units;
    }
  });

  const totalUnits = rows.reduce((s, r) => s + r.demand.units, 0);

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Service Usage</div>
          <div class="page-sub mono">${txCount.toLocaleString()} TRANSACTIONS · ${rows.length} PARTS · ${fmtNum(totalUnits)} UNITS IN LAST 180 DAYS</div>
        </div>
      </div>

      <div class="panel">
        <div class="filterbar">
          <div class="search-input">
            <input class="input" id="svc-usage-search" placeholder="Search part # or description…" value="${esc(SERVICE_USAGE_STATE.search)}" oninput="_svcUsageSearchInput(this.value)">
          </div>
          <select class="select" onchange="SERVICE_USAGE_STATE.sortBy = this.value; refresh()">
            <option value="units" ${SERVICE_USAGE_STATE.sortBy==='units'?'selected':''}>Sort: most units sold</option>
            <option value="daily" ${SERVICE_USAGE_STATE.sortBy==='daily'?'selected':''}>Sort: highest daily rate</option>
            <option value="last" ${SERVICE_USAGE_STATE.sortBy==='last'?'selected':''}>Sort: most recent sale</option>
          </select>
        </div>
        <div class="panel-body flush">
          ${rows.length === 0 ? `
            <div class="empty">
              <div class="empty-title">No service parts found</div>
              <div class="empty-msg">Import sales orders into Usage to populate this page.</div>
            </div>
          ` : `
            <div class="tbl-wrap">
              <table class="tbl">
                <thead><tr>
                  <th>Part</th>
                  <th>Description</th>
                  <th style="text-align:right">Computed Daily</th>
                  <th>Last Sale</th>
                </tr></thead>
                <tbody>
                  ${rows.slice(0, 500).map(r => {
                    const lastSale = r.demand.lastOrderDate ? fmtDate(r.demand.lastOrderDate) : "—";
                    const desc = r.part?.desc || "—";
                    return `
                      <tr>
                        <td class="pn">${esc(r.pn)}</td>
                        <td>${esc(desc)}</td>
                        <td class="right num bold">${fmtNum(r.computedDaily, 3)}</td>
                        <td class="dim tiny">${lastSale}</td>
                      </tr>
                    `;
                  }).join("")}
                </tbody>
              </table>
            </div>
            ${rows.length > 500 ? `<div class="muted center tiny" style="padding:14px">Showing first 500 of ${rows.length}. Use search to narrow.</div>` : ""}
          `}
        </div>
      </div>
    </div>`;
});

function applyServicePartDaily(pn, newDaily) {
  const part = DB.parts.find(p => p.pn === pn);
  if (!part) return;
  // Per-row Apply Computed Daily — gated by the same 4616 prompt as
  // delete actions. Still callable from the console after the UI was
  // hidden; the gate stays in front regardless of caller.
  if (!gateEdit()) return;
  const old = Number(part.daily) || 0;
  part.daily = newDaily;
  logAudit("daily-override", `${pn}: daily ${old.toFixed(3)} → ${newDaily.toFixed(3)} (Service Usage)`, { pn, oldDaily: old, newDaily });
  saveDB();
  bumpStatusCache();
  bumpDemandCache();
  showToast(`${pn} daily updated to ${newDaily.toFixed(3)}`, "ok");
  refresh();
}

function bulkApplyComputedDaily() {
  // Bulk Apply Computed Daily across every part — gate once before the
  // batch write. Still callable from the console after the UI was hidden.
  if (!gateEdit()) return;
  const demand = getAllDemand();
  let updated = 0;
  for (const part of DB.parts) {
    const d = demand.get(part.pn);
    if (!d) continue;
    const newDaily = d.appliedDaily;
    const oldDaily = Number(part.daily) || 0;
    if (newDaily !== oldDaily) {
      part.daily = newDaily;
      updated++;
    }
  }
  if (updated === 0) {
    showToast("No changes to apply — all daily rates already match", "info");
    return;
  }
  logAudit("daily-bulk-apply", `Applied 180-day average daily rates to ${updated} parts`, { count: updated });
  saveDB();
  bumpStatusCache();
  bumpDemandCache();
  showToast(`Updated daily rates on ${updated} parts`, "ok");
  refresh();
}

function openLogUsageModal(prefillPn = "") {
  let q = prefillPn;
  let selectedPN = prefillPn || null;
  const buildLines = [...new Set(DB.usage.map(u => u.buildLine).filter(Boolean))].sort();
  const reasons = ["Build", "Service", "Warranty", "Damaged", "Loss", "Other"];

  function render() {
    const matches = q && !selectedPN ? DB.parts.filter(p =>
      p.pn.toLowerCase().includes(q.toLowerCase()) || (p.desc||"").toLowerCase().includes(q.toLowerCase())
    ).slice(0, 6) : [];
    const part = selectedPN ? DB.parts.find(p => p.pn === selectedPN) : null;

    openModal(`
      <div class="modal-head">
        <div class="head-sm">Log usage</div>
        <div class="muted tiny mt-xs">Records a consumption transaction. By default this decrements on-hand inventory.</div>
      </div>
      <div class="modal-body">
        ${!part ? `
          <div class="field">
            <label>Find part</label>
            <input class="input lg" id="lu-search" autofocus placeholder="Type part # or description…" value="${esc(q)}">
          </div>
          ${matches.length > 0 ? `
            <div class="tbl-wrap" style="margin-top:8px">
              <table class="tbl">
                <thead><tr><th>Part</th><th>Description</th><th class="right">On Hand</th></tr></thead>
                <tbody>
                  ${matches.map(p => `
                    <tr class="clickable" onclick="(window._luSelect)('${esc(p.pn)}')">
                      <td class="pn">${esc(p.pn)}</td>
                      <td>${esc(p.desc)}</td>
                      <td class="right num">${fmtNum(p.onHand)}</td>
                    </tr>
                  `).join("")}
                </tbody>
              </table>
            </div>
          ` : (q ? `<div class="muted tiny center" style="padding:18px">No matches.</div>` : "")}
        ` : `
          <div class="stat-strip">
            <div class="stat"><div class="stat-label">Part</div><div class="stat-value mono" style="font-size:14px">${esc(part.pn)}</div></div>
            <div class="stat"><div class="stat-label">Description</div><div class="stat-value" style="font-size:13px;font-family:var(--f-ui);font-weight:500">${esc(part.desc)}</div></div>
            <div class="stat"><div class="stat-label">On Hand</div><div class="stat-value">${fmtNum(part.onHand)}</div></div>
          </div>
          <div class="grid-2" style="margin-top:14px">
            <div class="field">
              <label>Date</label>
              <input class="input lg" id="lu-date" type="date" value="${isoDate(TODAY)}">
            </div>
            <div class="field">
              <label>Qty used *</label>
              <input class="input lg num" id="lu-qty" type="number" min="1" autofocus value="1">
            </div>
            <div class="field">
              <label>Build line</label>
              <input class="input lg" id="lu-build" list="lu-build-list" placeholder="L5, LX, Mudmaster…">
              <datalist id="lu-build-list">${buildLines.map(b => `<option value="${esc(b)}">`).join("")}</datalist>
            </div>
            <div class="field">
              <label>Reason</label>
              <select class="select" id="lu-reason">
                ${reasons.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>User</label>
              <input class="input lg" id="lu-user" value="${esc(DB.settings.defaultBuyer||"")}">
            </div>
            <div class="field">
              <label>Notes</label>
              <input class="input lg" id="lu-notes" placeholder="(optional)">
            </div>
          </div>
          <label class="row mt-sm" style="cursor:pointer">
            <input type="checkbox" class="chk" id="lu-decrement" checked>
            <span>Decrement on-hand inventory by this qty</span>
          </label>
          <div class="row gap-md mt-sm">
            <button class="btn ghost" onclick="(window._luClear)()">← Pick different part</button>
          </div>
        `}
      </div>
      <div class="modal-foot">
        <button class="btn" data-close>Cancel</button>
        ${part ? `<button class="btn primary" onclick="(window._luSave)()">✓ Log usage</button>` : ""}
      </div>
    `);
    setTimeout(() => {
      const inp = $("#lu-search");
      if (inp) inp.oninput = (e) => { q = e.target.value; render(); };
      const qty = $("#lu-qty");
      if (qty) qty.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); window._luSave(); } };
    }, 50);
  }
  window._luSelect = (pn) => { selectedPN = pn; render(); };
  window._luClear = () => { selectedPN = null; q = ""; render(); };
  window._luSave = () => {
    const part = DB.parts.find(p => p.pn === selectedPN);
    if (!part) return;
    const qty = Math.round(parseFloat($("#lu-qty").value) || 0);
    if (qty <= 0) { showToast("Qty must be > 0", "warn"); return; }
    const dateStr = $("#lu-date").value;
    const ts = dateStr ? new Date(dateStr + "T12:00:00").toISOString() : new Date().toISOString();
    const decrement = $("#lu-decrement").checked;
    const u = {
      id: uid("us"), ts, pn: selectedPN, qty,
      buildLine: $("#lu-build").value.trim(),
      reason: $("#lu-reason").value,
      user: $("#lu-user").value.trim(),
      notes: $("#lu-notes").value.trim(),
    };
    DB.usage.push(u);
    logAudit("usage-add", `Logged usage: ${qty}× ${selectedPN}${u.buildLine ? ' on '+u.buildLine : ''}${u.reason ? ' ('+u.reason+')' : ''}`, { pn: selectedPN, qty });
    if (decrement) {
      const old = part.onHand || 0;
      part.onHand = Math.max(0, old - qty);
      logAudit("oh-edit", `${selectedPN}: ${fmtNum(old)} → ${fmtNum(part.onHand)} (usage)`, { pn: selectedPN, oldQ: old, newQ: part.onHand, delta: part.onHand-old });
    }
    saveDB();
    bumpStatusCache();
    autoSyncExcel();
    closeModal();
    showToast(`Usage logged: ${qty}× ${selectedPN}${decrement ? ` · on-hand now ${fmtNum(part.onHand)}` : ''}`, "ok", "Recorded");
    refresh();
  };
  render();
}

function confirmDeleteUsage(id) {
  if (!gateDelete()) return;
  const u = DB.usage.find(x => x.id === id);
  if (!u) return;
  openModal(`
    <div class="modal-head"><div class="head-sm">Delete this usage entry?</div></div>
    <div class="modal-body">
      <p>${fmtTime(u.ts)} · <span class="pn">${esc(u.pn)}</span> · <strong>${fmtNum(u.qty)}</strong> ${u.buildLine?'on '+esc(u.buildLine):''}</p>
      <label class="row mt-sm" style="cursor:pointer">
        <input type="checkbox" class="chk" id="du-restore" checked>
        <span>Restore on-hand by ${fmtNum(u.qty)} (reverse the decrement)</span>
      </label>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn danger" onclick="deleteUsage('${esc(id)}')">Delete</button>
    </div>
  `);
}

function deleteUsage(id) {
  const idx = DB.usage.findIndex(x => x.id === id);
  if (idx < 0) return;
  const u = DB.usage[idx];
  const restore = $("#du-restore")?.checked;
  if (restore) {
    const part = DB.parts.find(p => p.pn === u.pn);
    if (part) {
      const old = part.onHand || 0;
      part.onHand = old + (u.qty || 0);
      logAudit("oh-edit", `${u.pn}: ${fmtNum(old)} → ${fmtNum(part.onHand)} (usage reversal)`, { pn: u.pn, oldQ: old, newQ: part.onHand, delta: u.qty });
    }
  }
  DB.usage.splice(idx, 1);
  logAudit("usage-del", `Deleted usage: ${u.qty}× ${u.pn}`, { pn: u.pn });
  saveDB();
  bumpStatusCache();
  autoSyncExcel();
  closeModal();
  showToast("Usage deleted", "warn");
  refresh();
}

function openBulkUsageModal() {
  openModal(`
    <div class="modal-head">
      <div class="head-sm">Bulk log usage</div>
      <div class="muted tiny mt-xs">Paste rows: <span class="mono">PART_NUMBER &lt;TAB&gt; QTY [&lt;TAB&gt; BUILD_LINE]</span> — one per line. Date defaults to today; uncheck to skip on-hand decrement.</div>
    </div>
    <div class="modal-body">
      <div class="field"><label>Paste data</label>
        <textarea class="paste-area" id="bu-paste" autofocus placeholder="LM-DT-2000	4	L5&#10;LM-EN-2007	2	Mudmaster"></textarea>
      </div>
      <label class="row" style="gap:8px;margin-top:8px;cursor:pointer">
        <input type="checkbox" class="chk" id="bu-decrement" checked>
        <span>Decrement on-hand for each row</span>
      </label>
      <div class="row gap-md mt-sm">
        <button class="btn" onclick="bulkUsageParse()">Parse & preview →</button>
        <div class="grow"></div>
      </div>
      <div id="bu-preview"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="bu-apply" disabled onclick="bulkUsageApply()">Log 0 usages</button>
    </div>
  `);
}

let _bulkUsage = null;
function bulkUsageParse() {
  const txt = ($("#bu-paste").value || "").trim();
  if (!txt) { showToast("Paste some data first", "warn"); return; }
  const rows = txt.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  const parsed = [];
  let bad = 0, unknown = 0;
  for (let i = 0; i < rows.length; i++) {
    const cols = rows[i].split(/[\t,;|]+|\s{2,}/).map(s => s.trim()).filter(Boolean);
    if (cols.length < 2) {
      const tokens = rows[i].split(/\s+/);
      if (tokens.length < 2) { bad++; continue; }
      cols[0] = tokens[0]; cols[1] = tokens[1]; cols[2] = tokens.slice(2).join(" ");
    }
    const pn = cols[0];
    const qty = parseFloat((cols[1]||"").replace(/[^0-9.\-]/g, ""));
    if (i === 0 && (isNaN(qty) || /[a-z]/i.test(cols[1]))) continue; // header row
    if (isNaN(qty) || qty <= 0) { bad++; continue; }
    const part = DB.parts.find(p => p.pn === pn) || DB.parts.find(p => p.pn.toLowerCase() === pn.toLowerCase());
    if (!part) { unknown++; parsed.push({ pn, qty: Math.round(qty), buildLine: cols[2]||"", matched: false }); continue; }
    parsed.push({ pn: part.pn, desc: part.desc, qty: Math.round(qty), buildLine: cols[2]||"", matched: true });
  }
  _bulkUsage = parsed;
  const matched = parsed.filter(p => p.matched);
  $("#bu-apply").disabled = matched.length === 0;
  $("#bu-apply").textContent = `Log ${matched.length} usage${matched.length===1?'':'s'}`;
  $("#bu-preview").innerHTML = `
    <div class="dr-section">Preview</div>
    <div class="stat-strip" style="margin-bottom:10px">
      <div class="stat"><div class="stat-label">Total rows</div><div class="stat-value">${rows.length}</div></div>
      <div class="stat"><div class="stat-label">Matched</div><div class="stat-value ok">${matched.length}</div></div>
      <div class="stat"><div class="stat-label">Unknown</div><div class="stat-value ${unknown>0?'warn':''}">${unknown}</div></div>
      <div class="stat"><div class="stat-label">Bad</div><div class="stat-value ${bad>0?'warn':''}">${bad}</div></div>
    </div>
    <div class="tbl-wrap" style="max-height:240px;overflow-y:auto"><table class="tbl">
      <thead><tr><th>Part</th><th>Description</th><th class="right">Qty</th><th>Build</th><th></th></tr></thead>
      <tbody>
        ${parsed.slice(0, 100).map(r => r.matched ? `
          <tr><td class="pn">${esc(r.pn)}</td><td>${esc(r.desc||"")}</td><td class="right num bold">${fmtNum(r.qty)}</td><td class="dim">${esc(r.buildLine||"—")}</td><td><span class="pill ok">match</span></td></tr>
        ` : `
          <tr><td class="pn dim">${esc(r.pn)}</td><td colspan="3" class="dim">— part not found —</td><td><span class="pill warn">skip</span></td></tr>
        `).join("")}
      </tbody>
    </table></div>
  `;
}

function bulkUsageApply() {
  if (!_bulkUsage) return;
  const decrement = $("#bu-decrement").checked;
  const matched = _bulkUsage.filter(r => r.matched);
  let count = 0;
  for (const r of matched) {
    const part = DB.parts.find(p => p.pn === r.pn);
    if (!part) continue;
    DB.usage.push({
      id: uid("us"), ts: new Date().toISOString(),
      pn: r.pn, qty: r.qty, buildLine: r.buildLine, reason: "Build", user: DB.settings.defaultBuyer||"", notes: "bulk paste",
    });
    if (decrement) {
      const old = part.onHand || 0;
      part.onHand = Math.max(0, old - r.qty);
    }
    count++;
  }
  logAudit("usage-bulk", `Bulk logged ${count} usage transactions`);
  saveDB();
  bumpStatusCache();
  autoSyncExcel();
  closeModal();
  showToast(`${count} usage transactions logged${decrement?' · on-hand decremented':''}`, "ok");
  refresh();
}

function recomputeDailyFromUsage() {
  if (!Array.isArray(DB.usage) || DB.usage.length === 0) {
    showToast("No usage history to recalc from. Log some usage first.", "warn");
    return;
  }
  // Bulk daily-use write triggered by the "⟲ Recalc daily-use rates"
  // button on the generic Usage page — same 4616 gate as the other
  // bulk-apply paths. Prompt fires once before the batch.
  if (!gateEdit()) return;
  const days = DB.settings.usageWindowDays || 120;
  const cutoff = addDays(TODAY, -days);
  // Calendar daily rate — matches the projection logic which decrements daily per calendar day
  const map = {};
  for (const u of DB.usage) {
    if (new Date(u.ts) < cutoff) continue;
    map[u.pn] = (map[u.pn] || 0) + (u.qty || 0);
  }
  let updated = 0;
  for (const part of DB.parts) {
    const total = map[part.pn] || 0;
    const newDaily = round(total / Math.max(1, days), 4);
    if (newDaily > 0 && Math.abs(newDaily - (part.daily || 0)) > 0.005) {
      part.daily = newDaily;
      updated++;
    }
  }
  logAudit("daily-recalc", `Recomputed calendar daily-use rates from ${days}-day usage history (${updated} parts updated)`);
  saveDB();
  bumpStatusCache();
  autoSyncExcel();
  showToast(`Daily-use rates updated for ${updated} parts based on ${days}-day calendar consumption`, "ok");
  refresh();
}

/* Manual one-shot helpers */
async function syncWorkbookNow(kind) {
  if (!_fileHandles[kind]) { showToast("Not linked", "warn"); return; }
  updateSyncIndicator("syncing");
  const wb = buildWorkbook(kind);
  const ok = await writeWorkbook(kind, wb);
  updateSyncIndicator();
  if (ok) showToast(`${kindLabel(kind)} workbook synced`, "ok");
}

function downloadXlsxOnce(kind) {
  const wb = buildWorkbook(kind);
  if (!wb) return;
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `landmaster-${kind}-${isoDate(TODAY)}.xlsx`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
  showToast(`${kindLabel(kind)} workbook downloaded`, "ok");
}
