/* =====================================================
   28-page-backup-buy.js -- BACKUP BUY QUEUE.

   Sidebar: STOCK > Backup Buy Queue (replaces the Line Count nav
   entry; js/27's band loader is reused, not removed).

   THE IDEA
   The Base BOM queue trusts live on-hand. Live on-hand drifts: the
   recon ledger's nightly residual is exactly the record-keeping error
   between what the books say and what the receipts and burn account
   for. This queue runs the SAME reorder math with ONE input swapped:

     modeled on-hand = anchor + receipts since - usage since
                     = live on-hand - accumulated residual since anchor

   where anchor = the most recent count event, else the operator's
   baseline, else nothing (row says "no anchor"). The second identity
   is what the ledger already computes nightly, rate-step and chain
   aware (parts_onhand_snapshots.usage_est), so the model is READ from
   _irAggregate() -- never reinvented. Live parts.onHand is never an
   input to this queue's math; it is shown only for the comparison.

   REUSE, NOT REIMPLEMENTATION
   Shadow parts = clones with onHand := modeled, run through the real
   partsWithStatus({ parts }) / queueParts("base_bom", { parts }) --
   partStatus, blanket awareness, pre-launch, chain admission, force-
   admit gates, suggestedQty / cycleAwareSuggestedQty -- byte-identical
   to the Base BOM queue except for the parts array. When modeled equals
   live the two queues are identical by construction; the boot harness
   asserts that.

   DISAGREEMENT-FIRST VIEW
   Default filter: rows where the two queues disagree.
     MODEL SAYS ORDER, live silent -> "live may be inflated -- count
       before stockout"
     LIVE SAYS ORDER, model silent -> "live may be understated -- count
       before spending"
   Noise rules: placeholder rates (daily === 1) badge PLACEHOLDER and
   never flag; a delta inside the part's line-float band reads
   "explained by line float"; materiality = |delta| >= units AND
   |delta x cost| >= dollars, both editable on the tab.

   NEVER writes on-hand. Actions are Flag for count (existing) and Set
   baseline (an anchor DATE in settings + an audit row; distinct from a
   count).
   ===================================================== */

const BB_STATE = {
  filter: "disagree",       // "disagree" | "all"
  search: "",
  ready: false,             // snapshots + band loaded at least once
  loading: false,
  thresholds: { units: 5, usd: 50 },
  _supaWaitAttempts: 0,
  _lastError: null,
};
const BB_MIN_WINDOW_DAYS = 90;   // the recon ledger's default window is 30d; a baseline older than the window would truncate the model
const BB_THRESHOLD_KEY = "landmaster.backupBuy.thresholds";

try {
  const t = JSON.parse(localStorage.getItem(BB_THRESHOLD_KEY) || "null");
  if (t && Number.isFinite(t.units) && Number.isFinite(t.usd)) BB_STATE.thresholds = { units: Math.max(0, t.units), usd: Math.max(0, t.usd) };
} catch (_) {}

/* ---------------- pure helpers (tested by slice) ---------------- */

// The model, from the ledger aggregate. Returns null when there is no
// anchor (no count, no baseline) -- the row must say so, not guess.
function _bbModel(agg, liveOnHand) {
  const live = Number(liveOnHand) || 0;
  if (!agg || !agg.anchorKind) return null;
  const residual = Number(agg.residualSum) || 0;
  const modeled = Math.max(0, live - residual);
  return {
    modeled,
    delta: modeled - live,             // = -accumulated residual (negative when live is inflated)
    residual,
    anchorAt: agg.lastCountedAt || null,
    anchorKind: agg.anchorKind,        // "count" | "baseline"
    ledgerDays: Number(agg.ledgerDays) || 0,
  };
}

function _bbMaterial(delta, unitCost, thr) {
  const t = thr || { units: 5, usd: 50 };
  const units = Math.abs(Number(delta) || 0);
  const usd = units * (Number(unitCost) || 0);
  return units >= (Number(t.units) || 0) && usd >= (Number(t.usd) || 0);
}

// Disagreement classification. `bandWidth` = line-float band_high -
// band_low at RMSTOR-LM (null when the part has no band).
function _bbClassify(x) {
  const placeholder = Number(x.daily) === 1;
  if (placeholder) return { kind: "placeholder", flag: false, label: "PLACEHOLDER rate — not flagged" };
  if (x.modelAdmits && x.liveAdmits) return { kind: "agree-order", flag: false, label: "both queues order" };
  if (!x.modelAdmits && !x.liveAdmits) return { kind: "agree-silent", flag: false, label: "" };
  const inBand = Number.isFinite(x.bandWidth) && Math.abs(Number(x.delta) || 0) <= x.bandWidth;
  if (inBand) return { kind: "explained-by-band", flag: false, label: "explained by line float (allocated, not yet backflushed)" };
  if (!x.material) return { kind: "immaterial", flag: false, label: "below materiality" };
  if (x.modelAdmits) return { kind: "model-orders", flag: true, label: "MODEL SAYS ORDER — live may be inflated — count before stockout" };
  return { kind: "live-orders", flag: true, label: "LIVE SAYS ORDER — live may be understated — count before spending" };
}

// Days from today to the modeled reorder-by (daysOfCover - reorderBy
// duration), Infinity when no runout in horizon.
function _bbReorderByDays(statusRow) {
  if (!statusRow) return Infinity;
  const cover = Number(statusRow.daysOfCover);
  const rb = Number(statusRow.reorderBy) || 0;
  return Number.isFinite(cover) ? cover - rb : Infinity;
}

function _bbSuggestedQty(sp) {
  const cyc = (typeof getSupplierCycle === "function") ? getSupplierCycle(sp.supplier) : null;
  if (cyc && typeof cycleAwareSuggestedQty === "function") return Math.max(0, Math.round(Number(cycleAwareSuggestedQty(sp, Number(sp.onPO) || 0)) || 0));
  if (typeof suggestedQty === "function") return Math.max(0, Math.round(Number(suggestedQty(sp, Number(sp.onPO) || 0)) || 0));
  return 0;
}

/* ---------------- data ---------------- */

function _bbRouteEnter() {
  if (typeof _supa === "undefined" || !_supa) {
    BB_STATE._supaWaitAttempts++;
    if (BB_STATE._supaWaitAttempts > 40) { BB_STATE.ready = true; return; }
    setTimeout(() => { if (CURRENT_ROUTE === "backup-buy") { _bbRouteEnter(); refresh(); } }, 250);
    return;
  }
  if (BB_STATE.loading) return;
  BB_STATE.loading = true;
  const jobs = [];
  // Ledger snapshots via the recon tab's own loader (same rows, same
  // aggregate). Widen its window so an older baseline is not truncated.
  if (typeof IR_STATE !== "undefined" && typeof _irLoadSnapshots === "function") {
    const want = Math.max(Number(IR_STATE.windowDays) || 0, BB_MIN_WINDOW_DAYS);
    if (IR_STATE.snapsLoadedFor !== want) {
      IR_STATE.windowDays = want;
      IR_STATE.snapsLoadedFor = null;
      if (typeof _irInvalidate === "function") _irInvalidate();
      jobs.push(_irLoadSnapshots(want));
    }
  }
  // Line-float band via js/27's loader (kept: same band semantics).
  if (typeof _lcLoad === "function" && typeof LC_STATE !== "undefined" && LC_STATE.rows === null) jobs.push(_lcLoad());
  Promise.all(jobs).catch(err => { BB_STATE._lastError = (err && err.message) || String(err); }).then(() => {
    BB_STATE.loading = false;
    BB_STATE.ready = true;
    if (typeof _irInvalidate === "function") _irInvalidate();
    if (CURRENT_ROUTE === "backup-buy") refresh();
  });
}

function _bbBuildRows() {
  const aggByPn = (typeof _irAggregate === "function") ? _irAggregate() : new Map();
  const bandByPn = new Map();
  if (typeof LC_STATE !== "undefined" && Array.isArray(LC_STATE.rows)) {
    for (const r of LC_STATE.rows) bandByPn.set(r.pn, r);
  }
  // Shadow set: clones; modeled on-hand where an anchor exists, else live.
  const modelByPn = new Map();
  const shadow = (DB.parts || []).map(p => {
    const m = _bbModel(aggByPn.get(p.pn), p.onHand);
    if (m) modelByPn.set(p.pn, m);
    return m ? { ...p, onHand: m.modeled } : { ...p };
  });

  const live = (typeof partsWithStatus === "function") ? partsWithStatus() : [];
  const liveQ = new Set(((typeof queueParts === "function") ? queueParts("base_bom") : []).map(p => p.pn));
  const shadowStats = (typeof partsWithStatus === "function") ? partsWithStatus({ parts: shadow }) : [];
  const shadowQ = new Set(((typeof queueParts === "function") ? queueParts("base_bom", { parts: shadow }) : []).map(p => p.pn));
  const liveByPn = new Map(live.map(p => [p.pn, p]));

  const rows = [];
  for (const sp of shadowStats) {
    if (String(sp.itemType || "").toLowerCase().trim() !== "base_bom") continue;
    if (sp.isKit) continue;
    const lp = liveByPn.get(sp.pn);
    const m = modelByPn.get(sp.pn) || null;
    const band = bandByPn.get(sp.pn) || null;
    const bandWidth = (band && band.avail_known !== false && band.at_line !== false)
      ? Math.max(0, (Number(band.band_high) || 0) - (Number(band.band_low) || 0)) : null;
    const cost = (typeof orderUnitCost === "function") ? (Number(orderUnitCost(sp)) || 0) : (Number(sp.cost) || 0);
    const modelAdmits = shadowQ.has(sp.pn);
    const liveAdmits = liveQ.has(sp.pn);
    const delta = m ? m.delta : 0;
    const material = m ? _bbMaterial(delta, cost, BB_STATE.thresholds) : false;
    const cls = _bbClassify({ daily: sp.daily, modelAdmits, liveAdmits, delta, bandWidth, material });
    // The Base BOM queue shows the row's precomputed _suggestedQty (set by
    // partsWithStatus); the shadow row carries the same field computed
    // over modeled on-hand. Use it -- that is the reuse. The local helper
    // is only a fallback for a row that somehow lacks the field.
    const sq = modelAdmits
      ? (Number.isFinite(Number(sp._suggestedQty)) ? Math.max(0, Math.round(Number(sp._suggestedQty))) : _bbSuggestedQty(sp))
      : 0;
    rows.push({
      pn: sp.pn, desc: sp.desc || "", supplier: sp.supplier || "",
      live: lp ? Number(lp.onHand) || 0 : Number(sp.onHand) || 0,
      modeled: m ? m.modeled : null, delta, deltaUsd: delta * cost,
      hasAnchor: !!m, anchorAt: m ? m.anchorAt : null, anchorKind: m ? m.anchorKind : null, ledgerDays: m ? m.ledgerDays : 0,
      modelStatus: sp.status, modelReorderByDays: _bbReorderByDays(sp), modelDaysOfCover: sp.daysOfCover,
      liveStatus: lp ? lp.status : "?", liveAdmits, modelAdmits,
      sq, sqUsd: sq * cost, cost,
      band, bandWidth,
      cls, placeholder: cls.kind === "placeholder",
      blanket: sp._blanketQueue ? sp._blanketQueue.kind : null,
    });
  }
  return rows;
}

function _bbVisible(rows) {
  let out = rows;
  const q = String(BB_STATE.search || "").toLowerCase().trim();
  if (q) out = out.filter(r => (r.pn + " " + r.desc + " " + r.supplier).toLowerCase().includes(q));
  if (BB_STATE.filter === "disagree") out = out.filter(r => r.cls.flag);
  else out = out.filter(r => r.hasAnchor);
  out.sort((a, b) => {
    const ra = a.modelReorderByDays, rb = b.modelReorderByDays;
    if (ra !== rb) return (ra === Infinity ? 1e9 : ra) - (rb === Infinity ? 1e9 : rb);
    return Math.abs(b.deltaUsd) - Math.abs(a.deltaUsd);
  });
  return out;
}

/* ---------------- actions ---------------- */

function _bbTodayIso() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function _bbPersistSettings() {
  if (typeof saveDB === "function") { try { saveDB(); } catch (_) {} }
  if (typeof _pushSettings === "function") { try { _pushSettings(); } catch (_) {} }
}
// Set baseline = today. An anchor DATE only: the model runs forward from
// live's number as of now. Distinct from a count -- its own audit type,
// no counted_qty, nothing written to on-hand.
function _bbSetBaseline(pn) {
  if (!DB.settings || typeof DB.settings !== "object") DB.settings = {};
  if (!DB.settings.backupBaselines || typeof DB.settings.backupBaselines !== "object") DB.settings.backupBaselines = {};
  const iso = _bbTodayIso();
  DB.settings.backupBaselines[pn] = iso;
  if (typeof logAudit === "function") logAudit("baseline-set", `Backup Buy baseline set for ${pn} = ${iso} (model runs forward from live as of today)`, { pn, baseline: iso, scope: "part" });
  _bbPersistSettings();
  if (typeof _irInvalidate === "function") _irInvalidate();
  if (typeof showToast === "function") showToast(`${pn}: baseline set to today`, "ok");
  refresh();
}
function _bbSetBaselineAll() {
  if (typeof window !== "undefined" && typeof window.confirm === "function") {
    if (!window.confirm("Set the baseline to TODAY for every part? The model will trust live on-hand as of now and run forward from here. Counts still re-anchor individually.")) return;
  }
  if (!DB.settings || typeof DB.settings !== "object") DB.settings = {};
  const iso = _bbTodayIso();
  DB.settings.backupBaselineAll = iso;
  if (typeof logAudit === "function") logAudit("baseline-set", `Backup Buy baseline set for ALL parts = ${iso}`, { baseline: iso, scope: "all" });
  _bbPersistSettings();
  if (typeof _irInvalidate === "function") _irInvalidate();
  if (typeof showToast === "function") showToast("Baseline set to today for all parts", "ok");
  refresh();
}
function _bbSetFilter(v) { BB_STATE.filter = v === "all" ? "all" : "disagree"; refresh(); }
function _bbSetSearch(v) { BB_STATE.search = String(v || ""); refresh(); }
function _bbSetThreshold(k, v) {
  const n = Math.max(0, Number(v) || 0);
  BB_STATE.thresholds = { ...BB_STATE.thresholds, [k]: n };
  try { localStorage.setItem(BB_THRESHOLD_KEY, JSON.stringify(BB_STATE.thresholds)); } catch (_) {}
  refresh();
}
function _bbReload() { BB_STATE.ready = false; if (typeof IR_STATE !== "undefined") IR_STATE.snapsLoadedFor = null; if (typeof LC_STATE !== "undefined") LC_STATE.rows = null; _bbRouteEnter(); refresh(); }

if (typeof window !== "undefined") {
  Object.assign(window, { _bbSetBaseline, _bbSetBaselineAll, _bbSetFilter, _bbSetSearch, _bbSetThreshold, _bbReload });
}

/* ---------------- render ---------------- */

function _bbFmtDays(d) {
  if (d === Infinity || !Number.isFinite(d)) return "—";
  const date = (typeof addDays === "function" && typeof TODAY !== "undefined") ? addDays(TODAY, Math.round(d)) : null;
  const when = (date && typeof fmtDate === "function") ? fmtDate(date) : "";
  return d <= 0 ? `<span class="text-crit bold">passed${when ? " " + when : ""}</span>` : `${when} <span class="dim">(${Math.round(d)}d)</span>`;
}

function renderBackupBuy() {
  const main = document.getElementById("main");
  if (!main) return;
  if (!BB_STATE.ready && !BB_STATE.loading) _bbRouteEnter();

  const ready = BB_STATE.ready && !BB_STATE.loading;
  const rows = ready ? _bbBuildRows() : [];
  const visible = ready ? _bbVisible(rows) : [];
  const anchored = rows.filter(r => r.hasAnchor).length;
  const disagree = rows.filter(r => r.cls.flag).length;
  const modelOrders = rows.filter(r => r.cls.kind === "model-orders").length;
  const liveOrders = rows.filter(r => r.cls.kind === "live-orders").length;
  const noAnchor = rows.length - anchored;
  const t = BB_STATE.thresholds;

  const body = visible.map(r => {
    const bandTxt = r.band
      ? (r.band.at_line === false ? '<span class="dim">no line row</span>'
        : (r.band.avail_known === false ? `${fmtNum(r.band.band_high)} <span class="dim">(no low)</span>` : `${fmtNum(r.band.band_low)} &ndash; ${fmtNum(r.band.band_high)}`))
      : '<span class="dim">—</span>';
    const anchorTxt = r.hasAnchor
      ? `${r.anchorKind === "baseline" ? "baseline" : "counted"} ${esc(String(r.anchorAt || "").slice(0, 10))}`
      : '<span class="text-warn">no anchor — set baseline</span>';
    const deltaCls = r.delta < 0 ? "text-crit" : (r.delta > 0 ? "text-warn" : "dim");
    const badge = r.placeholder ? ' <span class="pill warn" style="font-size:9px;padding:0 4px">PLACEHOLDER</span>' : "";
    return `
      <tr>
        <td class="mono"><a href="#" onclick="openPartDetail('${esc(r.pn)}');return false;">${esc(r.pn)}</a>${badge}</td>
        <td class="dim" title="${esc(r.desc)}">${esc(r.desc)}</td>
        <td class="right num">${r.hasAnchor ? fmtNum(r.modeled) : "—"}</td>
        <td class="right num dim">${fmtNum(r.live)}</td>
        <td class="right num ${deltaCls}">${r.hasAnchor ? (r.delta > 0 ? "+" : "") + fmtNum(r.delta, 1) : "—"}<div class="dim tiny">${r.hasAnchor ? fmtMoney(r.deltaUsd) : ""}</div></td>
        <td>${r.hasAnchor ? _bbFmtDays(r.modelReorderByDays) : "—"}</td>
        <td class="right num">${r.modelAdmits ? `<span class="bold text-accent">${fmtNum(r.sq)}</span><div class="dim tiny">${fmtMoney(r.sqUsd)}</div>` : '<span class="dim">—</span>'}</td>
        <td><span class="pill ${r.liveAdmits ? (r.liveStatus === "critical" ? "crit" : "warn") : "ok"}" style="font-size:9px">${r.liveAdmits ? "LIVE ORDERS" : "live silent"}</span></td>
        <td class="tiny">${anchorTxt}</td>
        <td class="mono tiny">${bandTxt}</td>
        <td class="tiny ${r.cls.flag ? "bold" : "dim"}">${esc(r.cls.label)}</td>
        <td>
          <div class="row gap-sm">
            ${typeof flagForCountButton === "function" ? flagForCountButton(r.pn, { size: "xs" }) : ""}
            <button class="btn sm ghost" title="Anchor the model at today's live on-hand for this part" onclick="_bbSetBaseline('${esc(r.pn)}')">Set baseline</button>
          </div>
        </td>
      </tr>`;
  }).join("");

  main.innerHTML = `
    <style>
      .bb-strip { display:flex; gap:12px; flex-wrap:wrap; margin:10px 0; }
      .bb-stat { flex:1 1 140px; min-width:140px; padding:8px 12px; border:1px solid var(--line,#cbd5e1); border-radius:6px; }
      .bb-stat-label { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--dim,#64748b); }
      .bb-stat-value { font-size:18px; font-weight:700; }
      .bb-toolbar { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:12px 0 8px; }
      .bb-table td { vertical-align:top; }
      .bb-banner { margin:8px 0; padding:8px 12px; border-radius:6px; font-size:12px; background:var(--warn-soft); color:var(--warn); border:1px solid var(--warn-bd); }
    </style>
    <div class="page" data-page="backup-buy">
      <div class="page-head">
        <div>
          <div class="page-title">Backup Buy Queue</div>
          <div class="page-sub">The Base BOM reorder math, run on <strong>modeled</strong> on-hand (anchor + receipts − usage, from the recon ledger) instead of live. Where the two queues disagree, the live number is the suspect — count before you act on it.</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="_bbReload()">Reload</button>
          <button class="btn" onclick="_bbSetBaselineAll()">Set baseline = today (all)</button>
        </div>
      </div>

      ${!ready ? `<div class="empty tiny muted">Loading ledger snapshots and line-float band…</div>` : `
      <div class="bb-strip">
        <div class="bb-stat"><div class="bb-stat-label">Modeled parts</div><div class="bb-stat-value">${anchored}</div><div class="dim tiny">${noAnchor} with no anchor</div></div>
        <div class="bb-stat"><div class="bb-stat-label">Disagree</div><div class="bb-stat-value">${disagree}</div><div class="dim tiny">material, outside band, not placeholder</div></div>
        <div class="bb-stat"><div class="bb-stat-label">Model says order</div><div class="bb-stat-value text-crit">${modelOrders}</div><div class="dim tiny">live may be inflated</div></div>
        <div class="bb-stat"><div class="bb-stat-label">Live says order</div><div class="bb-stat-value text-warn">${liveOrders}</div><div class="dim tiny">live may be understated</div></div>
      </div>
      ${BB_STATE._lastError ? `<div class="bb-banner">Load problem: ${esc(BB_STATE._lastError)}</div>` : ""}
      <div class="bb-toolbar">
        <label class="row gap-sm" style="align-items:center"><input type="radio" name="bb-filter" ${BB_STATE.filter === "disagree" ? "checked" : ""} onchange="_bbSetFilter('disagree')"> <span class="muted tiny">Disagreements (${disagree})</span></label>
        <label class="row gap-sm" style="align-items:center"><input type="radio" name="bb-filter" ${BB_STATE.filter === "all" ? "checked" : ""} onchange="_bbSetFilter('all')"> <span class="muted tiny">All modeled rows (${anchored})</span></label>
        <input class="input" placeholder="Filter part / desc / supplier" value="${esc(BB_STATE.search)}" onchange="_bbSetSearch(this.value)" style="max-width:240px">
        <span class="flex-1"></span>
        <span class="muted tiny">Material when |Δ| ≥</span>
        <input class="input num" type="number" min="0" step="1" value="${t.units}" style="width:64px" onchange="_bbSetThreshold('units', this.value)"><span class="muted tiny">units AND ≥ $</span>
        <input class="input num" type="number" min="0" step="10" value="${t.usd}" style="width:72px" onchange="_bbSetThreshold('usd', this.value)">
      </div>
      ${visible.length === 0
        ? `<div class="empty"><div class="empty-title muted">${BB_STATE.filter === "disagree" ? "The two queues agree on every modeled part" : "No modeled parts"}</div><div class="empty-msg">${anchored === 0 ? "No part has a count or a baseline yet — use “Set baseline = today (all)” to start the model from live as of now." : "Switch to “All modeled rows” to see the model for every anchored part."}</div></div>`
        : `<div class="tbl-wrap"><table class="tbl bb-table">
            <thead><tr>
              <th>Part</th><th>Description</th>
              <th class="right">Modeled</th><th class="right">Live</th><th class="right">Δ (model − live)</th>
              <th>Modeled reorder-by</th><th class="right">Suggested qty</th>
              <th>Live verdict</th><th>Anchor</th><th>Count band @ line</th><th>Read</th><th></th>
            </tr></thead>
            <tbody>${body}</tbody>
          </table></div>
          <div class="dim tiny" style="margin-top:6px">${visible.length} of ${rows.length} base BOM parts shown. Sort: modeled reorder-by, then |Δ $|. Count band: RMSTOR-LM low = Available, high = On Hand. This page never writes on-hand.</div>`}
      `}
    </div>`;
}

if (typeof registerRoute === "function") registerRoute("backup-buy", renderBackupBuy);
