/* =====================================================
   07-page-orders.js
   Sections: PAGE: ORDER QUEUE — the daily work surface
   ===================================================== */

/* ============================================================
   PAGE: ORDER QUEUE — the daily work surface
   ============================================================ */
let OQ_STATE = {
  filter: "all",        // all | critical | warning
  supplier: "",
  buyer: "",
  search: "",
  sortBy: "urgency",    // urgency | pn | supplier | qty | value | desc | lead
  sortDir: "asc",

  // Days Cover column-header filter. Single-select; stacks with the toolbar
  // urgency filter and the supplier / buyer / search filters via AND.
  // Values: all | critical | critWarn | under30 | under60
  coverFilter: "all",

 headerFilters: {
    pn: "",
    desc: "",
    supplier: "",
    lead: "",
  },

  hiddenFilters: {
    pn: [],
    desc: [],
    supplier: [],
    lead: [],
  },

  headerOptions: {},
  openHeaderMenu: "",
};

function oqToggleHeaderMenu(key) {
  OQ_STATE.openHeaderMenu = OQ_STATE.openHeaderMenu === key ? "" : key;
  refresh();
}

function oqSetHeaderFilter(key, value) {
  OQ_STATE.headerFilters[key] = String(value || "").trim();
  OQ_STATE.openHeaderMenu = "";
  refresh();
}

function oqClearHeaderFilter(key) {
  OQ_STATE.headerFilters[key] = "";
  OQ_STATE.hiddenFilters[key] = [];
  OQ_STATE.openHeaderMenu = "";
  refresh();
}

// Days Cover dropdown selection. Single-select; "all" clears.
function oqSetCoverFilter(value) {
  OQ_STATE.coverFilter = String(value || "all");
  OQ_STATE.openHeaderMenu = "";
  refresh();
}

// Days Cover header dropdown. Same visual shell as oqHeaderDropdown
// (.excel-th / .excel-menu / .excel-check-row) so the row of column headers
// reads consistently, but the body is a radio group over fixed options
// rather than a search + value-list — matching the spec's filter semantics.
// "Critical only" / "Critical + Warning" rely on p.status, which already
// reflects supplier-mute overrides (isSupplierMuted forces status to "ok"),
// so muted parts never show as critical here — same as the row coloring.
function oqCoverDropdown() {
  const open = OQ_STATE.openHeaderMenu === "cover";
  const active = OQ_STATE.coverFilter && OQ_STATE.coverFilter !== "all" ? "active" : "";
  const options = [
    { key: "all",      label: "All" },
    { key: "critical", label: "Critical only" },
    { key: "critWarn", label: "Critical + Warning" },
    { key: "under30",  label: "Under 30 days" },
    { key: "under60",  label: "Under 60 days" },
  ];
  return `
    <th class="right">
      <div class="excel-th">
        <span>Days Cover</span>
        <button class="excel-drop ${active}" onclick="event.stopPropagation(); oqToggleHeaderMenu('cover')">▾</button>
        ${open ? `
          <div class="excel-menu" onclick="event.stopPropagation()">
            <button class="excel-menu-btn" onclick="oqSortHeader('urgency', 'asc')">Sort most urgent first</button>
            <button class="excel-menu-btn" onclick="oqSortHeader('urgency', 'desc')">Sort least urgent first</button>

            <div class="excel-menu-line"></div>

            <button class="excel-menu-btn ${active ? '' : 'disabled'}" onclick="oqSetCoverFilter('all')">
              Clear Filter from 'Days Cover'
            </button>

            <div class="excel-menu-line"></div>

            <div class="excel-values">
              ${options.map(o => `
                <label class="excel-check-row">
                  <input
                    type="radio"
                    name="oq-cover-filter"
                    ${OQ_STATE.coverFilter === o.key ? 'checked' : ''}
                    onchange="oqSetCoverFilter('${o.key}')"
                  >
                  <span>${esc(o.label)}</span>
                </label>
              `).join("")}
            </div>
          </div>
        ` : ""}
      </div>
    </th>
  `;
}

function oqToggleHeaderValue(key, value, checked) {
  let hidden = OQ_STATE.hiddenFilters[key] || [];

  if (checked) {
    hidden = hidden.filter(v => v !== value);
  } else {
    if (!hidden.includes(value)) hidden.push(value);
  }

  OQ_STATE.hiddenFilters[key] = hidden;
  oqReapplyHeaderFiltersInPlace();
}

function oqToggleAllHeaderValues(key, checked) {
  const values = OQ_STATE.headerOptions[key] || [];
  OQ_STATE.hiddenFilters[key] = checked ? [] : [...values];
  document.querySelectorAll(`[data-excel-option="${key}"] input[type="checkbox"]`).forEach(cb => { cb.checked = checked; });
  oqReapplyHeaderFiltersInPlace();
}

function oqReapplyHeaderFiltersInPlace() {
  const hidden = OQ_STATE.hiddenFilters || { pn: [], desc: [], supplier: [], lead: [] };
  const text = OQ_STATE.headerFilters || { pn: "", desc: "", supplier: "", lead: "" };
  const tpn = String(text.pn || "").toLowerCase();
  const td  = String(text.desc || "").toLowerCase();
  const ts  = String(text.supplier || "").toLowerCase();
  const rows = document.querySelectorAll('[data-oq-row]');
  let visibleCount = 0;
  const visiblePns = [];
  rows.forEach(row => {
    const pn = row.dataset.oqPn || "";
    const desc = row.dataset.oqDesc || "";
    const supplier = row.dataset.oqSupplier || "";
    const leadVal = row.dataset.oqLead || "";
    const leadDays = Number(row.dataset.oqLeadDays || 0);
    const textMatch =
      pn.toLowerCase().includes(tpn) &&
      desc.toLowerCase().includes(td) &&
      supplier.toLowerCase().includes(ts) &&
      oqLeadMatches(leadDays, text.lead);
    const valueMatch =
      !hidden.pn.includes(pn) &&
      !hidden.desc.includes(desc) &&
      !hidden.supplier.includes(supplier) &&
      !hidden.lead.includes(leadVal);
    const visible = textMatch && valueMatch;
    row.style.display = visible ? "" : "none";
    if (visible) { visibleCount++; visiblePns.push(row.dataset.oqRowPn || pn); }
  });
  OQ_STATE._lastFiltered = visiblePns;
  const empty = document.querySelector('#oq-empty-row');
  if (empty) empty.style.display = visibleCount > 0 ? "none" : "";
}

function oqInstallOutsideClick() {
  if (!OQ_STATE.openHeaderMenu) {
    if (OQ_STATE._outsideClick) {
      document.removeEventListener("click", OQ_STATE._outsideClick);
      OQ_STATE._outsideClick = null;
    }
    return;
  }
  if (OQ_STATE._outsideClick) return;
  const handler = () => {
    document.removeEventListener("click", handler);
    OQ_STATE._outsideClick = null;
    OQ_STATE.openHeaderMenu = "";
    refresh();
  };
  OQ_STATE._outsideClick = handler;
  setTimeout(() => document.addEventListener("click", handler), 0);
}

function oqMenuSearchValues(key, term) {
  const q = String(term || "").toLowerCase();

  document.querySelectorAll(`[data-excel-option="${key}"]`).forEach(row => {
    const value = row.dataset.search || "";
    row.style.display = value.includes(q) ? "flex" : "none";
  });
}

function oqSortHeader(key, dir) {
  OQ_STATE.sortBy = key;
  OQ_STATE.sortDir = dir;
  OQ_STATE.openHeaderMenu = "";
  refresh();
}

// Urgency margin used by the "Most urgent" sort. Margin = daysOfCover -
// reorderBy, where reorderBy = leadDays + safetyDays (already computed by
// partStatus). More negative = more urgent: a part with 40-day cover and
// 182-day lead (margin -142) ranks above a part with 25-day cover and 7-day
// lead (margin +18), since the long-lead part is the one that genuinely
// runs dry before resupply lands. Critical parts always have margin <= 0
// by definition (status === "critical" iff stockoutDay <= reorderBy), so
// they naturally cluster at the top under ascending sort.
// Missing cover/reorderBy → +Infinity → sorts to the bottom.
function oqUrgencyMargin(p) {
  const cover = Number(p?.daysOfCover);
  const reorderBy = Number(p?.reorderBy);
  if (!Number.isFinite(cover) || !Number.isFinite(reorderBy)) return Infinity;
  return cover - reorderBy;
}

function oqHeaderValue(p, key) {
  let value = "";

  if (key === "pn") value = p.pn || "";
  if (key === "desc") value = p.desc || "";
  if (key === "supplier") value = p.supplier || "";
  if (key === "lead") value = `${Number(p.leadDays || 0)}d`;

  return String(value).trim() || "(Blanks)";
}

function oqUniqueHeaderValues(rows, key) {
  const values = [...new Set(rows.map(p => oqHeaderValue(p, key)).filter(Boolean))];

  if (key === "lead") {
    return values.sort((a, b) => Number(a.replace("d", "")) - Number(b.replace("d", "")));
  }

  return values.sort((a, b) => String(a).localeCompare(String(b)));
}

function oqLeadMatches(leadDays, filterValue) {
  const f = String(filterValue || "").trim().toLowerCase().replace("d", "");
  const lead = Number(leadDays || 0);

  if (!f) return true;

  const range = f.match(/^(\d+)\s*-\s*(\d+)$/);
  if (range) {
    const min = Number(range[1]);
    const max = Number(range[2]);
    return lead >= min && lead <= max;
  }

  const match = f.match(/^(>=|<=|>|<|=)?\s*(\d+(\.\d+)?)$/);
  if (!match) return String(lead).includes(f);

  const op = match[1] || "=";
  const val = Number(match[2]);

  if (op === ">") return lead > val;
  if (op === "<") return lead < val;
  if (op === ">=") return lead >= val;
  if (op === "<=") return lead <= val;
  return lead === val;
}

function oqApplyHeaderFilters(rows) {
  return rows.filter(p => {
    const pn = String(p.pn || "").toLowerCase();
    const desc = String(p.desc || "").toLowerCase();
    const supplier = String(p.supplier || "").toLowerCase();

    const hidden = OQ_STATE.hiddenFilters || {
      pn: [],
      desc: [],
      supplier: [],
      lead: [],
    };

    const textMatch =
      pn.includes(OQ_STATE.headerFilters.pn.toLowerCase()) &&
      desc.includes(OQ_STATE.headerFilters.desc.toLowerCase()) &&
      supplier.includes(OQ_STATE.headerFilters.supplier.toLowerCase()) &&
      oqLeadMatches(p.leadDays, OQ_STATE.headerFilters.lead);

    const valueMatch =
      !hidden.pn.includes(oqHeaderValue(p, "pn")) &&
      !hidden.desc.includes(oqHeaderValue(p, "desc")) &&
      !hidden.supplier.includes(oqHeaderValue(p, "supplier")) &&
      !hidden.lead.includes(oqHeaderValue(p, "lead"));

    return textMatch && valueMatch;
  });
}

function oqHeaderDropdown(key, label, rows) {
  const open = OQ_STATE.openHeaderMenu === key;
  const values = oqUniqueHeaderValues(rows, key);

  OQ_STATE.headerOptions[key] = values;

  const hidden = OQ_STATE.hiddenFilters[key] || [];
  const hiddenHere = hidden.filter(v => values.includes(v));
  const active = (OQ_STATE.headerFilters[key] || hiddenHere.length) ? "active" : "";
  const allChecked = hiddenHere.length === 0;

  return `
    <th class="${key === "lead" ? "right" : ""}">
      <div class="excel-th">
        <span>${label}</span>
        <button class="excel-drop ${active}" onclick="event.stopPropagation(); oqToggleHeaderMenu('${key}')">▾</button>

        ${open ? `
          <div class="excel-menu" onclick="event.stopPropagation()">
            <button class="excel-menu-btn" onclick="oqSortHeader('${key}', 'asc')">Sort A to Z</button>
            <button class="excel-menu-btn" onclick="oqSortHeader('${key}', 'desc')">Sort Z to A</button>

            <div class="excel-menu-line"></div>

            <button class="excel-menu-btn ${active ? "" : "disabled"}" onclick="oqClearHeaderFilter('${key}')">
              Clear Filter from '${label}'
            </button>

            <div class="excel-menu-line"></div>

            <input 
              class="excel-menu-search"
              placeholder="Search"
              oninput="oqMenuSearchValues('${key}', this.value)"
            >

            <div class="excel-values">
              <label class="excel-check-row">
                <input 
                  type="checkbox" 
                  ${allChecked ? "checked" : ""}
                  onchange="oqToggleAllHeaderValues('${key}', this.checked)"
                >
                <span>Select All</span>
              </label>

              ${values.map(v => {
                const checked = !hidden.includes(v);
                return `
                  <label class="excel-check-row" data-excel-option="${key}" data-search="${esc(String(v).toLowerCase())}">
                    <input 
                      type="checkbox" 
                      ${checked ? "checked" : ""}
                      onchange="oqToggleHeaderValue('${key}', decodeURIComponent('${encodeURIComponent(v)}'), this.checked)"
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
// Re-run the current queue route handler in place so a +Add click can flip
// the row's button to "IN DRAFT" immediately, without losing scroll position
// (refresh()/navigate() would reset main.scrollTop).
function oqRerenderPreservingScroll() {
  const main = document.getElementById("main");
  const savedScrollTop = main ? main.scrollTop : 0;
  const currentRoute = document.querySelector(".nav-item.active")?.dataset?.route;
  if (currentRoute && typeof ROUTES !== "undefined" && ROUTES[currentRoute]) ROUTES[currentRoute]();
  if (main) requestAnimationFrame(() => { main.scrollTop = savedScrollTop; });
}

function renderOrderQueueFor(itemType) {
  const titleMap = { "base_bom": "Base BOM Queue", "options": "Options Queue", "service": "Service Queue" };
  const pageTitle = (itemType && titleMap[itemType]) || "Order Queue";
  // `stats` is the broader post-itemType, post-!isKit set used only for
  // the headline-count line below ("X of Y · N CRITICAL · M WARNING").
  // `needsOrder` is the actual queue list — same shape, but additionally
  // filtered to critical-or-warning and !phasingOut. queueParts() is the
  // shared chokepoint (js/03-calc.js) so the dashboard's
  // Critical/Order Today count can't drift from what renders here.
  let stats = partsWithStatus();
  // Route-param compare normalized on both sides so a part tagged "Service"
  // (capital S) still routes to the Service Queue. Byte-identical to strict
  // === for the canonical lowercase values used by the app's own writers.
  const _wantType = String(itemType || "").toLowerCase().trim();
  if (_wantType) stats = stats.filter(p => String(p.itemType || "").toLowerCase().trim() === _wantType);
  else stats = stats.filter(p => String(p.itemType || "").toLowerCase().trim() !== "do_not_order");
  stats = stats.filter(p => !p.isKit);
  const needsOrder = queueParts(itemType);
  
  // Apply filters
  let filtered = needsOrder;
  if (OQ_STATE.filter === "critical") filtered = filtered.filter(p => p.status === "critical");
  if (OQ_STATE.filter === "warning") filtered = filtered.filter(p => p.status === "warning");
  if (OQ_STATE.supplier) filtered = filtered.filter(p => p.supplier === OQ_STATE.supplier);
  if (OQ_STATE.buyer) filtered = filtered.filter(p => p.buyer === OQ_STATE.buyer);
  if (OQ_STATE.search) {
    const q = OQ_STATE.search.toLowerCase();
    filtered = filtered.filter(p =>
      p.pn.toLowerCase().includes(q) || (p.desc||"").toLowerCase().includes(q)
    );
  }
  // Days Cover column-header filter. Status-based options use p.status, which
  // already reflects supplier-mute overrides — muted parts stay out of the
  // "Critical only" / "Critical + Warning" buckets the same way they're not
  // colored red in the row treatment. The day cutoffs are a straight numeric
  // compare on p.daysOfCover (Infinity correctly fails both <30 and <60).
  if (OQ_STATE.coverFilter === "critical") {
    filtered = filtered.filter(p => p.status === "critical");
  } else if (OQ_STATE.coverFilter === "critWarn") {
    filtered = filtered.filter(p => p.status === "critical" || p.status === "warning");
  } else if (OQ_STATE.coverFilter === "under30") {
    filtered = filtered.filter(p => Number(p.daysOfCover) < 30);
  } else if (OQ_STATE.coverFilter === "under60") {
    filtered = filtered.filter(p => Number(p.daysOfCover) < 60);
  }

  // Render every toolbar-filter row; the header hidden filter is applied
  // in-place via display:none so the dropdown survives checkbox clicks.
  const headerFilterRows = filtered;

   // Sort
  filtered.sort((a, b) => {
    let cmp = 0;

    switch (OQ_STATE.sortBy) {
      case "pn":
        cmp = String(a.pn || "").localeCompare(String(b.pn || ""));
        break;

      case "desc":
        cmp = String(a.desc || "").localeCompare(String(b.desc || ""));
        break;

      case "supplier":
        cmp = String(a.supplier || "").localeCompare(String(b.supplier || ""));
        break;

      case "lead":
        cmp = Number(a.leadDays || 0) - Number(b.leadDays || 0);
        break;

      case "qty":
        cmp = a._suggestedQty - b._suggestedQty;
        break;

      case "value":
        cmp = a._suggestedQty * orderUnitCost(a) - b._suggestedQty * orderUnitCost(b);
        break;

      case "urgency":
      default:
        // Rank by urgency margin (cover - reorderBy), not raw daysOfCover.
        // Keeps the sort consistent with row colors: long-lead parts whose
        // cover doesn't reach lead+safety surface above short-lead parts
        // with smaller raw cover but a comfortable margin.
        cmp = oqUrgencyMargin(a) - oqUrgencyMargin(b);
        break;
    }

    return OQ_STATE.sortDir === "desc" ? -cmp : cmp;
  });

  const suppliers = [...new Set(needsOrder.map(p => p.supplier))].sort();
  const buyers = [...new Set(needsOrder.map(p => p.buyer))].sort();

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">${esc(pageTitle)}</div>
          <div class="page-sub mono">${filtered.length} OF ${needsOrder.length} PARTS · ${stats.filter(p=>p.status==="critical").length} CRITICAL · ${stats.filter(p=>p.status==="warning").length} WARNING</div>
        </div>
      </div>

      <div class="panel">
        <div class="filterbar">
          <div class="search-input">
            <input class="input" placeholder="Search part # or description…" value="${esc(OQ_STATE.search)}" onchange="OQ_STATE.search = this.value; refresh()" onkeydown="if(event.key === 'Enter'){ OQ_STATE.search = this.value; refresh(); }">
          </div>
          <select class="select" onchange="OQ_STATE.filter = this.value; refresh()">
            <option value="all" ${OQ_STATE.filter==='all'?'selected':''}>All urgency</option>
            <option value="critical" ${OQ_STATE.filter==='critical'?'selected':''}>Critical only</option>
            <option value="warning" ${OQ_STATE.filter==='warning'?'selected':''}>Warning only</option>
          </select>
          <select class="select" onchange="OQ_STATE.supplier = this.value; refresh()">
            <option value="">All suppliers</option>
            ${suppliers.map(s => `<option value="${esc(s)}" ${OQ_STATE.supplier===s?'selected':''}>${esc(s)}</option>`).join("")}
          </select>
          <select class="select" onchange="OQ_STATE.buyer = this.value; refresh()">
            <option value="">All buyers</option>
            ${buyers.map(b => `<option value="${esc(b)}" ${OQ_STATE.buyer===b?'selected':''}>${esc(b)}</option>`).join("")}
          </select>
          <div class="grow"></div>
          <span class="muted tiny">Sort:</span>
          <select class="select" onchange="OQ_STATE.sortBy = this.value; OQ_STATE.sortDir = (this.value === 'value' || this.value === 'qty') ? 'desc' : 'asc'; refresh()">
            <option value="urgency" ${OQ_STATE.sortBy==='urgency'?'selected':''}>Most urgent</option>
            <option value="value" ${OQ_STATE.sortBy==='value'?'selected':''}>Highest $</option>
            <option value="qty" ${OQ_STATE.sortBy==='qty'?'selected':''}>Largest qty</option>
            <option value="supplier" ${OQ_STATE.sortBy==='supplier'?'selected':''}>By supplier</option>
            <option value="pn" ${OQ_STATE.sortBy==='pn'?'selected':''}>By part #</option>
          </select>
        </div>
        <div class="panel-body flush">
  ${false ? `
    <div class="empty">
      <div class="empty-title">Inbox zero</div>
      <div class="empty-msg">No parts need ordering right now. Looking good.</div>
    </div>
  ` : `
    <div class="tbl-wrap oq-tbl-wrap">
              <table class="tbl oq-tbl">
                <colgroup>
                  <col class="oq-c-pn">
                  <col class="oq-c-desc">
                  <col class="oq-c-supplier">
                  <col class="oq-c-cover">
                  <col class="oq-c-lead">
                  <col class="oq-c-onhand">
                  <col class="oq-c-onpo">
                  <col class="oq-c-daily">
                  <col class="oq-c-sq">
                  <col class="oq-c-est">
                  <col class="oq-c-add">
                </colgroup>
                <thead>
  <tr>
    ${oqHeaderDropdown("pn", "Part", headerFilterRows)}
    ${oqHeaderDropdown("desc", "Description", headerFilterRows)}
    ${oqHeaderDropdown("supplier", "Supplier", headerFilterRows)}

    ${oqCoverDropdown()}

    ${oqHeaderDropdown("lead", "Lead", headerFilterRows)}

    <th class="right">On Hand</th>
    <th class="right">On PO</th>
    <th class="right">Daily Use</th>
    <th class="right">Suggest Qty</th>
    <th class="right">Est. $</th>
    <th></th>
  </tr>
</thead>
                <tbody>
                  <tr id="oq-empty-row" style="display:none"><td colspan="11" class="muted center" style="padding:28px">
                    No parts match the current filters. Adjust the column dropdowns or toolbar above.
                  </td></tr>
                  ${filtered.map(p => {
                    const sq = p._suggestedQty;
                    // Chain-final parts get a TRANSITION AT RISK tag when no
                    // covering PO arrives before the chain runs dry. Computed
                    // off the row's cached partsWithStatus state — non-final
                    // / non-chain parts get falsy here (zero cost).
                    const risk = (typeof chainTransitionRisk === "function") ? chainTransitionRisk(p) : false;
                    // SENSOURCING-SCOPED RELEASE / NO PO FLAGS.
                    // Scoped via getSupplierCycle (non-null) so no raw-name
                    // string-match; the rule extends automatically to any
                    // future cycled supplier. Non-Sensourcing rows fall
                    // through to the pre-existing BLKT branch below — byte-
                    // identical to today's rendering.
                    const supplierCycle = (typeof getSupplierCycle === "function") ? getSupplierCycle(p.supplier) : null;
                    const isCycledScope = !!supplierCycle;
                    // Trigger date rule: presence of transitionStartDate
                    // (PAST OR FUTURE — same gate as hard-cutin, NOT
                    // isPreLaunch which is future-only) wins over runout.
                    // Otherwise fall back to the chain-aware runout, which
                    // partsWithStatus has already written to p.daysOfCover
                    // (chainInfo.chainRunoutDays for chain members, per-
                    // part daysOfCover for standalone parts).
                    // triggerDate = the EARLIER of (runout, transitionStartDate).
                    // Previously transitionStartDate short-circuited runout; a
                    // part running dry in 10 days with a far-off transition
                    // date stayed quiet. Now: if runout comes first, we act on
                    // runout; if transition comes first, we act on transition;
                    // if only one exists, we use it.
                    let runoutDate = null;
                    if (Number.isFinite(p.daysOfCover) && typeof addDays === "function") {
                      runoutDate = addDays(TODAY, p.daysOfCover);
                    }
                    let transitionDate = null;
                    if (p.transitionStartDate && typeof parseDateLocal === "function") {
                      const parsed = parseDateLocal(p.transitionStartDate);
                      if (parsed && !isNaN(parsed.getTime())) transitionDate = parsed;
                    }
                    let triggerDate = null;
                    if (runoutDate && transitionDate) {
                      triggerDate = runoutDate.getTime() <= transitionDate.getTime() ? runoutDate : transitionDate;
                    } else if (runoutDate) {
                      triggerDate = runoutDate;
                    } else if (transitionDate) {
                      triggerDate = transitionDate;
                    }
                    const daysToTrigger = triggerDate
                      ? Math.round((triggerDate.getTime() - TODAY.getTime()) / DAY_MS) : null;
                    const inWindow = daysToTrigger !== null && daysToTrigger <= 21;
                    // Open blanket lookup (any-scope) — used to decide
                    // whether to hang a "BLKT" pill on the pn cell for
                    // rows without escalation, and to escalate to RELEASE
                    // for rows meeting the trigger.
                    const blk = (typeof findOpenBlanketForPart === "function") ? findOpenBlanketForPart(p.pn) : null;
                    const openPO = (typeof openPOQty === "function") ? openPOQty(p.pn) : 0;
                    // Flag scoping (grep-legible). BOTH flags gated to
                    // base_bom so options / service queue rows never get
                    // decorated with a base_bom-scoped affordance:
                    //   RELEASE — base_bom + open blanket + no normal PO
                    //     + inside the 21-day trigger window. ANY supplier
                    //     (broadened from Sensourcing-only so a non-cycled
                    //     base_bom part with a blanket still gets the CTA).
                    //   NO PO — base_bom + Sensourcing (isCycledScope) +
                    //     no blanket + no normal PO + valid triggerDate.
                    //     Sensourcing scope preserved from prior behavior:
                    //     the cycle-driven "you-should-have-a-PO-by-now"
                    //     alert is only meaningful for cycled suppliers.
                    //     Without a runout AND without a cutin date, there's
                    //     no demand signal — parts like PUTV-00xx spares and
                    //     23-8006 correctly fall through to "none".
                    const itemTypeNorm = String(p.itemType || "").toLowerCase().trim();
                    const isBaseBomScope = itemTypeNorm === "base_bom";
                    let flag = "none";
                    if (isBaseBomScope) {
                      if (blk && openPO === 0 && inWindow) {
                        flag = "RELEASE";
                      } else if (isCycledScope && !blk && openPO === 0 && triggerDate) {
                        flag = "NO PO";
                      }
                    }
                    // Enumerate ALL open blankets for the RELEASE tooltip so
                    // parts with multiple blankets (JP00026/JP00031/JP00032
                    // each have three) don't hide capacity behind a max-open
                    // pick. findOpenBlanketsForPart returns all open lines
                    // sorted earliest-expiring first.
                    let releaseTooltip = "";
                    if (flag === "RELEASE") {
                      const all = (typeof findOpenBlanketsForPart === "function")
                        ? findOpenBlanketsForPart(p.pn) : [];
                      const list = all.map(b => `${b.po.num} (${fmtNum(b.open)} open)`).join("; ");
                      releaseTooltip = `Release against blanket now — open blankets: ${list}. No open normal PO. Trigger date ${triggerDate ? triggerDate.toISOString().slice(0,10) : "n/a"} (${daysToTrigger}d).`;
                    }
                    const noPoTooltip = flag === "NO PO"
                      ? `No open blanket and no open order. Trigger date ${triggerDate ? triggerDate.toISOString().slice(0,10) : "n/a"} (${daysToTrigger}d).`
                      : "";
                    // Pill construction. Priority: RELEASE > NO PO > BLKT.
                    // RELEASE uses .pill.crit (call-to-action weight, same
                    // as TRANS). NO PO uses .pill.warn. BLKT unchanged from
                    // pre-flag rendering on rows that don't qualify for
                    // either Sensourcing flag.
                    let flagPill = "";
                    if (flag === "RELEASE") {
                      flagPill = ` <span class="pill crit" style="font-weight:700;letter-spacing:0.04em;font-size:9px;padding:1px 6px;margin-left:4px" title="${esc(releaseTooltip)}">RELEASE</span>`;
                    } else if (flag === "NO PO") {
                      flagPill = ` <span class="pill warn" style="font-weight:700;letter-spacing:0.04em;font-size:9px;padding:1px 6px;margin-left:4px" title="${esc(noPoTooltip)}">NO PO</span>`;
                    }
                    const blkPill = (flag === "none" && blk)
                      ? ` <span class="pill info" style="font-size:9px;padding:1px 5px;margin-left:4px;letter-spacing:0.04em" title="Blanket available — open blanket ${esc(blk.po.num)} · ${fmtNum(blk.open)} available to release against">BLKT</span>`
                      : "";
                    return `
                    <tr class="clickable" data-oq-row data-oq-row-pn="${esc(p.pn)}" data-oq-pn="${esc(oqHeaderValue(p, "pn"))}" data-oq-desc="${esc(oqHeaderValue(p, "desc"))}" data-oq-supplier="${esc(oqHeaderValue(p, "supplier"))}" data-oq-lead="${esc(oqHeaderValue(p, "lead"))}" data-oq-lead-days="${Number(p.leadDays || 0)}">
                      <td class="pn" onclick="openPartDetail('${esc(p.pn)}')">${esc(p.pn)}${p.phasingOut ? ' <span class="pill warn" style="font-size:9px;padding:1px 5px;margin-left:4px;text-transform:none;letter-spacing:0">phasing out</span>' : ''}${risk ? ` <span class="pill crit" style="font-weight:700;letter-spacing:0.04em;font-size:9px;padding:1px 6px;margin-left:4px" title="Transition risk — chain runs dry in ${risk.runoutDays}d, replacement order not yet placed">TRANS</span>` : ''}${flagPill}${blkPill}</td>
                      <td class="oq-desc-cell" title="${esc(p.desc || '')}" onclick="openPartDetail('${esc(p.pn)}')">${esc(p.desc)}</td>
                      <td class="dim oq-supplier-cell" title="${esc(p.supplier || '')}" onclick="openPartDetail('${esc(p.pn)}')">${esc(p.supplier)}</td>
                      <td class="right" onclick="openPartDetail('${esc(p.pn)}')"${(() => { const s = stockoutDateStr(p.daysOfCover); return s ? ` title="Projected stockout: ${s}"` : ''; })()}>
                        <span class="meter">
                          <span class="meter-bar ${p.status==='critical'?'crit':'warn'}"><i style="width:${clamp((p.daysOfCover/Math.max(p.leadDays+30,30))*100,5,100)}%"></i></span>
                          <span class="num bold ${p.status==='critical'?'text-crit':'text-warn'}">${p.daysOfCover === Infinity ? "∞" : p.daysOfCover + "d"}</span>
                        </span>
                      </td>
                      <td class="right num dim" onclick="openPartDetail('${esc(p.pn)}')">${p.leadDays}d</td>
                      <td class="right num" onclick="openPartDetail('${esc(p.pn)}')">${fmtNum(p.onHand)}</td>
                      <td class="right num dim" onclick="openPartDetail('${esc(p.pn)}')">${fmtNum(p.onPO)}</td>
                      <td class="right num dim" onclick="openPartDetail('${esc(p.pn)}')">${fmtNum(chainDisplayDaily(p),2)}</td>
                      <td class="right num bold text-accent" onclick="openPartDetail('${esc(p.pn)}')">${fmtNum(sq)}</td>
                      <td class="right num" onclick="openPartDetail('${esc(p.pn)}')">${fmtMoney(sq * orderUnitCost(p))}</td>
                      <td>${draftOrderHas(p.pn)
                        ? `<span class="btn sm" aria-disabled="true" style="min-width:72px;justify-content:center;cursor:default;color:var(--t2);font-weight:500;pointer-events:none">IN DRAFT</span>`
                        : `<button class="btn sm primary" style="min-width:72px;justify-content:center" onclick="event.stopPropagation(); quickAddToDraft('${esc(p.pn)}'); oqRerenderPreservingScroll();">+ Add</button>`}</td>
                    </tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>
          `}
        </div>
      </div>
    </div>`;

  oqReapplyHeaderFiltersInPlace();
  oqInstallOutsideClick();
}
registerRoute("order-queue",    () => renderOrderQueueFor(null));
registerRoute("base-bom-queue", () => renderOrderQueueFor("base_bom"));
registerRoute("options-queue",  () => renderOrderQueueFor("options"));
registerRoute("service-queue",  () => renderOrderQueueFor("service"));

