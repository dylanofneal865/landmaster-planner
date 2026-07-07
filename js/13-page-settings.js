/* =====================================================
   13-page-settings.js
   Sections: PAGE: SETTINGS
   ===================================================== */

/* ============================================================
   PAGE: SETTINGS
   ============================================================ */
registerRoute("settings", () => {
  const s = DB.settings;
  const poLineCount = (DB.pos || []).reduce((sum, po) => sum + (po.lines?.length || 0), 0);
  const lastPoSync = (DB.audit || []).find(a => a.type === "acumatica-po-sync")?.ts || null;
  const lastOnHandSync = (DB.audit || []).find(a => a.type === "acumatica-sync")?.ts || null;
  const lastBomSync = (DB.audit || []).find(a => a.type === "acumatica-bom-sync")?.ts || null;
  // BOM links load asynchronously after first paint; distinguish "not yet
  // arrived" (undefined) from "loaded but empty" (0) so the card doesn't
  // misleadingly show "0 links" during the brief boot window.
  const bomLinksLoaded = Array.isArray(DB.bomLinks);
  const bomLinksCount = bomLinksLoaded ? DB.bomLinks.length : null;
  const fgCount = (typeof FINISHED_GOODS !== "undefined" && Array.isArray(FINISHED_GOODS)) ? FINISHED_GOODS.length : 0;
  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Settings</div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Alert thresholds</div>
        </div>
        <div class="panel-body">
          <div class="settings-grid">
            <label>Safety buffer (days)</label>
            <div>
              <input class="input" type="number" min="0" id="set-safety" value="${s.safetyDays}">
              <div class="help">Extra buffer beyond lead time</div>
            </div>
            <label>Warning threshold (days)</label>
            <div>
              <input class="input" type="number" min="0" id="set-warn" value="${s.alertWarning}">
              <div class="help">If days-of-cover margin (after lead time) is at or below this, part is warning.</div>
            </div>
            <label>Workdays per week</label>
            <div>
              <input class="input" type="number" min="1" max="7" id="set-workdays" value="${s.workdaysPerWeek}">
              <div class="help">Used for daily-use rate calculations (5 = Mon–Fri).</div>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Defaults</div>
        </div>
        <div class="panel-body">
          <div class="settings-grid">
            <label>Default buyer</label>
            <div><input class="input" id="set-buyer" value="${esc(s.defaultBuyer||"")}"></div>
            <label>Currency</label>
            <div><input class="input" id="set-currency" value="${esc(s.currency||"USD")}" maxlength="6"></div>
            <label>PO number prefix</label>
            <div><input class="input" id="set-po-prefix" value="${esc(s.poPrefix||"PO-")}"></div>
            <!-- Next PO# row hidden from view — the underlying DB.poNum
                 logic and nextPONumber() flow are unchanged. The input
                 stays in the DOM (display:none) so saveSettings() can
                 still read it and round-trip the value without surprises. -->
            <label style="display:none">Next PO #</label>
            <div style="display:none">
              <input class="input num" type="number" min="1" id="set-po-next" value="${DB.poNum}">
            </div>
          </div>
          <div class="row" style="margin-top:14px">
            <button class="btn primary" onclick="saveSettings()">✓ Save settings</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Purchase Orders</div>
          <div class="panel-sub">Sourced live from Acumatica via Supabase — no manual file needed.</div>
        </div>
        <div class="panel-body">
          <div class="row gap-md">
            <span class="pill ok">● Acumatica · live</span>
            <span class="mono dim" style="font-size:11px">${DB.pos.length} POs · ${poLineCount} lines</span>
            <div class="grow"></div>
            <span class="muted tiny">${lastPoSync ? 'Last sync ' + fmtDate(lastPoSync) : 'Awaiting first sync'}</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">On-Hand</div>
          <div class="panel-sub">Sourced live from Acumatica via Supabase — no manual file needed.</div>
        </div>
        <div class="panel-body">
          <div class="row gap-md">
            <span class="pill ok">● Acumatica · live</span>
            <span class="mono dim" style="font-size:11px">${DB.parts.length} parts</span>
            <div class="grow"></div>
            <span class="muted tiny">${lastOnHandSync ? 'Last sync ' + fmtDate(lastOnHandSync) : 'Awaiting first sync'}</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Multi Level BOM</div>
          <div class="panel-sub">Finished-goods BOM structure, synced nightly from Acumatica.</div>
        </div>
        <div class="panel-body">
          <div class="row gap-md">
            <span class="pill ok">● Acumatica · live</span>
            <span class="mono dim" style="font-size:11px">${bomLinksLoaded ? `${fmtNum(bomLinksCount)} links · ${fgCount} finished goods` : 'loading…'}</span>
            <div class="grow"></div>
            <span class="muted tiny">Syncs daily 6:00 AM${lastBomSync ? ' · last ' + fmtDate(lastBomSync) : ''}</span>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Usage Excel sync</div>
          <div class="panel-sub">${fsSupported() ? 'Usage workbook: live two-way Excel sync (outbound writes, pull to read back).' : '<span class="text-warn">Your browser does not support live Excel sync. Use Chrome, Edge, or Brave for this feature.</span>'}</div>
        </div>
        <div class="panel-body">
          ${fsSupported() ? `
            <div class="settings-grid" style="grid-template-columns: 200px 1fr">
              ${["usage"].map(k => {
                const handle = _fileHandles[k];
                const linked = !!handle;
                const labels = {onhand:"On-Hand workbook",usage:"Usage workbook"};
                return `
                  <label>${labels[k]}</label>
                  <div>
                    ${linked ? `
                      <div class="row gap-md">
                        <span class="pill ok">● Linked</span>
                        <span class="mono dim" style="font-size:11px">${esc(handle.name)}</span>
                        <div class="grow"></div>
                        <button class="btn sm" onclick="syncWorkbookNow('${k}')">↑ Push now</button>
                        <button class="btn sm" onclick="pullFromExcel('${k}')">↓ Pull from Excel</button>
                        <button class="btn sm ghost" onclick="disconnectFile('${k}').then(refresh)">Unlink</button>
                      </div>
                      <div class="help">${k === 'onhand' ? 'Auto-writes the full inventory snapshot. Pull reads on-hand counts back from Excel — perfect for warehouse cycle counts.' :
                                          'Auto-writes every usage transaction. Pull merges new rows added in Excel.'}</div>
                    ` : `
                      <div class="row gap-md">
                        <button class="btn primary" onclick="pickAndLinkFile('${k}', 'save').then(refresh)">Connect new file</button>
                        <button class="btn" onclick="pickAndLinkFile('${k}', 'open').then(refresh)">Connect existing file</button>
                        <span class="muted tiny">Pick a location once — the app remembers it.</span>
                      </div>
                    `}
                  </div>
                `;
              }).join("")}

              <label>Auto-sync writes</label>
              <div>
                <label class="row" style="gap:8px;cursor:pointer">
                  <input type="checkbox" class="chk" id="set-autosync" ${DB.settings.autoSyncExcel?'checked':''} onchange="DB.settings.autoSyncExcel = this.checked; saveDB(); showToast(this.checked ? 'Auto-sync ON' : 'Auto-sync OFF', 'info')">
                  <span>Automatically write to linked workbooks on every change (debounced 1.2s)</span>
                </label>
              </div>
            </div>
          ` : `
            <p class="muted tiny">Open this app in Chrome, Edge, Brave, or Opera to enable live two-way sync with Excel.</p>
            <p class="muted tiny">In other browsers you can still use the Import / Export buttons below.</p>
          `}
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Service Usage Import</div>
          <div class="panel-sub">Monthly import of sales order shipments from Acumatica's 'Sales Orders by Line Item' report. Updates the Service Usage page and Service Queue urgency.</div>
        </div>
        <div class="panel-body">
          <div class="row gap-md">
            <button class="btn" onclick="$('#sales-order-import-input').click()">⇪ Import Sales Orders</button>
            <input type="file" id="sales-order-import-input" accept=".xlsx" style="display:none" onchange="handleSalesOrderImportFile(event)">
            ${DB.meta.lastSalesOrderImport ? `
              <span class="muted tiny">Last imported: ${fmtDate(DB.meta.lastSalesOrderImport.date)} from <span class="mono">${esc(DB.meta.lastSalesOrderImport.fileName)}</span> · ${DB.meta.lastSalesOrderImport.addedCount} added</span>
            ` : `<span class="muted tiny">No imports yet.</span>`}
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <div class="panel-title">Data</div>
          <div class="panel-sub">${DB.parts.length} parts · ${DB.pos.length} POs · ${(DB.usage||[]).length} usage txns · ${Object.keys(DB.kitBoms || {}).length} kit BOMs · ${DB.audit.length} log entries · source: ${esc(DB.meta.dataSource||"unknown")}${DB.meta.lastImport ? " · imported " + fmtDate(DB.meta.lastImport) : ""}</div>
        </div>
        <div class="panel-body col">
          <div class="row gap-md">
            <button class="btn" onclick="$('#file-input').click()">⇪ Import inventory from spreadsheet</button>
            <button class="btn" onclick="exportFullDB()">⇩ Export full database (JSON)</button>
            <button class="btn" onclick="importFullDBPrompt()">⇪ Restore database (JSON)</button>
          </div>
          <div class="row gap-md mt-sm">
            <button class="btn" onclick="$('#kit-bom-file-input').click()">⇪ Import Kit BOMs (Acumatica Excel)</button>
            <input type="file" id="kit-bom-file-input" accept=".xlsx" style="display:none" onchange="handleKitBomsImportFile(event)">
          </div>
          <div class="row gap-md mt-sm">
            <button class="btn" onclick="exportPartsAsCSV()">⇩ Export parts (CSV)</button>
            <button class="btn" onclick="exportAllPOsAsCSV()">⇩ Export all POs (CSV)</button>
            <button class="btn" onclick="exportAuditAsCSV()">⇩ Export audit (CSV)</button>
            <button class="btn" onclick="downloadXlsxOnce('pos')">⇩ Download POs (XLSX)</button>
            <button class="btn" onclick="downloadXlsxOnce('onhand')">⇩ Download On-Hand (XLSX)</button>
            <button class="btn" onclick="downloadXlsxOnce('usage')">⇩ Download Usage (XLSX)</button>
          </div>
          <div class="row gap-md" style="margin-top:8px;border-top:1px solid var(--line);padding-top:14px">
            <button class="btn danger" onclick="confirmReset()">↺ Reset all data (load fresh sample)</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><div class="panel-title">Keyboard shortcuts</div></div>
        <div class="panel-body">
          <div class="settings-grid">
            <label>Command palette</label><div><span class="cmd-kbd">⌘ K</span> or <span class="cmd-kbd">Ctrl K</span> · search anything</div>
            <label>Quick on-hand adjust</label><div><span class="cmd-kbd">U</span></div>
            <label>New PO</label><div><span class="cmd-kbd">N</span></div>
            <label>Go to Dashboard</label><div><span class="cmd-kbd">G</span> then <span class="cmd-kbd">D</span></div>
            <label>Go to Order Queue</label><div><span class="cmd-kbd">G</span> then <span class="cmd-kbd">Q</span></div>
            <label>Go to POs</label><div><span class="cmd-kbd">G</span> then <span class="cmd-kbd">P</span></div>
            <label>Go to On-Hand</label><div><span class="cmd-kbd">G</span> then <span class="cmd-kbd">O</span></div>
            <label>Go to Parts Catalog</label><div><span class="cmd-kbd">G</span> then <span class="cmd-kbd">C</span></div>
            <label>Go to Suppliers</label><div><span class="cmd-kbd">G</span> then <span class="cmd-kbd">S</span></div>
            <label>Go to Audit Log</label><div><span class="cmd-kbd">G</span> then <span class="cmd-kbd">A</span></div>
            <label>Go to Settings</label><div><span class="cmd-kbd">G</span> then <span class="cmd-kbd">T</span></div>
            <label>Close drawer/modal</label><div><span class="cmd-kbd">Esc</span></div>
          </div>
        </div>
      </div>
    </div>`;
});

function saveSettings() {
  const s = DB.settings;
  s.safetyDays = Math.max(0, parseInt($("#set-safety").value) || 0);
  s.alertWarning = Math.max(0, parseInt($("#set-warn").value) || 0);
  s.workdaysPerWeek = clamp(parseInt($("#set-workdays").value) || 5, 1, 7);
  s.defaultBuyer = $("#set-buyer").value.trim();
  s.currency = $("#set-currency").value.trim() || "USD";
  s.poPrefix = $("#set-po-prefix").value.trim() || "PO-";
  DB.poNum = Math.max(1, parseInt($("#set-po-next").value) || DB.poNum);
  logAudit("settings", "Settings updated");
  saveDB();
  bumpStatusCache();
  showToast("Settings saved", "ok");
  refresh();
}

function exportFullDB() {
  const json = JSON.stringify(DB, null, 2);
  downloadFile(json, `landmaster-backup-${isoDate(TODAY)}.json`, "application/json");
  showToast("Full database exported", "ok");
}

function exportAllPOsAsCSV() {
  const headers = ["PO #","Supplier","Status","Buyer","Created","Expected","Received","Part #","Description","Qty","Qty Received","Cost","Line Status","Line Notes"];
  const rows = [headers];
  for (const po of DB.pos) {
    if (po.lines.length === 0) {
      rows.push([po.num, po.supplier, po.status, displayBuyer(po), po.createdDate||"", po.expectedDate||"", po.receivedDate||"", "","","","","","",""]);
    }
    for (const ln of po.lines) {
      const part = DB.parts.find(p => p.pn === ln.pn);
      rows.push([po.num, po.supplier, po.status, displayBuyer(po), po.createdDate||"", po.expectedDate||"", po.receivedDate||"",
        ln.pn, part?.desc||"", ln.qty||0, ln.qtyReceived||0, ln.cost||0, ln.status, (ln.notes||"").replace(/"/g,'""')]);
    }
  }
  const csv = rows.map(r => r.map(c => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(",")).join("\n");
  downloadFile(csv, `purchase-orders-${isoDate(TODAY)}.csv`, "text/csv");
}

function importFullDBPrompt() {
  openModal(`
    <div class="modal-head"><div class="head-sm">Restore database from JSON</div></div>
    <div class="modal-body">
      <p class="muted tiny" style="margin-bottom:10px">Paste a previously exported Landmaster backup JSON. This <strong>replaces</strong> all current data.</p>
      <textarea class="paste-area" id="db-restore" placeholder='{"settings":{...},"parts":[...],"pos":[...]}'></textarea>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn danger" onclick="doImportFullDB()">Replace all data</button>
    </div>
  `);
}

function doImportFullDB() {
  try {
    const txt = $("#db-restore").value.trim();
    if (!txt) { showToast("Paste JSON first", "warn"); return; }
    const parsed = JSON.parse(txt);
    if (!parsed.parts || !Array.isArray(parsed.parts)) throw new Error("Missing or invalid 'parts'");
    if (!parsed.pos || !Array.isArray(parsed.pos)) throw new Error("Missing or invalid 'pos'");
    DB = { ...DEFAULTS, ...parsed,
      settings: { ...DEFAULTS.settings, ...(parsed.settings || {}) },
      meta: { ...DEFAULTS.meta, ...(parsed.meta || {}), dataSource: "imported", loaded: new Date().toISOString() },
    };
    if (!Array.isArray(DB.audit)) DB.audit = [];
    logAudit("import", `Restored database (${DB.parts.length} parts, ${DB.pos.length} POs)`);
    saveDB();
    bumpStatusCache();
    closeModal();
    showToast("Database restored", "ok");
    navigate("dashboard");
  } catch (e) {
    showToast("Import failed: " + e.message, "crit");
  }
}

function confirmReset() {
  if (!gateDelete()) return;
  openModal(`
    <div class="modal-head"><div class="head-sm">Reset all data?</div></div>
    <div class="modal-body">
      <p>This deletes <strong>everything</strong> — parts, POs, audit log — and loads fresh sample data.</p>
      <p class="muted tiny">Consider exporting a backup first.</p>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn" onclick="exportFullDB()">Export backup first</button>
      <button class="btn danger" onclick="doReset()">Reset everything</button>
    </div>
  `);
}

function handleKitBomsImportFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  showToast(`Parsing ${file.name}…`, "info");
  importKitBomsFromExcel(file).then(result => {
    showToast(`Imported ${result.totalKits} kit BOMs with ${result.totalComponents} component links`, "ok", "Kit BOMs");
    refresh();
  }).catch(err => {
    console.error("Kit BOM import failed:", err);
    showToast("Kit BOM import failed: " + (err.message || err), "crit");
  });
}

async function doReset() {
  resetDB();
  await bootstrapSample();
  DB = await loadDB();
  bumpStatusCache();
  closeModal();
  showToast("Reset to embedded Landmaster snapshot", "ok");
  navigate("dashboard");
}

/* ============================================================
   SERVICE USAGE IMPORT — Acumatica "Sales Orders by Line Item"
   ============================================================ */

function handleSalesOrderImportFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";  // allow re-selecting the same file later
  if (!file) return;

  showToast(`Parsing ${file.name}…`, "info");
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const preview = parseSalesOrderWorkbook(e.target.result, file.name);
      showSalesOrderImportPreview(preview);
    } catch (err) {
      console.error("Sales order import parse failed:", err);
      showToast("Import failed: " + err.message, "crit");
    }
  };
  reader.onerror = () => showToast("File read failed", "crit");
  reader.readAsArrayBuffer(file);
}

function parseSalesOrderWorkbook(arrayBuffer, fileName) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true, cellStyles: false, bookVBA: false, bookFiles: false, bookProps: false, bookSheets: false });
  const sheet = wb.Sheets["Data"];
  if (!sheet) throw new Error("Sheet 'Data' not found in workbook");

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });
  if (rows.length < 2) throw new Error("Workbook has no data rows");

  const headers = (rows[0] || []).map(h => (h == null ? "" : String(h)).trim());

  // Find FIRST occurrence of each needed header (some headers repeat in this report)
  const findCol = (name) => headers.indexOf(name);
  const colOrderNbr   = findCol("Order Nbr.");
  const colInvId      = findCol("Inventory ID");
  const colStatus     = findCol("Status");
  const colDate       = findCol("Date");
  const colSchedShip  = findCol("Sched. Shipment");
  const colQtyShipped = findCol("Qty. On Shipments");
  const colDesc       = findCol("Description");  // optional — used only for unmatched-not-in-catalog list

  const missing = [];
  if (colOrderNbr   < 0) missing.push("Order Nbr.");
  if (colInvId      < 0) missing.push("Inventory ID");
  if (colStatus     < 0) missing.push("Status");
  if (colDate       < 0) missing.push("Date");
  if (colSchedShip  < 0) missing.push("Sched. Shipment");
  if (colQtyShipped < 0) missing.push("Qty. On Shipments");
  if (missing.length) throw new Error("Missing required column(s): " + missing.join(", "));

  const toDate = (cell) => {
    if (cell == null || cell === "") return null;
    if (cell instanceof Date) return isNaN(cell.getTime()) ? null : cell;
    const d = new Date(cell);
    return isNaN(d.getTime()) ? null : d;
  };

  const cellStr = (cell) => (cell == null ? "" : String(cell)).trim();

  const existingKeys = new Set(
    (DB.usage || []).map(u => u.sourceKey).filter(Boolean)
  );

  const newRows = [];
  const unmatchedNotInCatalog = [];
  const unmatchedNotTaggedService = [];
  let alreadyImportedCount = 0;
  let totalKeptRows = 0;

  for (let r = 1; r < rows.length; r++) {
    try {
      const row = rows[r];
      if (!row || row.length === 0) continue;

      const invId = cellStr(row[colInvId]);
      if (!invId) continue;

      const qtyShipped = Number(row[colQtyShipped]);
      if (!Number.isFinite(qtyShipped) || qtyShipped <= 0) continue;

      const status = cellStr(row[colStatus]).toLowerCase();
      if (status === "cancelled" || status === "voided") continue;

      totalKeptRows++;

      const orderNbr = cellStr(row[colOrderNbr]);
      const sourceKey = `sales-order-${orderNbr}-${invId}`;
      const sheetDesc = colDesc >= 0 ? cellStr(row[colDesc]) : "";

      const part = DB.parts.find(p => p.pn === invId);
      if (!part) {
        unmatchedNotInCatalog.push({ pn: invId, desc: sheetDesc });
        continue;
      }

      if (existingKeys.has(sourceKey)) {
        alreadyImportedCount++;
        continue;
      }

      const effDate = toDate(row[colSchedShip]) || toDate(row[colDate]);
      if (!effDate) continue;  // no usable date → skip silently

      const ts = new Date(Date.UTC(
        effDate.getFullYear(), effDate.getMonth(), effDate.getDate(), 12, 0, 0
      )).toISOString();

      newRows.push({ pn: invId, qty: qtyShipped, ts, sourceKey, orderNbr, desc: part.desc || "" });
    } catch (rowErr) {
      console.warn(`Sales order import: skipping row ${r + 1}`, rowErr);
    }
  }

  return {
    fileName,
    totalKeptRows,
    newRows,
    alreadyImportedCount,
    unmatchedNotTaggedService,
    unmatchedNotInCatalog,
  };
}

let _pendingSalesOrderImport = null;

function showSalesOrderImportPreview(preview) {
  _pendingSalesOrderImport = preview;
  const canConfirm = preview.newRows.length > 0;
  openModal(`
    <div class="modal-head">
      <div class="head-sm">Service usage import preview</div>
      <div class="muted tiny mt-xs">${esc(preview.fileName)}</div>
    </div>
    <div class="modal-body">
      <div class="stat-strip" style="margin-bottom:10px">
        <div class="stat"><div class="stat-label">Lines found</div><div class="stat-value">${preview.totalKeptRows}</div></div>
        <div class="stat"><div class="stat-label">New (will import)</div><div class="stat-value ok">${preview.newRows.length}</div></div>
        <div class="stat"><div class="stat-label">Already imported</div><div class="stat-value">${preview.alreadyImportedCount}</div></div>
        <div class="stat"><div class="stat-label">Not tagged Service</div><div class="stat-value ${preview.unmatchedNotTaggedService.length>0?'warn':''}">${preview.unmatchedNotTaggedService.length}</div></div>
        <div class="stat"><div class="stat-label">Not in catalog</div><div class="stat-value ${preview.unmatchedNotInCatalog.length>0?'warn':''}">${preview.unmatchedNotInCatalog.length}</div></div>
      </div>
      ${canConfirm
        ? `<p class="muted tiny">Confirm to add ${preview.newRows.length} transaction${preview.newRows.length===1?'':'s'} to DB.usage and recompute daily-use rates.</p>`
        : `<p class="muted tiny">Nothing new to import.</p>`}
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" ${canConfirm?'':'disabled'} onclick="commitSalesOrderImport()">Confirm import</button>
    </div>
  `);
}

function commitSalesOrderImport() {
  const preview = _pendingSalesOrderImport;
  if (!preview) { showToast("No import pending", "warn"); return; }

  // Re-derive existing keys at commit time in case DB.usage moved since the parse.
  const existingKeys = new Set((DB.usage || []).map(u => u.sourceKey).filter(Boolean));
  const survivors = preview.newRows.filter(r => !existingKeys.has(r.sourceKey));
  const reSkipped = preview.newRows.length - survivors.length;

  if (!Array.isArray(DB.usage)) DB.usage = [];
  for (const r of survivors) {
    DB.usage.push({
      id: uid("us"),
      ts: r.ts,
      pn: r.pn,
      qty: r.qty,
      buildLine: "service",
      reason: "Sales order shipment - imported",
      user: "imported",
      sourceKey: r.sourceKey,
    });
  }

  // ---- Kit explosion ----
  // For each newly-imported sales-order line whose part is a kit,
  // create one additional usage row per component.
  // TODO: handle nested kits (a kit whose component is itself a kit).
  let explodedCount = 0;
  let skippedUnknownComponent = 0;
  for (const r of survivors) {
    if (!isKit(r.pn)) continue;
    const components = getComponentsOfKit(r.pn);
    for (const comp of components) {
      if (!comp.qty || comp.qty <= 0) continue;
      const compPart = DB.parts.find(p => p.pn === comp.pn);
      if (!compPart) { skippedUnknownComponent++; continue; }

      const compSourceKey = `kit-explosion-${r.sourceKey}-${comp.pn}`;
      if (existingKeys.has(compSourceKey)) continue;

      DB.usage.push({
        id: uid("us"),
        ts: r.ts,
        pn: comp.pn,
        qty: Math.round(r.qty * comp.qty),
        buildLine: "kit-explosion",
        reason: `From kit ${r.pn}`,
        user: "imported",
        sourceKey: compSourceKey,
      });
      existingKeys.add(compSourceKey);
      explodedCount++;
    }
  }

  // Remove historical "consolidated month" aggregates for ALL parts now that
  // we have real sales order data. These were placeholders from the original
  // Big Sheet import; the new sales order data supersedes them.
  // In-place splice (not reassignment) so cloud-sync's reference to DB.usage stays valid.
  const beforeCleanup = DB.usage.length;
  for (let i = DB.usage.length - 1; i >= 0; i--) {
    const u = DB.usage[i];
    if (!u.sourceKey && u.reason === "Historical (consolidated month)") {
      DB.usage.splice(i, 1);
    }
  }
  const removedCount = beforeCleanup - DB.usage.length;

  const addedCount = survivors.length;
  const alreadyImported = preview.alreadyImportedCount + reSkipped;
  const unmatchedNotTagged = preview.unmatchedNotTaggedService.length;
  const unmatchedNotInCatalog = preview.unmatchedNotInCatalog.length;

  const auditParts = [`${addedCount} added`];
  if (explodedCount > 0) auditParts.push(`exploded into ${explodedCount} component usage rows`);
  if (skippedUnknownComponent > 0) auditParts.push(`${skippedUnknownComponent} components skipped (unknown to catalog)`);
  auditParts.push(`${alreadyImported} already in`);
  if (removedCount > 0) auditParts.push(`${removedCount} historical aggregates removed`);
  logAudit(
    "sales-order-import",
    `Imported sales orders: ${auditParts.join(", ")}`,
    { added: addedCount, alreadyImported, explodedCount, skippedUnknownComponent, removedHistoricalAggregates: removedCount, unmatchedNotTagged, unmatchedNotInCatalog, fileName: preview.fileName }
  );

  DB.meta.lastSalesOrderImport = {
    date: new Date().toISOString(),
    fileName: preview.fileName,
    addedCount,
  };

  saveDB();
  // recomputeDailyFromUsage handles bumpStatusCache + autoSyncExcel + refresh + its own toast.
  recomputeDailyFromUsage();

  closeModal();
  _pendingSalesOrderImport = null;
  showSalesOrderImportResult({
    fileName: preview.fileName,
    addedCount,
    alreadyImported,
    removedCount,
    explodedCount,
    skippedUnknownComponent,
    unmatchedNotTaggedService: preview.unmatchedNotTaggedService,
    unmatchedNotInCatalog: preview.unmatchedNotInCatalog,
  });
}

function showSalesOrderImportResult(result) {
  const renderList = (rows) => rows.length === 0
    ? `<div class="muted tiny" style="padding:8px 0">None.</div>`
    : `<div class="tbl-wrap" style="max-height:240px;overflow-y:auto"><table class="tbl">
         <thead><tr><th>Part</th><th>Description</th></tr></thead>
         <tbody>${rows.map(r => `<tr><td class="pn">${esc(r.pn)}</td><td>${esc(r.desc||"")}</td></tr>`).join("")}</tbody>
       </table></div>`;

  openModal(`
    <div class="modal-head">
      <div class="head-sm">Sales order import complete</div>
      <div class="muted tiny mt-xs">${esc(result.fileName)}</div>
    </div>
    <div class="modal-body">
      <div class="stat-strip" style="margin-bottom:10px">
        <div class="stat"><div class="stat-label">Added</div><div class="stat-value ok">${result.addedCount}</div></div>
        <div class="stat"><div class="stat-label">Already imported</div><div class="stat-value">${result.alreadyImported}</div></div>
        ${result.explodedCount > 0 ? `<div class="stat"><div class="stat-label">Components exploded</div><div class="stat-value ok">${result.explodedCount}</div></div>` : ''}
        ${result.skippedUnknownComponent > 0 ? `<div class="stat"><div class="stat-label">Components skipped</div><div class="stat-value warn">${result.skippedUnknownComponent}</div></div>` : ''}
      </div>
      ${result.removedCount > 0 ? `<p class="muted tiny" style="margin-bottom:6px">Removed ${result.removedCount} stale historical aggregate${result.removedCount===1?'':'s'} for service-tagged parts.</p>` : ''}
      <p class="muted tiny" style="margin-bottom:10px">Daily-use rates recalculated. Last imported: ${fmtDate(DB.meta.lastSalesOrderImport.date)}.</p>
      <details style="margin-top:8px">
        <summary class="muted tiny" style="cursor:pointer">Not tagged Service · ${result.unmatchedNotTaggedService.length}</summary>
        ${renderList(result.unmatchedNotTaggedService)}
      </details>
      <details style="margin-top:8px">
        <summary class="muted tiny" style="cursor:pointer">Not in catalog · ${result.unmatchedNotInCatalog.length}</summary>
        ${renderList(result.unmatchedNotInCatalog)}
      </details>
    </div>
    <div class="modal-foot">
      <button class="btn primary" data-close>Done</button>
    </div>
  `);
}
