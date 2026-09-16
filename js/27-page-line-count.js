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

   A count inside [low, high] is OK. Below low is a SHORT. Above high
   is OVER -- subject to the materiality floor below.

   The BOM explosion (units on line x qty per unit) is a CROSS-CHECK,
   not the band source: check_delta = allocated - BOM float.

   COUNT SESSIONS (r2)
   The band moves whenever orders or location qty sync. Without a
   snapshot, a part counted at 09:05 and one counted at 09:40 are
   graded against different bands, so the same physical count can read
   OK in the morning and SHORT after lunch. "Start count" freezes every
   part's band into a count_sessions row; while that session is open,
   every count is graded against the FROZEN numbers. "Finish count"
   closes it with a summary.

   MATERIALITY (r2)
   40 missing out of 10,231 nuts is not a shortage, it is counting. A
   miss within LC_NOISE_FLOOR renders as "OK (within noise)" and raises
   no next-step strip, so the real misses stay visible.

   RENDERING (r2)
   The shell is rebuilt only when DATA changes. Filtering and sorting
   repaint the table body alone, so the filter input is never destroyed
   mid-keystroke and keeps focus. See _lcPaintTable.

   DATA (all server-computed; this file only renders)
     line_float       per-part bands + cross-check, written by
                      netlify/functions/line-float-compute.js
     line_float_meta  single 'current' row: as-of stamps, units by
                      model, anomalies
     count_sessions   frozen band snapshots per counting walk
     shelf_counts     physical counts, verdicts, recount confirmations

   ISOLATION
     * READ-ONLY against every planner table. The only writes are count
       sessions and physical counts, through cycle-count-write.
     * NOTHING is ever written back to Acumatica. The SHORT/OVER strips
       tell Dylan what to do there; this app only records.
     * Deleting this file leaves every other tab byte-identical.
   ===================================================== */

/* ---------------- tunables ---------------- */

const LC_LINE_LOCATION = "RMSTOR-LM";
const LC_LINE_WAREHOUSE = "WHI900";

// Feeds older than this raise the stale banner.
const LC_STALE_HOURS = 24;

// FEED SKEW. The band mixes two feeds: allocation comes from the order
// sync, on-hand from the location sync. If they were taken far apart,
// the band describes a line that never existed at any single moment --
// orders from 09:00 against stock from 11:00. 90 minutes is the
// tolerance; past that the header says so.
const LC_FEED_SKEW_MIN = 90;

// MATERIALITY FLOOR -- Dylan tunes these two numbers.
// A count that misses the band by no more than max(LC_NOISE_ABS,
// LC_NOISE_PCT x band_high) reads "OK (within noise)" instead of
// SHORT/OVER, and raises no next-step strip. Deliberately applied at
// RENDER time, not frozen onto the stored row, so retuning re-grades
// history consistently rather than leaving a mix of rows judged under
// different thresholds.
const LC_NOISE_ABS = 2;      // units
const LC_NOISE_PCT = 0.01;   // 1% of the high end of the band

// A part needs this many CONFIRMED, MATERIAL shorts before it lands on
// the chronic-leak punch list. One short is an incident; two is a
// process problem.
const LC_CHRONIC_MIN_SHORTS = 2;

// Rows painted at once. 816 rows of inputs is what made typing in the
// filter unusable. Everything is still counted, filtered, sorted and
// exported -- only the paint is capped.
const LC_ROW_CAP = 100;

// Keystroke settle before the table repaints.
const LC_FILTER_DEBOUNCE_MS = 150;

/* ---------------- state ---------------- */

const LC_STATE = {
  rows: null,          // line_float rows
  meta: null,          // line_float_meta.data
  counts: null,        // Map pn -> latest shelf_count
  allCounts: null,     // every shelf_count fetched (chronic-leak view)
  session: null,       // open count_sessions row, or null
  lastSummary: null,   // summary from the most recent finishCountSession
  loading: false,
  search: "",
  sortKey: "released_float",
  sortDir: "desc",
  onlyFlagged: false,
  onlyChronic: false,
  showAll: false,
  anomaliesOpen: false,
  // Triage and chronic leaks open by default: both are short, actionable
  // lists Dylan is meant to work through. Anomalies stay collapsed --
  // that one is diagnostic output, not a to-do list.
  triageOpen: true,
  chronicOpen: true,
  entry: {},           // pn -> in-progress count value
  saving: {},          // pn -> bool
  busy: false,         // session-level action in flight
  // Shell-vs-body paint bookkeeping (see _lcPaintTable).
  _dataVersion: 0,
  _paintedVersion: -1,
  _filterTimer: null,
  _supaWaitAttempts: 0,
};

function _lcTouch() { LC_STATE._dataVersion++; }

/* ---------------- data ---------------- */

async function _lcLoad() {
  if (LC_STATE.loading) return;
  if (typeof _supa === "undefined" || !_supa) { LC_STATE.rows = []; _lcTouch(); return; }
  LC_STATE.loading = true;
  try {
    const [rowsRes, metaRes, countsRes, sessRes] = await Promise.all([
      _supa.from("line_float")
        .select("pn, band_low, band_high, onhand_at_line, avail_at_line, allocated_at_line, released_float, check_delta, check_flag, avail_known, at_line, computed_at")
        .limit(5000),
      _supa.from("line_float_meta").select("data").eq("id", "current").maybeSingle(),
      // Newest 2000 counts. Reduced to latest-per-pn for the rows and
      // kept whole for the chronic-leak tally. Small table; one query
      // beats a per-row lookup.
      _supa.from("shelf_counts")
        .select("id, pn, counted_qty, counted_at, counted_by, verdict, on_hand_at_count, band_low, band_high, miss, session_id, confirmed, confirmed_by, confirmed_at")
        .order("counted_at", { ascending: false })
        .limit(2000),
      _supa.from("count_sessions")
        .select("id, started_at, started_by, finished_at, finished_by, note, snapshot, summary")
        .order("started_at", { ascending: false })
        .limit(5),
    ]);
    if (rowsRes.error) throw rowsRes.error;
    LC_STATE.rows = rowsRes.data || [];
    LC_STATE.meta = (metaRes && metaRes.data && metaRes.data.data) || null;

    // Pre-migration tolerance: shelf_counts may not have the r2 columns
    // yet, in which case the select above 400s. Fall back to the columns
    // that have always existed rather than showing no count history.
    let countRows = (countsRes && countsRes.data) || [];
    if (countsRes && countsRes.error) {
      const legacy = await _supa.from("shelf_counts")
        .select("id, pn, counted_qty, counted_at, counted_by, verdict, on_hand_at_count")
        .order("counted_at", { ascending: false }).limit(2000);
      countRows = (legacy && legacy.data) || [];
      if (!legacy.error) console.warn("[line-count] shelf_counts is pre-r2 — sessions, miss magnitude and recount confirmation are unavailable until the migration runs.");
    }
    LC_STATE.allCounts = countRows;
    const latest = new Map();
    for (const c of countRows) if (!latest.has(c.pn)) latest.set(c.pn, c);  // already desc
    LC_STATE.counts = latest;

    const sessions = (sessRes && !sessRes.error && sessRes.data) ? sessRes.data : [];
    LC_STATE.session = sessions.find(s => !s.finished_at) || null;
    if (!LC_STATE.session) {
      const done = sessions.find(s => s.finished_at && s.summary);
      LC_STATE.lastSummary = done ? { ...done.summary, finishedAt: done.finished_at, startedAt: done.started_at } : null;
    }
  } catch (err) {
    console.warn("[line-count] load failed:", err && err.message);
    LC_STATE.rows = LC_STATE.rows || [];
    LC_STATE.counts = LC_STATE.counts || new Map();
    LC_STATE.allCounts = LC_STATE.allCounts || [];
  }
  LC_STATE.loading = false;
  _lcTouch();
}

function _lcRouteEnter() {
  if (LC_STATE.loading) return;
  if (LC_STATE.rows !== null) return;
  // cloudInit creates _supa ~200ms after DOMContentLoaded, while
  // navigate() fires ON DOMContentLoaded. Retry on a MACROtask so the
  // event loop can actually run cloudInit; a microtask retry here would
  // spin the tab (see the d949eed freeze).
  if (typeof _supa === "undefined" || !_supa) {
    LC_STATE._supaWaitAttempts++;
    if (LC_STATE._supaWaitAttempts > 40) { LC_STATE.rows = []; _lcTouch(); refresh(); return; }
    setTimeout(() => { if (CURRENT_ROUTE === "line-count") _lcRouteEnter(); }, 250);
    return;
  }
  _lcLoad().then(() => { if (CURRENT_ROUTE === "line-count") refresh(); });
}

function _lcReload() {
  LC_STATE.rows = null; LC_STATE.counts = null; LC_STATE.allCounts = null;
  LC_STATE._paintedVersion = -1;
  _lcRouteEnter(); refresh();
}

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
function _lcClock(iso) {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "unknown";
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
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

// Minutes between the order feed and the location feed. The band mixes
// both, so a wide gap means it describes no single moment in time.
function _lcFeedSkewMin() {
  const m = LC_STATE.meta;
  if (!m || !m.prod_orders_synced_at || !m.locations_synced_at) return null;
  const a = new Date(m.prod_orders_synced_at).getTime();
  const b = new Date(m.locations_synced_at).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round(Math.abs(a - b) / 60000);
}

/* ---------------- band + grading ---------------- */

// THE BAND A COUNT IS JUDGED AGAINST. With a session open this is the
// FROZEN snapshot, not live data -- that is the entire point of a
// session. Falls back to live for a part the snapshot never saw (added
// to the line after the walk began).
function _lcBandFor(row) {
  const s = LC_STATE.session;
  if (s && s.snapshot && Array.isArray(s.snapshot.parts)) {
    if (!s._index) {
      s._index = new Map(s.snapshot.parts.map(p => [p.pn, p]));
    }
    const p = s._index.get(row.pn);
    if (p) {
      return {
        low: Number(p.band_low) || 0,
        high: Number(p.band_high) || 0,
        allocated: Number(p.allocated) || 0,
        bomFloat: Number(p.bom_float) || 0,
        frozen: true,
      };
    }
  }
  return {
    low: Number(row.band_low) || 0,
    high: Number(row.band_high) || 0,
    allocated: Number(row.allocated_at_line) || 0,
    bomFloat: Number(row.released_float) || 0,
    frozen: false,
  };
}

function _lcNoiseFloor(bandHigh) {
  return Math.max(LC_NOISE_ABS, Math.abs(Number(bandHigh) || 0) * LC_NOISE_PCT);
}

// Grade a stored count. `verdict` on the row is the hard fact about the
// band; materiality is applied here so the floor stays tunable.
function _lcGrade(count) {
  if (!count) return null;
  const hi = Number(count.band_high);
  const lo = Number(count.band_low);
  const q = Number(count.counted_qty) || 0;
  const hard = count.verdict === "short" || count.verdict === "over";
  let miss = Number(count.miss);
  let missKnown = Number.isFinite(miss);
  if (!missKnown) {
    // Pre-migration rows carry neither `miss` nor the band.
    // on_hand_at_count has always been band_high, so an OVER is still
    // measurable; a SHORT without band_low is NOT.
    const high = Number.isFinite(hi) ? hi : Number(count.on_hand_at_count);
    if (count.verdict === "over" && Number.isFinite(high)) { miss = q - high; missKnown = true; }
    else if (count.verdict === "short" && Number.isFinite(lo)) { miss = q - lo; missKnown = true; }
    else { miss = 0; missKnown = !hard; }
  }
  const floorBase = Number.isFinite(hi) ? hi : Number(count.on_hand_at_count) || 0;
  const floor = _lcNoiseFloor(floorBase);
  // An unmeasurable miss must NOT be dismissed as noise. A pre-r2 short
  // whose band_low is gone is still a short somebody recorded; silently
  // grading it "within noise" would bury a real variance behind a
  // missing column. It stays material, and the strip says the size is
  // unknown rather than inventing one.
  const material = hard && (!missKnown || Math.abs(miss) > floor);
  return { verdict: count.verdict, miss, missKnown, floor, hard, material, counted: q };
}

/* ---------------- chronic leak ---------------- */

// Parts with LC_CHRONIC_MIN_SHORTS or more CONFIRMED, MATERIAL shorts.
// Confirmed means a human walked back and recounted -- an unconfirmed
// short is a number someone typed once, and does not belong on a
// process-problem punch list.
function _lcChronic() {
  const byPn = new Map();
  for (const c of (LC_STATE.allCounts || [])) {
    if (c.verdict !== "short" || !c.confirmed) continue;
    const g = _lcGrade(c);
    if (!g || !g.material) continue;
    let rec = byPn.get(c.pn);
    if (!rec) { rec = { pn: c.pn, shorts: 0, variance: 0, last: c.counted_at, sessions: new Set() }; byPn.set(c.pn, rec); }
    rec.shorts++;
    rec.variance += Math.abs(g.miss);
    if (c.session_id) rec.sessions.add(c.session_id);
    if (c.counted_at > rec.last) rec.last = c.counted_at;
  }
  return [...byPn.values()]
    .filter(r => r.shorts >= LC_CHRONIC_MIN_SHORTS)
    .map(r => ({ ...r, sessions: r.sessions.size }))
    .sort((a, b) => b.variance - a.variance);
}

/* ---------------- row selection ---------------- */

function _lcVisibleRows() {
  let out = (LC_STATE.rows || []).slice();
  const q = String(LC_STATE.search || "").toLowerCase().trim();
  if (q) out = out.filter(r => (r.pn + " " + _lcPartDesc(r.pn)).toLowerCase().indexOf(q) !== -1);
  if (LC_STATE.onlyFlagged) out = out.filter(r => r.check_flag);
  if (LC_STATE.onlyChronic) {
    const set = new Set(_lcChronic().map(c => c.pn));
    out = out.filter(r => set.has(r.pn));
  }
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

/* ---------------- actions: filter / sort ---------------- */

// A: the filter must never rebuild its own input, or the caret dies
// between letters. Debounce the keystrokes, then repaint the TABLE
// only -- the input element is left completely untouched, so focus and
// selection survive without any save/restore trickery.
function _lcOnFilterInput(v) {
  LC_STATE.search = String(v || "");
  if (LC_STATE._filterTimer) clearTimeout(LC_STATE._filterTimer);
  LC_STATE._filterTimer = setTimeout(() => {
    LC_STATE._filterTimer = null;
    _lcPaintTable();
  }, LC_FILTER_DEBOUNCE_MS);
}
function _lcClearFilter() {
  LC_STATE.search = "";
  const el = document.getElementById("lc-filter");
  if (el) el.value = "";
  _lcPaintTable();
  if (el) el.focus();
}
function _lcSort(key) {
  if (LC_STATE.sortKey === key) LC_STATE.sortDir = LC_STATE.sortDir === "asc" ? "desc" : "asc";
  else { LC_STATE.sortKey = key; LC_STATE.sortDir = key === "pn" ? "asc" : "desc"; }
  _lcPaintTable();
}
function _lcToggleFlagged() { LC_STATE.onlyFlagged = !LC_STATE.onlyFlagged; _lcPaintTable(); }
function _lcToggleChronicFilter() { LC_STATE.onlyChronic = !LC_STATE.onlyChronic; _lcPaintTable(); }
function _lcShowAll() { LC_STATE.showAll = true; _lcPaintTable(); }
function _lcToggleAnomalies() { LC_STATE.anomaliesOpen = !LC_STATE.anomaliesOpen; refresh(); }
function _lcToggleTriage() { LC_STATE.triageOpen = !LC_STATE.triageOpen; refresh(); }
function _lcToggleChronic() { LC_STATE.chronicOpen = !LC_STATE.chronicOpen; refresh(); }

/* ---------------- actions: writes ---------------- */

async function _lcPost(write) {
  const resp = await fetch("/.netlify/functions/cycle-count-write", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-fs-edit-token": (typeof FS_EDIT_TOKEN_CLIENT !== "undefined") ? FS_EDIT_TOKEN_CLIENT : "",
      "x-app-build": String((typeof APP_BUILD !== "undefined") ? APP_BUILD : 0),
    },
    body: JSON.stringify({ writes: [write] }),
  });
  let json = null;
  try { json = await resp.json(); } catch (_) {}
  const r0 = json && Array.isArray(json.results) ? json.results[0] : null;
  if (r0 && r0.ok === false) return { ok: false, error: String(r0.error || "rejected"), result: r0 };
  if (!resp.ok || (json && json.ok === false)) {
    return { ok: false, error: (json && json.error) || ("server " + resp.status) };
  }
  return { ok: true, result: r0 };
}
function _lcErr(detail) {
  const msg = "Line Count: " + detail;
  if (typeof showToast === "function") showToast(msg, "warn"); else alert(msg);
}
function _lcNameOrWarn() {
  const name = (typeof _ccName === "function") ? _ccName() : "";
  if (!name) _lcErr("enter your name on the Inventory Reconciliation tab first — it stamps every count");
  return name;
}

function _lcSetEntry(pn, v) { LC_STATE.entry[pn] = v; }

async function _lcSaveCount(pn) {
  const name = _lcNameOrWarn(); if (!name) return;
  const raw = LC_STATE.entry[pn];
  if (raw === undefined || raw === "" || !Number.isFinite(Number(raw))) { _lcErr("enter a count first"); return; }
  const row = (LC_STATE.rows || []).find(r => r.pn === pn);
  if (!row) return;
  const band = _lcBandFor(row);
  const counted = Math.max(0, Math.round(Number(raw)));
  LC_STATE.saving[pn] = true; _lcPaintTable();
  const res = await _lcPost({
    op: "recordShelfCount",
    pn, counted_qty: counted, counted_by: name,
    band_low: band.low, band_high: band.high,
    line_float_at_count: band.bomFloat,
    session_id: LC_STATE.session ? LC_STATE.session.id : undefined,
  });
  LC_STATE.saving[pn] = false;
  if (!res.ok) { _lcErr("count save failed: " + res.error); _lcPaintTable(); return; }
  const r0 = res.result || {};
  const rec = {
    id: r0.id, pn, counted_qty: counted, counted_at: r0.countedAt || new Date().toISOString(),
    counted_by: name, verdict: r0.verdict, on_hand_at_count: band.high,
    band_low: band.low, band_high: band.high,
    miss: Number.isFinite(Number(r0.miss)) ? Number(r0.miss) : undefined,
    session_id: LC_STATE.session ? LC_STATE.session.id : null,
    confirmed: false,
  };
  if (!(LC_STATE.counts instanceof Map)) LC_STATE.counts = new Map();
  LC_STATE.counts.set(pn, rec);
  LC_STATE.allCounts = [rec, ...(LC_STATE.allCounts || [])];
  delete LC_STATE.entry[pn];
  const g = _lcGrade(rec);
  if (typeof showToast === "function") {
    const label = (g && g.hard && !g.material) ? "OK (within noise)" : String(r0.verdict || "").toUpperCase();
    showToast(`${pn}: counted ${counted} — ${label}`, (g && g.material) ? "warn" : "ok");
  }
  _lcTouch();
  refresh();
}

async function _lcToggleConfirm(countId, pn, on) {
  const name = _lcNameOrWarn(); if (!name) { refresh(); return; }
  if (!countId) { _lcErr("this count predates recount confirmation — recount and save it again"); return; }
  LC_STATE.busy = true; _lcPaintTable();
  const res = await _lcPost({ op: "confirmShelfCount", count_id: countId, confirmed_by: name, confirmed: !!on });
  LC_STATE.busy = false;
  if (!res.ok) { _lcErr("confirm failed: " + res.error); refresh(); return; }
  const patch = (c) => {
    if (!c || c.id !== countId) return c;
    return { ...c, confirmed: !!on, confirmed_by: on ? name : null, confirmed_at: on ? new Date().toISOString() : null };
  };
  LC_STATE.allCounts = (LC_STATE.allCounts || []).map(patch);
  const cur = LC_STATE.counts.get(pn);
  if (cur && cur.id === countId) LC_STATE.counts.set(pn, patch(cur));
  _lcTouch();
  refresh();
}

async function _lcStartSession() {
  const name = _lcNameOrWarn(); if (!name) return;
  const rows = LC_STATE.rows || [];
  if (rows.length === 0) { _lcErr("no band data to snapshot — run the compute first"); return; }
  LC_STATE.busy = true; refresh();
  const m = LC_STATE.meta || {};
  const res = await _lcPost({
    op: "startCountSession",
    started_by: name,
    snapshot: rows.map(r => ({
      pn: r.pn, band_low: r.band_low, band_high: r.band_high,
      allocated_at_line: r.allocated_at_line, released_float: r.released_float,
    })),
    feeds: {
      prod_orders_synced_at: m.prod_orders_synced_at || null,
      locations_synced_at: m.locations_synced_at || null,
      bom_pulled_at: m.bom_pulled_at || null,
      computed_at: m.computed_at || null,
    },
  });
  LC_STATE.busy = false;
  if (!res.ok) { _lcErr(res.error); refresh(); return; }
  const r0 = res.result || {};
  LC_STATE.session = {
    id: r0.id, started_at: r0.startedAt || new Date().toISOString(), started_by: name,
    finished_at: null,
    snapshot: {
      parts: rows.map(r => ({
        pn: r.pn, band_low: Number(r.band_low) || 0, band_high: Number(r.band_high) || 0,
        allocated: Number(r.allocated_at_line) || 0, bom_float: Number(r.released_float) || 0,
      })),
      feeds: { prod_orders_synced_at: m.prod_orders_synced_at || null, locations_synced_at: m.locations_synced_at || null },
      partCount: rows.length,
    },
  };
  LC_STATE.lastSummary = null;
  if (typeof showToast === "function") showToast(`Count session open — ${r0.parts} part bands frozen`, "ok");
  _lcTouch(); refresh();
}

async function _lcFinishSession() {
  const name = _lcNameOrWarn(); if (!name) return;
  const s = LC_STATE.session;
  if (!s) return;
  LC_STATE.busy = true; refresh();
  const res = await _lcPost({ op: "finishCountSession", session_id: s.id, finished_by: name });
  LC_STATE.busy = false;
  if (!res.ok) { _lcErr("finish failed: " + res.error); refresh(); return; }
  const r0 = res.result || {};
  LC_STATE.lastSummary = { ...(r0.summary || {}), startedAt: s.started_at, finishedAt: r0.finishedAt };
  LC_STATE.session = null;
  if (typeof showToast === "function") {
    const t = r0.summary || {};
    showToast(`Count closed — ${t.counted || 0} counted, ${t.short || 0} short, ${t.over || 0} over`, "ok");
  }
  _lcTouch(); refresh();
}

/* ---------------- export ---------------- */

// Deliberately Part / Description / Count Low / Count High only. This
// sheet goes to whoever walks the location; showing them the expected
// on-hand figure invites counting toward the answer. Exports the full
// filtered set, not just the painted page.
function _lcExportCsv() {
  const rows = _lcVisibleRows();
  const esc2 = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
  const lines = [["Part", "Description", "Count Low", "Count High"].map(esc2).join(",")];
  for (const r of rows) {
    const b = _lcBandFor(r);
    lines.push([r.pn, _lcPartDesc(r.pn), Math.round(b.low), Math.round(b.high)].map(esc2).join(","));
  }
  const iso = new Date().toISOString().slice(0, 10);
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `line-count-${iso}.csv`;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}

if (typeof window !== "undefined") {
  Object.assign(window, {
    _lcSetEntry, _lcSaveCount, _lcExportCsv, _lcSort, _lcOnFilterInput, _lcClearFilter,
    _lcToggleFlagged, _lcToggleAnomalies, _lcReload, _lcStartSession, _lcFinishSession,
    _lcToggleConfirm, _lcToggleTriage, _lcToggleChronic, _lcToggleChronicFilter, _lcShowAll,
  });
}

/* ---------------- render: pieces ---------------- */

function _lcHeaderHtml() {
  const m = LC_STATE.meta;
  if (!m) return `<div class="empty tiny muted">No compute has run yet — the band appears once line-float-compute writes it (hourly after each production-order sync, or 06:30 UTC).</div>`;
  const stamps = [
    { label: "Production orders", at: m.prod_orders_synced_at },
    { label: "Location qty", at: m.locations_synced_at },
    { label: "BOM pull", at: m.bom_pulled_at },
    { label: "Computed", at: m.computed_at },
  ];
  const anyStale = stamps.some(s => _lcIsStale(s.at));
  const skew = _lcFeedSkewMin();
  const skewBad = skew !== null && skew > LC_FEED_SKEW_MIN;
  const units = Array.isArray(m.units_by_model) ? m.units_by_model : [];
  const noBom = units.filter(u => u && u.hasBom === false);
  return `
    ${anyStale ? `<div class="lc-banner">One or more feeds are more than ${LC_STALE_HOURS}h old — the band below may not reflect what is on the line right now. Check the timestamps.</div>` : ""}
    ${skewBad ? `<div class="lc-banner">Feed skew: the order feed and the location feed were taken <strong>${skew} minutes apart</strong> (tolerance ${LC_FEED_SKEW_MIN}m). Allocation comes from one and on-hand from the other, so this band describes no single moment — treat near-boundary counts as inconclusive until both feeds line up.</div>` : ""}
    <div class="lc-strip">
      ${stamps.map(s => `
        <div class="lc-stat">
          <div class="lc-stat-label">${esc(s.label)}</div>
          <div class="lc-stat-value ${_lcIsStale(s.at) ? "text-warn" : ""}">${esc(_lcAgo(s.at))}</div>
          <div class="lc-stat-sub mono">${esc(s.at ? String(s.at).slice(0, 16).replace("T", " ") : "unknown")}</div>
        </div>`).join("")}
      <div class="lc-stat">
        <div class="lc-stat-label">On the line</div>
        <div class="lc-stat-value">${_lcNum(m.total_units_on_line)} units</div>
        <div class="lc-stat-sub">${units.length} model${units.length === 1 ? "" : "s"} &middot; ${_lcNum(m.released_orders)} order${m.released_orders === 1 ? "" : "s"}${skew !== null ? ` &middot; skew ${skew}m` : ""}</div>
      </div>
    </div>
    <div class="lc-models">
      ${units.length === 0
        ? `<span class="dim tiny">No open production orders in an on-line status (${(m.on_line_statuses || []).join(" / ") || "none configured"}).</span>`
        : units.slice().sort((a, b) => (b.units || 0) - (a.units || 0)).map(u => `
            <span class="lc-model${u.hasBom === false ? " lc-model-nobom" : ""}" title="${esc((u.desc || "") + (u.hasBom === false ? " — NO BOM: this model's consumption is invisible to the cross-check" : ""))}">
              <span class="mono">${esc(u.sku)}</span> ${_lcNum(u.units)}<span class="dim"> / ${_lcNum(u.orders)} ord</span>${u.hasBom === false ? ' <span class="pill warn lc-chip">NO BOM</span>' : ""}
            </span>`).join("")}
    </div>
    ${noBom.length > 0 ? `<div class="dim tiny" style="margin-top:4px">${noBom.length} model(s) on the line have no BOM — their consumption is missing from the cross-check column, so a delta flag on parts they use may be a false alarm. The band itself is unaffected.</div>` : ""}
  `;
}

function _lcSessionHtml() {
  const s = LC_STATE.session;
  const busy = LC_STATE.busy;
  if (s) {
    const feeds = (s.snapshot && s.snapshot.feeds) || {};
    const counted = (LC_STATE.allCounts || []).filter(c => c.session_id === s.id);
    const t = { ok: 0, short: 0, over: 0, noise: 0 };
    for (const c of counted) {
      const g = _lcGrade(c);
      if (!g || !g.hard) t.ok++;
      else if (!g.material) t.noise++;
      else if (g.verdict === "short") t.short++;
      else t.over++;
    }
    return `
      <div class="lc-session lc-session-open">
        <div class="lc-session-main">
          <div class="lc-session-title">Counting against the snapshot from ${esc(_lcClock(s.started_at))}</div>
          <div class="dim tiny">
            Frozen ${_lcNum((s.snapshot && s.snapshot.partCount) || 0)} part bands &middot; opened by ${esc(s.started_by || "?")} ${esc(_lcAgo(s.started_at))}.
            Every count below is graded against these numbers, not live data, so a sync mid-walk cannot re-grade what you already counted.
            ${feeds.prod_orders_synced_at ? `<br>Snapshot feeds — orders ${esc(String(feeds.prod_orders_synced_at).slice(0, 16).replace("T", " "))}, locations ${esc(String(feeds.locations_synced_at || "unknown").slice(0, 16).replace("T", " "))}.` : ""}
          </div>
          <div class="lc-session-tally">
            <span>${counted.length} counted</span>
            <span class="pill ok">${t.ok} ok</span>
            ${t.noise > 0 ? `<span class="pill info">${t.noise} within noise</span>` : ""}
            ${t.short > 0 ? `<span class="pill crit">${t.short} short</span>` : ""}
            ${t.over > 0 ? `<span class="pill warn">${t.over} over</span>` : ""}
          </div>
        </div>
        <button class="btn primary" ${busy ? "disabled" : ""} onclick="_lcFinishSession()">${busy ? "..." : "Finish count"}</button>
      </div>`;
  }
  const sum = LC_STATE.lastSummary;
  return `
    <div class="lc-session">
      <div class="lc-session-main">
        <div class="lc-session-title">No count session open</div>
        <div class="dim tiny">Counts are graded against the live band, which moves whenever orders or location qty sync. Start a session to freeze every band for the length of the walk so the same physical count cannot read OK now and SHORT after lunch.</div>
        ${sum ? `
          <div class="lc-session-tally" style="margin-top:8px">
            <span class="dim tiny">Last session ${esc(_lcClock(sum.startedAt))}&ndash;${esc(_lcClock(sum.finishedAt))}:</span>
            <span>${_lcNum(sum.counted)} counted</span>
            <span class="pill ok">${_lcNum(sum.ok)} ok</span>
            ${sum.short ? `<span class="pill crit">${_lcNum(sum.short)} short</span>` : ""}
            ${sum.over ? `<span class="pill warn">${_lcNum(sum.over)} over</span>` : ""}
          </div>
          ${Array.isArray(sum.biggestMisses) && sum.biggestMisses.length ? `
            <div class="dim tiny" style="margin-top:4px">Biggest misses: ${sum.biggestMisses.slice(0, 6).map(b => `<span class="mono">${esc(b.pn)}</span> ${b.miss > 0 ? "+" : ""}${_lcNum(b.miss, 1)}`).join(" &middot; ")}</div>` : ""}
        ` : ""}
      </div>
      <button class="btn primary" ${busy ? "disabled" : ""} onclick="_lcStartSession()">${busy ? "..." : "Start count"}</button>
    </div>`;
}

// The next-step strip. This is the whole point of grading a count: the
// verdict alone tells Dylan something is wrong, the strip tells him what
// to do about it. Adjustments happen in Acumatica by hand -- nothing
// here writes to it.
function _lcNextStepHtml(count, grade) {
  if (!grade || !grade.hard || !grade.material) return "";
  const diff = Math.abs(grade.miss);
  const confirmed = !!count.confirmed;
  const chk = `
    <label class="lc-confirm" title="Tick once someone has physically walked back and recounted. Only confirmed shorts reach the chronic-leak list.">
      <input type="checkbox" class="chk" ${confirmed ? "checked" : ""} ${LC_STATE.busy ? "disabled" : ""}
             onchange="_lcToggleConfirm('${esc(count.id || "")}','${esc(count.pn)}', this.checked)">
      <span>${confirmed ? `Confirmed after recount${count.confirmed_by ? " by " + esc(count.confirmed_by) : ""}` : "Confirmed after recount"}</span>
    </label>`;
  if (grade.verdict === "short") {
    const sized = grade.missKnown
      ? `<strong>SHORT by ${_lcNum(diff, 1)}.</strong>`
      : `<strong>SHORT, size unknown.</strong> This count predates the band being stored on the row, so how far short it ran cannot be recovered — recount to get a current number.`;
    const action = grade.missKnown
      ? `If the recount confirms it, adjust in Acumatica at <span class="mono">${LC_LINE_WAREHOUSE}/${LC_LINE_LOCATION}</span>
         <strong>down by ${_lcNum(diff, 1)} or more</strong> (count ${_lcNum(grade.counted)} vs band low ${_lcNum(Number(count.band_low))}).`
      : `If the recount confirms it, adjust in Acumatica at <span class="mono">${LC_LINE_WAREHOUSE}/${LC_LINE_LOCATION}</span> to the recounted figure.`;
    return `
      <div class="lc-step lc-step-short">
        ${sized}
        Recount and check the stations before anything else — stock staged at a cell still belongs to this location.
        ${action}
        ${chk}
      </div>`;
  }
  return `
    <div class="lc-step lc-step-over">
      <strong>OVER by ${_lcNum(diff, 1)}.</strong>
      Recount first. An over is usually an un-posted return or a completion that has not backflushed yet, not real extra stock —
      check for both before adjusting up.
      ${chk}
    </div>`;
}

function _lcChronicHtml() {
  const list = _lcChronic();
  if (list.length === 0 && !LC_STATE.onlyChronic) {
    return `<div class="lc-panel"><div class="lc-panel-head"><strong>Chronic leaks</strong><span class="dim tiny">No part has ${LC_CHRONIC_MIN_SHORTS}+ confirmed material shorts yet. Tick "confirmed after recount" on a short to start building this list.</span></div></div>`;
  }
  const total = list.reduce((s, r) => s + r.variance, 0);
  return `
    <div class="lc-panel">
      <div class="lc-panel-head">
        <button class="btn sm ghost" onclick="_lcToggleChronic()">${LC_STATE.chronicOpen ? "&#9662;" : "&#9656;"} Chronic leaks: ${list.length}</button>
        <span class="dim tiny">${LC_CHRONIC_MIN_SHORTS}+ confirmed material shorts &middot; ${_lcNum(total, 1)} units of confirmed variance total. This is the process-problem punch list, not a counting list.</span>
        <span class="flex-1"></span>
        <label class="row gap-sm" style="align-items:center;cursor:pointer">
          <input type="checkbox" class="chk" ${LC_STATE.onlyChronic ? "checked" : ""} onchange="_lcToggleChronicFilter()">
          <span class="muted tiny">Show only these in the table</span>
        </label>
      </div>
      ${LC_STATE.chronicOpen && list.length > 0 ? `
        <div class="tbl-wrap" style="max-height:260px;overflow:auto">
          <table class="tbl"><thead><tr>
            <th style="width:130px">Part</th><th>Description</th>
            <th class="right" style="width:120px">Confirmed shorts</th>
            <th class="right" style="width:140px">Total variance</th>
            <th class="right" style="width:120px">Last</th>
          </tr></thead><tbody>
            ${list.map(r => `<tr>
              <td class="mono">${esc(r.pn)}</td>
              <td class="dim">${esc(_lcPartDesc(r.pn))}</td>
              <td class="right num bold">${r.shorts}</td>
              <td class="right num text-warn">${_lcNum(r.variance, 1)}</td>
              <td class="right dim tiny">${esc(_lcAgo(r.last))}</td>
            </tr>`).join("")}
          </tbody></table>
        </div>` : ""}
    </div>`;
}

function _lcTriageHtml() {
  const flagged = (LC_STATE.rows || []).filter(r => r.check_flag)
    .sort((a, b) => Math.abs(Number(b.check_delta) || 0) - Math.abs(Number(a.check_delta) || 0));
  if (flagged.length === 0) {
    return `<div class="lc-panel"><div class="lc-panel-head"><strong>Cross-check triage</strong><span class="dim tiny">No part's allocation disagrees with its BOM float by more than max(1, 5% of on hand). Acumatica's allocation and the BOM agree.</span></div></div>`;
  }
  const top = flagged.slice(0, 15);
  return `
    <div class="lc-panel">
      <div class="lc-panel-head">
        <button class="btn sm ghost" onclick="_lcToggleTriage()">${LC_STATE.triageOpen ? "&#9662;" : "&#9656;"} Cross-check triage: ${flagged.length} flagged</button>
        <span class="dim tiny">allocated &minus; BOM float, past max(1, 5% of on hand). A positive delta means Acumatica is holding more than the BOM says the line needs (stuck allocation from a closed order); negative means the BOM explodes to more than Acumatica reserved (missing BOM line, or a model on the line with no BOM). Neither moves the band.</span>
      </div>
      ${LC_STATE.triageOpen ? `
        <div class="tbl-wrap" style="max-height:300px;overflow:auto">
          <table class="tbl"><thead><tr>
            <th style="width:130px">Part</th><th>Description</th>
            <th class="right" style="width:90px">On hand</th>
            <th class="right" style="width:100px">Allocated</th>
            <th class="right" style="width:100px">BOM float</th>
            <th class="right" style="width:100px">Delta</th>
            <th style="width:150px">Likely cause</th>
          </tr></thead><tbody>
            ${top.map(r => {
              const d = Number(r.check_delta) || 0;
              return `<tr>
                <td class="mono">${esc(r.pn)}</td>
                <td class="dim">${esc(_lcPartDesc(r.pn))}</td>
                <td class="right num">${_lcNum(r.onhand_at_line)}</td>
                <td class="right num">${_lcNum(r.allocated_at_line)}</td>
                <td class="right num">${_lcNum(r.released_float, 1)}</td>
                <td class="right num bold text-warn">${d > 0 ? "+" : ""}${_lcNum(d, 1)}</td>
                <td class="tiny dim">${d > 0 ? "stuck allocation" : "missing BOM coverage"}</td>
              </tr>`;
            }).join("")}
          </tbody></table>
        </div>
        ${flagged.length > top.length ? `<div class="dim tiny" style="padding:6px 2px">Showing the top 15 by |delta|; ${flagged.length - top.length} more are flagged. Use the "only cross-check flags" toggle for the full list.</div>` : ""}
      ` : ""}
    </div>`;
}

function _lcAnomaliesHtml() {
  const m = LC_STATE.meta;
  const list = (m && Array.isArray(m.anomalies)) ? m.anomalies : [];
  const byKind = {};
  for (const a of list) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  const summary = Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(", ") || "none";
  return `
    <div class="lc-panel">
      <div class="lc-panel-head">
        <button class="btn sm ghost" onclick="_lcToggleAnomalies()">${LC_STATE.anomaliesOpen ? "&#9662;" : "&#9656;"} Anomalies: ${list.length}</button>
        <span class="dim tiny">${esc(summary)}</span>
      </div>
      ${LC_STATE.anomaliesOpen && list.length > 0 ? `
        <div class="tbl-wrap" style="max-height:280px;overflow:auto">
          <table class="tbl"><thead><tr><th style="width:150px">Kind</th><th style="width:120px">Part</th><th>Detail</th></tr></thead>
          <tbody>${list.map(a => `<tr><td class="mono tiny">${esc(a.kind)}</td><td class="mono">${esc(a.parent || "")}</td><td class="tiny">${esc(a.detail || "")}</td></tr>`).join("")}</tbody></table>
        </div>` : ""}
    </div>`;
}

/* ---------------- render: the table ---------------- */

function _lcRowHtml(r) {
  const pn = r.pn;
  const band = _lcBandFor(r);
  const last = (LC_STATE.counts instanceof Map) ? LC_STATE.counts.get(pn) : null;
  const grade = _lcGrade(last);
  const entry = LC_STATE.entry[pn];
  const saving = !!LC_STATE.saving[pn];
  const lo = Math.round(band.low), hi = Math.round(band.high);
  const degenerate = r.avail_known === false;
  // No row at the line at all, as opposed to a row with no availability.
  // Both render without a low end, but only one of them means "we have
  // no data for this part here" — and that one must say so, because 0-0
  // otherwise reads as a confident "the line holds none of these".
  const absent = r.at_line === false;
  const d = Number(r.check_delta) || 0;

  let verdictHtml = "";
  if (grade) {
    const cls = !grade.hard ? "ok" : (!grade.material ? "info" : (grade.verdict === "short" ? "crit" : "warn"));
    const label = !grade.hard ? "OK"
      : (!grade.material ? "OK (within noise)" : String(grade.verdict).toUpperCase());
    const title = grade.hard && !grade.material
      ? `Missed the band by ${Math.abs(grade.miss).toFixed(1)}, within the ${grade.floor.toFixed(1)}-unit noise floor for this part (max(${LC_NOISE_ABS}, ${LC_NOISE_PCT * 100}% of ${_lcNum(band.high)})) — not worth chasing.`
      : "";
    verdictHtml = `<div class="dim tiny lc-last" title="${esc(title)}">
        <span class="pill ${cls}">${esc(label)}</span>
        ${_lcNum(last.counted_qty)} &middot; ${esc(_lcAgo(last.counted_at))}${last.counted_by ? " &middot; " + esc(last.counted_by) : ""}
      </div>`;
  }

  return `
    <tr>
      <td class="mono">${esc(pn)}</td>
      <td class="dim">${esc(_lcPartDesc(pn))}</td>
      <td class="right num">${_lcNum(r.onhand_at_line)}</td>
      <td class="right num ${degenerate ? "dim" : ""}">${degenerate ? "&mdash;" : _lcNum(r.avail_at_line)}</td>
      <td class="right num dim">${degenerate ? "&mdash;" : _lcNum(r.allocated_at_line)}</td>
      <td class="right num dim">${_lcNum(r.released_float, 1)}</td>
      <td class="right num">${degenerate
        ? '<span class="dim" title="Available missing for this part — no allocation figure to compare against">n/a</span>'
        : `<span class="${r.check_flag ? "text-warn bold" : "dim"}">${d > 0 ? "+" : ""}${_lcNum(d, 1)}</span>`}</td>
      <td class="mono bold">${absent
        ? `<span class="text-warn" title="This part has NO row at ${LC_LINE_WAREHOUSE}/${LC_LINE_LOCATION}. It is either issued from another location or missing from the location feed — this is not a statement that the line holds none.">no line row</span>`
        : (degenerate
          ? `<span class="text-warn" title="QtyAvailable missing at the line, so there is no low end. Treat this as on-hand only, not a band.">${hi} (no low)</span>`
          : `${lo} &ndash; ${hi}`)}${band.frozen ? '<span class="lc-frozen" title="Frozen by the open count session">&#10052;</span>' : ""}</td>
      <td>
        <div class="row gap-sm" style="align-items:center">
          <input class="input num" type="number" min="0" step="1" style="width:78px"
                 value="${entry === undefined ? "" : esc(String(entry))}" placeholder="count"
                 oninput="_lcSetEntry('${esc(pn)}', this.value)">
          <button class="btn sm primary" ${saving ? "disabled" : ""} onclick="_lcSaveCount('${esc(pn)}')">${saving ? "..." : "Save"}</button>
        </div>
        ${verdictHtml}
        ${last ? _lcNextStepHtml(last, grade) : ""}
      </td>
    </tr>`;
}

// Repaints ONLY the table body and its count line. Never touches the
// filter input, so the caret survives. This is the function every
// filter / sort / toggle goes through.
function _lcPaintTable() {
  const host = document.getElementById("lc-tbody");
  if (!host) { refresh(); return; }   // shell not up yet
  const rows = _lcVisibleRows();
  const capped = !LC_STATE.showAll && rows.length > LC_ROW_CAP;
  const painted = capped ? rows.slice(0, LC_ROW_CAP) : rows;
  host.innerHTML = painted.map(_lcRowHtml).join("");

  const note = document.getElementById("lc-count-note");
  if (note) {
    const all = (LC_STATE.rows || []).length;
    note.innerHTML = capped
      ? `Showing ${LC_ROW_CAP} of ${rows.length} matching parts (${all} total) &mdash; <a href="#" onclick="_lcShowAll();return false;">show all</a>, or narrow the filter. Export and the tallies use the full ${rows.length}.`
      : `Showing ${rows.length} of ${all} parts.`;
  }
  // Sort arrows live in the header row, which is outside the tbody.
  const thead = document.getElementById("lc-thead");
  if (thead) thead.innerHTML = _lcTheadHtml();
  LC_STATE._paintedVersion = LC_STATE._dataVersion;
}

function _lcTheadHtml() {
  const th = (key, label, cls) =>
    `<th class="${cls || ""}" style="cursor:pointer" onclick="_lcSort('${key}')">${label}${LC_STATE.sortKey === key ? (LC_STATE.sortDir === "asc" ? " &#9650;" : " &#9660;") : ""}</th>`;
  return `<tr>
    ${th("pn", "Part")}
    <th>Description</th>
    ${th("onhand_at_line", "On hand @ line", "right")}
    ${th("avail_at_line", "Available @ line", "right")}
    ${th("allocated_at_line", "Allocated", "right")}
    ${th("released_float", "BOM float", "right")}
    ${th("check_delta", "Delta", "right")}
    <th>Count should be</th>
    <th style="width:300px">Physical count</th>
  </tr>`;
}

/* ---------------- render: shell ---------------- */

function renderLineCount() {
  const main = document.getElementById("main");
  if (!main) return;
  _lcRouteEnter();

  // A: the shell carries the filter input. Rebuilding it on a keystroke
  // is what stole focus, so the shell is rebuilt ONLY when the
  // underlying data actually changed. Any other refresh() -- a timer, a
  // realtime nudge, another tab's bump -- repaints the table alone and
  // leaves the caret where it was.
  const shellUp = !!main.querySelector('[data-page="line-count"]');
  if (shellUp && LC_STATE._paintedVersion === LC_STATE._dataVersion) { _lcPaintTable(); return; }

  const loading = LC_STATE.rows === null || LC_STATE.loading;
  const all = LC_STATE.rows || [];
  const flaggedCount = all.filter(r => r.check_flag).length;
  // Two distinct failures. `at_line === false` means the part has no row
  // at WHI900/RMSTOR-LM at all (not stocked there, or the location feed
  // dropped it — a truncated read of part_locations looks exactly like
  // this). `at_line === true` with no availability means the row is
  // there but QtyAvailableinLocation did not parse. Different causes,
  // different fixes; one banner for both hid a real data-loss bug.
  // at_line is undefined on pre-r3 rows — treat those as unknown rather
  // than asserting either way.
  const notAtLine = all.filter(r => r.at_line === false).length;
  const availUnknown = all.filter(r => r.at_line !== false && r.avail_known === false).length;
  const name = (typeof _ccName === "function") ? _ccName() : "";

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
      .lc-chip { font-size:9px; padding:0 4px; }
      .lc-toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:12px 0 6px; }
      .lc-table th { white-space:nowrap; }
      .lc-table td { vertical-align:top; }
      .lc-last { margin-top:3px; }
      .lc-frozen { margin-left:5px; opacity:.65; font-weight:400; }
      /* Local warn bar: the app has no global .banner class (the IR tab
         asks for one and gets unstyled markup), so define our own. */
      .lc-banner {
        margin:8px 0; padding:8px 12px; border-radius:6px; font-size:12px;
        background:var(--warn-soft); color:var(--warn); border:1px solid var(--warn-bd);
      }
      .lc-session {
        display:flex; gap:16px; align-items:flex-start; margin:12px 0;
        padding:12px 14px; border:1px solid var(--line,#cbd5e1); border-radius:8px;
      }
      .lc-session-open { border-color:var(--accent,#2563eb); background:var(--info-soft,rgba(37,99,235,.06)); }
      .lc-session-main { flex:1; min-width:0; }
      .lc-session-title { font-size:13px; font-weight:700; margin-bottom:3px; }
      .lc-session-tally { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px; font-size:12px; }
      .lc-panel { margin-top:14px; border:1px solid var(--line,#cbd5e1); border-radius:8px; padding:10px 12px; }
      .lc-panel-head { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:6px; }
      .lc-step {
        margin-top:5px; padding:6px 9px; border-radius:5px; font-size:11.5px; line-height:1.5;
        border-left:3px solid var(--warn,#b45309); background:var(--bg-2,rgba(0,0,0,.03));
      }
      .lc-step-short { border-left-color:var(--crit,#dc2626); }
      .lc-confirm { display:flex; gap:6px; align-items:center; margin-top:5px; cursor:pointer; font-size:11px; }
    </style>
    <div class="page" data-page="line-count">
      <div class="page-head">
        <div>
          <div class="page-title">Line Count</div>
          <div class="page-sub">What a physical count of <span class="mono">${LC_LINE_WAREHOUSE}/${LC_LINE_LOCATION}</span> should come to. Acumatica allocates stock to open production orders but only backflushes on completion, so the answer is a band, not a number. A count inside the band is OK; below the low end is a short worth chasing.</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="_lcReload()">Reload</button>
          <button class="btn" onclick="_lcExportCsv()">Export CSV</button>
        </div>
      </div>

      ${_lcHeaderHtml()}
      ${_lcSessionHtml()}

      ${!name ? `<div class="lc-banner">Enter your name on the Inventory Reconciliation tab before counting &mdash; it is stamped on every count.</div>` : ""}
      ${availUnknown > 0 ? `<div class="lc-banner">${availUnknown} part(s) have a row at the line but no QtyAvailable, so they show an on-hand figure with no low end rather than a band. Those rows cannot read SHORT.</div>` : ""}
      ${notAtLine > 0 ? `<div class="lc-banner">${notAtLine} part(s) are consumed by open orders but have <strong>no location row at all</strong> at <span class="mono">${LC_LINE_WAREHOUSE}/${LC_LINE_LOCATION}</span>, so they read 0. Either they are issued from a different location, or the location feed is incomplete for them &mdash; do not read a count of 0 on those rows as agreement. If this number jumps between computes, the location read is coming back short; check the <span class="mono">[FETCH]</span> and <span class="mono">[LINE]</span> lines in the compute log.</div>` : ""}

      <div class="lc-toolbar">
        <input class="input" id="lc-filter" placeholder="Filter part or description..."
               value="${esc(LC_STATE.search)}" oninput="_lcOnFilterInput(this.value)" style="max-width:280px">
        ${LC_STATE.search ? `<button class="btn sm ghost" onclick="_lcClearFilter()">Clear</button>` : ""}
        <label class="row gap-sm" style="align-items:center;cursor:pointer">
          <input type="checkbox" class="chk" ${LC_STATE.onlyFlagged ? "checked" : ""} onchange="_lcToggleFlagged()">
          <span class="muted tiny">Only cross-check flags (${flaggedCount})</span>
        </label>
      </div>
      <div class="dim tiny" id="lc-count-note" style="margin-bottom:8px"></div>

      ${loading
        ? `<div class="empty tiny muted">Loading line data...</div>`
        : (all.length === 0
            ? `<div class="empty"><div class="empty-title muted">No line data yet</div><div class="empty-msg">The band appears once line-float-compute writes it &mdash; it now runs after every production-order sync, and at 06:30 UTC.</div></div>`
            : `<div class="tbl-wrap"><table class="tbl lc-table">
                <thead id="lc-thead">${_lcTheadHtml()}</thead>
                <tbody id="lc-tbody"></tbody>
              </table></div>`)}

      ${_lcChronicHtml()}
      ${_lcTriageHtml()}
      ${_lcAnomaliesHtml()}
    </div>
  `;
  if (!loading && all.length > 0) _lcPaintTable();
  LC_STATE._paintedVersion = LC_STATE._dataVersion;
}

if (typeof registerRoute === "function") registerRoute("line-count", renderLineCount);
