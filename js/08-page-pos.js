/* =====================================================
   08-page-pos.js
   Sections: PAGE: PURCHASE ORDERS (list), PO DETAIL DRAWER — full edit, line ops, receive, submit
   ===================================================== */

/* ============================================================
   PAGE: PURCHASE ORDERS (list)
   ============================================================ */
let POS_STATE = {
  filter: "active",
  search: "",
  sortBy: "date",
  sortDir: "desc",
  headerFilters: { num: "", supplier: "", status: "" },
  hiddenFilters: { num: [], supplier: [], status: [] },
  headerOptions: {},
  openHeaderMenu: "",
};
let OPEN_PO_ID = null;

/* ----- Excel-style header dropdowns (mirrors Order Queue) ----- */
function posToggleHeaderMenu(key) {
  POS_STATE.openHeaderMenu = POS_STATE.openHeaderMenu === key ? "" : key;
  refresh();
}
function posClearHeaderFilter(key) {
  POS_STATE.headerFilters[key] = "";
  POS_STATE.hiddenFilters[key] = [];
  POS_STATE.openHeaderMenu = "";
  refresh();
}
function posToggleHeaderValue(key, value, checked) {
  let hidden = POS_STATE.hiddenFilters[key] || [];
  if (checked) hidden = hidden.filter(v => v !== value);
  else if (!hidden.includes(value)) hidden.push(value);
  POS_STATE.hiddenFilters[key] = hidden;
  posReapplyHeaderFiltersInPlace();
}
function posToggleAllHeaderValues(key, checked) {
  const values = POS_STATE.headerOptions[key] || [];
  POS_STATE.hiddenFilters[key] = checked ? [] : [...values];
  document.querySelectorAll(`[data-pos-option="${key}"] input[type="checkbox"]`).forEach(cb => { cb.checked = checked; });
  posReapplyHeaderFiltersInPlace();
}
function posReapplyHeaderFiltersInPlace() {
  const hidden = POS_STATE.hiddenFilters || { num: [], supplier: [], status: [] };
  const text = POS_STATE.headerFilters || { num: "", supplier: "", status: "" };
  const tn = String(text.num || "").toLowerCase();
  const ts = String(text.supplier || "").toLowerCase();
  const tst = String(text.status || "").toLowerCase();
  const rows = document.querySelectorAll('[data-pos-row]');
  let visibleCount = 0;
  rows.forEach(row => {
    const num = row.dataset.poNum || "";
    const supplier = row.dataset.poSupplier || "";
    const status = row.dataset.poStatus || "";
    const textMatch = num.toLowerCase().includes(tn) && supplier.toLowerCase().includes(ts) && status.toLowerCase().includes(tst);
    const valueMatch = !hidden.num.includes(num) && !hidden.supplier.includes(supplier) && !hidden.status.includes(status);
    const visible = textMatch && valueMatch;
    row.style.display = visible ? "" : "none";
    if (visible) visibleCount++;
  });
  const empty = document.querySelector('#pos-empty-row');
  if (empty) empty.style.display = visibleCount > 0 ? "none" : "";
  const countEl = document.querySelector('#pos-count');
  if (countEl) countEl.textContent = `${visibleCount} SHOWING · ${DB.pos.length} TOTAL`;
}
function posInstallOutsideClick() {
  if (!POS_STATE.openHeaderMenu) {
    if (POS_STATE._outsideClick) {
      document.removeEventListener("click", POS_STATE._outsideClick);
      POS_STATE._outsideClick = null;
    }
    return;
  }
  if (POS_STATE._outsideClick) return;
  const handler = () => {
    document.removeEventListener("click", handler);
    POS_STATE._outsideClick = null;
    POS_STATE.openHeaderMenu = "";
    refresh();
  };
  POS_STATE._outsideClick = handler;
  setTimeout(() => document.addEventListener("click", handler), 0);
}
function posMenuSearchValues(key, term) {
  const q = String(term || "").toLowerCase();
  document.querySelectorAll(`[data-pos-option="${key}"]`).forEach(row => {
    const value = row.dataset.search || "";
    row.style.display = value.includes(q) ? "flex" : "none";
  });
}
function posSortHeader(key, dir) {
  POS_STATE.sortBy = key;
  POS_STATE.sortDir = dir;
  POS_STATE.openHeaderMenu = "";
  refresh();
}

function posHeaderValue(po, key) {
  let value = "";
  if (key === "num") value = po.num || "";
  if (key === "supplier") value = po.supplier || "";
  if (key === "status") value = posDisplayStatus(po).label;
  return String(value).trim() || "(Blanks)";
}

function posDisplayStatus(po) {
  const a = po.acumStatus;
  if (a) {
    const map = {
      "Open":             { label: "Open",             cls: "info" },
      "On Hold":          { label: "On Hold",          cls: "warn" },
      "Pending Approval": { label: "Pending Approval", cls: "muted" },
      "Pending Printing": { label: "Pending Printing", cls: "muted" },
      "Pending Email":    { label: "Pending Email",    cls: "muted" },
      "Awaiting Link":    { label: "Awaiting Link",    cls: "muted" },
      "Completed":        { label: "Completed",        cls: "ok" },
      "Rejected":         { label: "Rejected",         cls: "crit" },
      "Canceled":         { label: "Canceled",         cls: "crit" },
    };
    return map[a] || { label: a, cls: "muted" };
  }
  const fb = {
    "draft":      { label: "Draft",      cls: "muted" },
    "submitted":  { label: "Submitted",  cls: "info" },
    "in_transit": { label: "In Transit", cls: "info" },
    "received":   { label: "Completed",  cls: "ok" },
    "cancelled":  { label: "Cancelled",  cls: "crit" },
    "closed":     { label: "Closed",     cls: "muted" },
  };
  return fb[po.status] || { label: poStatusLabel(po.status), cls: "muted" };
}

// Time-based status badge for a PO row/drawer:
//   • Normal / Release PO with a past expected date → OVERDUE (solid-crit)
//   • Blanket PO past its expiration → EXPIRED (warn pill)
//   • Blanket PO within its authorization window OR blanketExpires unknown
//     → no badge at all (a blanket is never "overdue" — it's an
//     authorization, not a scheduled receipt, so comparing po.expectedDate
//     against today would flag every blanket incorrectly).
//   • received / closed POs → no badge.
// Returns { html: string, isOverdue: boolean } — isOverdue drives the
// expected-date column's text-crit styling on the list row.
function poTimeBadge(po) {
  if (!po) return { html: "", isOverdue: false };
  // EXPIRED pill for blanket POs stays local — it's specific to the
  // blanket strip's authorization-window semantics (blanketExpires),
  // which don't belong in the general poState() classification.
  const bm = poBlanketMeta(po);
  if (bm.kind === "blanket") {
    const anyExpired = (bm.blanketLines || []).some(l => l.blanketExpires && new Date(l.blanketExpires) < TODAY);
    if (anyExpired) return { html: '<span class="pill warn">EXPIRED</span>', isOverdue: false };
    return { html: "", isOverdue: false };
  }
  // OVERDUE derives entirely from poState (js/03-calc.js). poState.overdue
  // fires only when the PO is active AND has at least one open line (per
  // isLineOpen — openQty-authoritative) AND expected date is past AND no
  // blanket line present. All the guards that used to live inline here
  // (po.status !== received/closed check, any-open-line gate) are folded
  // into poState so tabs / dashboard / badge share the same predicate.
  if (poState(po).overdue) {
    return { html: '<span class="pill solid-crit">OVERDUE</span>', isOverdue: true };
  }
  return { html: "", isOverdue: false };
}

function posSubLineHTML(po) {
  const ds = posDisplayStatus(po);
  const badge = poTimeBadge(po);
  return `${esc(po.supplier)} · <span class="pill ${ds.cls}">${esc(ds.label)}</span> ${badge.html}`;
}

// Classify a PO by its blanket relationship. A PO is:
//   • blanket  → any line has type === "Blanket"
//   • release  → any line carries a blanketPoNum (parent link)
//   • normal   → neither
// Returned meta drives both the list-row indicator and the drawer strip
// so those two surfaces can't drift out of sync.
//
// Per-line preservation: `blanketLines` carries EVERY blanket-typed line
// (sorted earliest-expiring first — undated lines sort last, matching
// findOpenBlanketsForPart's release-priority order). Consumers must
// enumerate that array rather than reading `blanketLine`/`open`/`total`
// as if they represented the whole PO — those fields are the
// representative-line values, kept for the EXPIRED-pill and Expires-On
// surfaces where a single date is meaningful, and left alongside for
// backward-compat with any straggler reader.
function poBlanketMeta(po) {
  if (!po || !Array.isArray(po.lines)) return { kind: "normal" };
  const blanketLines = po.lines
    .filter(l => String(l.type || "").trim().toLowerCase() === "blanket")
    .slice()
    .sort((a, b) => {
      const aE = a.blanketExpires, bE = b.blanketExpires;
      if (aE && bE) return aE < bE ? -1 : aE > bE ? 1 : 0;
      if (aE && !bE) return -1;
      if (!aE && bE) return 1;
      return 0;
    });
  let parentBlanketNum = null;
  for (const ln of po.lines) {
    if (ln.blanketPoNum) {
      parentBlanketNum = String(ln.blanketPoNum).trim() || null;
      break;
    }
  }
  if (blanketLines.length > 0) {
    const rep = blanketLines[0];  // earliest-expiring
    const open = Math.max(0, Number(rep.blanketOpenQty || 0));
    const total = Math.max(0, Number(rep.qty || 0));
    return { kind: "blanket", blanketLine: rep, blanketLines, open, total };
  }
  if (parentBlanketNum) {
    return { kind: "release", parentBlanketNum };
  }
  return { kind: "normal" };
}

// Per-line breakdown string for the drawer banner, list-row indicator,
// and release-child parent tail. Renders as "N blanket line[s] · a + b + c"
// so a 3-line PO like POW0001289 (18397=40, 18420=60, 19931=150) shows
// "3 blanket lines · 40 + 60 + 150" instead of a first-line-only "40".
// Callers append their own contextual suffix ("open", "left on blanket").
function fmtBlanketLinesBreakdown(blanketLines) {
  const n = (blanketLines || []).length;
  const opens = (blanketLines || []).map(l => fmtNum(Math.max(0, Number(l.blanketOpenQty || 0))));
  return `${n} blanket line${n === 1 ? "" : "s"} · ${opens.join(" + ")}`;
}

// Expires clause for the drawer banner. Silent when no dates; renders
// "expires <date>" when all lines share one expiration; renders "earliest
// expires <date>" when lines differ, to signal that other authorizations
// extend past this date.
function fmtBlanketExpiresClause(blanketLines) {
  const uniq = [...new Set((blanketLines || []).map(l => l.blanketExpires).filter(Boolean))];
  if (uniq.length === 0) return "";
  const earliest = uniq.slice().sort()[0];
  const label = uniq.length === 1 ? "expires" : "earliest expires";
  return ` · ${label} <span class="mono">${esc(fmtDate(earliest))}</span>`;
}

// Find an OPEN blanket PO covering `pn`. Returns { po, line, open } for the
// blanket line with the greatest remaining blanketOpenQty (so if two blankets
// exist, the queue points at the one with more capacity). Null if none.
// Used by the queue row + draft-order tagging.
function findOpenBlanketForPart(pn) {
  if (!pn) return null;
  const target = String(pn).trim();
  let best = null;
  for (const po of (DB.pos || [])) {
    if (!isActivePO(po)) continue;
    for (const ln of (po.lines || [])) {
      if (String(ln.pn || "").trim() !== target) continue;
      if (String(ln.type || "").trim().toLowerCase() !== "blanket") continue;
      const open = Math.max(0, Number(ln.blanketOpenQty || 0));
      if (open <= 0) continue;
      if (!best || open > best.open) {
        best = { po, line: ln, open };
      }
    }
  }
  return best;
}

// ALL open blanket lines for `pn`, sorted by release-priority:
//   1. earliest-expiring first (use the blanket about to expire before one
//      with runway — standard procurement priority)
//   2. blankets with no expiration date sort LAST (undated → treat as latest)
//   3. tiebreak by largest open (release from the blanket with the most
//      capacity when expirations tie, so we clear it fastest)
// Returns an empty array if the part has no open blankets — draft cap-and-
// split calls this and treats [] as "no blanket, normal order."
//
// Multi-blanket support: cap-and-split iterates this list in order, greedily
// consuming each blanket's open qty until the requested total is filled or
// the list is exhausted (any remainder goes as a normal order line).
function findOpenBlanketsForPart(pn) {
  if (!pn) return [];
  const target = String(pn).trim();
  const out = [];
  for (const po of (DB.pos || [])) {
    if (!isActivePO(po)) continue;
    for (const ln of (po.lines || [])) {
      if (String(ln.pn || "").trim() !== target) continue;
      if (String(ln.type || "").trim().toLowerCase() !== "blanket") continue;
      const open = Math.max(0, Number(ln.blanketOpenQty || 0));
      if (open <= 0) continue;
      out.push({ po, line: ln, open, blanketExpires: ln.blanketExpires || null });
    }
  }
  out.sort((a, b) => {
    const aE = a.blanketExpires, bE = b.blanketExpires;
    if (aE && bE) {
      if (aE !== bE) return aE < bE ? -1 : 1;
    } else if (aE && !bE) return -1;
    else if (!aE && bE) return 1;
    // Tiebreak on ties in blanketExpires (equal, or both undated).
    // Releases and cap-and-split must consume the blanket DUE SOONEST —
    // the old largest-open tiebreak picked a far-future blanket over
    // the one that tripped the release window. Falls through to
    // ln.expectedDate then po.expectedDate (parseDateLocal for tz
    // safety, undated last), then finally to largest open as before.
    const aExpRaw = (a.line && a.line.expectedDate) || (a.po && a.po.expectedDate) || null;
    const bExpRaw = (b.line && b.line.expectedDate) || (b.po && b.po.expectedDate) || null;
    const aExp = aExpRaw && typeof parseDateLocal === "function" ? parseDateLocal(aExpRaw) : null;
    const bExp = bExpRaw && typeof parseDateLocal === "function" ? parseDateLocal(bExpRaw) : null;
    if (aExp && bExp) {
      const aMs = aExp.getTime(), bMs = bExp.getTime();
      if (aMs !== bMs) return aMs - bMs;
    } else if (aExp && !bExp) return -1;
    else if (!aExp && bExp) return 1;
    // Final fallback — larger open wins.
    return b.open - a.open;
  });
  return out;
}

// Find an EXHAUSTED blanket line for `pn` — a blanket-type line that matches
// the part but whose remaining open qty has burned down to zero. Used by the
// draft-order path to note "POW0001289 fully consumed — ordering normally"
// so the user can see we DIDN'T just miss the blanket linkage. Returns null
// when no blanket exists for this part at all (i.e. an ordinary non-blanket
// part). Prefers the most-recently-expired blanket when several exist.
function findExhaustedBlanketForPart(pn) {
  if (!pn) return null;
  const target = String(pn).trim();
  let best = null;
  for (const po of (DB.pos || [])) {
    if (!isActivePO(po)) continue;
    for (const ln of (po.lines || [])) {
      if (String(ln.pn || "").trim() !== target) continue;
      if (String(ln.type || "").trim().toLowerCase() !== "blanket") continue;
      const open = Math.max(0, Number(ln.blanketOpenQty || 0));
      if (open > 0) continue; // caller wants ONLY exhausted lines
      if (!best) { best = { po, line: ln, open }; continue; }
      // Prefer the LATER expiration among exhausted blankets — the one
      // most recently "used up" is the most relevant note.
      const aE = best.line.blanketExpires, bE = ln.blanketExpires;
      if (aE && bE && bE > aE) best = { po, line: ln, open };
    }
  }
  return best;
}

function posLineStatusCellHTML(po, ln) {
  // Route the pill through isLineOpen so the drawer's per-line label
  // matches the openPOQty / Follow-Ups / queue-admission view of the
  // same line. Previously used stored ln.status (sync-derived from
  // stale qtyReceived) + (qty - qtyReceived), which showed lines as
  // "OPEN / 50 open" while every downstream supply consumer correctly
  // treated them as closed via openQty=0. Now: if isLineOpen says
  // false, render as closed (Received/Cancelled based on stored status
  // for the label spelling — RECEIVED default when ambiguous).
  const closed = !isLineOpen(po, ln);
  if (closed) {
    // Prefer the specific "cancelled" label when the stored status
    // carries it; everything else that's !isLineOpen is effectively
    // received/complete from the buyer's perspective.
    const s = String(ln.status || "").toLowerCase().trim();
    const label = (s === "cancelled" || s === "canceled") ? "cancelled" : "received";
    return `<span class="pill ${lineStatusClass(label)}">${esc(label)}</span>`;
  }
  // Open line — remaining reads openQty when present (Acumatica-fresh),
  // falls back to (qty - qtyReceived) for legacy rows without openQty.
  const remaining = (ln.openQty !== undefined && ln.openQty !== null)
    ? Math.max(0, Number(ln.openQty))
    : Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
  return `<span class="pill ${lineStatusClass(ln.status)}">${esc(ln.status)}</span>${remaining > 0 ? `<div class="tiny dim mono" style="margin-top:2px">${fmtNum(remaining)} open</div>` : ""}`;
}

function patchOpenPODrawer() {
  if (OPEN_PO_ID == null) return;
  const drawerBd = $("#drawer-bd");
  if (!drawerBd || !drawerBd.classList.contains("open")) return;
  const po = DB.pos.find(p => p.id === OPEN_PO_ID);
  if (!po) return;

  const sub = $("#drawer-sub");
  if (sub) sub.innerHTML = posSubLineHTML(po);

  for (const ln of po.lines) {
    const row = $(`tr[data-line="${ln.id}"]`);
    if (!row) continue;
    const setIfNotFocused = (field, val) => {
      const inp = row.querySelector(`input[data-field="${field}"]`);
      if (!inp || document.activeElement === inp) return;
      inp.value = val;
    };
    setIfNotFocused("qty", ln.qty || 0);
    setIfNotFocused("qtyReceived", ln.qtyReceived || 0);
    setIfNotFocused("cost", ln.cost || 0);
    setIfNotFocused("expectedDate", ln.expectedDate ? isoDate(ln.expectedDate) : "");
    const statusCell = row.querySelector("[data-line-status]");
    if (statusCell) statusCell.innerHTML = posLineStatusCellHTML(po, ln);
  }
}

function posMatchesTab(po, tab) {
  // Consolidated PO-state classification — every tab derives from the
  // single poState() function in js/03-calc.js. Previously each case
  // computed its own predicate against po.status/acumStatus/expectedDate,
  // which drifted from isLineOpen: e.g., POC0004348 with 0 isLineOpen
  // lines landed in "overdue" because the tab test was `isActivePO(po)
  // && expectedDate < TODAY`, ignoring line-level truth. Now:
  //   - active/open/onhold/pending/overdue are all derived from poState.
  //   - closed = poState.closed = (header closed OR every line is done).
  //   - Overdue is INDEPENDENT of open/onhold/pending — a PO with an
  //     open line past its date lands in both "open" and "overdue".
  const s = poState(po);
  switch (tab) {
    case "active":  return s.active;
    case "open":    return s.open;
    case "onhold":  return s.onhold;
    case "pending": return s.pending;
    case "overdue": return s.overdue;
    case "closed":  return s.closed;
    case "all":     return true;
    default:        return true;
  }
}
function posUniqueHeaderValues(rows, key) {
  return [...new Set(rows.map(po => posHeaderValue(po, key)).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
}
function posApplyHeaderFilters(rows) {
  return rows.filter(po => {
    const num = String(po.num || "").toLowerCase();
    const supplier = String(po.supplier || "").toLowerCase();
    const statusLabel = poStatusLabel(po.status).toLowerCase();
    const hidden = POS_STATE.hiddenFilters || { num: [], supplier: [], status: [] };

    const textMatch =
      num.includes(POS_STATE.headerFilters.num.toLowerCase()) &&
      supplier.includes(POS_STATE.headerFilters.supplier.toLowerCase()) &&
      statusLabel.includes(POS_STATE.headerFilters.status.toLowerCase());

    const valueMatch =
      !hidden.num.includes(posHeaderValue(po, "num")) &&
      !hidden.supplier.includes(posHeaderValue(po, "supplier")) &&
      !hidden.status.includes(posHeaderValue(po, "status"));

    return textMatch && valueMatch;
  });
}

function posHeaderDropdown(key, label, rows) {
  const open = POS_STATE.openHeaderMenu === key;
  const values = posUniqueHeaderValues(rows, key);
  POS_STATE.headerOptions[key] = values;

  const hidden = POS_STATE.hiddenFilters[key] || [];
  const hiddenHere = hidden.filter(v => values.includes(v));
  const active = (POS_STATE.headerFilters[key] || hiddenHere.length) ? "active" : "";
  const allChecked = hiddenHere.length === 0;

  return `
    <th>
      <div class="excel-th">
        <span>${label}</span>
        <button class="excel-drop ${active}" onclick="event.stopPropagation(); posToggleHeaderMenu('${key}')">▾</button>

        ${open ? `
          <div class="excel-menu" onclick="event.stopPropagation()">
            <button class="excel-menu-btn" onclick="posSortHeader('${key}', 'asc')">Sort A to Z</button>
            <button class="excel-menu-btn" onclick="posSortHeader('${key}', 'desc')">Sort Z to A</button>

            <div class="excel-menu-line"></div>

            <button class="excel-menu-btn ${active ? "" : "disabled"}" onclick="posClearHeaderFilter('${key}')">
              Clear Filter from '${label}'
            </button>

            <div class="excel-menu-line"></div>

            <input
              class="excel-menu-search"
              placeholder="Search"
              oninput="posMenuSearchValues('${key}', this.value)"
            >

            <div class="excel-values">
              <label class="excel-check-row">
                <input
                  type="checkbox"
                  ${allChecked ? "checked" : ""}
                  onchange="posToggleAllHeaderValues('${key}', this.checked)"
                >
                <span>Select All</span>
              </label>

              ${values.map(v => {
                const checked = !hidden.includes(v);
                return `
                  <label class="excel-check-row" data-pos-option="${key}" data-search="${esc(String(v).toLowerCase())}">
                    <input
                      type="checkbox"
                      ${checked ? "checked" : ""}
                      onchange="posToggleHeaderValue('${key}', decodeURIComponent('${encodeURIComponent(v)}'), this.checked)"
                    >
                    <span>${esc(v)}</span>
                  </label>
                `;
              }).join("")}
            </div>

          </div>
        ` : ""}
      </div>
    </th>
  `;
}

registerRoute("pos", () => {
  let pos = DB.pos.slice();
  pos = pos.filter(p => posMatchesTab(p, POS_STATE.filter));

  if (POS_STATE.search) {
    const q = POS_STATE.search.toLowerCase();
    // Every access wraps in String(x || "") so a partial-write PO with
    // a missing num / supplier / lines / line.pn can't throw and kill
    // the whole render. Prior code assumed every PO row had a full
    // shape; a realtime UPDATE mid-write occasionally lands with
    // undefined fields and would crash the .toLowerCase() call.
    pos = pos.filter(p =>
      String(p && p.num || "").toLowerCase().includes(q) ||
      String(p && p.supplier || "").toLowerCase().includes(q) ||
      (p && Array.isArray(p.lines) ? p.lines : []).some(l =>
        String(l && l.pn || "").toLowerCase().includes(q)
      )
    );
  }

  // Render every tab+search row; the header hidden filter is applied in-place
  // via display:none so the dropdown's DOM survives checkbox clicks.
  const headerFilterRows = pos;

  // Sort — header dropdowns and the toolbar select both write into POS_STATE.
  const dir = POS_STATE.sortDir === "asc" ? 1 : -1;
  pos.sort((a, b) => {
    let cmp = 0;
    switch (POS_STATE.sortBy) {
      case "num":
        cmp = String(a.num || "").localeCompare(String(b.num || ""));
        break;
      case "supplier":
        cmp = String(a.supplier || "").localeCompare(String(b.supplier || ""));
        break;
      case "status":
        cmp = posDisplayStatus(a).label.localeCompare(posDisplayStatus(b).label);
        break;
      case "expected":
        cmp = new Date(a.expectedDate || 0) - new Date(b.expectedDate || 0);
        break;
      case "value":
        cmp = poTotalValue(a) - poTotalValue(b);
        break;
      case "date":
      default:
        cmp = poNumKey(a) - poNumKey(b);
        break;
    }
    return cmp * dir;
  });

  const counts = {
    active:  DB.pos.filter(p => posMatchesTab(p, "active")).length,
    open:    DB.pos.filter(p => posMatchesTab(p, "open")).length,
    onhold:  DB.pos.filter(p => posMatchesTab(p, "onhold")).length,
    pending: DB.pos.filter(p => posMatchesTab(p, "pending")).length,
    overdue: DB.pos.filter(p => posMatchesTab(p, "overdue")).length,
    closed:  DB.pos.filter(p => posMatchesTab(p, "closed")).length,
    all:     DB.pos.length,
  };

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Purchase Orders</div>
          <div class="page-sub mono" id="pos-count">${pos.length} SHOWING · ${DB.pos.length} TOTAL</div>
        </div>
        <div class="page-actions">
        </div>
      </div>

      <div class="panel">
        <div class="filterbar">
          <div class="search-input">
            <input class="input" id="pos-search" placeholder="Search PO #, supplier, or part…" value="${esc(POS_STATE.search)}"
              oninput="POS_STATE.search = this.value; POS_STATE._refocusSearch = true; clearTimeout(POS_STATE._searchT); POS_STATE._searchT = setTimeout(() => refresh(), 200);">
          </div>
          <div class="grow"></div>
          <span class="muted tiny">Sort:</span>
          <select class="select" onchange="if(this.value==='oldest'){POS_STATE.sortBy='date';POS_STATE.sortDir='asc';}else{POS_STATE.sortBy=this.value;POS_STATE.sortDir=(this.value==='expected'?'asc':'desc');} refresh()">
            <option value="date" ${POS_STATE.sortBy==='date' && POS_STATE.sortDir==='desc' ? 'selected' : ''}>Newest first</option>
            <option value="oldest" ${POS_STATE.sortBy==='date' && POS_STATE.sortDir==='asc' ? 'selected' : ''}>Oldest first</option>
            <option value="expected" ${POS_STATE.sortBy==='expected'?'selected':''}>Expected date</option>
            <option value="value" ${POS_STATE.sortBy==='value'?'selected':''}>Highest $</option>
          </select>
        </div>

        <div style="padding: 8px 12px; border-bottom: 1px solid var(--line-soft); display:flex; gap:4px; flex-wrap:wrap; background: var(--bg);">
          ${[
            ["active","Active",counts.active],
            ["open","Open",counts.open],
            ["onhold","On Hold",counts.onhold],
            ["pending","Pending",counts.pending],
            ["overdue","Overdue",counts.overdue],
            ["closed","Closed",counts.closed],
            ["all","All",counts.all],
          ].map(([k,l,c]) => `
            <button class="btn sm ${POS_STATE.filter===k?'primary':''}" onclick="POS_STATE.filter='${k}'; refresh()">${l} <span style="opacity:0.7;font-family:var(--f-mono)">${c}</span></button>
          `).join("")}
        </div>

        <div class="panel-body flush">
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              ${posHeaderDropdown("num", "PO #", headerFilterRows)}
              ${posHeaderDropdown("supplier", "Supplier", headerFilterRows)}
              ${posHeaderDropdown("status", "Status", headerFilterRows)}
              <th>Buyer</th>
              <th class="right">Lines</th>
              <th class="right">Qty</th>
              <th class="right">Value</th>
              <th>Created</th>
              <th>Expected</th>
              <th></th>
            </tr></thead>
            <tbody>
              <tr id="pos-empty-row" style="display:none"><td colspan="10" class="muted center" style="padding:28px">
                No POs match the current filters. Adjust the column dropdowns or tabs above.
              </td></tr>
              ${pos.map(po => {
              try {
                // Every field access below fans out from `po`, so a
                // realtime write that lands mid-flight with a missing
                // field (`lines`, `num`, `supplier`, blanket linkage
                // on old-shape rows) can throw and kill the whole
                // `.map()` — the entire table would go blank. Wrap
                // each row so a bad PO logs, renders an error stub,
                // and every other PO still renders.
                const lines = Array.isArray(po && po.lines) ? po.lines : [];
                const open = lines.filter(l => isLineOpen(po, l));
                const totalQty = lines.reduce((s,l) => s + (l && l.qty || 0), 0);
                const bm = poBlanketMeta(po);
                // Time-badge helper handles the blanket-vs-normal split:
                // blankets never show OVERDUE (they're authorizations, not
                // scheduled deliveries) and instead flag EXPIRED when their
                // authorization window has closed. isOverdue is only true
                // for actual overdue Normal/Release POs, so the expected-
                // date column's crit-red styling won't fire on blankets.
                const timeBadge = poTimeBadge(po);
                let blanketIndicatorHTML = "";
                if (bm.kind === "blanket") {
                  // Per-line breakdown so the row can't hide any specific
                  // line's remaining coverage. Same shape as the drawer strip.
                  blanketIndicatorHTML = ` <span class="pill info" style="margin-left:4px" title="Blanket order">BLANKET</span>` +
                    ` <span class="mono dim tiny" style="margin-left:4px">${esc(fmtBlanketLinesBreakdown(bm.blanketLines))} open</span>`;
                } else if (bm.kind === "release") {
                  blanketIndicatorHTML = ` <span class="pill muted" style="margin-left:4px" title="Release against blanket ${esc(bm.parentBlanketNum)}">RELEASE</span>` +
                    ` <span class="mono dim tiny" style="margin-left:4px">↳ ${esc(bm.parentBlanketNum)}</span>`;
                }
                return `
                <tr class="clickable" data-pos-row data-po-num="${esc(posHeaderValue(po, "num"))}" data-po-supplier="${esc(posHeaderValue(po, "supplier"))}" data-po-status="${esc(posHeaderValue(po, "status"))}" onclick="openPODetail('${esc(po.id)}')">
                  <td class="pn">${esc(po.num)}</td>
                  <td>${esc(po.supplier)}</td>
                  <td>${(() => { const ds = posDisplayStatus(po); return `<span class="pill ${ds.cls}">${esc(ds.label)}</span>`; })()} ${timeBadge.html ? `<span style="margin-left:4px">${timeBadge.html}</span>` : ""}${blanketIndicatorHTML}</td>
                  <td class="dim">${esc(displayBuyer(po) || "—")}</td>
                  <td class="right num">${po.lines.length}${open.length !== po.lines.length ? ` <span class="dim">/ ${open.length} open</span>` : ''}</td>
                  <td class="right num">${fmtNum(totalQty)}</td>
                  <td class="right num">${fmtMoney(poTotalValue(po))}</td>
                  <td class="dim num">${fmtDate(po.createdDate)}</td>
                  <td class="num ${timeBadge.isOverdue ? 'text-crit bold' : 'dim'}">${fmtDate(po.expectedDate)}</td>
                  <td><button class="btn sm" onclick="event.stopPropagation(); openPODetail('${esc(po.id)}')">Open</button></td>
                </tr>`;
              } catch (e) {
                console.error("[pos-render] row failed", {
                  poId: po && po.id,
                  poNum: po && po.num,
                  error: (e && e.message) || e,
                });
                // Render a compact error stub so the row is visible in the
                // table with its PO # / id (whichever survived) — the user
                // can spot which PO is bad and open the drawer to inspect.
                // The rest of the table keeps rendering normally.
                const label = String((po && (po.num || po.id)) || "?");
                return `
                  <tr data-pos-row style="opacity:0.75">
                    <td class="pn">${esc(label)}</td>
                    <td colspan="9" class="muted">
                      <span class="pill crit" style="margin-right:8px">RENDER ERROR</span>
                      This PO row failed to render — see console for details.
                    </td>
                  </tr>`;
              }
              }).join("")}
            </tbody>
          </table></div>
        </div>
      </div>
    </div>`;

  posReapplyHeaderFiltersInPlace();
  posInstallOutsideClick();

  // Live search debounces the refresh; after we re-render, put the cursor
  // back where the user was typing.
  if (POS_STATE._refocusSearch) {
    POS_STATE._refocusSearch = false;
    setTimeout(() => {
      const inp = $("#pos-search");
      if (inp) {
        inp.focus();
        const len = inp.value.length;
        inp.setSelectionRange(len, len);
      }
    }, 0);
  }
});

// Numeric portion of a PO number — used as the "newest first" sort key
// because Acumatica assigns PO #s sequentially, which is more reliable than
// the imported createdDate field (the snapshot has a few future-dated typos).
// New app-created POs (e.g. PO-47120) also sort cleanly above older imports.
function poNumKey(po) {
  const groups = String(po.num || "").match(/\d+/g);
  if (!groups || !groups.length) return -Infinity;
  return parseInt(groups[groups.length - 1], 10);
}

function poTotalValue(po) {
  return po.lines.reduce((s, l) => {
    if (l.status === "cancelled") return s;
    return s + (l.qty || 0) * (l.cost || 0);
  }, 0);
}
function poRemainingValue(po) {
  return (po.lines || []).reduce((s, l) => {
    if (!isLineOpen(po, l)) return s;
    const rem = Math.max(0, (l.qty||0) - (l.qtyReceived||0));
    return s + rem * (l.cost || 0);
  }, 0);
}

/* ============================================================
   PO DETAIL DRAWER — full edit, line ops, receive, submit
   ============================================================ */
function openPODetail(poId) {
  const po = DB.pos.find(p => p.id === poId);
  if (!po) return;
  renderPODetail(po);
}

function renderPODetail(po) {
  OPEN_PO_ID = po.id;
  const editable = po.status === "draft" || po.status === "submitted" || po.status === "in_transit";
  const linesHTML = po.lines.map(ln => renderPOLineRow(po, ln, editable)).join("");
  const totalQty = po.lines.reduce((s,l) => s + (l.qty||0), 0);
  const recvQty = po.lines.reduce((s,l) => s + (l.qtyReceived||0), 0);
  const totalVal = poTotalValue(po);

  const bm = poBlanketMeta(po);
  let blanketStripHTML = "";
  if (bm.kind === "blanket") {
    // Per-line breakdown — never collapse to a single pooled figure. For
    // POW0001289 (18397=40, 18420=60, 19931=150) this renders
    // "3 blanket lines · 40 + 60 + 150 open". Expiration clause names it
    // "earliest expires" when lines have different expirations so the
    // remaining runway isn't misrepresented as the earliest one.
    blanketStripHTML = `
      <div style="margin:0 0 14px; padding:10px 12px; background:var(--accent-soft); border-left:3px solid var(--accent-d); border-radius:3px; font-size:12px; color:var(--t1);">
        <span class="pill info" style="margin-right:8px">BLANKET</span>
        <span>Blanket order · <strong class="mono">${esc(fmtBlanketLinesBreakdown(bm.blanketLines))}</strong> open${fmtBlanketExpiresClause(bm.blanketLines)}</span>
      </div>`;
  } else if (bm.kind === "release") {
    // Try to resolve the parent blanket so we can inline its remaining. Match
    // by po.num — the same key the release line carries in blanketPoNum.
    const parent = (DB.pos || []).find(p => String(p.num || "").trim() === bm.parentBlanketNum);
    let parentTail = "";
    if (parent) {
      const parentMeta = poBlanketMeta(parent);
      if (parentMeta.kind === "blanket") {
        // Enumerate parent's blanket lines rather than first-line-only.
        parentTail = ` <span class="dim">(<span class="mono">${esc(fmtBlanketLinesBreakdown(parentMeta.blanketLines))}</span> left on blanket)</span>`;
      }
    }
    const linkAttrs = parent
      ? `onclick="openPODetail('${esc(parent.id)}')" style="cursor:pointer;color:var(--accent-d);text-decoration:underline"`
      : `style="color:var(--t2)"`;
    blanketStripHTML = `
      <div style="margin:0 0 14px; padding:10px 12px; background:var(--info-soft); border-left:3px solid var(--info); border-radius:3px; font-size:12px; color:var(--t1);">
        <span class="pill muted" style="margin-right:8px">RELEASE</span>
        <span>Release against blanket <span class="mono" ${linkAttrs}>↳ ${esc(bm.parentBlanketNum)}</span>${parentTail}</span>
      </div>`;
  }

  const html = `
    <div class="drawer-head">
      <div class="title-block">
        <div class="pre">PURCHASE ORDER</div>
        <div class="title">${esc(po.num)}</div>
        <div class="sub" id="drawer-sub">${posSubLineHTML(po)}</div>
      </div>
      <button class="drawer-x" data-close>×</button>
    </div>
    <div class="drawer-body">
      ${blanketStripHTML}
      <div class="stat-strip">
        <div class="stat"><div class="stat-label">Lines</div><div class="stat-value">${po.lines.length}</div></div>
        <div class="stat"><div class="stat-label">Qty Ordered</div><div class="stat-value">${fmtNum(totalQty)}</div></div>
        <div class="stat"><div class="stat-label">Qty Received</div><div class="stat-value ${recvQty===totalQty?'ok':(recvQty>0?'warn':'')}">${fmtNum(recvQty)}</div></div>
        <div class="stat"><div class="stat-label">Total Value</div><div class="stat-value">${fmtMoney(totalVal)}</div></div>
      </div>

      <div class="dr-section">Header</div>
      <div class="grid-2">
        <div class="field"><label>Status</label>
          <select class="select" id="po-status">
            <option value="draft" ${po.status==="draft"?"selected":""}>Draft</option>
            <option value="submitted" ${po.status==="submitted"?"selected":""}>Submitted</option>
            <option value="in_transit" ${po.status==="in_transit"?"selected":""}>In Transit</option>
            <option value="received" ${po.status==="received"?"selected":""}>Received</option>
            <option value="closed" ${po.status==="closed"?"selected":""}>Closed</option>
            <option value="cancelled" ${po.status==="cancelled"?"selected":""}>Cancelled</option>
          </select>
        </div>
        <div class="field"><label>Buyer</label>
          ${po.source === "acumatica"
            ? `<div class="dim" style="padding:8px 0">${esc(po.createdBy || "")}</div>`
            : `<input class="input" id="po-buyer" value="${esc(po.buyer||"")}">`}
        </div>
        <div class="field"><label>Supplier</label>
          <input class="input" id="po-supplier" value="${esc(po.supplier||"")}">
        </div>
        ${bm.kind === "blanket" ? (() => {
          // Blanket POs: swap the "Expected Delivery" input for a read-only
          // "Expires On" showing ln.blanketExpires. The blanket's expiration
          // is sourced from Acumatica, not editable in the planner. po.expectedDate
          // on a blanket header is the created date (wrong to show), so we
          // omit the editable input entirely — savePOHeader guards against
          // the missing #po-expected.
          const bExp = bm.blanketLine && bm.blanketLine.blanketExpires;
          return `<div class="field"><label>Expires On</label>
            <div class="dim" style="padding:8px 0">${bExp ? esc(fmtDate(bExp)) : "—"}</div>
          </div>`;
        })() : `<div class="field"><label>Expected Delivery</label>
          <input class="input" type="date" id="po-expected" value="${po.expectedDate ? isoDate(po.expectedDate) : ""}">
        </div>`}
        <div class="field"><label>Created</label>
          <input class="input" type="date" id="po-created" value="${po.createdDate ? isoDate(po.createdDate) : ""}">
        </div>
        <div class="field"><label>Submitted</label>
          <input class="input" type="date" id="po-submitted" value="${po.submittedDate ? isoDate(po.submittedDate) : ""}">
        </div>
      </div>

      <div class="field" style="margin-top:12px"><label>Notes</label>
        <textarea class="textarea" id="po-notes">${esc(po.notes||"")}</textarea>
      </div>

      <div class="dr-section" style="display:flex; align-items:center; gap:8px;">
        <span>Lines</span>
        <div style="margin-left:auto"></div>
        <button class="btn sm" onclick="addPOLine('${esc(po.id)}')">+ Add line</button>
      </div>

      ${po.lines.length === 0 ? `
        <div class="empty"><div class="empty-msg">No lines yet. Click + Add line.</div></div>
      ` : `
        <div class="tbl-wrap"><table class="lines-tbl">
          <thead><tr>
            <th>Part</th>
            <th class="right">Qty</th>
            <th class="right">Recv</th>
            <th class="right">Cost</th>
            <th>Expected</th>
            <th>Status</th>
            <th></th>
          </tr></thead>
          <tbody>
            ${linesHTML}
          </tbody>
        </table></div>
      `}

      <div class="dr-section">PO Actions</div>
      <div class="row gap-md flex-wrap">
        ${po.status === "draft" ? `<button class="btn primary" onclick="submitPO('${esc(po.id)}')">▶ Submit PO</button>` : ""}
        ${poState(po).active ? `<button class="btn primary" onclick="receiveAllPO('${esc(po.id)}')">↓ Receive all open</button>` : ""}
        <button class="btn" onclick="duplicatePO('${esc(po.id)}')">⧉ Duplicate</button>
        <button class="btn" onclick="exportPOAsCSV('${esc(po.id)}')">⇩ Export CSV</button>
        <button class="btn danger" onclick="confirmDeletePO('${esc(po.id)}')">Delete PO</button>
      </div>
    </div>
    <div class="drawer-foot">
      <button class="btn ghost" data-close>Close</button>
      <button class="btn primary" onclick="savePOHeader('${esc(po.id)}')">Save changes</button>
    </div>`;
  openDrawer(html, { wide: true });
}

function renderPOLineRow(po, ln, editable) {
  const part = DB.parts.find(p => p.pn === ln.pn);
  return `
    <tr data-line="${esc(ln.id)}">
      <td>
        <div class="pn">${esc(ln.pn)}</div>
        <div class="dim tiny">${esc(part?.desc || "—")}</div>
      </td>
      <td class="right" style="width:90px">
        <input class="input num" type="number" data-field="qty" value="${ln.qty||0}" min="0" oninput="updatePOLine('${esc(po.id)}','${esc(ln.id)}','qty',this.value)">
      </td>
      <td class="right" style="width:90px">
        <input class="input num" type="number" data-field="qtyReceived" value="${ln.qtyReceived||0}" min="0" oninput="updatePOLine('${esc(po.id)}','${esc(ln.id)}','qtyReceived',this.value)">
      </td>
      <td class="right" style="width:100px">
        <input class="input num" type="number" step="0.01" data-field="cost" value="${ln.cost||0}" min="0" oninput="updatePOLine('${esc(po.id)}','${esc(ln.id)}','cost',this.value)">
      </td>
      <td style="width:140px">
        <input class="input" type="date" data-field="expectedDate" value="${ln.expectedDate ? isoDate(ln.expectedDate) : ''}" oninput="updatePOLine('${esc(po.id)}','${esc(ln.id)}','expectedDate',this.value)">
      </td>
      <td data-line-status>${posLineStatusCellHTML(po, ln)}</td>
      <td>
        <button class="btn sm" onclick="receiveLine('${esc(po.id)}','${esc(ln.id)}')">Receive</button>
        <button class="btn sm ghost" onclick="removePOLine('${esc(po.id)}','${esc(ln.id)}')">×</button>
      </td>
    </tr>
  `;
}

function lineStatusClass(s) {
  return ({
    "open": "info",
    "partial": "warn",
    "received": "ok",
    "cancelled": "muted",
  })[s] || "muted";
}

function updatePOLine(poId, lineId, field, value) {
  const po = DB.pos.find(p => p.id === poId); if (!po) return;
  const ln = po.lines.find(l => l.id === lineId); if (!ln) return;
  const before = ln[field];
  if (field === "qty" || field === "qtyReceived" || field === "cost") {
    value = parseFloat(value) || 0;
  }
  if (field === "expectedDate") {
    value = value ? new Date(value).toISOString() : null;
  }
  ln[field] = value;
  // Auto-update line status
  const recv = ln.qtyReceived || 0;
  const ord = ln.qty || 0;
  if (recv === 0 && ln.status !== "cancelled") ln.status = "open";
  else if (recv > 0 && recv < ord) ln.status = "partial";
  else if (recv >= ord && ord > 0) ln.status = "received";
  // No need to log on every keystroke — only major changes
  saveDB();
  bumpStatusCache();
  // Don't full re-render; debounce instead
}

function addPOLine(poId) {
  const po = DB.pos.find(p => p.id === poId); if (!po) return;
  // Prompt: show modal with part picker
  showPartPickerModal({
    title: "Add line to " + po.num,
    onSelect: (pn) => {
      const part = DB.parts.find(p => p.pn === pn);
      if (!part) return;
      const sq = suggestedQty({...part, onPO: openPOQty(pn), daily: part.daily});
      const newLine = {
        id: uid("ln"),
        pn,
        qty: sq || part.moq || 1,
        qtyReceived: 0,
        cost: part.cost || 0,
        expectedDate: po.expectedDate || addDays(TODAY, leadTimeDays(part)).toISOString(),
        status: "open",
        notes: "",
      };
      po.lines.push(newLine);
      logAudit("po-edit", `Added line ${pn} × ${newLine.qty} to ${po.num}`, { poId: po.id, pn });
      saveDB(); bumpStatusCache(); closeModal();
      renderPODetail(po);
      showToast(`${pn} added`, "ok");
    }
  });
}

function removePOLine(poId, lineId) {
  if (!gateDelete()) return;
  const po = DB.pos.find(p => p.id === poId); if (!po) return;
  const ln = po.lines.find(l => l.id === lineId); if (!ln) return;
  if (!confirm(`Remove line ${ln.pn} from ${po.num}?`)) return;
  po.lines = po.lines.filter(l => l.id !== lineId);
  logAudit("po-edit", `Removed line ${ln.pn} from ${po.num}`, { poId: po.id });
  saveDB(); bumpStatusCache();
  renderPODetail(po);
  showToast("Line removed", "warn");
}

function receiveLine(poId, lineId) {
  const po = DB.pos.find(p => p.id === poId); if (!po) return;
  const ln = po.lines.find(l => l.id === lineId); if (!ln) return;
  const part = DB.parts.find(p => p.pn === ln.pn);
  const remaining = Math.max(0, (ln.qty||0) - (ln.qtyReceived||0));
  
  openModal(`
    <div class="modal-head">
      <div style="font-size: 11px; color: var(--t3); text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600">Receive Line</div>
      <div style="font-family: var(--f-mono); font-size: 18px; font-weight: 500; margin-top: 4px;">${esc(ln.pn)}</div>
      <div class="muted tiny" style="margin-top:4px">${esc(part?.desc||"—")} · ${esc(po.num)}</div>
    </div>
    <div class="modal-body">
      <div class="stat-strip">
        <div class="stat"><div class="stat-label">Ordered</div><div class="stat-value">${fmtNum(ln.qty||0)}</div></div>
        <div class="stat"><div class="stat-label">Already Received</div><div class="stat-value">${fmtNum(ln.qtyReceived||0)}</div></div>
        <div class="stat"><div class="stat-label">Open</div><div class="stat-value warn">${fmtNum(remaining)}</div></div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label>Receiving qty</label>
          <input class="input num lg" type="number" id="recv-qty" value="${remaining}" min="0">
        </div>
        <div class="field">
          <label>Receipt date</label>
          <input class="input lg" type="date" id="recv-date" value="${isoDate(TODAY)}">
        </div>
      </div>
      <div class="field" style="margin-top:12px">
        <label>Note (optional)</label>
        <input class="input" id="recv-note" placeholder="e.g., Short ship — backorder remaining">
      </div>
      <div class="muted tiny" style="margin-top:8px">↑ Receiving will increase the on-hand for this part by the received qty.</div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" onclick="confirmReceive('${esc(po.id)}','${esc(ln.id)}')">↓ Confirm receive</button>
    </div>
  `);
}

function confirmReceive(poId, lineId) {
  const po = DB.pos.find(p => p.id === poId); if (!po) return;
  const ln = po.lines.find(l => l.id === lineId); if (!ln) return;
  const recvQty = parseFloat($("#recv-qty").value) || 0;
  const recvDate = $("#recv-date").value;
  const note = $("#recv-note").value.trim();
  if (recvQty <= 0) { showToast("Enter a quantity > 0", "warn"); return; }
  // Update line
  ln.qtyReceived = (ln.qtyReceived || 0) + recvQty;
  if (ln.qtyReceived >= ln.qty) ln.status = "received";
  else ln.status = "partial";
  // Increase on-hand
  const part = DB.parts.find(p => p.pn === ln.pn);
  if (part) part.onHand = (part.onHand || 0) + recvQty;
  // PO-level: if all lines received, mark PO received
  const allRecv = po.lines.every(l => l.status === "received" || l.status === "cancelled");
  if (allRecv) {
    po.status = "received";
    po.receivedDate = new Date(recvDate).toISOString();
  } else if (po.status === "submitted" || po.status === "draft") {
    po.status = "in_transit";
  }
  logAudit("po-recv", `Received ${ln.pn} × ${recvQty} on ${po.num}${note ? ' — '+note : ''}`, { poId: po.id, pn: ln.pn, qty: recvQty });
  saveDB(); bumpStatusCache();
  closeModal();
  renderPODetail(po);
  showToast(`Received ${fmtNum(recvQty)} of ${ln.pn}. On-hand updated.`, "ok", "Receipt logged");
}

function receiveAllPO(poId) {
  const po = DB.pos.find(p => p.id === poId); if (!po) return;
  // Route through isLineOpen so lines already closed per Acumatica's
  // Open Qty (post-ad85c2f) aren't re-received. Reading the stored
  // ln.status here would include stale-open lines whose openQty is 0 —
  // batch-receiving them would double-credit on-hand and inflate
  // qtyReceived past qty. isLineOpen agrees with the drawer's per-line
  // label and every supply consumer.
  const open = po.lines.filter(l => isLineOpen(po, l));
  if (!open.length) return;
  if (!confirm(`Receive all ${open.length} open line(s) on ${po.num}? This will increase on-hand.`)) return;
  for (const ln of open) {
    // Remaining: prefer Acumatica's openQty when present, fall back to
    // (qty - qtyReceived) for legacy rows without openQty.
    const remaining = (ln.openQty !== undefined && ln.openQty !== null)
      ? Math.max(0, Number(ln.openQty))
      : Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
    if (remaining > 0) {
      ln.qtyReceived = (ln.qtyReceived || 0) + remaining;
      ln.openQty = 0;
      ln.status = "received";
      const part = DB.parts.find(p => p.pn === ln.pn);
      if (part) part.onHand = (part.onHand || 0) + remaining;
      logAudit("po-recv", `Received ${ln.pn} × ${remaining} on ${po.num}`, { poId: po.id, pn: ln.pn, qty: remaining });
    }
  }
  po.status = "received";
  po.receivedDate = new Date().toISOString();
  saveDB(); bumpStatusCache();
  renderPODetail(po);
  showToast(`All lines received on ${po.num}.`, "ok", "PO complete");
}

function submitPO(poId) {
  const po = DB.pos.find(p => p.id === poId); if (!po) return;
  if (!po.lines.length) { showToast("Add at least one line first", "warn"); return; }
  po.status = "submitted";
  po.submittedDate = new Date().toISOString();
  logAudit("po-edit", `Submitted ${po.num} to ${po.supplier} · ${po.lines.length} lines · ${fmtMoney(poTotalValue(po))}`, { poId: po.id });
  saveDB(); bumpStatusCache();
  renderPODetail(po);
  showToast(`${po.num} submitted to ${po.supplier}`, "ok", "PO submitted");
}

function duplicatePO(poId) {
  const src = DB.pos.find(p => p.id === poId); if (!src) return;
  const newPO = JSON.parse(JSON.stringify(src));
  newPO.id = uid("po");
  newPO.num = nextPONumber();
  newPO.status = "draft";
  newPO.createdDate = new Date().toISOString();
  newPO.submittedDate = null;
  newPO.receivedDate = null;
  newPO.lines.forEach(l => { l.id = uid("ln"); l.qtyReceived = 0; l.status = "open"; });
  DB.pos.unshift(newPO);
  logAudit("po-add", `Duplicated ${src.num} → ${newPO.num}`, { poId: newPO.id });
  saveDB();
  showToast(`Duplicated as ${newPO.num}`, "ok");
  renderPODetail(newPO);
}

function confirmDeletePO(poId) {
  if (!gateDelete()) return;
  const po = DB.pos.find(p => p.id === poId); if (!po) return;
  if (!confirm(`Delete ${po.num}? This cannot be undone.`)) return;
  DB.pos = DB.pos.filter(p => p.id !== poId);
  logAudit("po-edit", `Deleted ${po.num}`, { poId });
  saveDB(); bumpStatusCache();
  closeDrawer();
  refresh();
  showToast(`${po.num} deleted`, "warn");
}

function savePOHeader(poId) {
  const po = DB.pos.find(p => p.id === poId); if (!po) return;
  const newStatus = $("#po-status").value;
  const buyerInput = $("#po-buyer");
  const newBuyer = buyerInput ? buyerInput.value.trim() : null;
  const newSupplier = $("#po-supplier").value.trim();
  // Blanket POs render "Expires On" (read-only, sourced from ln.blanketExpires)
  // in place of the editable "Expected Delivery" input, so #po-expected is
  // absent. Fall back to the current expectedDate ISO so the field passes
  // through unchanged rather than throwing on null.value.
  const expectedInput = $("#po-expected");
  const newExpected = expectedInput ? expectedInput.value : (po.expectedDate ? isoDate(po.expectedDate) : "");
  const newCreated = $("#po-created").value;
  const newSubmitted = $("#po-submitted").value;
  const newNotes = $("#po-notes").value.trim();

  let changes = [];
  if (po.status !== newStatus) changes.push(`status: ${po.status} → ${newStatus}`);
  if (buyerInput && po.buyer !== newBuyer) changes.push(`buyer`);
  if (po.supplier !== newSupplier) changes.push(`supplier`);
  if (expectedInput && isoDate(po.expectedDate||0) !== newExpected) changes.push(`expected`);

  po.status = newStatus;
  if (buyerInput) po.buyer = newBuyer;
  po.supplier = newSupplier;
  po.expectedDate = newExpected ? new Date(newExpected).toISOString() : null;
  po.createdDate = newCreated ? new Date(newCreated).toISOString() : po.createdDate;
  po.submittedDate = newSubmitted ? new Date(newSubmitted).toISOString() : po.submittedDate;
  po.notes = newNotes;

  if (changes.length) logAudit("po-edit", `${po.num} updated: ${changes.join(", ")}`, { poId: po.id });
  saveDB(); bumpStatusCache();
  closeDrawer();
  refresh();
  showToast(`${po.num} saved`, "ok");
}

function exportPOAsCSV(poId) {
  const po = DB.pos.find(p => p.id === poId); if (!po) return;
  const rows = [
    ["PO Number", po.num],
    ["Supplier", po.supplier],
    ["Status", po.status],
    ["Buyer", displayBuyer(po)],
    ["Created", isoDate(po.createdDate || "")],
    ["Expected", isoDate(po.expectedDate || "")],
    [],
    ["Part","Description","Qty","Received","Cost","Line Total","Expected","Status"],
    ...po.lines.map(l => {
      const part = DB.parts.find(p => p.pn === l.pn);
      return [l.pn, part?.desc||"", l.qty||0, l.qtyReceived||0, l.cost||0, (l.qty||0)*(l.cost||0), isoDate(l.expectedDate||""), l.status];
    }),
    [],
    ["TOTAL","","","",`${fmtMoney(poTotalValue(po))}`],
  ];
  downloadCSV(rows, `${po.num}.csv`);
  showToast(`${po.num}.csv downloaded`, "ok");
}

function downloadCSV(rows, filename) {
  const csv = rows.map(r => r.map(cell => {
    const s = String(cell ?? "");
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
    return s;
  }).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}

function showPartPickerModal({ title, onSelect }) {
  let q = "";
  // Stash the callback on window so the inline onclick can reach it with its
  // closure intact — stringifying the function would lose `po` and friends.
  window._partPickerSelect = (pn) => onSelect(pn);
  function render() {
    const parts = DB.parts.filter(p =>
      !q || p.pn.toLowerCase().includes(q.toLowerCase()) || (p.desc||"").toLowerCase().includes(q.toLowerCase())
    ).slice(0, 50);
    openModal(`
      <div class="modal-head">
        <div style="font-size: 13px; font-weight: 600; margin-bottom:6px;">${esc(title)}</div>
        <input class="input" id="pp-search" placeholder="Type part # or description…" autofocus value="${esc(q)}">
      </div>
      <div class="modal-body" style="padding: 0;">
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Part</th><th>Description</th><th>Supplier</th><th class="right">On Hand</th><th class="right">Cost</th></tr></thead>
            <tbody>
              ${parts.length === 0 ? '<tr><td colspan="5" class="muted center" style="padding:20px">No matches</td></tr>' : parts.map(p => `
                <tr class="clickable" onclick="window._partPickerSelect('${esc(p.pn)}')">
                  <td class="pn">${esc(p.pn)}</td>
                  <td>${esc(p.desc)}</td>
                  <td class="dim">${esc(p.supplier)}</td>
                  <td class="right num">${fmtNum(p.onHand)}</td>
                  <td class="right num">${fmtMoneyDec(p.cost)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div class="modal-foot"><button class="btn" data-close>Cancel</button></div>
    `);
    setTimeout(() => {
      const inp = $("#pp-search");
      if (inp) inp.oninput = (e) => { q = e.target.value; render(); };
    }, 50);
  }
  render();
}

