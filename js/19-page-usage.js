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
registerRoute("usage",          () => renderUsageFor(null));
registerRoute("base-bom-usage", renderBaseBomUsage);
registerRoute("options-usage",  () => renderUsageFor("options"));

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

  // Sort
  rows.sort((a, b) => {
    const aDaily = Number(a.daily) || 0;
    const bDaily = Number(b.daily) || 0;
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

  // Stats over the unfiltered base_bom set
  const total = parts.length;
  const rated = parts.filter(p => (Number(p.daily) || 0) > 0);
  const withRate = rated.length;
  const withoutRate = total - withRate;
  const avgDaily = withRate > 0 ? rated.reduce((s, p) => s + (Number(p.daily) || 0), 0) / withRate : 0;

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

      <div class="two-col">
        <div>
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
                        const d = Number(p.daily) || 0;
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
                                onblur="bbuApplyRateFromInput('${esc(p.pn)}', this.value)"
                                onkeydown="if(event.key==='Enter'){this.blur()}"
                                style="width:100px;text-align:right">
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
        </div>

        <div>
          <div class="panel">
            <div class="panel-head"><div class="panel-title">How rates work</div></div>
            <div class="panel-body" style="font-size:12px;color:var(--t2);line-height:1.6">
              <p>Daily-use rates here feed the <strong>Base BOM Queue</strong>'s stockout projections.</p>
              <p>Set rates by <strong>importing a sheet</strong>, <strong>pasting rows</strong>, or <strong>editing inline</strong>. Each change saves immediately and syncs to Supabase.</p>
              <p>Rows flagged <span class="pill warn">MISSING RATE</span> contribute nothing to demand and won't be flagged for reorder.</p>
              <p>Service usage is tracked separately and isn't affected by changes here.</p>
            </div>
          </div>
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
      <div style="font-size:13px;font-weight:600">Import base BOM rates</div>
      <div class="muted tiny" style="margin-top:4px">CSV or XLSX with a PN column and a daily-rate (or monthly-rate) column. Only updates existing base_bom parts; no new parts created.</div>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>File</label>
        <input type="file" id="bbu-import-file" accept=".csv,.xlsx,.xls">
      </div>
      <div style="margin-top:10px">
        <label class="row" style="gap:6px;margin-bottom:6px"><input type="radio" name="bbu-imp-mode" value="daily" checked> <span>Rate column is <strong>daily</strong> (units / day)</span></label>
        <label class="row" style="gap:6px"><input type="radio" name="bbu-imp-mode" value="monthly"> <span>Rate column is <strong>monthly</strong> (will divide by 30)</span></label>
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
      <div style="font-size:13px;font-weight:600">Import preview · ${esc(filename)}</div>
      <div class="muted tiny" style="margin-top:4px">${totalRows} file row${totalRows === 1 ? '' : 's'} · PN col: <span class="mono">${esc(pnCol)}</span> · rate col: <span class="mono">${esc(rateCol)}</span> · mode: <strong>${esc(mode)}</strong>${mode === 'monthly' ? ' (÷30)' : ''}</div>
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
      <div style="font-size:13px;font-weight:600">Paste base BOM rates</div>
      <div class="muted tiny" style="margin-top:4px">One row per line: <span class="mono">PART_NUMBER &lt;TAB&gt; RATE</span> (comma also accepted). Only updates existing base_bom parts.</div>
    </div>
    <div class="modal-body">
      <div style="margin-bottom:10px">
        <label class="row" style="gap:6px;margin-bottom:6px"><input type="radio" name="bbu-paste-mode" value="daily" checked> <span>Rate is <strong>daily</strong></span></label>
        <label class="row" style="gap:6px"><input type="radio" name="bbu-paste-mode" value="monthly"> <span>Rate is <strong>monthly</strong> (will divide by 30)</span></label>
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
  const mode = document.querySelector('input[name="bbu-paste-mode"]:checked')?.value || "daily";
  const divisor = mode === "monthly" ? 30 : 1;
  const baseBomPns = new Set(DB.parts.filter(p => p.itemType === "base_bom" && !isKit(p.pn)).map(p => p.pn));
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
        <div class="page-actions">
          <button class="btn primary" onclick="bulkApplyComputedDaily()">⚡ Apply all computed daily rates</button>
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
            <option value="diff" ${SERVICE_USAGE_STATE.sortBy==='diff'?'selected':''}>Sort: biggest difference</option>
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
                  <th class="right">180d Units</th>
                  <th class="right">Current Daily</th>
                  <th class="right">Computed Daily</th>
                  <th class="right">Δ</th>
                  <th>Last Sale</th>
                  <th></th>
                </tr></thead>
                <tbody>
                  ${rows.slice(0, 500).map(r => {
                    const diffSign = r.diff > 0 ? "+" : "";
                    const diffColor = Math.abs(r.diff) < 0.05 ? "var(--t3)" : (r.diff > 0 ? "var(--crit)" : "var(--accent)");
                    const lastSale = r.demand.lastOrderDate ? fmtDate(r.demand.lastOrderDate) : "—";
                    const desc = r.part?.desc || "—";
                    const hasChange = r.diff !== 0;
                    return `
                      <tr>
                        <td class="pn">${esc(r.pn)}</td>
                        <td>${esc(desc)}</td>
                        <td class="right num">${fmtNum(r.demand.units)}</td>
                        <td class="right num dim">${fmtNum(r.storedDaily, 3)}</td>
                        <td class="right num bold">${fmtNum(r.computedDaily, 3)}</td>
                        <td class="right num" style="color:${diffColor}">${diffSign}${fmtNum(r.diff, 3)}</td>
                        <td class="dim tiny">${lastSale}</td>
                        <td>${hasChange ? `<button class="btn sm" onclick="applyServicePartDaily('${esc(r.pn)}', ${r.computedDaily})">Apply</button>` : ""}</td>
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
        <div style="font-size: 13px; font-weight: 600;">Log usage</div>
        <div class="muted tiny" style="margin-top:4px">Records a consumption transaction. By default this decrements on-hand inventory.</div>
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
          <label class="row" style="gap:8px;margin-top:10px;cursor:pointer">
            <input type="checkbox" class="chk" id="lu-decrement" checked>
            <span>Decrement on-hand inventory by this qty</span>
          </label>
          <div class="row gap-md" style="margin-top:8px">
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
  const u = DB.usage.find(x => x.id === id);
  if (!u) return;
  openModal(`
    <div class="modal-head"><div style="font-size:13px;font-weight:600">Delete this usage entry?</div></div>
    <div class="modal-body">
      <p>${fmtTime(u.ts)} · <span class="pn">${esc(u.pn)}</span> · <strong>${fmtNum(u.qty)}</strong> ${u.buildLine?'on '+esc(u.buildLine):''}</p>
      <label class="row" style="gap:8px;margin-top:10px;cursor:pointer">
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
      <div style="font-size: 13px; font-weight: 600;">Bulk log usage</div>
      <div class="muted tiny" style="margin-top:4px">Paste rows: <span class="mono">PART_NUMBER &lt;TAB&gt; QTY [&lt;TAB&gt; BUILD_LINE]</span> — one per line. Date defaults to today; uncheck to skip on-hand decrement.</div>
    </div>
    <div class="modal-body">
      <div class="field"><label>Paste data</label>
        <textarea class="paste-area" id="bu-paste" autofocus placeholder="LM-DT-2000	4	L5&#10;LM-EN-2007	2	Mudmaster"></textarea>
      </div>
      <label class="row" style="gap:8px;margin-top:8px;cursor:pointer">
        <input type="checkbox" class="chk" id="bu-decrement" checked>
        <span>Decrement on-hand for each row</span>
      </label>
      <div class="row gap-md" style="margin-top:8px">
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
