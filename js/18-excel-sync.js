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
// POs are sourced from Acumatica → Supabase (see netlify/functions/acumatica-sync.js).
// Only the On-Hand and Usage workbooks remain as live two-way Excel sync targets.
const FS_KINDS = ["onhand", "usage"];
const _fileHandles = { onhand: null, usage: null };
const _lastSync = { onhand: null, usage: null };

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
    if (mode === "save") {
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
  // Immediately write fresh data
  const wb = buildWorkbook(kind);
  if (wb) await writeWorkbook(kind, wb);
  showToast(`${kindLabel(kind)} workbook connected: ${handle.name}`, "ok", "Excel linked");
  updateSyncIndicator();
  return handle;
}

async function disconnectFile(kind) {
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

// Header indicator now reflects the freshness of Acumatica → Supabase syncs.
// The legacy `state` arg from Excel auto-sync callers is intentionally
// ignored — Excel sync status now lives on the Settings page panel.
function updateSyncIndicator() {
  const el = $("#top-stat-sync");
  if (!el) return;
  const audit = (typeof DB !== "undefined" && DB && Array.isArray(DB.audit)) ? DB.audit : null;
  if (!audit) {
    el.className = "status-pill";
    el.innerHTML = `<span class="dot">○</span> SYNC`;
    return;
  }
  // DB.audit is kept newest-first by cloudInit + realtime inserts, so .find
  // returns the most recent acumatica sync entry.
  const last = audit.find(a => a && (a.type === "acumatica-sync" || a.type === "acumatica-po-sync"));
  const ts = last && last.ts ? new Date(last.ts).getTime() : NaN;
  if (isNaN(ts)) {
    el.className = "status-pill crit";
    el.innerHTML = `<span class="dot">●</span> SYNC ERROR`;
    return;
  }
  const ageMin = (Date.now() - ts) / 60000;
  const rel = _relTimeSince(ts);
  if (ageMin > 120) {
    el.className = "status-pill crit";
    el.innerHTML = `<span class="dot">●</span> SYNC ERROR`;
  } else if (ageMin > 30) {
    el.className = "status-pill warn";
    el.innerHTML = `<span class="dot">●</span> STALE · ${rel}`;
  } else {
    el.className = "status-pill ok";
    el.innerHTML = `<span class="dot">●</span> SYNCED · ${rel}`;
  }
}

function _relTimeSince(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
}

// One global 30s timer. Idempotent: re-invoking start clears any existing
// timer first, so route changes (or anything else that calls start) can
// never accumulate duplicates.
let _syncIndicatorTimer = null;
function startSyncIndicatorTimer() {
  if (_syncIndicatorTimer) clearInterval(_syncIndicatorTimer);
  _syncIndicatorTimer = setInterval(updateSyncIndicator, 30000);
  updateSyncIndicator();
}
function stopSyncIndicatorTimer() {
  if (_syncIndicatorTimer) { clearInterval(_syncIndicatorTimer); _syncIndicatorTimer = null; }
}
if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startSyncIndicatorTimer);
  } else {
    startSyncIndicatorTimer();
  }
}
