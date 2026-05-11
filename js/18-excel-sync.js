/* =====================================================
   18-excel-sync.js
   Sections: LIVE EXCEL SYNC — File System Access API + IndexedDB
   ===================================================== */

/* ============================================================
   LIVE EXCEL SYNC — File System Access API + IndexedDB
   Persists file handles across sessions; reads + writes 3 workbooks:
   PO lines, On-Hand inventory, Usage transactions.
   Works in Chrome, Edge, Brave, Opera. Falls back to download elsewhere.
   ============================================================ */
const IDB_NAME = "landmaster-fs";
const IDB_STORE = "handles";
const FS_KINDS = ["pos", "onhand", "usage"];
const _fileHandles = { pos: null, onhand: null, usage: null };
const _lastSync = { pos: null, onhand: null, usage: null };
let _lastPosModified = null;
let _posPollTimer = null;

function fsSupported() {
  return typeof window !== "undefined"
      && "showSaveFilePicker" in window
      && "showOpenFilePicker" in window;
}

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadFileHandles() {
  if (!fsSupported()) return;
  for (const k of FS_KINDS) {
    try {
      const h = await idbGet(`fs.${k}`);
      if (h) _fileHandles[k] = h;
    } catch (e) { /* ignore */ }
  }
  if (_fileHandles.pos) { await syncPOsFromAcumatica({silent:true}); startPOPolling(); }
}

async function pickAndLinkFile(kind, mode = "save") {
  if (!fsSupported()) {
    showToast("Live Excel sync needs Chrome, Edge, or Brave.", "warn", "Browser not supported");
    return null;
  }
  const opts = {
    types: [{ description: "Excel workbook", accept: { "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"] }}],
    suggestedName: `landmaster-${kind}.xlsx`,
  };
  let handle;
  try {
    if (kind === "pos") {
      [handle] = await window.showOpenFilePicker({ ...opts, multiple: false });
    } else if (mode === "save") {
      handle = await window.showSaveFilePicker(opts);
    } else {
      [handle] = await window.showOpenFilePicker({ ...opts, multiple: false });
    }
  } catch (e) {
    if (e.name === "AbortError") return null;
    showToast("File pick failed: " + e.message, "crit");
    return null;
  }
  await idbSet(`fs.${kind}`, handle);
  _fileHandles[kind] = handle;
  if (kind === "pos") {
    _lastPosModified = null;
    await syncPOsFromAcumatica();
    startPOPolling();
  } else {
    // Immediately write fresh data
    const wb = buildWorkbook(kind);
    if (wb) await writeWorkbook(kind, wb);
  }
  showToast(`${kindLabel(kind)} workbook connected: ${handle.name}`, "ok", "Excel linked");
  updateSyncIndicator();
  return handle;
}

async function disconnectFile(kind) {
  if (kind === "pos") {
    stopPOPolling();
    _lastPosModified = null;
  }
  await idbDel(`fs.${kind}`);
  _fileHandles[kind] = null;
  showToast(`${kindLabel(kind)} workbook unlinked`, "info");
  updateSyncIndicator();
}

async function ensurePermission(handle, write = false) {
  const opts = { mode: write ? "readwrite" : "read" };
  try {
    if ((await handle.queryPermission(opts)) === "granted") return true;
    return (await handle.requestPermission(opts)) === "granted";
  } catch (e) { return false; }
}

function kindLabel(k) {
  return ({pos: "PO Lines", onhand: "On-Hand", usage: "Usage"})[k] || k;
}

function buildWorkbook(kind) {
  if (kind === "pos") return buildPOWorkbook();
  if (kind === "onhand") return buildOnHandWorkbook();
  if (kind === "usage") return buildUsageWorkbook();
  return null;
}

async function writeWorkbook(kind, workbook) {
  if (kind === "pos") return true;
  const handle = _fileHandles[kind];
  if (!handle) return false;
  if (!await ensurePermission(handle, true)) {
    showToast(`Permission needed for ${kindLabel(kind)} file. Click "Pull" or reconnect.`, "warn");
    return false;
  }
  try {
    const writable = await handle.createWritable();
    const buf = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    await writable.write(buf);
    await writable.close();
    _lastSync[kind] = new Date();
    return true;
  } catch (e) {
    showToast(`Couldn't write ${kindLabel(kind)} — close it in Excel first. (${e.message})`, "crit");
    return false;
  }
}

/* ----- WORKBOOK BUILDERS ----- */
function buildPOWorkbook() {
  const headers = [
    "PO #","Supplier","Status","Buyer","Created","Submitted","Expected","Received","PO Notes",
    "Line #","Part #","Description","Qty","Qty Recv","Open Qty","Unit Cost","Line Total","Line Expected","Line Status","Line Notes"
  ];
  const rows = [headers];
  const dt = (s) => s ? new Date(s) : null;
  for (const po of DB.pos) {
    if (!po.lines.length) {
      rows.push([po.num, po.supplier, po.status, displayBuyer(po), dt(po.createdDate), dt(po.submittedDate), dt(po.expectedDate), dt(po.receivedDate), po.notes||"",
        "","","","","","","","","","",""]);
      continue;
    }
    po.lines.forEach((ln, idx) => {
      const part = DB.parts.find(p => p.pn === ln.pn);
      const open = Math.max(0, (ln.qty||0) - (ln.qtyReceived||0));
      rows.push([
        po.num, po.supplier, po.status, displayBuyer(po), dt(po.createdDate), dt(po.submittedDate), dt(po.expectedDate), dt(po.receivedDate), po.notes||"",
        idx+1, ln.pn, part?.desc||"", ln.qty||0, ln.qtyReceived||0, open, ln.cost||0, (ln.qty||0)*(ln.cost||0),
        dt(ln.expectedDate), ln.status||"open", ln.notes||""
      ]);
    });
  }
  const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
  ws["!cols"] = [{wch:12},{wch:24},{wch:12},{wch:14},{wch:12},{wch:12},{wch:12},{wch:12},{wch:30},
                 {wch:6},{wch:18},{wch:34},{wch:8},{wch:8},{wch:8},{wch:10},{wch:12},{wch:12},{wch:10},{wch:24}];
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  // Auto-filter on header row
  const range = XLSX.utils.decode_range(ws["!ref"]);
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({s:{r:0,c:0}, e:{r:0, c:range.e.c}}) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Purchase Orders");
  return wb;
}

function buildOnHandWorkbook() {
  const headers = ["Part #","Description","Supplier","Buyer","Class","Category","On Hand","On PO","Daily Use","Days Cover","Status","Unit Cost","On-Hand Value","Lead (wks)","MOQ","Pack","Notes"];
  const rows = [headers];
  const stats = partsWithStatus();
  // Sort by urgency for instant attention at top
  stats.sort((a,b) => a.urgency - b.urgency);
  for (const p of stats) {
    rows.push([
      p.pn, p.desc||"", p.supplier||"", p.buyer||"", p.partClass||"", p.category||"",
      p.onHand||0, p.onPO||0, p.daily||0,
      p.daysOfCover === Infinity ? "—" : p.daysOfCover,
      p.status,
      p.cost||0, (p.onHand||0)*(p.cost||0),
      p.ltWeeks||0, p.moq||0, p.packSize||1, p.notes||""
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [{wch:18},{wch:34},{wch:24},{wch:14},{wch:6},{wch:14},{wch:8},{wch:8},{wch:10},{wch:10},{wch:10},{wch:10},{wch:14},{wch:10},{wch:8},{wch:6},{wch:30}];
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };
  const range = XLSX.utils.decode_range(ws["!ref"]);
  ws["!autofilter"] = { ref: XLSX.utils.encode_range({s:{r:0,c:0}, e:{r:0, c:range.e.c}}) };
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "On-Hand Inventory");
  return wb;
}

function buildUsageWorkbook() {
  // Sheet 1: transactions
  const txnHeaders = ["Date","Part #","Description","Qty Used","Build Line","Reason","User","Notes"];
  const txnRows = [txnHeaders];
  const sorted = DB.usage.slice().sort((a,b) => new Date(b.ts) - new Date(a.ts));
  for (const u of sorted) {
    const part = DB.parts.find(p => p.pn === u.pn);
    txnRows.push([new Date(u.ts), u.pn, part?.desc||"", u.qty||0, u.buildLine||"", u.reason||"", u.user||"", u.notes||""]);
  }
  const ws1 = XLSX.utils.aoa_to_sheet(txnRows, { cellDates: true });
  ws1["!cols"] = [{wch:14},{wch:18},{wch:34},{wch:8},{wch:14},{wch:14},{wch:14},{wch:24}];
  ws1["!freeze"] = { xSplit: 0, ySplit: 1 };
  const r1 = XLSX.utils.decode_range(ws1["!ref"]);
  ws1["!autofilter"] = { ref: XLSX.utils.encode_range({s:{r:0,c:0}, e:{r:0, c:r1.e.c}}) };

  // Sheet 2: summary by part
  const sumHeaders = ["Part #","Description","Qty Used (7d)","Qty Used (30d)","Qty Used (90d)","Avg Daily (30d)","Last Used"];
  const sumRows = [sumHeaders];
  const map = {};
  const cutoff7  = addDays(TODAY, -7);
  const cutoff30 = addDays(TODAY, -30);
  const cutoff90 = addDays(TODAY, -90);
  for (const u of DB.usage) {
    const dt = new Date(u.ts);
    if (!map[u.pn]) map[u.pn] = { q7: 0, q30: 0, q90: 0, last: null };
    const m = map[u.pn];
    if (dt >= cutoff90) m.q90 += u.qty || 0;
    if (dt >= cutoff30) m.q30 += u.qty || 0;
    if (dt >= cutoff7)  m.q7  += u.qty || 0;
    if (!m.last || dt > new Date(m.last)) m.last = u.ts;
  }
  for (const p of DB.parts) {
    const m = map[p.pn] || { q7:0, q30:0, q90:0, last:null };
    const workdays30 = 30 * (DB.settings.workdaysPerWeek/7);
    const avgDaily = m.q30 / Math.max(1, workdays30);
    sumRows.push([p.pn, p.desc||"", m.q7, m.q30, m.q90, round(avgDaily, 2), m.last ? new Date(m.last) : ""]);
  }
  const ws2 = XLSX.utils.aoa_to_sheet(sumRows, { cellDates: true });
  ws2["!cols"] = [{wch:18},{wch:34},{wch:14},{wch:14},{wch:14},{wch:14},{wch:14}];
  ws2["!freeze"] = { xSplit: 0, ySplit: 1 };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws1, "Usage Transactions");
  XLSX.utils.book_append_sheet(wb, ws2, "Summary by Part");
  return wb;
}

/* ----- READ-BACK (Pull from Excel) ----- */
async function pullFromExcel(kind) {
  const handle = _fileHandles[kind];
  if (!handle) { showToast(`No ${kindLabel(kind)} file linked`, "warn"); return; }
  if (!await ensurePermission(handle, false)) { showToast("Permission denied", "warn"); return; }
  let count = 0;
  try {
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: "array", cellDates: true });
    if (kind === "onhand") count = readOnHandRows(wb);
    else if (kind === "usage") count = readUsageRows(wb);
    else if (kind === "pos") count = readPORows(wb);
    saveDB();
    bumpStatusCache();
    showToast(`Pulled ${count} change${count===1?'':'s'} from ${kindLabel(kind)}.xlsx`, count > 0 ? "ok" : "info");
    refresh();
  } catch (e) {
    showToast(`Pull failed: ${e.message}`, "crit");
  }
}

function readOnHandRows(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
  let count = 0;
  for (const r of rows) {
    const pn = String(r["Part #"] || r["Part"] || r["PN"] || r["Part Number"] || "").trim();
    if (!pn) continue;
    const ohRaw = r["On Hand"] ?? r["OnHand"] ?? r["Qty"] ?? r["Quantity"];
    if (ohRaw === undefined || ohRaw === "") continue;
    const oh = Math.round(parseFloat(String(ohRaw).replace(/[^0-9.\-]/g, "")));
    if (isNaN(oh) || oh < 0) continue;
    const part = DB.parts.find(p => p.pn === pn);
    if (!part) continue;
    if ((part.onHand || 0) !== oh) {
      const old = part.onHand || 0;
      part.onHand = oh;
      logAudit("oh-pull", `${pn}: ${fmtNum(old)} → ${fmtNum(oh)} (pulled from Excel)`, { pn, oldQ: old, newQ: oh, delta: oh-old });
      count++;
    }
  }
  return count;
}

function readUsageRows(wb) {
  const sn = wb.SheetNames.find(n => /usage|transaction/i.test(n)) || wb.SheetNames[0];
  const ws = wb.Sheets[sn];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  // De-dupe against existing usage by ts+pn+qty
  const existing = new Set(DB.usage.map(u => `${u.ts}|${u.pn}|${u.qty}`));
  let count = 0;
  for (const r of rows) {
    const pn = String(r["Part #"] || r["Part"] || "").trim();
    if (!pn) continue;
    const qtyRaw = r["Qty Used"] ?? r["Qty"];
    const qty = parseFloat(String(qtyRaw||"").replace(/[^0-9.\-]/g, ""));
    if (isNaN(qty) || qty <= 0) continue;
    const dateStr = r["Date"];
    let ts;
    if (dateStr instanceof Date) ts = dateStr.toISOString();
    else if (dateStr) ts = new Date(dateStr).toISOString();
    else continue;
    const key = `${ts}|${pn}|${qty}`;
    if (existing.has(key)) continue;
    DB.usage.push({
      id: uid("us"),
      ts, pn, qty: Math.round(qty),
      buildLine: String(r["Build Line"]||"").trim(),
      reason: String(r["Reason"]||"").trim(),
      user: String(r["User"]||"").trim(),
      notes: String(r["Notes"]||"").trim(),
    });
    existing.add(key);
    count++;
  }
  return count;
}

function readPORows(wb) {
  // Read PO line edits — qty, qtyReceived, cost, expectedDate, status, notes
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });
  let count = 0;
  for (const r of rows) {
    const poNum = String(r["PO #"]||"").trim();
    const pn    = String(r["Part #"]||"").trim();
    if (!poNum || !pn) continue;
    const po = DB.pos.find(p => p.num === poNum);
    if (!po) continue;
    const ln = po.lines.find(l => l.pn === pn);
    if (!ln) continue;
    let changed = false;
    const newQty   = parseFloat(String(r["Qty"]||"").replace(/[^0-9.\-]/g, ""));
    const newRecv  = parseFloat(String(r["Qty Recv"]||"").replace(/[^0-9.\-]/g, ""));
    const newCost  = parseFloat(String(r["Unit Cost"]||"").replace(/[^0-9.\-]/g, ""));
    if (!isNaN(newQty)  && Math.abs(newQty  - (ln.qty||0))         > 0.001) { ln.qty = newQty; changed = true; }
    if (!isNaN(newRecv) && Math.abs(newRecv - (ln.qtyReceived||0)) > 0.001) { ln.qtyReceived = newRecv; changed = true; }
    if (!isNaN(newCost) && Math.abs(newCost - (ln.cost||0))        > 0.001) { ln.cost = newCost; changed = true; }
    // Recompute line status
    if (changed) {
      const ord = ln.qty||0, recv = ln.qtyReceived||0;
      if (ln.status !== "cancelled") {
        if (recv === 0) ln.status = "open";
        else if (recv < ord) ln.status = "partial";
        else if (recv >= ord && ord > 0) ln.status = "received";
      }
      logAudit("po-pull", `${poNum} / ${pn} updated from Excel`, { poId: po.id, pn });
      count++;
    }
  }
  return count;
}

/* ----- ACUMATICA INBOUND (PO Lines, read-only) ----- */
function normalizeAcumaticaStatus(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const map = [
    [/^on\s*hold$/i, "On Hold"],
    [/^pending\s*approval$/i, "Pending Approval"],
    [/^pending\s*print(ing)?$/i, "Pending Printing"],
    [/^pending\s*e?-?mail$/i, "Pending Email"],
    [/^awaiting\s*link$/i, "Awaiting Link"],
    [/^open$/i, "Open"],
    [/^completed$/i, "Completed"],
    [/^rejected$/i, "Rejected"],
    [/^cancell?ed$/i, "Canceled"],
  ];
  for (const [re, canon] of map) if (re.test(s)) return canon;
  return s;
}
const ACUMATICA_STATUS_PRIORITY = ["On Hold", "Pending Approval", "Pending Printing", "Pending Email", "Awaiting Link", "Open", "Completed", "Rejected", "Canceled"];
function rollupAcumaticaStatus(lines) {
  let bestPri = Infinity, best = "", fallback = "";
  for (const l of (lines || [])) {
    const s = l.acumStatus || "";
    if (!s) continue;
    const pri = ACUMATICA_STATUS_PRIORITY.indexOf(s);
    if (pri >= 0) { if (pri < bestPri) { bestPri = pri; best = s; } }
    else if (!fallback) fallback = s;
  }
  return best || fallback;
}

function parseAcumaticaPOWorkbook(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: "array", cellDates: true });
  const ws = wb.Sheets["Data"];
  if (!ws) return [];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: true });
  let headerRow = -1;
  for (let i = 0; i < Math.min(8, aoa.length); i++) {
    if ((aoa[i] || []).some(c => String(c).trim() === "Order Nbr.")) { headerRow = i; break; }
  }
  if (headerRow < 0) return [];
  const headers = aoa[headerRow].map(h => String(h).trim());
  const rows = [];
  for (let i = headerRow + 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (!r || r.length === 0) continue;
    const obj = {};
    headers.forEach((h, j) => {
      const v = r[j];
      obj[h] = typeof v === "string" ? v.replace(/\s+$/, "") : v;
    });
    rows.push(obj);
  }
  const byOrder = new Map();
  for (const r of rows) {
    const num = String(r["Order Nbr."] || "").trim();
    if (!num) continue;
    if (!byOrder.has(num)) byOrder.set(num, []);
    byOrder.get(num).push(r);
  }
  const toIso = (v) => {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d) ? null : d.toISOString();
  };
  const toNum = (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string") return parseFloat(v.trim().replace(/,/g, "")) || 0;
    return 0;
  };
  const pos = [];
  for (const [num, group] of byOrder) {
    const first = group[0];
    const lines = group.map((r) => {
      const qty = toNum(r["Order Qty."]);
      const qtyReceived = toNum(r["Qty. On Receipts"]);
      const acumStatus = normalizeAcumaticaStatus(r["Status"]);
      let status;
      if (qty > 0 && qtyReceived >= qty) status = "received";
      else if (qtyReceived > 0) status = "partial";
      else if (acumStatus === "Rejected" || acumStatus === "Canceled") status = "cancelled";
      else if (acumStatus === "Completed") status = "received";
      else status = "open";
      return {
        id: uid("pl"),
        pn: String(r["Inventory ID"] || "").trim(),
        qty,
        qtyReceived,
        cost: toNum(r["POLine_unitCost"]),
        expectedDate: toIso(r["Promised"]),
        status,
        acumStatus,
        lineNbr: r["Line Nbr."],
        notes: ""
      };
    });
    const allTerm = lines.length > 0 && lines.every(l => l.status === "received" || l.status === "cancelled");
    const anyReceived = lines.some(l => l.status === "received");
    const anyProgress = lines.some(l => l.status === "partial" || l.status === "received");
    let poStatus;
    if (allTerm && anyReceived) poStatus = "received";
    else if (anyProgress) poStatus = "in_transit";
    else poStatus = "submitted";
    pos.push({
      id: "po_" + num,
      num,
      supplier: String(first["Vendor Name"] || "").trim(),
      source: "acumatica",
      buyer: "",
      createdBy: String(first["Created By"] || "").trim(),
      notes: "",
      createdDate: toIso(first["Date"]),
      expectedDate: toIso(first["Promised"]),
      status: poStatus,
      acumStatus: rollupAcumaticaStatus(lines),
      lines
    });
  }
  return pos;
}

async function syncPOsFromAcumatica({silent=false}={}) {
  const handle = _fileHandles.pos;
  if (!handle) return;
  if (!await ensurePermission(handle, false)) {
    if (!silent) showToast("Permission needed for PO Lines file", "warn");
    return;
  }
  try {
    const file = await handle.getFile();
    if (file.lastModified === _lastPosModified) return;
    _lastPosModified = file.lastModified;
    const buf = await file.arrayBuffer();
    const incoming = parseAcumaticaPOWorkbook(buf);
    const incomingNums = new Set(incoming.map(p => p.num));
    const sig = (po) => JSON.stringify({
      status: po.status,
      acumStatus: po.acumStatus || "",
      createdBy: po.createdBy || "",
      supplier: po.supplier,
      expectedDate: po.expectedDate,
      createdDate: po.createdDate,
      lines: (po.lines || []).slice()
        .sort((a, b) => String(a.lineNbr ?? a.pn).localeCompare(String(b.lineNbr ?? b.pn)))
        .map(l => ({ pn: l.pn, qty: l.qty, qtyReceived: l.qtyReceived, cost: l.cost, expectedDate: l.expectedDate, status: l.status, acumStatus: l.acumStatus || "", lineNbr: l.lineNbr })),
    });
    let added = 0, changed = 0, removed = 0;
    for (const inc of incoming) {
      const existing = DB.pos.find(p => p.num === inc.num);
      if (existing) {
        const before = sig(existing);
        const buyer = existing.buyer;
        const notes = existing.notes;
        Object.assign(existing, inc, { buyer, notes });
        if (sig(existing) !== before) changed++;
      } else {
        DB.pos.push(inc);
        added++;
      }
    }
    for (const po of DB.pos) {
      if (po.source === "acumatica" && !incomingNums.has(po.num) && po.status !== "received") {
        po.status = "received";
        po.acumStatus = "Completed";
        removed++;
      }
    }
    saveDB();
    bumpStatusCache();
    updateNavBadges();
    updateTopBar();
    updateSyncIndicator();
    if (CURRENT_ROUTE && (added > 0 || changed > 0 || removed > 0)) navigate(CURRENT_ROUTE);
    if (added > 0 || changed > 0 || removed > 0) patchOpenPODrawer();
  } catch (e) {
    if (!silent) showToast(`PO sync failed: ${e.message}`, "crit");
  }
}

function startPOPolling() {
  stopPOPolling();
  _posPollTimer = setInterval(() => { if (_fileHandles.pos) syncPOsFromAcumatica({silent:true}); }, 60000);
}
function stopPOPolling() { if (_posPollTimer) { clearInterval(_posPollTimer); _posPollTimer = null; } }

/* ----- AUTO-SYNC (debounced) ----- */
let _syncDebounce = null;
let _syncing = false;

function autoSyncExcel() {
  if (!DB.settings.autoSyncExcel) return;
  if (!fsSupported()) return;
  if (!Object.values(_fileHandles).some(Boolean)) return;
  clearTimeout(_syncDebounce);
  _syncDebounce = setTimeout(async () => {
    if (_syncing) return;
    _syncing = true;
    updateSyncIndicator("syncing");
    try {
      for (const k of FS_KINDS) {
        if (!_fileHandles[k]) continue;
        const wb = buildWorkbook(k);
        if (wb) await writeWorkbook(k, wb);
      }
    } finally {
      _syncing = false;
      updateSyncIndicator();
    }
  }, 1200);
}

function updateSyncIndicator(state) {
  const el = $("#top-stat-sync");
  if (!el) return;
  const linked = FS_KINDS.filter(k => _fileHandles[k]).length;
  if (state === "syncing") {
    el.className = "status-pill warn";
    el.innerHTML = `<span class="dot">●</span> SYNCING…`;
    return;
  }
  if (linked === 0) {
    el.className = "status-pill";
    el.innerHTML = `<span class="dot">○</span> SYNC OFF`;
  } else if (linked === 3) {
    el.className = "status-pill ok";
    el.innerHTML = `<span class="dot">●</span> SYNC ON · 3/3`;
  } else {
    el.className = "status-pill warn";
    el.innerHTML = `<span class="dot">●</span> SYNC PARTIAL · ${linked}/3`;
  }
}
