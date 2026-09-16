/* =====================================================
   27-page-line-count.js -- LINE COUNT tab.

   Sidebar: STOCK > Line Count. Separate from Inventory
   Reconciliation; that tab is untouched.

   THE QUESTION THIS TAB ANSWERS
   What SHOULD a physical count of Acumatica location
   WHI900/RMSTOR-LM come to? Not a single number -- a band, because
   Acumatica allocates component stock to open production orders but
   does not backflush it until a unit COMPLETES.

     band_high = QtyOnHand   at RMSTOR-LM  (the books)
     band_low  = QtyAvailable at RMSTOR-LM (books minus allocated)
     allocated = band_high - band_low

   A count inside [low, high] is OK. Below low is a real SHORT. Above
   high is OVER.

   The BOM explosion (units on line x qty per unit) is a CROSS-CHECK,
   not the band source: check_delta = allocated - BOM float. Near zero
   means Acumatica's allocation and the BOM agree. Materially off means
   missing BOM lines, partial allocation, or a stale sync.

   DATA (all server-computed; this file only renders)
     line_float       per-part bands + cross-check, written by
                      netlify/functions/line-float-compute.js
     line_float_meta  single 'current' row: as-of stamps, units by
                      model, anomalies
     shelf_counts     physical counts + verdicts recorded here

   ISOLATION
     * READ-ONLY against every planner table. The only write is a
       physical count, and it goes through cycle-count-write's
       recordShelfCount op.
     * NOTHING is ever written back to Acumatica.
     * Deleting this file leaves every other tab byte-identical.
   ===================================================== */

const LC_STATE = {
  rows: null,          // line_float rows
  meta: null,          // line_float_meta.data
  counts: null,        // latest shelf_counts per pn
  loading: false,
  loadedAt: null,
  search: "",
  sortKey: "released_float",
  sortDir: "desc",
  onlyFlagged: false,
  anomaliesOpen: false,
  entry: {},           // pn -> in-progress count value
  saving: {},          // pn -> bool
  _supaWaitAttempts: 0,
};

const LC_LINE_LOCATION = "RMSTOR-LM";
const LC_LINE_WAREHOUSE = "WHI900";
const LC_STALE_HOURS = 24;

/* ---------------- data ---------------- */

async function _lcLoad() {
  if (LC_STATE.loading) return;
  if (typeof _supa === "undefined" || !_supa) { LC_STATE.rows = []; return; }
  LC_STATE.loading = true;
  try {
    const [rowsRes, metaRes, countsRes] = await Promise.all([
      _supa.from("line_float")
        .select("pn, band_low, band_high, onhand_at_line, avail_at_line, allocated_at_line, released_float, check_delta, check_flag, avail_known, qty_per_unit, computed_at")
        .limit(5000),
      _supa.from("line_float_meta").select("data").eq("id", "current").maybeSingle(),
      // Newest 2000 counts, reduced to latest-per-pn in JS. Small table;
      // one query beats a per-row lookup.
      _supa.from("shelf_counts")
        .select("pn, counted_qty, counted_at, counted_by, verdict, on_hand_at_count")
        .order("counted_at", { ascending: false })
        .limit(2000),
    ]);
    if (rowsRes.error) throw rowsRes.error;
    LC_STATE.rows = rowsRes.data || [];
    LC_STATE.meta = (metaRes && metaRes.data && metaRes.data.data) || null;
    const latest = new Map();
    for (const c of ((countsRes && countsRes.data) || [])) {
      if (!latest.has(c.pn)) latest.set(c.pn, c);   // ordered desc already
    }
    LC_STATE.counts = latest;
    LC_STATE.loadedAt = new Date().toISOString();
  } catch (err) {
    console.warn("[line-count] load failed:", err && err.message);
    LC_STATE.rows = LC_STATE.rows || [];
    LC_STATE.counts = LC_STATE.counts || new Map();
  }
  LC_STATE.loading = false;
}

function _lcRouteEnter() {
  if (LC_STATE.loading) return;
  if (LC_STATE.rows !== null) return;
  // Same guard shape the IR tab needs: cloudInit creates _supa ~200ms
  // after DOMContentLoaded, while navigate() fires ON DOMContentLoaded.
  // Retry on a MACROtask so the event loop can actually run cloudInit;
  // a microtask retry here would spin the tab.
  if (typeof _supa === "undefined" || !_supa) {
    LC_STATE._supaWaitAttempts++;
    if (LC_STATE._supaWaitAttempts > 40) { LC_STATE.rows = []; refresh(); return; }
    setTimeout(() => { if (CURRENT_ROUTE === "line-count") _lcRouteEnter(); }, 250);
    return;
  }
  _lcLoad().then(() => { if (CURRENT_ROUTE === "line-count") refresh(); });
}

function _lcReload() { LC_STATE.rows = null; LC_STATE.counts = null; _lcRouteEnter(); refresh(); }

/* ---------------- helpers ---------------- */

function _lcPartDesc(pn) {
  if (typeof DB === "undefined" || !DB || !Array.isArray(DB.parts)) return "";
  const p = DB.parts.find(x => x && x.pn === pn);
  return p ? (p.desc || "") : "";
}
function _lcAgo(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "unknown";
  const h = ms / 3600000;
  if (h < 1) return Math.max(1, Math.round(ms / 60000)) + "m ago";
  if (h < 48) return Math.round(h) + "h ago";
  return Math.round(h / 24) + "d ago";
}
function _lcIsStale(iso) {
  if (!iso) return true;
  return (Date.now() - new Date(iso).getTime()) > LC_STALE_HOURS * 3600000;
}
function _lcNum(n, dp) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "-";
  return (typeof fmtNum === "function") ? fmtNum(v, dp || 0) : String(Math.round(v));
}

function _lcVisibleRows() {
  const rows = (LC_STATE.rows || []).slice();
  const q = String(LC_STATE.search || "").toLowerCase().trim();
  let out = rows;
  if (q) {
    out = out.filter(r => (r.pn + " " + _lcPartDesc(r.pn)).toLowerCase().indexOf(q) !== -1);
  }
  if (LC_STATE.onlyFlagged) out = out.filter(r => r.check_flag);
  const dir = LC_STATE.sortDir === "asc" ? 1 : -1;
  const key = LC_STATE.sortKey;
  out.sort((a, b) => {
    let av = a[key], bv = b[key];
    if (key === "pn") return dir * String(av).localeCompare(String(bv));
    if (key === "check_delta") { av = Math.abs(Number(av) || 0); bv = Math.abs(Number(bv) || 0); }
    return dir * ((Number(av) || 0) - (Number(bv) || 0));
  });
  return out;
}

/* ---------------- count entry ---------------- */

function _lcSetEntry(pn, v) { LC_STATE.entry[pn] = v; }
async function _lcSaveCount(pn) {
  const name = (typeof _ccName === "function") ? _ccName() : "";
  if (!name) {
    if (typeof showToast === "function") showToast("Enter your name on the Inventory Reconciliation tab first — it stamps the count", "warn");
    return;
  }
  const raw = LC_STATE.entry[pn];
  const counted = Math.max(0, Math.round(Number(raw) || 0));
  if (raw === undefined || raw === "" || !Number.isFinite(Number(raw))) {
    if (typeof showToast === "function") showToast("Enter a count first", "warn");
    return;
  }
  const row = (LC_STATE.rows || []).find(r => r.pn === pn);
  if (!row) return;
  LC_STATE.saving[pn] = true; refresh();
  try {
    const resp = await fetch("/.netlify/functions/cycle-count-write", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fs-edit-token": (typeof FS_EDIT_TOKEN_CLIENT !== "undefined") ? FS_EDIT_TOKEN_CLIENT : "",
        "x-app-build": String((typeof APP_BUILD !== "undefined") ? APP_BUILD : 0),
      },
      body: JSON.stringify({ writes: [{
        op: "recordShelfCount",
        pn,
        counted_qty: counted,
        counted_by: name,
        band_low: Number(row.band_low) || 0,
        band_high: Number(row.band_high) || 0,
        line_float_at_count: Number(row.released_float) || 0,
      }] }),
    });
    const json = await resp.json();
    const r0 = json && Array.isArray(json.results) ? json.results[0] : null;
    const opErr = r0 && r0.ok === false ? String(r0.error || "") : "";
    if (opErr) { _lcErr(opErr); }
    else if (!resp.ok || (json && json.ok === false)) { _lcErr((json && json.error) || ("server " + resp.status)); }
    else {
      if (!(LC_STATE.counts instanceof Map)) LC_STATE.counts = new Map();
      LC_STATE.counts.set(pn, {
        pn, counted_qty: counted, counted_at: (r0 && r0.countedAt) || new Date().toISOString(),
        counted_by: name, verdict: r0 && r0.verdict, on_hand_at_count: row.band_high,
      });
      delete LC_STATE.entry[pn];
      if (typeof showToast === "function") {
        const v = r0 && r0.verdict;
        showToast(`${pn}: counted ${counted} — ${String(v || "").toUpperCase()}`, v === "ok" ? "ok" : "warn");
      }
    }
  } catch (err) { _lcErr((err && err.message) || "network error"); }
  LC_STATE.saving[pn] = false;
  refresh();
}
function _lcErr(detail) {
  const msg = "Count save failed: " + detail;
  if (typeof showToast === "function") showToast(msg, "warn"); else alert(msg);
}

/* ---------------- export ---------------- */

// Deliberately Part / Description / Count Low / Count High only. This
// sheet goes to whoever walks the location; showing them the expected
// numbers beyond the band invites counting toward the answer.
function _lcExportCsv() {
  const rows = _lcVisibleRows();
  const head = ["Part", "Description", "Count Low", "Count High"];
  const esc2 = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
  const lines = [head.map(esc2).join(",")];
  for (const r of rows) {
    lines.push([r.pn, _lcPartDesc(r.pn), Math.round(Number(r.band_low) || 0), Math.round(Number(r.band_high) || 0)].map(esc2).join(","));
  }
  const iso = new Date().toISOString().slice(0, 10);
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `line-count-${iso}.csv`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

function _lcSort(key) {
  if (LC_STATE.sortKey === key) LC_STATE.sortDir = LC_STATE.sortDir === "asc" ? "desc" : "asc";
  else { LC_STATE.sortKey = key; LC_STATE.sortDir = key === "pn" ? "asc" : "desc"; }
  refresh();
}
function _lcSetSearch(v) { LC_STATE.search = String(v || ""); refresh(); }
function _lcToggleFlagged() { LC_STATE.onlyFlagged = !LC_STATE.onlyFlagged; refresh(); }
function _lcToggleAnomalies() { LC_STATE.anomaliesOpen = !LC_STATE.anomaliesOpen; refresh(); }

if (typeof window !== "undefined") {
  Object.assign(window, {
    _lcSetEntry, _lcSaveCount, _lcExportCsv, _lcSort, _lcSetSearch,
    _lcToggleFlagged, _lcToggleAnomalies, _lcReload,
  });
}

/* ---------------- render ---------------- */

function _lcHeaderHtml() {
  const m = LC_STATE.meta;
  if (!m) return `<div class="empty tiny muted">No compute has run yet — hit /.netlify/functions/line-float-run?write=1 or wait for the 06:30 UTC job.</div>`;
  const stamps = [
    { label: "Production orders", at: m.prod_orders_synced_at },
    { label: "Location qty", at: m.locations_synced_at },
    { label: "BOM pull", at: m.bom_pulled_at },
    { label: "Computed", at: m.computed_at },
  ];
  const anyStale = stamps.some(s => _lcIsStale(s.at));
  const units = Array.isArray(m.units_by_model) ? m.units_by_model : [];
  const totalUnits = Number(m.total_units_on_line) || 0;
  const noBom = units.filter(u => u && u.hasBom === false);
  return `
    ${anyStale ? `<div class="lc-banner">One or more feeds are more than ${LC_STALE_HOURS}h old — the band below may not reflect what is on the line right now. Check the timestamps.</div>` : ""}
    <div class="lc-strip">
      ${stamps.map(s => `
        <div class="lc-stat">
          <div class="lc-stat-label">${esc(s.label)}</div>
          <div class="lc-stat-value ${_lcIsStale(s.at) ? "text-warn" : ""}">${esc(_lcAgo(s.at))}</div>
          <div class="lc-stat-sub mono">${esc(s.at ? String(s.at).slice(0, 16).replace("T", " ") : "unknown")}</div>
        </div>`).join("")}
      <div class="lc-stat">
        <div class="lc-stat-label">On the line</div>
        <div class="lc-stat-value">${_lcNum(totalUnits)} units</div>
        <div class="lc-stat-sub">${units.length} model${units.length === 1 ? "" : "s"} &middot; ${_lcNum(m.released_orders)} order${m.released_orders === 1 ? "" : "s"}</div>
      </div>
    </div>
    <div class="lc-models">
      ${units.length === 0
        ? `<span class="dim tiny">No open production orders in an on-line status (${(m.on_line_statuses || []).join(" / ") || "none configured"}).</span>`
        : units.slice().sort((a, b) => (b.units || 0) - (a.units || 0)).map(u => `
            <span class="lc-model${u.hasBom === false ? " lc-model-nobom" : ""}" title="${esc((u.desc || "") + (u.hasBom === false ? " — NO BOM: this model's consumption is invisible to the cross-check" : ""))}">
              <span class="mono">${esc(u.sku)}</span> ${_lcNum(u.units)}<span class="dim"> / ${_lcNum(u.orders)} ord</span>${u.hasBom === false ? ' <span class="pill warn" style="font-size:9px;padding:0 4px">NO BOM</span>' : ""}
            </span>`).join("")}
    </div>
    ${noBom.length > 0 ? `<div class="dim tiny" style="margin-top:4px">${noBom.length} model(s) on the line have no BOM — their consumption is missing from the cross-check column, so a delta flag on parts they use may be a false alarm. The band itself is unaffected.</div>` : ""}
  `;
}

function _lcAnomaliesHtml() {
  const m = LC_STATE.meta;
  const list = (m && Array.isArray(m.anomalies)) ? m.anomalies : [];
  const byKind = {};
  for (const a of list) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  const summary = Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(", ") || "none";
  return `
    <div class="lc-anom">
      <button class="btn sm ghost" onclick="_lcToggleAnomalies()">${LC_STATE.anomaliesOpen ? "&#9662;" : "&#9656;"} Anomalies: ${list.length}</button>
      <span class="dim tiny">${esc(summary)}</span>
      ${LC_STATE.anomaliesOpen && list.length > 0 ? `
        <div class="tbl-wrap" style="margin-top:8px;max-height:280px;overflow:auto">
          <table class="tbl"><thead><tr><th style="width:150px">Kind</th><th style="width:120px">Part</th><th>Detail</th></tr></thead>
          <tbody>${list.map(a => `<tr><td class="mono tiny">${esc(a.kind)}</td><td class="mono">${esc(a.parent || "")}</td><td class="tiny">${esc(a.detail || "")}</td></tr>`).join("")}</tbody></table>
        </div>` : ""}
    </div>`;
}

function renderLineCount() {
  const main = document.getElementById("main");
  if (!main) return;
  _lcRouteEnter();

  const loading = LC_STATE.rows === null || LC_STATE.loading;
  const rows = loading ? [] : _lcVisibleRows();
  const all = LC_STATE.rows || [];
  const flaggedCount = all.filter(r => r.check_flag).length;
  const availUnknown = all.filter(r => r.avail_known === false).length;
  const counts = LC_STATE.counts instanceof Map ? LC_STATE.counts : new Map();
  const name = (typeof _ccName === "function") ? _ccName() : "";

  const body = rows.map(r => {
    const pn = r.pn;
    const last = counts.get(pn);
    const entry = LC_STATE.entry[pn];
    const saving = !!LC_STATE.saving[pn];
    const lo = Math.round(Number(r.band_low) || 0);
    const hi = Math.round(Number(r.band_high) || 0);
    const degenerate = r.avail_known === false;
    const verdictPill = last
      ? `<span class="pill ${last.verdict === "ok" ? "ok" : "crit"}" style="font-size:9px">${esc(String(last.verdict || "").toUpperCase())}</span>`
      : "";
    const deltaCell = r.check_flag
      ? `<span class="text-warn bold">${Number(r.check_delta) > 0 ? "+" : ""}${_lcNum(r.check_delta, 1)}</span>`
      : `<span class="dim">${Number(r.check_delta) > 0 ? "+" : ""}${_lcNum(r.check_delta, 1)}</span>`;
    return `
      <tr>
        <td class="mono">${esc(pn)}</td>
        <td class="dim">${esc(_lcPartDesc(pn))}</td>
        <td class="right num">${_lcNum(r.onhand_at_line)}</td>
        <td class="right num ${degenerate ? "dim" : ""}">${degenerate ? "&mdash;" : _lcNum(r.avail_at_line)}</td>
        <td class="right num dim">${degenerate ? "&mdash;" : _lcNum(r.allocated_at_line)}</td>
        <td class="right num dim">${_lcNum(r.released_float, 1)}</td>
        <td class="right num">${degenerate ? '<span class="dim" title="Available missing for this part — no allocation figure to compare against">n/a</span>' : deltaCell}</td>
        <td class="mono bold">${degenerate ? `<span class="text-warn" title="QtyAvailable missing at the line, so there is no low end. Treat this as on-hand only, not a band.">${hi} (no low)</span>` : `${lo} &ndash; ${hi}`}</td>
        <td>
          <div class="row gap-sm" style="align-items:center">
            <input class="input num" type="number" min="0" step="1" style="width:78px"
                   value="${entry === undefined ? "" : esc(String(entry))}"
                   placeholder="count"
                   oninput="_lcSetEntry('${esc(pn)}', this.value)">
            <button class="btn sm primary" ${saving || !name ? "disabled" : ""} onclick="_lcSaveCount('${esc(pn)}')">${saving ? "..." : "Save"}</button>
          </div>
          ${last ? `<div class="dim tiny" style="margin-top:2px">${verdictPill} ${_lcNum(last.counted_qty)} &middot; ${esc(_lcAgo(last.counted_at))}${last.counted_by ? " &middot; " + esc(last.counted_by) : ""}</div>` : ""}
        </td>
      </tr>`;
  }).join("");

  const th = (key, label, cls) =>
    `<th class="${cls || ""}" style="cursor:pointer" onclick="_lcSort('${key}')">${label}${LC_STATE.sortKey === key ? (LC_STATE.sortDir === "asc" ? " &#9650;" : " &#9660;") : ""}</th>`;

  main.innerHTML = `
    <style>
      .lc-strip { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:10px; }
      .lc-stat { flex:1 1 150px; min-width:150px; padding:8px 12px; border:1px solid var(--line,#cbd5e1); border-radius:6px; }
      .lc-stat-label { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--dim,#64748b); }
      .lc-stat-value { font-size:18px; font-weight:700; margin:2px 0; }
      .lc-stat-sub { font-size:11px; color:var(--dim,#64748b); }
      .lc-models { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
      .lc-model { padding:3px 8px; border:1px solid var(--line,#cbd5e1); border-radius:999px; font-size:12px; }
      .lc-model-nobom { border-color:var(--warn,#b45309); }
      .lc-anom { margin-top:14px; }
      .lc-toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:12px 0; }
      .lc-table th { white-space:nowrap; }
      .lc-table td { vertical-align:top; }
      /* Local warn bar: the app has no global .banner class (the IR tab
         asks for one and gets unstyled markup), so define our own. */
      .lc-banner {
        margin:8px 0; padding:8px 12px; border-radius:6px; font-size:12px;
        background:var(--warn-soft); color:var(--warn); border:1px solid var(--warn-bd);
      }
    </style>
    <div class="page" data-page="line-count">
      <div class="page-head">
        <div>
          <div class="page-title">Line Count</div>
          <div class="page-sub">What a physical count of <span class="mono">${LC_LINE_WAREHOUSE}/${LC_LINE_LOCATION}</span> should come to. Acumatica allocates stock to open production orders but only backflushes on completion, so the answer is a band, not a number. A count inside the band is OK; below the low end is a real short.</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="_lcReload()">Reload</button>
          <button class="btn" onclick="_lcExportCsv()">Export CSV</button>
        </div>
      </div>

      ${_lcHeaderHtml()}

      ${!name ? `<div class="lc-banner">Enter your name on the Inventory Reconciliation tab before counting &mdash; it is stamped on every count.</div>` : ""}
      ${availUnknown > 0 ? `<div class="lc-banner">${availUnknown} part(s) have no QtyAvailable at the line, so they show an on-hand figure with no low end rather than a band. Those rows cannot read SHORT.</div>` : ""}

      <div class="lc-toolbar">
        <input class="input" placeholder="Filter part or description..." value="${esc(LC_STATE.search)}" oninput="_lcSetSearch(this.value)" style="max-width:280px">
        <label class="row gap-sm" style="align-items:center;cursor:pointer">
          <input type="checkbox" class="chk" ${LC_STATE.onlyFlagged ? "checked" : ""} onchange="_lcToggleFlagged()">
          <span class="muted tiny">Only cross-check flags (${flaggedCount})</span>
        </label>
        <span class="flex-1"></span>
        <span class="dim tiny">${rows.length} of ${all.length} parts</span>
      </div>

      ${loading
        ? `<div class="empty tiny muted">Loading line data...</div>`
        : (all.length === 0
            ? `<div class="empty"><div class="empty-title muted">No line data yet</div><div class="empty-msg">Run <span class="mono">/.netlify/functions/line-float-run?write=1&amp;token=...</span> or wait for the 06:30 UTC compute.</div></div>`
            : `<div class="tbl-wrap"><table class="tbl lc-table">
                <thead><tr>
                  ${th("pn", "Part")}
                  <th>Description</th>
                  ${th("onhand_at_line", "On hand @ line", "right")}
                  ${th("avail_at_line", "Available @ line", "right")}
                  ${th("allocated_at_line", "Allocated", "right")}
                  ${th("released_float", "BOM float", "right")}
                  ${th("check_delta", "Delta", "right")}
                  <th>Count should be</th>
                  <th style="width:210px">Physical count</th>
                </tr></thead>
                <tbody>${body}</tbody>
              </table></div>`)}

      ${_lcAnomaliesHtml()}
    </div>
  `;
}

if (typeof registerRoute === "function") registerRoute("line-count", renderLineCount);
