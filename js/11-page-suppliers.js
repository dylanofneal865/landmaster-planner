/* =====================================================
   11-page-suppliers.js
   Sections: PAGE: SUPPLIERS — aggregated view
   ===================================================== */

/* ============================================================
   PAGE: SUPPLIERS — aggregated view
   ============================================================ */
let SUP_STATE = {
  sortBy: "ohValue",
  sortDir: "desc",
  headerFilters: { name: "" },
  hiddenFilters: { name: [] },
  headerOptions: {},
  openHeaderMenu: "",
};

/* ----- Excel-style header dropdown for the Supplier column ----- */
function supToggleHeaderMenu(key) {
  SUP_STATE.openHeaderMenu = SUP_STATE.openHeaderMenu === key ? "" : key;
  refresh();
}
function supClearHeaderFilter(key) {
  SUP_STATE.headerFilters[key] = "";
  SUP_STATE.hiddenFilters[key] = [];
  SUP_STATE.openHeaderMenu = "";
  refresh();
}
function supToggleHeaderValue(key, value, checked) {
  let hidden = SUP_STATE.hiddenFilters[key] || [];
  if (checked) hidden = hidden.filter(v => v !== value);
  else if (!hidden.includes(value)) hidden.push(value);
  SUP_STATE.hiddenFilters[key] = hidden;
  supReapplyHeaderFiltersInPlace();
}
function supToggleAllHeaderValues(key, checked) {
  const values = SUP_STATE.headerOptions[key] || [];
  SUP_STATE.hiddenFilters[key] = checked ? [] : [...values];
  document.querySelectorAll(`[data-sup-option="${key}"] input[type="checkbox"]`).forEach(cb => { cb.checked = checked; });
  supReapplyHeaderFiltersInPlace();
}
function supReapplyHeaderFiltersInPlace() {
  const hidden = SUP_STATE.hiddenFilters || { name: [] };
  const text = SUP_STATE.headerFilters || { name: "" };
  const tn = String(text.name || "").toLowerCase();
  const rows = document.querySelectorAll('[data-sup-row]');
  let visibleCount = 0;
  rows.forEach(row => {
    const name = row.dataset.suName || "";
    const textMatch = name.toLowerCase().includes(tn);
    const valueMatch = !hidden.name.includes(name);
    const visible = textMatch && valueMatch;
    row.style.display = visible ? "" : "none";
    if (visible) visibleCount++;
  });
  const empty = document.querySelector('#sup-empty-row');
  if (empty) empty.style.display = visibleCount > 0 ? "none" : "";
}
function supInstallOutsideClick() {
  if (!SUP_STATE.openHeaderMenu) {
    if (SUP_STATE._outsideClick) {
      document.removeEventListener("click", SUP_STATE._outsideClick);
      SUP_STATE._outsideClick = null;
    }
    return;
  }
  if (SUP_STATE._outsideClick) return;
  const handler = () => {
    document.removeEventListener("click", handler);
    SUP_STATE._outsideClick = null;
    SUP_STATE.openHeaderMenu = "";
    refresh();
  };
  SUP_STATE._outsideClick = handler;
  setTimeout(() => document.addEventListener("click", handler), 0);
}
function supMenuSearchValues(key, term) {
  const q = String(term || "").toLowerCase();
  document.querySelectorAll(`[data-sup-option="${key}"]`).forEach(row => {
    const value = row.dataset.search || "";
    row.style.display = value.includes(q) ? "flex" : "none";
  });
}
function supSortHeader(key, dir) {
  SUP_STATE.sortBy = key;
  SUP_STATE.sortDir = dir;
  SUP_STATE.openHeaderMenu = "";
  refresh();
}
function supHeaderValue(s, key) {
  if (key === "name") return String(s.name || "").trim() || "(Blanks)";
  return "";
}
function supUniqueHeaderValues(rows, key) {
  return [...new Set(rows.map(s => supHeaderValue(s, key)).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
}
function supApplyHeaderFilters(rows) {
  return rows.filter(s => {
    const name = String(s.name || "").toLowerCase();
    const hidden = SUP_STATE.hiddenFilters || { name: [] };
    const textMatch = name.includes(SUP_STATE.headerFilters.name.toLowerCase());
    const valueMatch = !hidden.name.includes(supHeaderValue(s, "name"));
    return textMatch && valueMatch;
  });
}
function supHeaderDropdown(key, label, rows) {
  const open = SUP_STATE.openHeaderMenu === key;
  const values = supUniqueHeaderValues(rows, key);
  SUP_STATE.headerOptions[key] = values;

  const hidden = SUP_STATE.hiddenFilters[key] || [];
  const hiddenHere = hidden.filter(v => values.includes(v));
  const active = (SUP_STATE.headerFilters[key] || hiddenHere.length) ? "active" : "";
  const allChecked = hiddenHere.length === 0;

  return `
    <th>
      <div class="excel-th">
        <span>${label}</span>
        <button class="excel-drop ${active}" onclick="event.stopPropagation(); supToggleHeaderMenu('${key}')">▾</button>

        ${open ? `
          <div class="excel-menu" onclick="event.stopPropagation()">
            <button class="excel-menu-btn" onclick="supSortHeader('${key}', 'asc')">Sort A to Z</button>
            <button class="excel-menu-btn" onclick="supSortHeader('${key}', 'desc')">Sort Z to A</button>

            <div class="excel-menu-line"></div>

            <button class="excel-menu-btn ${active ? "" : "disabled"}" onclick="supClearHeaderFilter('${key}')">
              Clear Filter from '${label}'
            </button>

            <div class="excel-menu-line"></div>

            <input
              class="excel-menu-search"
              placeholder="Search"
              oninput="supMenuSearchValues('${key}', this.value)"
            >

            <div class="excel-values">
              <label class="excel-check-row">
                <input
                  type="checkbox"
                  ${allChecked ? "checked" : ""}
                  onchange="supToggleAllHeaderValues('${key}', this.checked)"
                >
                <span>Select All</span>
              </label>

              ${values.map(v => {
                const checked = !hidden.includes(v);
                return `
                  <label class="excel-check-row" data-sup-option="${key}" data-search="${esc(String(v).toLowerCase())}">
                    <input
                      type="checkbox"
                      ${checked ? "checked" : ""}
                      onchange="supToggleHeaderValue('${key}', decodeURIComponent('${encodeURIComponent(v)}'), this.checked)"
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

registerRoute("suppliers", () => {
  const stats = partsWithStatus();
  // Aggregate by NORMALIZED supplier key (supplierKey in js/02-utils.js).
  // Feeds emit the same supplier in different shapes — "FASTENAL COMPANY"
  // from the parts feed vs "Fastenal" from the pos feed — so keying on
  // raw p.supplier / po.supplier silently drops the PO join and produces
  // zero Open POs / $0 rows. Aggregating by supplierKey collapses those.
  // The original raw name stays on `a.name` for display so the UI keeps
  // showing the supplier the way the feed wrote it.
  //
  // Collision detection: if two DIFFERENT raw part-supplier names
  // normalize to the same key, log so the normalizer's over-merge risk
  // is visible.
  const map = new Map();
  const rawNamesByKey = new Map();   // key → Set of raw part-side names seen
  for (const p of stats) {
    const raw = p.supplier || "—";
    const key = supplierKey(raw) || raw.toLowerCase();  // fallback: empty key would collapse everything
    if (!rawNamesByKey.has(key)) rawNamesByKey.set(key, new Set());
    rawNamesByKey.get(key).add(raw);
    if (!map.has(key)) map.set(key, {
      name: raw, key, parts: 0, critical: 0, warning: 0, ohValue: 0, openPOs: 0, openPOValue: 0,
      ltSum: 0, ltCount: 0, partsList: [],
    });
    const a = map.get(key);
    a.parts++;
    // Skip reorder-suppressed parts (Do Not Order OR phasingOut — the
    // "burn down existing stock" checkbox) from the critical/warning
    // counters. They still count toward a.parts and a.ohValue (the
    // supplier still carries them and their on-hand value is real);
    // only the counters that drive the "should this supplier be
    // chased?" signal exclude them. Predicate lives in js/03-calc.js
    // next to isQueueEligible so the rule doesn't drift.
    if (!isReorderSuppressed(p)) {
      // Count off the TRUE status so muted suppliers still show real
      // crit/warn tallies in their own row. The "muted" override in
      // partsWithStatus flips p.status to "ok" for header/queue/dashboard
      // surfaces; supplier-facing surfaces consult _rawStatus instead.
      const real = p._rawStatus || p.status;
      if (real === "critical") a.critical++;
      if (real === "warning")  a.warning++;
    }
    a.ohValue += (p.onHand || 0) * (p.cost || 0);
    if (p.ltWeeks) { a.ltSum += p.ltWeeks; a.ltCount++; }
    a.partsList.push(p);
  }
  // Collision warning — surface any keys where multiple distinct raw
  // part-supplier names collapsed to the same normalized value. Not
  // fatal (usually the intended behavior), but visible so an over-
  // aggressive normalizer can be caught.
  for (const [key, rawSet] of rawNamesByKey.entries()) {
    if (rawSet.size > 1) {
      console.warn(
        `[suppliers] normalizer collision — ${rawSet.size} distinct raw names collapsed to key "${key}":`,
        [...rawSet]
      );
    }
  }

  // Add PO data. Route through isLineOpen so completed/closed POs from the
  // Acumatica feed don't inflate per-supplier open-PO counts or value.
  //
  // UNMATCHED tracking: any PO whose normalized supplier key doesn't
  // match a parts-side aggregate would previously have been silently
  // dropped (the exact bug this fix targets). Collect them by key so a
  // visible "UNMATCHED POs" row can render at the table bottom — silent
  // $0 is precisely the state we're trying to eliminate.
  const unmatched = new Map();   // key → { names: Set, openPOs: 0, openPOValue: 0 }
  for (const po of DB.pos) {
    const openLines = (po.lines || []).filter(ln => isLineOpen(po, ln));
    if (openLines.length === 0) continue;
    const poRaw = po.supplier || "—";
    const key = supplierKey(poRaw) || poRaw.toLowerCase();
    const a = map.get(key);
    if (!a) {
      if (!unmatched.has(key)) unmatched.set(key, { key, names: new Set(), openPOs: 0, openPOValue: 0 });
      const u = unmatched.get(key);
      u.names.add(poRaw);
      u.openPOs++;
      for (const ln of openLines) {
        const remaining = Math.max(0, (ln.qty||0) - (ln.qtyReceived||0));
        u.openPOValue += remaining * (ln.cost || 0);
      }
      continue;
    }
    a.openPOs++;
    for (const ln of openLines) {
      const remaining = Math.max(0, (ln.qty||0) - (ln.qtyReceived||0));
      a.openPOValue += remaining * (ln.cost || 0);
    }
  }
  if (unmatched.size > 0) {
    // Surface a compact list so the console has enough context to fix
    // the underlying feed mismatch (or extend the normalizer).
    const summary = [...unmatched.values()].map(u => ({
      key: u.key,
      poSupplierNames: [...u.names],
      openPOs: u.openPOs,
      openPOValue: u.openPOValue,
    }));
    console.warn(
      `[suppliers] ${unmatched.size} PO supplier key(s) with no matching parts-side supplier — ` +
      `their Open POs/$ are aggregated under the UNMATCHED row.`,
      summary
    );
  }

  let suppliers = [...map.values()];

  // Render every aggregated supplier; the header hidden filter is applied
  // in-place via display:none so the dropdown survives checkbox clicks.
  const headerFilterRows = suppliers;

  const dir = SUP_STATE.sortDir === "asc" ? 1 : -1;
  suppliers.sort((a, b) => {
    let cmp = 0;
    switch (SUP_STATE.sortBy) {
      case "name":
        cmp = String(a.name || "").localeCompare(String(b.name || "")); break;
      case "ohValue":
      default:
        cmp = (a.ohValue || 0) - (b.ohValue || 0); break;
    }
    return cmp * dir;
  });

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Suppliers</div>
          <div class="page-sub mono">${suppliers.length} OF ${headerFilterRows.length} SUPPLIERS · ${fmtMoney(headerFilterRows.reduce((s,a) => s+a.ohValue, 0))} TOTAL ON-HAND VALUE</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-body flush">
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr>
                ${supHeaderDropdown("name", "Supplier", headerFilterRows)}
                <th class="right">Parts</th>
                <th class="right">Critical</th>
                <th class="right">Warning</th>
                <th class="right">Avg Lead</th>
                <th class="right">On-Hand $</th>
                <th class="right">Open POs</th>
                <th class="right">Open PO $</th>
                <th></th>
              </tr></thead>
              <tbody>
                <tr id="sup-empty-row" style="display:none"><td colspan="9" class="muted center" style="padding:28px">
                  No suppliers match the current filter. Adjust the Supplier dropdown above.
                </td></tr>
                ${suppliers.map(a => {
                  const avgLT = a.ltCount > 0 ? round(a.ltSum / a.ltCount, 1) : 0;
                  return `
                    <tr class="clickable" data-sup-row data-su-name="${esc(supHeaderValue(a, "name"))}" onclick="openSupplierDetail('${esc(a.name)}')">
                      <td class="bold">${esc(a.name)}${isSupplierMuted(a.name) ? ' <span class="pill warn">MUTED</span>' : ''}</td>
                      <td class="right num">${fmtNum(a.parts)}</td>
                      <td class="right">${a.critical > 0 ? `<span class="pill crit">${a.critical}</span>` : '<span class="dim">0</span>'}</td>
                      <td class="right">${a.warning > 0 ? `<span class="pill warn">${a.warning}</span>` : '<span class="dim">0</span>'}</td>
                      <td class="right num dim">${avgLT}w</td>
                      <td class="right num">${fmtMoney(a.ohValue)}</td>
                      <td class="right num ${a.openPOs>0?'':'dim'}">${a.openPOs}</td>
                      <td class="right num">${fmtMoney(a.openPOValue)}</td>
                      <td><button class="btn sm" onclick="event.stopPropagation(); openSupplierDetail('${esc(a.name)}')">View</button></td>
                    </tr>
                  `;
                }).join("")}
                ${unmatched.size > 0 ? (() => {
                  // UNMATCHED row — sum of every PO whose supplier key
                  // didn't join to a parts-side supplier. Visible failure
                  // signal: silent $0 was what hid this bug in the first
                  // place. Distinct raw PO-supplier names go in the title
                  // attr so a hover reveals exactly which spellings are
                  // failing to join.
                  const list = [...unmatched.values()];
                  const totalOpen = list.reduce((s, u) => s + u.openPOs, 0);
                  const totalValue = list.reduce((s, u) => s + u.openPOValue, 0);
                  const allNames = [...new Set(list.flatMap(u => [...u.names]))].sort();
                  const nameSample = allNames.slice(0, 8).join("; ") + (allNames.length > 8 ? `; …+${allNames.length - 8}` : "");
                  return `
                    <tr data-sup-row style="background:var(--warn-soft)" title="Distinct PO-supplier names not matching any parts-side supplier: ${esc(allNames.join("; "))}">
                      <td class="bold"><span class="pill warn" style="margin-right:8px">UNMATCHED</span><span class="dim tiny">${esc(nameSample)}</span></td>
                      <td class="right num dim">—</td>
                      <td class="right dim">—</td>
                      <td class="right dim">—</td>
                      <td class="right num dim">—</td>
                      <td class="right num dim">—</td>
                      <td class="right num bold">${fmtNum(totalOpen)}</td>
                      <td class="right num bold">${fmtMoney(totalValue)}</td>
                      <td></td>
                    </tr>
                  `;
                })() : ""}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;

  supReapplyHeaderFiltersInPlace();
  supInstallOutsideClick();
});

function openSupplierDetail(name) {
  const stats = partsWithStatus();
  // Match parts AND POs by normalized supplier key so the drawer counts
  // agree with the row that just launched it. Prior raw-equality filters
  // dropped any PO or part whose feed spelled the supplier differently
  // (e.g. row aggregated "FASTENAL COMPANY" and "Fastenal" together, but
  // the drawer's === filter only caught one variant). supplierKey lives
  // in js/02-utils.js — same helper the aggregation uses.
  const targetKey = supplierKey(name);
  const parts = stats.filter(p => supplierKey(p.supplier) === targetKey);
  const pos = DB.pos.filter(p => supplierKey(p.supplier) === targetKey).sort((a,b) => new Date(b.createdDate) - new Date(a.createdDate));
  const ohValue = parts.reduce((s,p) => s + (p.onHand||0)*(p.cost||0), 0);
  // Drawer always shows the TRUE status; muted parts have p.status forced to
  // "ok" but keep their original in p._rawStatus. Reorder-suppressed parts
  // (Do Not Order OR phasingOut) drop out of the crit/warn tally — same
  // predicate the Suppliers table row uses so the drawer stats never
  // disagree with the row you clicked.
  const crit = parts.filter(p => (p._rawStatus || p.status) === "critical" && !isReorderSuppressed(p)).length;
  const warn = parts.filter(p => (p._rawStatus || p.status) === "warning"  && !isReorderSuppressed(p)).length;
  const avgLT = parts.length > 0 ? round(parts.reduce((s,p) => s + (p.ltWeeks||0), 0) / parts.length, 1) : 0;
  const buyers = [...new Set(parts.map(p => p.buyer).filter(Boolean))];
  const muted = isSupplierMuted(name);

  const html = `
    <div class="drawer-head">
      <div class="title-block">
        <div class="pre">SUPPLIER</div>
        <div class="title">${esc(name)}</div>
        <div class="sub">${parts.length} parts · ${pos.length} total POs · avg lead ${avgLT}w${muted ? ' · <span class="pill warn">MUTED</span>' : ''}</div>
      </div>
      <button class="drawer-x" data-close>×</button>
    </div>
    <div class="drawer-body">
      <div class="stat-strip">
        <div class="stat"><div class="stat-label">Parts</div><div class="stat-value">${parts.length}</div></div>
        <div class="stat"><div class="stat-label">Critical</div><div class="stat-value ${crit>0?'crit':''}">${crit}</div></div>
        <div class="stat"><div class="stat-label">Warning</div><div class="stat-value ${warn>0?'warn':''}">${warn}</div></div>
        <div class="stat"><div class="stat-label">On-Hand $</div><div class="stat-value">${fmtMoney(ohValue)}</div></div>
        <div class="stat"><div class="stat-label">Avg Lead</div><div class="stat-value">${avgLT}w</div></div>
        <div class="stat"><div class="stat-label">Buyers</div><div class="stat-value" style="font-size:13px;font-family:var(--f-ui);font-weight:500">${esc(buyers.join(", ")||"—")}</div></div>
      </div>

      <div class="dr-section">Parts (${parts.length})</div>
      <div class="tbl-wrap" style="max-height:380px;overflow-y:auto"><table class="tbl">
        <thead><tr><th>Part</th><th>Description</th><th class="right">On Hand</th><th class="right">Days Cover</th><th></th></tr></thead>
        <tbody>
          ${parts.sort((a,b) => a.urgency - b.urgency).slice(0, 100).map(p => {
            const real = p._rawStatus || p.status;
            return `
            <tr class="clickable" onclick="closeDrawer(); setTimeout(() => openPartDetail('${esc(p.pn)}'), 200)">
              <td class="pn">${esc(p.pn)}</td>
              <td>${esc(p.desc)}</td>
              <td class="right num">${fmtNum(p.onHand)}</td>
              <td class="right">
                <span class="num bold ${real==='critical'?'text-crit':real==='warning'?'text-warn':''}">${p.daysOfCover === Infinity ? '∞' : p.daysOfCover + 'd'}</span>
              </td>
              <td><span class="pill ${real==='critical'?'crit':real==='warning'?'warn':'ok'}">${real==='critical'?'CRIT':real==='warning'?'WARN':'OK'}</span></td>
            </tr>
          `;}).join("")}
        </tbody>
      </table></div>

      ${pos.length > 0 ? `
        <div class="dr-section">Recent POs</div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>PO #</th><th>Status</th><th class="right">Lines</th><th class="right">Value</th><th>Created</th><th>Expected</th></tr></thead>
          <tbody>
            ${pos.slice(0, 20).map(po => {
              const val = po.lines.reduce((s,l) => s + (l.qty||0)*(l.cost||0), 0);
              return `
                <tr class="clickable" onclick="closeDrawer(); setTimeout(() => openPODetail('${esc(po.id)}'), 200)">
                  <td class="pn">${esc(po.num)}</td>
                  <td><span class="pill ${poStatusClass(po.status)}">${poStatusLabel(po.status)}</span></td>
                  <td class="right num">${po.lines.length}</td>
                  <td class="right num">${fmtMoney(val)}</td>
                  <td class="num dim">${fmtDate(po.createdDate)}</td>
                  <td class="num dim">${fmtDate(po.expectedDate)}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table></div>
      ` : ""}
     </div>

  <div class="drawer-foot">
    <button class="btn ${muted ? 'warn' : 'ghost'}" onclick="toggleSupplierMute(decodeURIComponent('${encodeURIComponent(name)}'))">${muted ? 'Unmute alerts' : 'Mute alerts'}</button>
    <button class="btn danger" onclick="deleteSupplierByName(decodeURIComponent('${encodeURIComponent(name)}'))">Delete Supplier</button>
    <button class="btn" data-close>Close</button>
  </div>
`;

openDrawer(html, { wide: true });
}




function deleteSupplierByName(supplierName) {
  if (!supplierName) return;
  if (!gateDelete()) return;

  const confirmed = confirm(
    `Are you sure you want to delete this supplier?\n\n${supplierName}\n\nThis will remove the supplier from the supplier list and unassign it from all related parts. This cannot be undone.`
  );

  if (!confirmed) return;

  // Remove supplier record if it exists
  if (Array.isArray(DB.suppliers)) {
    DB.suppliers = DB.suppliers.filter(s => {
      const supplierRecordName = s.name || s.supplier || s.vendor || "";
      return supplierRecordName.toLowerCase() !== supplierName.toLowerCase();
    });
  }

  // Unassign supplier from parts
  if (Array.isArray(DB.parts)) {
    DB.parts.forEach(p => {
      if ((p.supplier || "").toLowerCase() === supplierName.toLowerCase()) {
        p.supplier = "";
      }
    });
  }

  logAudit("supplier-delete", `Deleted supplier: ${supplierName}`);
  saveDB();
  closeDrawer();
  refresh();
  navigate("suppliers");

  showToast(`${supplierName} deleted.`, "ok");
}

