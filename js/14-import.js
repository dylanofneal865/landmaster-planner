/* =====================================================
   14-import.js
   Sections: FILE IMPORT — XLSX / CSV
   ===================================================== */

/* ============================================================
   FILE IMPORT — XLSX / CSV
   Smart column detection so the user doesn't have to map fields.
   ============================================================ */
function handleFileImport(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array", cellDates: true });
      // Try common sheet names; fall back to first
      const sheetName =
        wb.SheetNames.find(n => /big.?sheet|inventory|parts|master/i.test(n)) ||
        wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
      if (!rows.length) { showToast("Sheet is empty", "warn"); return; }
      previewImport(rows, sheetName, file.name);
    } catch (err) {
      console.error(err);
      showToast("Import failed: " + err.message, "crit");
    }
  };
  reader.onerror = () => showToast("Failed to read file", "crit");
  reader.readAsArrayBuffer(file);
}

function detectColumns(sampleRow) {
  // Build a normalized lookup of header → original key
  const keys = Object.keys(sampleRow);
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const find = (...patterns) => {
    for (const k of keys) {
      const n = norm(k);
      for (const p of patterns) if (n.includes(p)) return k;
    }
    return null;
  };
  return {
    pn: find("partnumber","partno","part","pn","sku","item","material"),
    desc: find("description","desc","name"),
    supplier: find("supplier","vendor","mfr"),
    onHand: find("onhand","qtyonhand","stock","inventory","qty","quantity","balance"),
    daily: find("daily","perday","avgdaily","usage","consumption","demand"),
    cost: find("cost","unitcost","price","unitprice"),
    ltWeeks: find("leadtimeweeks","leadweeks","ltweeks","leadwk"),
    ltDays: find("leadtimedays","leaddays","ltdays"),
    ltGen: find("leadtime","lt","lead"),
    moq: find("moq","minorder","minqty"),
    pack: find("packsize","pack","casepack"),
    cls: find("class","abc","classification"),
    cat: find("category","cat","type","family"),
    buyer: find("buyer","planner","owner"),
    notes: find("notes","comment","remark"),
  };
}

function previewImport(rows, sheetName, filename) {
  const cols = detectColumns(rows[0]);
  // Convert rows to candidate parts
  const candidates = [];
  let unparsable = 0;
  for (const row of rows) {
    const pn = cols.pn ? String(row[cols.pn]||"").trim() : "";
    if (!pn) { unparsable++; continue; }
    const onHand = cols.onHand ? parseFloat(String(row[cols.onHand]||"").replace(/[^0-9.\-]/g,"")) : 0;
    const daily = cols.daily ? parseFloat(String(row[cols.daily]||"").replace(/[^0-9.\-]/g,"")) : 0;
    const cost = cols.cost ? parseFloat(String(row[cols.cost]||"").replace(/[^0-9.\-]/g,"")) : 0;
    let ltWeeks = 0;
    if (cols.ltWeeks) ltWeeks = parseFloat(String(row[cols.ltWeeks]||"").replace(/[^0-9.\-]/g,"")) || 0;
    else if (cols.ltDays) ltWeeks = (parseFloat(String(row[cols.ltDays]||"").replace(/[^0-9.\-]/g,"")) || 0) / 7;
    else if (cols.ltGen) {
      const v = parseFloat(String(row[cols.ltGen]||"").replace(/[^0-9.\-]/g,"")) || 0;
      // Heuristic: if it's a small number, assume weeks; if large, assume days
      ltWeeks = v <= 26 ? v : v / 7;
    }
    candidates.push({
      pn,
      desc: cols.desc ? String(row[cols.desc]||"").trim() : "",
      supplier: cols.supplier ? String(row[cols.supplier]||"").trim() : "Unknown",
      buyer: cols.buyer ? String(row[cols.buyer]||"").trim() : (DB.settings.defaultBuyer||"Buyer"),
      onHand: isNaN(onHand) ? 0 : Math.max(0, Math.round(onHand)),
      daily: isNaN(daily) ? 0 : Math.max(0, daily),
      cost: isNaN(cost) ? 0 : Math.max(0, cost),
      ltWeeks: Math.max(0, ltWeeks || 0),
      moq: cols.moq ? Math.max(0, parseInt(String(row[cols.moq]||"").replace(/[^0-9]/g,"")) || 0) : 0,
      packSize: cols.pack ? Math.max(1, parseInt(String(row[cols.pack]||"").replace(/[^0-9]/g,"")) || 1) : 1,
      partClass: cols.cls ? String(row[cols.cls]||"B").trim().charAt(0).toUpperCase() : "B",
      category: cols.cat ? String(row[cols.cat]||"").trim() : "",
      notes: cols.notes ? String(row[cols.notes]||"").trim() : "",
    });
  }
  // Match against existing
  const existingByPN = new Map(DB.parts.map(p => [p.pn, p]));
  const newParts = candidates.filter(c => !existingByPN.has(c.pn));
  const updates = candidates.filter(c => existingByPN.has(c.pn));
  const sample = candidates.slice(0, 6);

  const colSummary = Object.entries(cols).filter(([_,v]) => v).map(([k,v]) => `<span class="tag">${k}: ${esc(v)}</span>`).join(" ");

  openModal(`
    <div class="modal-head">
      <div style="font-size:13px;font-weight:600">Import preview · ${esc(filename)}</div>
      <div class="muted tiny" style="margin-top:4px">Sheet: <span class="mono">${esc(sheetName)}</span> · ${rows.length} rows · ${candidates.length} valid · ${unparsable} skipped</div>
    </div>
    <div class="modal-body">
      <div class="stat-strip" style="margin-bottom:14px">
        <div class="stat"><div class="stat-label">New parts</div><div class="stat-value ok">${newParts.length}</div></div>
        <div class="stat"><div class="stat-label">Updating</div><div class="stat-value">${updates.length}</div></div>
        <div class="stat"><div class="stat-label">Skipped</div><div class="stat-value ${unparsable>0?'warn':''}">${unparsable}</div></div>
        <div class="stat"><div class="stat-label">Total to apply</div><div class="stat-value">${candidates.length}</div></div>
      </div>

      <div class="dr-section" style="margin-top:0">Detected columns</div>
      <div class="tag-row" style="margin-bottom:14px">${colSummary || '<span class="muted tiny">No columns matched — please check your sheet headers.</span>'}</div>

      <div class="dr-section">Sample (first 6 rows)</div>
      <div class="tbl-wrap" style="max-height:240px;overflow-y:auto">
        <table class="tbl">
          <thead><tr><th>Part</th><th>Description</th><th>Supplier</th><th class="right">On Hand</th><th class="right">Daily</th><th class="right">Cost</th><th class="right">Lead</th></tr></thead>
          <tbody>
            ${sample.map(c => `
              <tr>
                <td class="pn">${esc(c.pn)}</td>
                <td>${esc(c.desc)}</td>
                <td class="dim">${esc(c.supplier)}</td>
                <td class="right num">${fmtNum(c.onHand)}</td>
                <td class="right num dim">${fmtNum(c.daily, 2)}</td>
                <td class="right num">${fmtMoneyDec(c.cost)}</td>
                <td class="right num dim">${c.ltWeeks}w</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>

      <div class="dr-section">Strategy</div>
      <div class="row gap-md" style="flex-wrap:wrap">
        <label class="row" style="gap:6px"><input type="radio" name="imp-mode" value="merge" checked> <span><strong>Merge</strong> — add new, update existing</span></label>
        <label class="row" style="gap:6px"><input type="radio" name="imp-mode" value="oh-only"> <span>Update <strong>on-hand only</strong> (preserve everything else)</span></label>
        <label class="row" style="gap:6px"><input type="radio" name="imp-mode" value="cost-only"> <span>Update <strong>cost only</strong> (existing parts; skip unknowns)</span></label>
        <label class="row" style="gap:6px"><input type="radio" name="imp-mode" value="replace"> <span style="color:var(--crit)"><strong>Replace all parts</strong> (deletes existing)</span></label>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" onclick="applyImport()">Apply ${candidates.length} row${candidates.length===1?'':'s'}</button>
    </div>
  `);
  window._pendingImport = candidates;
}

function applyImport() {
  const candidates = window._pendingImport;
  if (!candidates) { showToast("Nothing to import", "warn"); return; }
  const mode = document.querySelector('input[name="imp-mode"]:checked')?.value || "merge";
  let added = 0, updated = 0, ohChanged = 0;

  if (mode === "replace") {
    DB.parts = candidates.map(c => ({...c, kanban: false, reasonCode: "MRP"}));
    added = candidates.length;
  } else if (mode === "oh-only") {
    const map = new Map(DB.parts.map(p => [p.pn, p]));
    for (const c of candidates) {
      const existing = map.get(c.pn);
      if (existing && (existing.onHand || 0) !== c.onHand) {
        existing.onHand = c.onHand;
        ohChanged++;
      }
    }
  } else if (mode === "cost-only") {
    const map = new Map(DB.parts.map(p => [p.pn, p]));
    const mapLower = new Map(DB.parts.map(p => [String(p.pn).toLowerCase(), p]));
    let costChanged = 0, skippedUnknown = 0, skippedNoCost = 0, sameAlready = 0;
    for (const c of candidates) {
      let existing = map.get(c.pn);
      if (!existing) existing = mapLower.get(String(c.pn).toLowerCase());
      if (!existing) { skippedUnknown++; continue; }
      const newCost = Number(c.cost);
      if (!Number.isFinite(newCost) || newCost <= 0) { skippedNoCost++; continue; }
      if ((existing.cost || 0) === newCost) { sameAlready++; continue; }
      existing.cost = newCost;
      costChanged++;
    }
    DB.meta.lastImport = new Date().toISOString();
    DB.meta.dataSource = "imported";
    logAudit("import", `Cost-only import: ${costChanged} costs updated · ${sameAlready} unchanged · ${skippedUnknown} unknown PNs · ${skippedNoCost} skipped (no cost)`);
    saveDB();
    bumpStatusCache();
    closeModal();
    showToast(`Cost-only import · ${costChanged} updated · ${sameAlready} unchanged · ${skippedUnknown} unknown · ${skippedNoCost} no cost`, "ok", "Cost update applied");
    navigate("dashboard");
    return;
  } else {
    // merge
    const map = new Map(DB.parts.map(p => [p.pn, p]));
    for (const c of candidates) {
      const existing = map.get(c.pn);
      if (existing) {
        const oldOh = existing.onHand || 0;
        Object.assign(existing, c);
        if (oldOh !== c.onHand) ohChanged++;
        updated++;
      } else {
        DB.parts.push({...c, kanban: false, reasonCode: "MRP"});
        added++;
      }
    }
  }
  DB.meta.lastImport = new Date().toISOString();
  DB.meta.dataSource = "imported";
  logAudit("import", `Imported ${candidates.length} rows · ${added} added · ${updated} updated · ${ohChanged} on-hand changes`);
  saveDB();
  bumpStatusCache();
  closeModal();
  showToast(`Import applied · ${added} new · ${updated} updated`, "ok", "Data imported");
  navigate("dashboard");
}
