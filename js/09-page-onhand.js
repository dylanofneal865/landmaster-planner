/* =====================================================
   09-page-onhand.js
   Sections: PAGE: ON-HAND INVENTORY UPDATE
   ===================================================== */

/* ============================================================
   PAGE: ON-HAND INVENTORY UPDATE
   The most important workflow: keeping on-hand counts accurate.
   Inline edits, bulk paste, deltas shown in real time.
   ============================================================ */
let OH_STATE = { search: "", supplier: "", status: "all", sortBy: "urgency", edits: new Map() };

registerRoute("onhand", () => {
  const stats = partsWithStatus();

  // Filter
  let parts = stats.slice();
  if (OH_STATE.search) {
    const q = OH_STATE.search.toLowerCase();
    parts = parts.filter(p => p.pn.toLowerCase().includes(q) || (p.desc||"").toLowerCase().includes(q));
  }
  if (OH_STATE.supplier) parts = parts.filter(p => p.supplier === OH_STATE.supplier);
  if (OH_STATE.status === "edited") parts = parts.filter(p => OH_STATE.edits.has(p.pn));
  else if (OH_STATE.status === "critical") parts = parts.filter(p => p.status === "critical");
  else if (OH_STATE.status === "warning") parts = parts.filter(p => p.status === "warning");
  else if (OH_STATE.status === "ok") parts = parts.filter(p => p.status === "ok");
  else if (OH_STATE.status === "zero") parts = parts.filter(p => (p.onHand||0) === 0);

  // Sort
  parts.sort((a,b) => {
    switch (OH_STATE.sortBy) {
      case "pn": return a.pn.localeCompare(b.pn);
      case "supplier": return a.supplier.localeCompare(b.supplier);
      case "onhand": return (a.onHand||0) - (b.onHand||0);
      case "value": return (b.onHand||0)*(b.cost||0) - (a.onHand||0)*(a.cost||0);
      case "urgency":
      default: return a.urgency - b.urgency;
    }
  });

  const suppliers = [...new Set(stats.map(p => p.supplier))].sort();
  const editCount = OH_STATE.edits.size;

  // Compute net delta of pending edits
  let deltaQty = 0, deltaVal = 0;
  for (const [pn, newVal] of OH_STATE.edits.entries()) {
    const part = DB.parts.find(p => p.pn === pn);
    if (!part) continue;
    const d = newVal - (part.onHand || 0);
    deltaQty += d;
    deltaVal += d * (part.cost || 0);
  }

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">On-Hand Update</div>
          <div class="page-sub mono">${parts.length} OF ${stats.length} PARTS · UPDATE COUNTS WHERE THEY'VE CHANGED</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="openOnHandBulkModal()">⇪ Bulk paste</button>
          <button class="btn" onclick="openOnHandQuickModal()">⚡ Quick adjust</button>
        </div>
      </div>

      <div class="panel">
        <div class="filterbar">
          <div class="search-input">
  <input class="input" placeholder="Search part # or description…" value="${esc(OH_STATE.search)}" onchange="OH_STATE.search = this.value; refresh()" onkeydown="if(event.key === 'Enter'){ OH_STATE.search = this.value; refresh(); }">
</div>

<select class="select" onchange="OH_STATE.status = this.value; refresh()">
            <option value="all" ${OH_STATE.status==='all'?'selected':''}>All parts</option>
            <option value="critical" ${OH_STATE.status==='critical'?'selected':''}>Critical only</option>
            <option value="warning" ${OH_STATE.status==='warning'?'selected':''}>Warning only</option>
            <option value="ok" ${OH_STATE.status==='ok'?'selected':''}>OK only</option>
            <option value="zero" ${OH_STATE.status==='zero'?'selected':''}>Zero on hand</option>
            <option value="edited" ${OH_STATE.status==='edited'?'selected':''}>Edited (${editCount})</option>
          </select>
          <select class="select" onchange="OH_STATE.supplier = this.value; refresh()">
            <option value="">All suppliers</option>
            ${suppliers.map(s => `<option value="${esc(s)}" ${OH_STATE.supplier===s?'selected':''}>${esc(s)}</option>`).join("")}
          </select>
          <div class="grow"></div>
          <span class="muted tiny">Sort:</span>
          <select class="select" onchange="OH_STATE.sortBy = this.value; refresh()">
            <option value="urgency" ${OH_STATE.sortBy==='urgency'?'selected':''}>Most urgent</option>
            <option value="onhand" ${OH_STATE.sortBy==='onhand'?'selected':''}>Lowest on-hand</option>
            <option value="value" ${OH_STATE.sortBy==='value'?'selected':''}>Highest $ value</option>
            <option value="supplier" ${OH_STATE.sortBy==='supplier'?'selected':''}>By supplier</option>
            <option value="pn" ${OH_STATE.sortBy==='pn'?'selected':''}>By part #</option>
          </select>
        </div>
        <div class="panel-body flush">
          ${parts.length === 0 ? `
            <div class="empty">
              <div class="empty-title">No matches</div>
              <div class="empty-msg">Adjust filters or search.</div>
            </div>
          ` : `
            <div class="tbl-wrap">
              <table class="tbl">
                <thead><tr>
                  <th>Part</th>
                  <th>Description</th>
                  <th>Supplier</th>
                  <th class="right">Status</th>
                  <th class="right">On PO</th>
                  <th class="right">Current</th>
                  <th class="right" style="width:200px">Update On-Hand</th>
                  <th class="right">Days Cover</th>
                </tr></thead>
                <tbody>
                  ${parts.map(p => {
                    const editing = OH_STATE.edits.has(p.pn);
                    const newVal = editing ? OH_STATE.edits.get(p.pn) : (p.onHand || 0);
                    const delta = newVal - (p.onHand || 0);
                    return `
                    <tr class="${editing ? 'oh-row-edited' : ''}" data-pn="${esc(p.pn)}">
                      <td class="pn clickable" onclick="openPartDetail('${esc(p.pn)}')">${esc(p.pn)}</td>
                      <td>${esc(p.desc)}</td>
                      <td class="dim">${esc(p.supplier)}</td>
                      <td class="right">
                        <span class="pill ${p.status==='critical'?'crit':p.status==='warning'?'warn':'ok'}">${p.status==='critical'?'CRIT':p.status==='warning'?'WARN':'OK'}</span>
                      </td>
                      <td class="right num dim">${fmtNum(p.onPO)}</td>
                      <td class="right num">${fmtNum(p.onHand)}</td>
                      <td class="right">
                        <button class="oh-step minus" onclick="ohStep('${esc(p.pn)}', -1)" title="Decrease by 1">−</button>
                        <input class="oh-input ${editing?'edited':''}" type="number" min="0" value="${newVal}"
                          oninput="ohEdit('${esc(p.pn)}', this.value)"
                          onfocus="OH_STATE._focusPn='${esc(p.pn)}'; this.select()"
                          onkeydown="ohKey(event, '${esc(p.pn)}')">
                        <button class="oh-step plus" onclick="ohStep('${esc(p.pn)}', 1)" title="Increase by 1">+</button>
                        ${delta !== 0 ? `<span class="oh-delta ${delta > 0 ? 'up' : 'down'}">${delta > 0 ? '+' : ''}${fmtNum(delta)}</span>` : ''}
                      </td>
                      <td class="right">
                        <span class="num bold ${p.status==='critical'?'text-crit':p.status==='warning'?'text-warn':''}">${p.daysOfCover === Infinity ? '∞' : p.daysOfCover + 'd'}</span>
                      </td>
                    </tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>
          `}
        </div>
        ${editCount > 0 ? `
          <div class="action-bar">
            <span class="count">${editCount}</span>
            <span>pending update${editCount===1?'':'s'} · net Δ ${deltaQty>0?'+':''}${fmtNum(deltaQty)} units · ${deltaVal>=0?'+':''}${fmtMoney(deltaVal)}</span>
            <div class="grow" style="flex:1"></div>
            <button class="btn" onclick="OH_STATE.edits.clear(); refresh()">Discard all</button>
            <button class="btn primary" onclick="commitOnHandEdits()">✓ Apply ${editCount} update${editCount===1?'':'s'}</button>
          </div>
        ` : `
          <div class="action-bar" style="background:var(--bg-2);color:var(--t3)">
            <span style="font-size:11px;font-family:var(--f-mono);letter-spacing:0.04em">TIP: TYPE NEW VALUES, USE +/− BUTTONS, OR PASTE FROM SPREADSHEET. APPLY ALL AT ONCE.</span>
          </div>
        `}
      </div>
    </div>`;

  // Restore focus if it was on an input (avoid losing typing position)
  setTimeout(() => {
    const focusPn = OH_STATE._focusPn;
    if (focusPn) {
      const inp = document.querySelector(`tr[data-pn="${focusPn}"] .oh-input`);
      if (inp) { inp.focus(); inp.select(); }
      OH_STATE._focusPn = null;
    }
  }, 0);
});

function ohEdit(pn, valueStr) {
  const part = DB.parts.find(p => p.pn === pn);
  if (!part) return;
  const v = parseFloat(valueStr);
  if (isNaN(v) || v < 0) return;
  const rounded = Math.round(v);
  if (rounded === (part.onHand || 0)) {
    OH_STATE.edits.delete(pn);
  } else {
    OH_STATE.edits.set(pn, rounded);
  }
  // Don't full re-render on every keystroke — would lose focus
  // Just update the row visuals
  const tr = document.querySelector(`tr.oh-row-edited[data-pn="${pn}"], tr[data-pn="${pn}"]`);
  // Update the action bar lazily after a brief debounce
  clearTimeout(OH_STATE._debounce);
  OH_STATE._debounce = setTimeout(() => refresh(), 350);
}

function ohStep(pn, delta) {
  const part = DB.parts.find(p => p.pn === pn);
  if (!part) return;
  const cur = OH_STATE.edits.has(pn) ? OH_STATE.edits.get(pn) : (part.onHand || 0);
  const next = Math.max(0, cur + delta);
  if (next === (part.onHand || 0)) {
    OH_STATE.edits.delete(pn);
  } else {
    OH_STATE.edits.set(pn, next);
  }
  refresh();
}

function ohKey(e, pn) {
  if (e.key === "Enter") {
    e.preventDefault();
    e.target.blur();
    OH_STATE._focusPn = null;
    refresh();
  } else if (e.key === "Escape") {
    OH_STATE.edits.delete(pn);
    refresh();
  }
}

function commitOnHandEdits() {
  if (OH_STATE.edits.size === 0) { showToast("Nothing to update", "warn"); return; }
  const list = [...OH_STATE.edits.entries()];
  let count = 0, totalDelta = 0;
  for (const [pn, newVal] of list) {
    const part = DB.parts.find(p => p.pn === pn);
    if (!part) continue;
    const old = part.onHand || 0;
    const delta = newVal - old;
    if (delta === 0) continue;
    part.onHand = newVal;
    logAudit("oh-edit", `${pn}: ${fmtNum(old)} → ${fmtNum(newVal)} (${delta>0?'+':''}${fmtNum(delta)})`, { pn, oldQ: old, newQ: newVal, delta });
    count++;
    totalDelta += delta;
  }
  OH_STATE.edits.clear();
  saveDB();
  bumpStatusCache();
  showToast(`${count} on-hand count${count===1?'':'s'} updated · net ${totalDelta>0?'+':''}${fmtNum(totalDelta)}`, "ok", "Inventory updated");
  refresh();
}

/* Quick on-hand modal — adjust a single part fast from anywhere */
function openOnHandQuickModal(prefillPn = "") {
  let q = prefillPn;
  let selectedPN = prefillPn || null;

  function render() {
    const matches = q ? DB.parts.filter(p =>
      p.pn.toLowerCase().includes(q.toLowerCase()) || (p.desc||"").toLowerCase().includes(q.toLowerCase())
    ).slice(0, 8) : [];
    const part = selectedPN ? DB.parts.find(p => p.pn === selectedPN) : null;

    openModal(`
      <div class="modal-head">
        <div style="font-size: 13px; font-weight: 600;">Quick on-hand adjustment</div>
        <div class="muted tiny" style="margin-top:4px">Search by part #, then enter the new count.</div>
      </div>
      <div class="modal-body">
        ${!part ? `
          <div class="field">
            <label>Find part</label>
            <input class="input lg" id="qoh-search" autofocus placeholder="Type part # or description…" value="${esc(q)}">
          </div>
          ${matches.length > 0 ? `
            <div class="tbl-wrap" style="margin-top:8px">
              <table class="tbl">
                <thead><tr><th>Part</th><th>Description</th><th class="right">On Hand</th></tr></thead>
                <tbody>
                  ${matches.map(p => `
                    <tr class="clickable" onclick="(window._qohSelect)('${esc(p.pn)}')">
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
            <div class="stat"><div class="stat-label">Current</div><div class="stat-value">${fmtNum(part.onHand)}</div></div>
          </div>
          <div class="grid-2" style="margin-top:14px">
            <div class="field">
              <label>New on-hand count</label>
              <input class="input lg" id="qoh-new" type="number" min="0" autofocus value="${part.onHand||0}">
            </div>
            <div class="field">
              <label>Reason / note (optional)</label>
              <input class="input lg" id="qoh-note" placeholder="Cycle count, found extra, scrapped…">
            </div>
          </div>
          <div class="row gap-md" style="margin-top:8px">
            <button class="btn" onclick="(window._qohAdjust)(-10)">−10</button>
            <button class="btn" onclick="(window._qohAdjust)(-1)">−1</button>
            <button class="btn" onclick="(window._qohAdjust)(1)">+1</button>
            <button class="btn" onclick="(window._qohAdjust)(10)">+10</button>
            <div class="grow"></div>
            <button class="btn ghost" onclick="(window._qohClear)()">← Pick different part</button>
          </div>
        `}
      </div>
      <div class="modal-foot">
        <button class="btn" data-close>Cancel</button>
        ${part ? `<button class="btn primary" onclick="(window._qohSave)()">✓ Save</button>` : ""}
      </div>
    `);

    setTimeout(() => {
      const inp = $("#qoh-search");
      if (inp) inp.oninput = (e) => { q = e.target.value; render(); };
      const newInp = $("#qoh-new");
      if (newInp) newInp.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); window._qohSave(); } };
    }, 50);
  }

  window._qohSelect = (pn) => { selectedPN = pn; render(); };
  window._qohClear = () => { selectedPN = null; q = ""; render(); };
  window._qohAdjust = (d) => {
    const inp = $("#qoh-new");
    if (!inp) return;
    inp.value = Math.max(0, (parseFloat(inp.value)||0) + d);
    inp.focus();
  };
  window._qohSave = () => {
    if (!selectedPN) return;
    const part = DB.parts.find(p => p.pn === selectedPN);
    if (!part) return;
    const newVal = Math.max(0, Math.round(parseFloat($("#qoh-new").value) || 0));
    const note = $("#qoh-note").value.trim();
    const old = part.onHand || 0;
    const delta = newVal - old;
    if (delta === 0) { showToast("No change", "warn"); return; }
    part.onHand = newVal;
    logAudit("oh-edit", `${selectedPN}: ${fmtNum(old)} → ${fmtNum(newVal)} (${delta>0?'+':''}${fmtNum(delta)})${note ? ' · ' + note : ''}`, { pn: selectedPN, oldQ: old, newQ: newVal, delta, note });
    saveDB();
    bumpStatusCache();
    showToast(`${selectedPN}: ${fmtNum(old)} → ${fmtNum(newVal)} (${delta>0?'+':''}${fmtNum(delta)})`, "ok", "Updated");
    closeModal();
    refresh();
  };

  render();
}

/* Bulk paste on-hand modal — paste tab/space/comma separated PN<->qty rows */
function openOnHandBulkModal() {
  openModal(`
    <div class="modal-head">
      <div style="font-size: 13px; font-weight: 600;">Bulk on-hand update</div>
      <div class="muted tiny" style="margin-top:4px">Paste rows in the format: <span class="mono">PART_NUMBER &lt;TAB or SPACE&gt; QTY</span> — one part per line. Headers are auto-skipped.</div>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>Paste data</label>
        <textarea class="paste-area" id="bulk-paste-area" autofocus placeholder="C9-10000	42&#10;C9-10003	158&#10;C9-10006	0"></textarea>
      </div>
      <div class="row gap-md" style="margin-top:8px">
        <button class="btn" onclick="bulkParsePreview()">Parse & preview →</button>
        <div class="grow"></div>
      </div>
      <div id="bulk-preview"></div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" id="bulk-apply" onclick="bulkApply()" disabled>Apply 0 updates</button>
    </div>
  `);
}

let _bulkParsed = null;

function bulkParsePreview() {
  const txt = ($("#bulk-paste-area").value || "").trim();
  if (!txt) { showToast("Paste some data first", "warn"); return; }
  const rows = txt.split(/\r?\n/).map(r => r.trim()).filter(Boolean);

  const parsed = [];
  let skipped = 0, badQty = 0, unknown = 0, headerSkipped = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Split on tab, comma, multi-space, semicolon, pipe
    const cols = row.split(/[\t,;|]+|\s{2,}/).map(s => s.trim()).filter(Boolean);
    let pnRaw, qtyRaw;
    if (cols.length === 1) {
      // Try splitting on single space — last token is qty
      const tokens = row.split(/\s+/);
      qtyRaw = tokens[tokens.length - 1];
      pnRaw = tokens.slice(0, -1).join(" ");
    } else if (cols.length >= 2) {
      pnRaw = cols[0];
      qtyRaw = cols[cols.length - 1];
    } else continue;

    if (!pnRaw) { skipped++; continue; }
    const qty = parseFloat((qtyRaw || "").replace(/[^0-9.\-]/g, ""));
    // Header detection — first row with non-numeric qty
    if (i === 0 && (isNaN(qty) || /[a-z]/i.test(qtyRaw))) { headerSkipped++; continue; }
    if (isNaN(qty) || qty < 0) { badQty++; continue; }

    // Match part — try exact, then case-insensitive
    let part = DB.parts.find(p => p.pn === pnRaw);
    if (!part) part = DB.parts.find(p => p.pn.toLowerCase() === pnRaw.toLowerCase());
    if (!part) { unknown++; parsed.push({ pn: pnRaw, qty: Math.round(qty), matched: false }); continue; }

    const newQ = Math.round(qty);
    parsed.push({
      pn: part.pn,
      desc: part.desc,
      oldQ: part.onHand || 0,
      newQ,
      delta: newQ - (part.onHand || 0),
      matched: true,
    });
  }

  _bulkParsed = parsed;
  const matched = parsed.filter(p => p.matched);
  const changes = matched.filter(p => p.delta !== 0);

  $("#bulk-apply").disabled = changes.length === 0;
  $("#bulk-apply").textContent = `Apply ${changes.length} update${changes.length===1?'':'s'}`;
  $("#bulk-apply").classList.toggle("primary", changes.length > 0);

  $("#bulk-preview").innerHTML = `
    <div class="dr-section">Preview</div>
    <div class="stat-strip" style="margin-bottom:10px">
      <div class="stat"><div class="stat-label">Total Rows</div><div class="stat-value">${rows.length}</div></div>
      <div class="stat"><div class="stat-label">Matched</div><div class="stat-value ok">${matched.length}</div></div>
      <div class="stat"><div class="stat-label">Changes</div><div class="stat-value">${changes.length}</div></div>
      <div class="stat"><div class="stat-label">Unknown PN</div><div class="stat-value ${unknown>0?'warn':''}">${unknown}</div></div>
      <div class="stat"><div class="stat-label">Bad Qty</div><div class="stat-value ${badQty>0?'warn':''}">${badQty}</div></div>
      ${headerSkipped > 0 ? `<div class="stat"><div class="stat-label">Header</div><div class="stat-value">skipped</div></div>` : ""}
    </div>
    <div class="tbl-wrap" style="max-height:280px;overflow-y:auto">
      <table class="tbl">
        <thead><tr><th>Part</th><th>Description</th><th class="right">From</th><th class="right">To</th><th class="right">Δ</th><th></th></tr></thead>
        <tbody>
          ${parsed.slice(0, 100).map(r => r.matched ? `
            <tr>
              <td class="pn">${esc(r.pn)}</td>
              <td>${esc(r.desc||"")}</td>
              <td class="right num dim">${fmtNum(r.oldQ)}</td>
              <td class="right num bold">${fmtNum(r.newQ)}</td>
              <td class="right">${r.delta!==0 ? `<span class="oh-delta ${r.delta>0?'up':'down'}">${r.delta>0?'+':''}${fmtNum(r.delta)}</span>` : '<span class="dim">—</span>'}</td>
              <td><span class="pill ok">match</span></td>
            </tr>
          ` : `
            <tr>
              <td class="pn dim">${esc(r.pn)}</td>
              <td colspan="4" class="dim">— part not found —</td>
              <td><span class="pill warn">skip</span></td>
            </tr>
          `).join("")}
          ${parsed.length > 100 ? `<tr><td colspan="6" class="muted center tiny">…and ${parsed.length-100} more rows</td></tr>` : ""}
        </tbody>
      </table>
    </div>
  `;
}

function bulkApply() {
  if (!_bulkParsed) return;
  const changes = _bulkParsed.filter(r => r.matched && r.delta !== 0);
  if (!changes.length) { showToast("No changes to apply", "warn"); return; }
  let applied = 0, totalDelta = 0;
  for (const r of changes) {
    const part = DB.parts.find(p => p.pn === r.pn);
    if (!part) continue;
    part.onHand = r.newQ;
    logAudit("oh-bulk", `${r.pn}: ${fmtNum(r.oldQ)} → ${fmtNum(r.newQ)} (bulk paste)`, { pn: r.pn, oldQ: r.oldQ, newQ: r.newQ, delta: r.delta });
    applied++;
    totalDelta += r.delta;
  }
  saveDB();
  bumpStatusCache();
  _bulkParsed = null;
  closeModal();
  showToast(`${applied} parts updated · net ${totalDelta>0?'+':''}${fmtNum(totalDelta)}`, "ok", "Bulk update applied");
  refresh();
}
