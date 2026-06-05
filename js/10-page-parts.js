/* =====================================================
   10-page-parts.js
   Sections: PART DETAIL DRAWER — full part info, projection chart, edit, PAGE: PARTS CATALOG — search, filter, edit any part
   ===================================================== */

/* ============================================================
   PART DETAIL DRAWER — full part info, projection chart, edit
   ============================================================ */
function openPartDetail(pn) {
  const part = DB.parts.find(p => p.pn === pn);
  if (!part) { showToast("Part not found: " + pn, "warn"); return; }
  renderPartDetail(part);
}

function renderPartDetail(part) {
  const onPO = openPOQty(part.pn);
  const status = partStatus(part);
  const sq = suggestedQty({...part, onPO, daily: part.daily});

  // Build projection with dynamic horizon — extend enough to show both the
  // stockout day and the lead-time landing day, capped at 365 so slow movers
  // don't flatten the chart.
  const coverDays = daysUntilStockout(part);
  const leadDays = leadTimeDays(part);
  const finiteCover = Number.isFinite(coverDays) ? coverDays : 0;
  let horizon = Math.max(90, finiteCover + 14, leadDays + 14);
  horizon = Math.min(horizon, 365);
  const series = projectOnHand(part, horizon);
  const minOH = Math.min(...series.map(s => s.oh), 0);
  const maxOH = Math.max(...series.map(s => s.oh), part.onHand || 0, 1);

  // Open POs containing this part
  const linesForPart = [];
  for (const po of DB.pos) {
    if (po.status === "received" || po.status === "closed" || po.status === "cancelled") continue;
    for (const ln of po.lines) {
      if (ln.pn === part.pn && ln.status !== "received" && ln.status !== "cancelled") {
        const remaining = Math.max(0, (ln.qty||0) - (ln.qtyReceived||0));
        if (remaining > 0) linesForPart.push({ po, ln, remaining });
      }
    }
  }

  // Recent transactions involving this part
  const txns = DB.audit.filter(a => a.detail && a.detail.pn === part.pn).slice(0, 8);

  // Inventory runway SVG — fixed canvas size; viewBox scales the content.
  // Wider left pad for y-axis labels; extra bottom pad for month ticks.
  // PR is generous so labels anchored near the horizon (stockout, lead-time
  // landing, +horizonD) don't run off the right edge of the SVG viewBox.
  const W = 720, H = 180, PL = 56, PR = 80, PT = 24, PB = 28;
  const xS = i => PL + (i / Math.max(1, series.length - 1)) * (W - PL - PR);
  const yS = v => H - PB - ((v - minOH) / Math.max(1, maxOH - minOH)) * (H - PT - PB);
  const linePath = series.map((s,i) => `${i===0?'M':'L'}${xS(i)},${yS(s.oh)}`).join(" ");
  const areaPath = `${linePath} L${xS(series.length-1)},${H-PB} L${xS(0)},${H-PB} Z`;
  const stockoutIdx = series.findIndex(s => s.oh <= 0);
  const todayMark = `<line x1="${xS(0)}" y1="${PT}" x2="${xS(0)}" y2="${H-PB}" stroke="var(--accent)" stroke-width="1" opacity="0.6"/>`;
  const zeroLine = minOH <= 0 ? `<line x1="${PL}" y1="${yS(0)}" x2="${W-PR}" y2="${yS(0)}" class="spark-zero"/>` : "";

  // PO receipt dots + labels, with crowding suppression (~20px in x).
  let _lastRecvLabelX = -Infinity;
  const recvMarkers = series.map((s, i) => {
    if (!s.recv || s.recv <= 0) return "";
    const cx = xS(i);
    const cy = yS(s.oh);
    const dot = `<circle cx="${cx}" cy="${cy}" r="3" fill="#4aa3f2"/>`;
    let label = "";
    if (cx - _lastRecvLabelX > 20) {
      label = `<text x="${cx}" y="${cy - 7}" text-anchor="middle" fill="#4aa3f2" font-size="9" font-family="var(--f-mono)">+${fmtNum(s.recv)}</text>`;
      _lastRecvLabelX = cx;
    }
    return dot + label;
  }).join("");

  // Lead-time landing line (only if it lands inside the visible horizon).
  // The "order today → arrives day N" label flips to end-anchor at the right
  // inner edge when the line is too close to the horizon to fit a start-
  // anchored label without clipping.
  let leadLine = "";
  if (leadDays > 0 && leadDays <= horizon) {
    const lx = xS(leadDays);
    const LEAD_LABEL_WIDTH = 160; // ≈ "order today → arrives day NNN" at font-size 9
    const wouldOverflow = lx + 4 + LEAD_LABEL_WIDTH > W - 6;
    const tx = wouldOverflow ? Math.min(W - 6, lx - 4) : Math.max(PL + 2, lx + 4);
    const anchor = wouldOverflow ? ` text-anchor="end"` : "";
    leadLine = `
      <line x1="${lx}" y1="${PT}" x2="${lx}" y2="${H-PB}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="3 3" opacity="0.85"/>
      <text x="${tx}" y="${PT+10}"${anchor} fill="var(--warn)" font-size="9" font-family="var(--f-mono)">order today → arrives day ${leadDays}</text>
    `;
  }

  // Overdue gap band — only when the reorder window has been missed.
  const gapBand = (Number.isFinite(coverDays) && leadDays > coverDays) ? `
    <rect x="${xS(coverDays)}" y="${PT}" width="${xS(leadDays) - xS(coverDays)}" height="${H - PT - PB}" fill="var(--crit)" opacity="0.12"/>
    <text x="${(xS(coverDays) + xS(leadDays)) / 2}" y="${PT + 18}" text-anchor="middle" fill="var(--crit)" font-size="10" font-family="var(--f-mono)">${leadDays - coverDays}-day gap</text>
  ` : "";

  // Y-axis labels (right-aligned in left pad).
  const yAxis = `
    <text x="${PL - 6}" y="${yS(part.onHand || 0) + 3}" text-anchor="end" fill="var(--t3)" font-size="9" font-family="var(--f-mono)">${fmtNum(part.onHand || 0)}</text>
    ${minOH <= 0 ? `<text x="${PL - 6}" y="${yS(0) + 3}" text-anchor="end" fill="var(--t3)" font-size="9" font-family="var(--f-mono)">0</text>` : ""}
  `;

  // X-axis month tick labels — drop a "Mon" abbrev each day the month changes.
  const _monAbbrev = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  let _prevMonth = series[0]?.d ? series[0].d.getMonth() : -1;
  const xAxis = series.map((s, i) => {
    if (i === 0) return ""; // skip i=0 to avoid colliding with the TODAY label
    const m = s.d.getMonth();
    if (m === _prevMonth) return "";
    _prevMonth = m;
    return `<text x="${xS(i)}" y="${H - 8}" text-anchor="middle" fill="var(--t3)" font-size="9" font-family="var(--f-mono)">${_monAbbrev[m]}</text>`;
  }).join("");

  // Stockout marker — first day at or below zero, two stacked labels.
  // When the marker is close to the right edge, anchor the labels at the
  // right inner edge so the longer "day NNN · M/D/YY" line can't clip.
  let stockoutMarker = "";
  if (stockoutIdx >= 0) {
    const sx = xS(stockoutIdx);
    const sy = yS(0);
    const STOCKOUT_LABEL_WIDTH = 110; // ≈ "day NNN · M/D/YY" at font-size 9
    const wouldOverflow = sx + 6 + STOCKOUT_LABEL_WIDTH > W - 6;
    const tx = wouldOverflow ? Math.min(W - 6, sx - 6) : Math.max(PL + 2, sx + 6);
    const anchor = wouldOverflow ? ` text-anchor="end"` : "";
    stockoutMarker = `
      <circle cx="${sx}" cy="${sy}" r="4" fill="var(--crit)"/>
      <text x="${tx}" y="${sy-12}"${anchor} fill="var(--crit)" font-size="10" font-family="var(--f-mono)">out of stock</text>
      <text x="${tx}" y="${sy-2}"${anchor} fill="var(--crit)" font-size="9" font-family="var(--f-mono)">day ${stockoutIdx} · ${stockoutDateStr(stockoutIdx)}</text>
    `;
  }

  // Status banner — plain-language summary placed above the chart.
  let runwayBanner;
  if (!Number.isFinite(coverDays)) {
    runwayBanner = `<div class="dim tiny" style="margin-bottom:8px">No projected stockout at current demand.</div>`;
  } else if (leadDays > coverDays) {
    runwayBanner = `<div class="tiny" style="margin-bottom:8px;color:var(--crit);font-weight:600">Runs out in ${coverDays}d (${stockoutDateStr(coverDays)}). Resupply takes ${leadDays}d — reorder overdue by ${leadDays - coverDays}d.</div>`;
  } else {
    runwayBanner = `<div class="tiny" style="margin-bottom:8px;color:var(--warn);font-weight:500">Runs out in ${coverDays}d (${stockoutDateStr(coverDays)}). Reorder by day ${Math.max(0, coverDays - leadDays)} to stay covered.</div>`;
  }

  const partIsKit = typeof isKit === "function" && isKit(part.pn);
  const kitComponents = partIsKit ? getComponentsOfKit(part.pn) : [];

  const html = `
    <div class="drawer-head">
      <div class="title-block">
        <div class="pre">${partIsKit ? 'KIT' : `PART · ${esc(part.partClass||"")}`}</div>
        <div class="title">${esc(part.pn)}</div>
        <div class="sub">${esc(part.desc)} · <span class="pill ${partIsKit ? 'ok' : (status.status==='critical'?'crit':status.status==='warning'?'warn':'ok')}" ${partIsKit ? 'style="background:var(--accent-soft,#eef);color:var(--accent,#36c)"' : ''}>${partIsKit ? 'KIT · ' + kitComponents.length + ' COMPONENTS' : status.status.toUpperCase()}</span></div>
      </div>
      <button class="drawer-x" data-close>×</button>
    </div>
    <div class="drawer-body">
      ${partIsKit ? `
        <div class="dr-section">Kit components</div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Component</th>
            <th>Description</th>
            <th class="right">Qty per kit</th>
            <th class="dim">Type</th>
          </tr></thead>
          <tbody>
            ${kitComponents.map(c => {
              const compPart = DB.parts.find(pp => pp.pn === c.pn);
              const inCatalog = !!compPart;
              const qtyStr = c.qty % 1 === 0 ? fmtNum(c.qty) : fmtNum(c.qty, 2);
              return `
                <tr ${inCatalog ? `class="clickable" onclick="openPartDetail('${esc(c.pn)}')"` : ''}>
                  <td class="pn">${esc(c.pn)}${!inCatalog ? ' <span class="pill warn" title="Not in parts catalog">⚠</span>' : ''}</td>
                  <td>${esc(compPart?.desc || c.desc || '—')}</td>
                  <td class="right num bold">${qtyStr}</td>
                  <td class="dim tiny">${c.isStock ? 'Stock' : 'Non-stock'}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table></div>
        <p class="muted tiny" style="margin-top:8px;line-height:1.5">When this kit ships, each component's daily-use is automatically credited based on Qty per kit. Kits never generate purchase suggestions — their components do.</p>
      ` : ''}
      ${(() => {
        const parentKits = typeof getKitsForComponent === "function" ? getKitsForComponent(part.pn) : [];
        if (!parentKits.length) return '';
        return `
          <div class="dr-section">Used in ${parentKits.length} kit${parentKits.length === 1 ? '' : 's'}</div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th>Kit</th>
              <th>Description</th>
              <th class="right">Qty per kit</th>
              <th class="dim">Type</th>
            </tr></thead>
            <tbody>
              ${parentKits.map(k => {
                const qtyStr = k.qty_per_kit % 1 === 0 ? fmtNum(k.qty_per_kit) : fmtNum(k.qty_per_kit, 2);
                const kitInCatalog = DB.parts.some(pp => pp.pn === k.kit_pn);
                return `
                  <tr ${kitInCatalog ? `class="clickable" onclick="openPartDetail('${esc(k.kit_pn)}')"` : ''}>
                    <td class="pn">${esc(k.kit_pn)}${!kitInCatalog ? ' <span class="pill warn" title="Kit BOM exists but kit is not in parts catalog">⚠</span>' : ''}</td>
                    <td>${esc(k.kit_desc || '—')}</td>
                    <td class="right num bold">${qtyStr}</td>
                    <td class="dim tiny">${k.isStock ? 'Stock' : 'Non-stock'}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table></div>
          <p class="muted tiny" style="margin-top:8px;line-height:1.5">Every sale of these kits credits this component's daily-use rate based on Qty per kit. This is part of why the part's demand is what it is today.</p>
        ` ;
      })()}
      <div class="stat-strip">
        <div class="stat"><div class="stat-label">On Hand</div><div class="stat-value">${fmtNum(part.onHand)}</div></div>
        <div class="stat"><div class="stat-label">On PO</div><div class="stat-value ${onPO>0?'':'dim'}">${fmtNum(onPO)}</div></div>
        <div class="stat"><div class="stat-label">Daily Use</div><div class="stat-value">${fmtNum(part.daily, 2)}</div></div>
        <div class="stat"><div class="stat-label">Days Cover</div><div class="stat-value ${status.status==='critical'?'crit':status.status==='warning'?'warn':'ok'}">${status.daysOfCover === Infinity ? '∞' : status.daysOfCover + 'd'}</div>${(() => { const s = stockoutDateStr(status.daysOfCover); return s ? `<div class="dim tiny mono" style="margin-top:2px">${s}</div>` : ''; })()}</div>
        <div class="stat"><div class="stat-label">Lead Time</div><div class="stat-value">${part.ltWeeks||0}w</div></div>
        <div class="stat"><div class="stat-label">Unit Cost</div><div class="stat-value">${fmtMoneyDec(part.cost)}</div></div>
      </div>

      <div class="dr-section">Inventory runway</div>
      ${runwayBanner}
      <div class="spark-wrap">
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">
          ${gapBand}
          ${zeroLine}
          ${todayMark}
          ${leadLine}
          <path d="${areaPath}" class="spark-area"/>
          <path d="${linePath}" class="spark-line"/>
          ${recvMarkers}
          ${stockoutMarker}
          ${yAxis}
          ${xAxis}
          <text x="${PL}" y="${PT-8}" fill="var(--t3)" font-size="9" font-family="var(--f-mono)">TODAY</text>
          <text x="${W-6}" y="${PT-8}" text-anchor="end" fill="var(--t3)" font-size="9" font-family="var(--f-mono)">+${horizon}D</text>
        </svg>
      </div>

      <div class="dr-section">Quick actions</div>
      <div class="row gap-md" style="flex-wrap:wrap">
        <button class="btn primary" onclick="closeDrawer(); openOnHandQuickModal('${esc(part.pn)}')">⚡ Update on-hand</button>
        ${!partIsKit && (status.status === "critical" || status.status === "warning" || sq > 0) ? `<button class="btn primary" onclick="quickAddToDraft('${esc(part.pn)}'); closeDrawer()">+ Order ${fmtNum(sq)}</button>` : ""}
        <button class="btn" onclick="closeDrawer(); navigate('order-queue')">View order queue</button>
      </div>

      <div class="dr-section">Edit part</div>
      <div class="grid-2">
        <div class="field"><label>Part #</label><input class="input" id="pd-pn" value="${esc(part.pn)}"></div>
        <div class="field"><label>Description</label><input class="input" id="pd-desc" value="${esc(part.desc||"")}"></div>
        <div class="field"><label>Supplier</label><input class="input" id="pd-supplier" value="${esc(part.supplier||"")}"></div>
        <div class="field"><label>Buyer</label><input class="input" id="pd-buyer" value="${esc(part.buyer||"")}"></div>
        <div class="field"><label>On Hand</label><input class="input num" type="number" min="0" id="pd-oh" value="${part.onHand||0}"></div>
        <div class="field"><label>Daily Use (avg)</label><input class="input num" type="number" min="0" step="0.01" id="pd-daily" value="${part.daily||0}"></div>
        <div class="field"><label>Unit Cost</label><input class="input num" type="number" min="0" step="0.01" id="pd-cost" value="${part.cost||0}"></div>
        <div class="field"><label>Lead Time (weeks)</label><input class="input num" type="number" min="0" step="0.5" id="pd-lt" value="${part.ltWeeks||0}"></div>
        <div class="field"><label>MOQ</label><input class="input num" type="number" min="0" id="pd-moq" value="${part.moq||0}"></div>
        <div class="field"><label>Pack Size</label><input class="input num" type="number" min="1" id="pd-pack" value="${part.packSize||1}"></div>
        <div class="field"><label>Class</label>
          <select class="select" id="pd-class">
            <option value="A" ${part.partClass==="A"?"selected":""}>A · high value/critical</option>
            <option value="B" ${part.partClass==="B"?"selected":""}>B · medium</option>
            <option value="C" ${part.partClass==="C"?"selected":""}>C · low</option>
          </select>
        </div>
        <div class="field"><label>Category</label>
          <input class="input" id="pd-cat" value="${esc(part.category||"")}">
        </div>
        <div class="field"><label>Item Type</label>
          <select class="select" id="pd-itemtype">
            <option value=""             ${!part.itemType                   ? "selected" : ""}>—</option>
            <option value="base_bom"     ${part.itemType === "base_bom"     ? "selected" : ""}>Base BOM</option>
            <option value="options"      ${part.itemType === "options"      ? "selected" : ""}>Options</option>
            <option value="service"      ${part.itemType === "service"      ? "selected" : ""}>Service</option>
            <option value="do_not_order" ${part.itemType === "do_not_order" ? "selected" : ""}>Do Not Order</option>
          </select>
        </div>
      </div>
      <div class="field" style="margin-top:12px"><label>Notes</label>
        <textarea class="textarea" id="pd-notes">${esc(part.notes||"")}</textarea>
      </div>

      ${linesForPart.length > 0 ? `
        <div class="dr-section">Open PO lines for this part</div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>PO</th><th>Status</th><th class="right">Open Qty</th><th>Expected</th></tr></thead>
          <tbody>
            ${linesForPart.map(({po, ln, remaining}) => `
              <tr class="clickable" onclick="openPODetail('${esc(po.id)}')">
                <td class="pn">${esc(po.num)}</td>
                <td><span class="pill ${poStatusClass(po.status)}">${poStatusLabel(po.status)}</span></td>
                <td class="right num">${fmtNum(remaining)}</td>
                <td class="num dim">${fmtDate(ln.expectedDate || po.expectedDate)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table></div>
      ` : ""}

      ${txns.length > 0 ? `
        <div class="dr-section">Recent activity</div>
        <div>
          ${txns.map(a => `
            <div class="audit-entry ${a.type}">
              <div class="audit-ts">${fmtTime(a.ts)}</div>
              <div class="audit-msg">${esc(a.msg)}</div>
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
    <div class="drawer-foot">
      <button class="btn danger" onclick="confirmDeletePart('${esc(part.pn)}')">Delete</button>
      <div class="grow" style="flex:1"></div>
      <button class="btn ghost" data-close>Close</button>
      <button class="btn primary" onclick="savePartFromDetail('${esc(part.pn)}')">Save changes</button>
    </div>
  `;
  openDrawer(html, { wide: true });
}

function savePartFromDetail(originalPn) {
  const part = DB.parts.find(p => p.pn === originalPn);
  if (!part) return;
  const newPN = $("#pd-pn").value.trim();
  if (!newPN) { showToast("Part # required", "warn"); return; }
  if (newPN !== originalPn && DB.parts.some(p => p.pn === newPN)) {
    showToast("Part # already exists", "warn"); return;
  }
  const oldOh = part.onHand || 0;
  part.pn = newPN;
  part.desc = $("#pd-desc").value.trim();
  part.supplier = $("#pd-supplier").value.trim();
  part.buyer = $("#pd-buyer").value.trim();
  part.onHand = Math.max(0, Math.round(parseFloat($("#pd-oh").value) || 0));
  part.daily = Math.max(0, parseFloat($("#pd-daily").value) || 0);
  part.cost = Math.max(0, parseFloat($("#pd-cost").value) || 0);
  part.ltWeeks = Math.max(0, parseFloat($("#pd-lt").value) || 0);
  part.moq = Math.max(0, parseInt($("#pd-moq").value) || 0);
  part.packSize = Math.max(1, parseInt($("#pd-pack").value) || 1);
  part.partClass = $("#pd-class").value;
  part.category = $("#pd-cat").value.trim();
  part.itemType = $("#pd-itemtype").value || null;
  part.notes = $("#pd-notes").value.trim();
  // If PN changed, update PO line refs
  if (newPN !== originalPn) {
    for (const po of DB.pos) for (const ln of po.lines) if (ln.pn === originalPn) ln.pn = newPN;
  }
  if (oldOh !== part.onHand) {
    logAudit("oh-edit", `${newPN}: ${fmtNum(oldOh)} → ${fmtNum(part.onHand)} (part edit)`, { pn: newPN, oldQ: oldOh, newQ: part.onHand, delta: part.onHand - oldOh });
  } else {
    logAudit("part-edit", `Edited ${newPN}`, { pn: newPN });
  }
  saveDB();
  bumpStatusCache();
  closeDrawer();
  showToast(`${newPN} updated`, "ok");
  refresh();
}

function confirmDeletePart(pn) {
  if (!gateDelete()) return;
  openModal(`
    <div class="modal-head"><div style="font-size:13px;font-weight:600">Delete part?</div></div>
    <div class="modal-body">
      <p>This will permanently remove <span class="pn">${esc(pn)}</span> from the catalog.</p>
      <p class="muted tiny">Open PO lines for this part will remain but will reference a missing part. This cannot be undone.</p>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn danger" onclick="deletePart('${esc(pn)}')">Delete permanently</button>
    </div>
  `);
}

function deletePart(pn) {
  const idx = DB.parts.findIndex(p => p.pn === pn);
  if (idx < 0) return;
  DB.parts.splice(idx, 1);
  logAudit("part-del", `Deleted part ${pn}`, { pn });
  saveDB();
  bumpStatusCache();
  closeModal();
  closeDrawer();
  showToast(`${pn} deleted`, "warn");
  refresh();
}

/* ============================================================
   PAGE: PARTS CATALOG — search, filter, edit any part
   ============================================================ */
let PARTS_STATE = {
  search: "",
  supplier: "",
  category: "",
  partClass: "",
  sortBy: "pn",
  sortDir: "asc",
  headerFilters: { pn: "", desc: "", supplier: "", cls: "", status: "" },
  hiddenFilters: { pn: [], desc: [], supplier: [], cls: [], status: [] },
  headerOptions: {},
  openHeaderMenu: "",
};

/* ----- Excel-style header dropdowns (mirrors Order Queue / POs) ----- */
function partsToggleHeaderMenu(key) {
  PARTS_STATE.openHeaderMenu = PARTS_STATE.openHeaderMenu === key ? "" : key;
  refresh();
}
function partsClearHeaderFilter(key) {
  PARTS_STATE.headerFilters[key] = "";
  PARTS_STATE.hiddenFilters[key] = [];
  PARTS_STATE.openHeaderMenu = "";
  refresh();
}
function partsToggleHeaderValue(key, value, checked) {
  let hidden = PARTS_STATE.hiddenFilters[key] || [];
  if (checked) hidden = hidden.filter(v => v !== value);
  else if (!hidden.includes(value)) hidden.push(value);
  PARTS_STATE.hiddenFilters[key] = hidden;
  partsRerenderPreservingScroll();
}
function partsToggleAllHeaderValues(key, checked) {
  const values = PARTS_STATE.headerOptions[key] || [];
  PARTS_STATE.hiddenFilters[key] = checked ? [] : [...values];
  partsRerenderPreservingScroll();
}

// Re-run the parts route handler in place so header-dropdown changes flow
// through partsApplyHeaderFilters BEFORE the 500-row slice, then restore the
// main viewport's scroll so the user doesn't jump to top. We bypass refresh()
// /navigate() because those reset scrollTop and rebuild the top bar etc. —
// none of which we need for a header-filter toggle.
function partsRerenderPreservingScroll() {
  const main = document.getElementById("main");
  const savedScrollTop = main ? main.scrollTop : 0;
  if (typeof ROUTES !== "undefined" && ROUTES.parts) ROUTES.parts();
  if (main) requestAnimationFrame(() => { main.scrollTop = savedScrollTop; });
}
function partsReapplyHeaderFiltersInPlace() {
  const hidden = PARTS_STATE.hiddenFilters || { pn: [], desc: [], supplier: [], cls: [], status: [] };
  const text = PARTS_STATE.headerFilters || { pn: "", desc: "", supplier: "", cls: "", status: "" };
  const tpn = String(text.pn || "").toLowerCase();
  const td  = String(text.desc || "").toLowerCase();
  const tsu = String(text.supplier || "").toLowerCase();
  const tcl = String(text.cls || "").toLowerCase();
  const tst = String(text.status || "").toLowerCase();
  const rows = document.querySelectorAll('[data-parts-row]');
  let visibleCount = 0;
  rows.forEach(row => {
    const pn = row.dataset.ptPn || "";
    const desc = row.dataset.ptDesc || "";
    const supplier = row.dataset.ptSupplier || "";
    const cls = row.dataset.ptCls || "";
    const status = row.dataset.ptStatus || "";
    const textMatch = pn.toLowerCase().includes(tpn) && desc.toLowerCase().includes(td) && supplier.toLowerCase().includes(tsu) && cls.toLowerCase().includes(tcl) && status.toLowerCase().includes(tst);
    const valueMatch = !hidden.pn.includes(pn) && !hidden.desc.includes(desc) && !hidden.supplier.includes(supplier) && !hidden.cls.includes(cls) && !hidden.status.includes(status);
    const visible = textMatch && valueMatch;
    row.style.display = visible ? "" : "none";
    if (visible) visibleCount++;
  });
  const empty = document.querySelector('#parts-empty-row');
  if (empty) empty.style.display = visibleCount > 0 ? "none" : "";
}
function partsInstallOutsideClick() {
  if (!PARTS_STATE.openHeaderMenu) {
    if (PARTS_STATE._outsideClick) {
      document.removeEventListener("click", PARTS_STATE._outsideClick);
      PARTS_STATE._outsideClick = null;
    }
    return;
  }
  if (PARTS_STATE._outsideClick) return;
  const handler = () => {
    document.removeEventListener("click", handler);
    PARTS_STATE._outsideClick = null;
    PARTS_STATE.openHeaderMenu = "";
    refresh();
  };
  PARTS_STATE._outsideClick = handler;
  setTimeout(() => document.addEventListener("click", handler), 0);
}
function partsMenuSearchValues(key, term) {
  const q = String(term || "").toLowerCase();
  document.querySelectorAll(`[data-parts-option="${key}"]`).forEach(row => {
    const value = row.dataset.search || "";
    row.style.display = value.includes(q) ? "flex" : "none";
  });
}
function partsSortHeader(key, dir) {
  PARTS_STATE.sortBy = key;
  PARTS_STATE.sortDir = dir;
  PARTS_STATE.openHeaderMenu = "";
  refresh();
}

// Repurposes the "cls" column to show ITEM TYPE while keeping the header-filter
// plumbing keyed on "cls" so data attributes and hidden-value matching keep
// working unchanged. The toolbar "All classes" dropdown and the part-detail
// drawer's Class field still use partClass.
function partItemTypeLabel(p) {
  if (p.isKit) return "Kit";
  switch (p.itemType) {
    case "base_bom":     return "Base BOM";
    case "options":      return "Options";
    case "service":      return "Service";
    case "do_not_order": return "Do Not Order";
    default:             return "Untagged";
  }
}

function partsHeaderValue(p, key) {
  let value = "";
  if (key === "pn") value = p.pn || "";
  if (key === "desc") value = p.desc || "";
  if (key === "supplier") value = p.supplier || "";
  if (key === "cls") value = partItemTypeLabel(p);
  if (key === "status") value = p.isKit ? "Kit" : p.itemType === "do_not_order" ? "Do Not Order" : p.status === "critical" ? "Critical" : p.status === "warning" ? "Warning" : "OK";
  return String(value).trim() || "(Blanks)";
}
function partsUniqueHeaderValues(rows, key) {
  return [...new Set(rows.map(p => partsHeaderValue(p, key)).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
}
function partsApplyHeaderFilters(rows) {
  return rows.filter(p => {
    const pn = String(p.pn || "").toLowerCase();
    const desc = String(p.desc || "").toLowerCase();
    const supplier = String(p.supplier || "").toLowerCase();
    const cls = partItemTypeLabel(p).toLowerCase();
    const statusLabel = (p.itemType === "do_not_order" ? "Do Not Order" : p.status === "critical" ? "Critical" : p.status === "warning" ? "Warning" : "OK").toLowerCase();
    const hidden = PARTS_STATE.hiddenFilters || { pn: [], desc: [], supplier: [], cls: [], status: [] };

    const textMatch =
      pn.includes(PARTS_STATE.headerFilters.pn.toLowerCase()) &&
      desc.includes(PARTS_STATE.headerFilters.desc.toLowerCase()) &&
      supplier.includes(PARTS_STATE.headerFilters.supplier.toLowerCase()) &&
      cls.includes(PARTS_STATE.headerFilters.cls.toLowerCase()) &&
      statusLabel.includes(PARTS_STATE.headerFilters.status.toLowerCase());

    const valueMatch =
      !hidden.pn.includes(partsHeaderValue(p, "pn")) &&
      !hidden.desc.includes(partsHeaderValue(p, "desc")) &&
      !hidden.supplier.includes(partsHeaderValue(p, "supplier")) &&
      !hidden.cls.includes(partsHeaderValue(p, "cls")) &&
      !hidden.status.includes(partsHeaderValue(p, "status"));

    return textMatch && valueMatch;
  });
}

function partsHeaderDropdown(key, label, rows) {
  const open = PARTS_STATE.openHeaderMenu === key;
  const values = partsUniqueHeaderValues(rows, key);
  PARTS_STATE.headerOptions[key] = values;

  const hidden = PARTS_STATE.hiddenFilters[key] || [];
  const hiddenHere = hidden.filter(v => values.includes(v));
  const active = (PARTS_STATE.headerFilters[key] || hiddenHere.length) ? "active" : "";
  const allChecked = hiddenHere.length === 0;

  return `
    <th>
      <div class="excel-th">
        <span>${label}</span>
        <button class="excel-drop ${active}" onclick="event.stopPropagation(); partsToggleHeaderMenu('${key}')">▾</button>

        ${open ? `
          <div class="excel-menu" onclick="event.stopPropagation()">
            <button class="excel-menu-btn" onclick="partsSortHeader('${key}', 'asc')">Sort A to Z</button>
            <button class="excel-menu-btn" onclick="partsSortHeader('${key}', 'desc')">Sort Z to A</button>

            <div class="excel-menu-line"></div>

            <button class="excel-menu-btn ${active ? "" : "disabled"}" onclick="partsClearHeaderFilter('${key}')">
              Clear Filter from '${label}'
            </button>

            <div class="excel-menu-line"></div>

            <input
              class="excel-menu-search"
              placeholder="Search"
              oninput="partsMenuSearchValues('${key}', this.value)"
            >

            <div class="excel-values">
              <label class="excel-check-row">
                <input
                  type="checkbox"
                  ${allChecked ? "checked" : ""}
                  onchange="partsToggleAllHeaderValues('${key}', this.checked)"
                >
                <span>Select All</span>
              </label>

              ${values.map(v => {
                const checked = !hidden.includes(v);
                return `
                  <label class="excel-check-row" data-parts-option="${key}" data-search="${esc(String(v).toLowerCase())}">
                    <input
                      type="checkbox"
                      ${checked ? "checked" : ""}
                      onchange="partsToggleHeaderValue('${key}', decodeURIComponent('${encodeURIComponent(v)}'), this.checked)"
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

registerRoute("parts", () => {
  const stats = partsWithStatus();
  let parts = stats.slice();

  if (PARTS_STATE.search) {
    const q = PARTS_STATE.search.toLowerCase();
    parts = parts.filter(p => p.pn.toLowerCase().includes(q) || (p.desc||"").toLowerCase().includes(q) || (p.supplier||"").toLowerCase().includes(q));
  }
  if (PARTS_STATE.supplier) parts = parts.filter(p => p.supplier === PARTS_STATE.supplier);
  if (PARTS_STATE.category) parts = parts.filter(p => p.category === PARTS_STATE.category);
  if (PARTS_STATE.partClass) parts = parts.filter(p => p.partClass === PARTS_STATE.partClass);

  // Dropdown option list is built from the post-toolbar, pre-header set so
  // unchecked values stay visible (and re-checkable) in the dropdown.
  const headerFilterRows = parts;
  // Header-dropdown filters must apply BEFORE the render-time 500-row slice,
  // otherwise the dropdown could only filter within the first 500 of 1625
  // parts (rest never reach the DOM).
  parts = partsApplyHeaderFilters(parts);

  const dir = PARTS_STATE.sortDir === "desc" ? -1 : 1;
  parts.sort((a, b) => {
    let cmp = 0;
    switch (PARTS_STATE.sortBy) {
      case "desc":
        cmp = (a.desc || "").localeCompare(b.desc || ""); break;
      case "supplier":
        cmp = (a.supplier || "").localeCompare(b.supplier || ""); break;
      case "cls":
        cmp = partItemTypeLabel(a).localeCompare(partItemTypeLabel(b)); break;
      case "status":
        cmp = partsHeaderValue(a, "status").localeCompare(partsHeaderValue(b, "status")); break;
      case "onhand":
        cmp = (a.onHand || 0) - (b.onHand || 0); break;
      case "value":
        cmp = (a.onHand || 0) * (a.cost || 0) - (b.onHand || 0) * (b.cost || 0); break;
      case "leadtime":
        cmp = (a.ltWeeks || 0) - (b.ltWeeks || 0); break;
      case "pn":
      default:
        cmp = (a.pn || "").localeCompare(b.pn || ""); break;
    }
    return cmp * dir;
  });

  const suppliers = [...new Set(stats.map(p => p.supplier))].sort();
  const categories = [...new Set(stats.map(p => p.category).filter(Boolean))].sort();
  const totalValue = parts.reduce((s,p) => s + (p.onHand||0)*(p.cost||0), 0);

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Parts Catalog</div>
          <div class="page-sub mono">${parts.length} OF ${stats.length} PARTS · ${fmtMoney(totalValue)} ON-HAND VALUE</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="exportPartsAsCSV()">⇩ Export CSV</button>
          <button class="btn primary" onclick="openAddPartModal()">+ Add part</button>
        </div>
      </div>

      <div class="panel">
        <div class="filterbar">
          <div class="search-input">
            <input class="input" placeholder="Search part # or description…" value="${esc(PARTS_STATE.search)}" onchange="PARTS_STATE.search = this.value; refresh()" onkeydown="if(event.key === 'Enter'){ PARTS_STATE.search = this.value; refresh(); }">
          </div>
          <select class="select" onchange="PARTS_STATE.supplier = this.value; refresh()">
            <option value="">All suppliers</option>
            ${suppliers.map(s => `<option value="${esc(s)}" ${PARTS_STATE.supplier===s?'selected':''}>${esc(s)}</option>`).join("")}
          </select>
          ${categories.length > 0 ? `
            <select class="select" onchange="PARTS_STATE.category = this.value; refresh()">
              <option value="">All categories</option>
              ${categories.map(c => `<option value="${esc(c)}" ${PARTS_STATE.category===c?'selected':''}>${esc(c)}</option>`).join("")}
            </select>
          ` : ""}
          <select class="select" onchange="PARTS_STATE.partClass = this.value; refresh()">
            <option value="">All classes</option>
            <option value="A" ${PARTS_STATE.partClass==='A'?'selected':''}>Class A</option>
            <option value="B" ${PARTS_STATE.partClass==='B'?'selected':''}>Class B</option>
            <option value="C" ${PARTS_STATE.partClass==='C'?'selected':''}>Class C</option>
          </select>
          <div class="grow"></div>
          <span class="muted tiny">Sort:</span>
          <select class="select" onchange="PARTS_STATE.sortBy = this.value; PARTS_STATE.sortDir = (['onhand','value','leadtime'].includes(this.value) ? 'desc' : 'asc'); refresh()">
            <option value="pn" ${PARTS_STATE.sortBy==='pn'?'selected':''}>Part #</option>
            <option value="desc" ${PARTS_STATE.sortBy==='desc'?'selected':''}>Description</option>
            <option value="supplier" ${PARTS_STATE.sortBy==='supplier'?'selected':''}>Supplier</option>
            <option value="onhand" ${PARTS_STATE.sortBy==='onhand'?'selected':''}>On-hand qty</option>
            <option value="value" ${PARTS_STATE.sortBy==='value'?'selected':''}>$ value</option>
            <option value="leadtime" ${PARTS_STATE.sortBy==='leadtime'?'selected':''}>Lead time</option>
          </select>
        </div>
        <div class="panel-body flush">
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr>
                ${partsHeaderDropdown("pn", "Part", headerFilterRows)}
                ${partsHeaderDropdown("desc", "Description", headerFilterRows)}
                ${partsHeaderDropdown("supplier", "Supplier", headerFilterRows)}
                ${partsHeaderDropdown("cls", "Type", headerFilterRows)}
                <th class="right">On Hand</th>
                <th class="right">On PO</th>
                <th class="right">Daily</th>
                <th class="right">Lead</th>
                <th class="right">Cost</th>
                <th class="right">$ Value</th>
                ${partsHeaderDropdown("status", "Status", headerFilterRows)}
              </tr></thead>
              <tbody>
                <tr id="parts-empty-row" style="display:none"><td colspan="11" class="muted center" style="padding:28px">
                  No parts match the current filters. Adjust the column dropdowns or toolbar above.
                </td></tr>
                ${parts.slice(0, 500).map(p => `
                  <tr class="clickable" data-parts-row data-pt-pn="${esc(partsHeaderValue(p, "pn"))}" data-pt-desc="${esc(partsHeaderValue(p, "desc"))}" data-pt-supplier="${esc(partsHeaderValue(p, "supplier"))}" data-pt-cls="${esc(partsHeaderValue(p, "cls"))}" data-pt-status="${esc(partsHeaderValue(p, "status"))}" onclick="openPartDetail('${esc(p.pn)}')">
                    <td class="pn">${esc(p.pn)}</td>
                    <td>${esc(p.desc)}</td>
                    <td class="dim">${esc(p.supplier)}</td>
                    <td class="dim">${p.isKit ? '<span class="pill" style="background:var(--accent-soft,#eef);color:var(--accent,#36c)">KIT</span>' : esc(partItemTypeLabel(p))}</td>
                    <td class="right num">${fmtNum(p.onHand)}</td>
                    <td class="right num dim">${fmtNum(p.onPO)}</td>
                    <td class="right num dim">${fmtNum(p.daily, 2)}</td>
                    <td class="right num dim">${p.ltWeeks || 0}w</td>
                    <td class="right num">${fmtMoneyDec(p.cost)}</td>
                    <td class="right num">${fmtMoney((p.onHand||0)*(p.cost||0))}</td>
                    <td>${p.isKit ? '<span class="pill" style="background:var(--accent-soft,#eef);color:var(--accent,#36c)">KIT</span>' : p.itemType === 'do_not_order' ? '<span class="pill muted">DNO</span>' : `<span class="pill ${p.status==='critical'?'crit':p.status==='warning'?'warn':'ok'}">${p.status==='critical'?'CRIT':p.status==='warning'?'WARN':'OK'}</span>`}</td>
                  </tr>
                `).join("")}
                ${parts.length > 500 ? `<tr><td colspan="11" class="muted center tiny" style="padding:14px">Showing first 500 of ${parts.length} — use filters to narrow.</td></tr>` : ""}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;

  partsReapplyHeaderFiltersInPlace();
  partsInstallOutsideClick();
});

function openAddPartModal() {
  openModal(`
    <div class="modal-head"><div style="font-size:13px;font-weight:600">Add new part</div></div>
    <div class="modal-body">
      <div class="grid-2">
        <div class="field"><label>Part # *</label><input class="input lg" id="ap-pn" autofocus></div>
        <div class="field"><label>Description *</label><input class="input lg" id="ap-desc"></div>
        <div class="field"><label>Supplier *</label><input class="input lg" id="ap-supplier" list="ap-supplier-list">
          <datalist id="ap-supplier-list">${[...new Set(DB.parts.map(p=>p.supplier))].sort().map(s => `<option value="${esc(s)}">`).join("")}</datalist>
        </div>
        <div class="field"><label>Buyer</label><input class="input lg" id="ap-buyer" value="${esc(DB.settings.defaultBuyer||"")}"></div>
        <div class="field"><label>On Hand</label><input class="input lg num" type="number" min="0" id="ap-oh" value="0"></div>
        <div class="field"><label>Daily Use</label><input class="input lg num" type="number" min="0" step="0.01" id="ap-daily" value="1"></div>
        <div class="field"><label>Unit Cost</label><input class="input lg num" type="number" min="0" step="0.01" id="ap-cost" value="0"></div>
        <div class="field"><label>Lead (weeks)</label><input class="input lg num" type="number" min="0" step="0.5" id="ap-lt" value="4"></div>
        <div class="field"><label>MOQ</label><input class="input lg num" type="number" min="0" id="ap-moq" value="1"></div>
        <div class="field"><label>Class</label>
          <select class="select" id="ap-class">
            <option value="A">A</option><option value="B" selected>B</option><option value="C">C</option>
          </select>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" onclick="doAddPart()">+ Add part</button>
    </div>
  `);
}

function doAddPart() {
  const pn = $("#ap-pn").value.trim();
  if (!pn) { showToast("Part # required", "warn"); return; }
  if (DB.parts.some(p => p.pn === pn)) { showToast("Part # already exists", "warn"); return; }
  const desc = $("#ap-desc").value.trim();
  const supplier = $("#ap-supplier").value.trim();
  if (!desc || !supplier) { showToast("Description and supplier required", "warn"); return; }
  const part = {
    pn, desc, supplier,
    buyer: $("#ap-buyer").value.trim() || DB.settings.defaultBuyer,
    onHand: Math.max(0, Math.round(parseFloat($("#ap-oh").value) || 0)),
    daily: Math.max(0, parseFloat($("#ap-daily").value) || 0),
    cost: Math.max(0, parseFloat($("#ap-cost").value) || 0),
    ltWeeks: Math.max(0, parseFloat($("#ap-lt").value) || 0),
    moq: Math.max(0, parseInt($("#ap-moq").value) || 0),
    packSize: 1,
    partClass: $("#ap-class").value,
    category: "",
    notes: "",
    kanban: false,
    reasonCode: "MRP",
  };
  DB.parts.push(part);
  logAudit("part-add", `Added new part ${pn}`, { pn });
  saveDB();
  bumpStatusCache();
  closeModal();
  showToast(`${pn} added to catalog`, "ok");
  refresh();
}

function exportPartsAsCSV() {
  const headers = ["Part #","Description","Supplier","Buyer","Class","Category","On Hand","On PO","Daily Use","Cost","Lead Weeks","MOQ","Pack","Notes"];
  const stats = partsWithStatus();
  const rows = [headers].concat(stats.map(p => [
    p.pn, p.desc||"", p.supplier||"", p.buyer||"", p.partClass||"", p.category||"",
    p.onHand||0, p.onPO||0, p.daily||0, p.cost||0, p.ltWeeks||0, p.moq||0, p.packSize||1, (p.notes||"").replace(/"/g,'""')
  ]));
  const csv = rows.map(r => r.map(c => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(",")).join("\n");
  downloadFile(csv, `parts-catalog-${isoDate(TODAY)}.csv`, "text/csv");
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}
