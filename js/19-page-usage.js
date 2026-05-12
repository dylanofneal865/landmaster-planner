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
registerRoute("base-bom-usage", () => renderUsageFor("base_bom"));
registerRoute("options-usage",  () => renderUsageFor("options"));
/* =====================================================
   Service Usage page (rebuilt)
   Demand-audit tool for service parts.
   Shows the math behind each part's daily rate and lets
   the user bulk-apply computed rates to DB.parts.
   ===================================================== */

// Threshold for "meaningfully different" — show parts whose new
// daily differs from stored by more than max(0.1, 10%).
function _isDailyChanged(stored, computed) {
  const s = Number(stored) || 0;
  const c = Number(computed) || 0;
  return Math.abs(c - s) > Math.max(0.1, s * 0.10);
}

let SERVICE_USAGE_STATE = {
  search: "",
  sortBy: "velocity",  // velocity | diff | last | units
  showAll: false,      // false = only "review me" list
};

registerRoute("service-usage", () => {
  const demand = getAllDemand();
  const txCount = (DB.usage || []).length;

  // Build rows: every part with sales history, joined with stored data
  const allRows = [];
  for (const [pn, d] of demand.entries()) {
    const part = DB.parts.find(p => p.pn === pn);
    const storedDaily = Number(part?.daily) || 0;
    const diff = d.appliedDaily - storedDaily;
    const diffPct = storedDaily > 0 ? (diff / storedDaily) * 100 : (d.appliedDaily > 0 ? 999 : 0);
    allRows.push({
      pn, part, demand: d,
      storedDaily,
      computedDaily: d.appliedDaily,
      diff,
      diffPct,
      changed: _isDailyChanged(storedDaily, d.appliedDaily),
    });
  }

  // Filter to "review me" by default
  let rows = SERVICE_USAGE_STATE.showAll ? allRows : allRows.filter(r => r.changed);

  // Search
  if (SERVICE_USAGE_STATE.search) {
    const q = SERVICE_USAGE_STATE.search.toLowerCase();
    rows = rows.filter(r =>
      r.pn.toLowerCase().includes(q) ||
      (r.part?.desc || "").toLowerCase().includes(q)
    );
  }

  // Sort
  rows.sort((a, b) => {
    switch (SERVICE_USAGE_STATE.sortBy) {
      case "diff": return Math.abs(b.diff) - Math.abs(a.diff);
      case "last":
        return (b.demand.lastOrderDate || "").localeCompare(a.demand.lastOrderDate || "");
      case "units": return b.demand.totalUnits365 - a.demand.totalUnits365;
      case "velocity":
      default: return Math.abs(b.demand.velocityPct) - Math.abs(a.demand.velocityPct);
    }
  });

  // Anomaly buckets (from all rows, not filtered)
  const surging = allRows.filter(r => r.demand.velocity === "surging")
    .sort((a, b) => b.demand.velocityPct - a.demand.velocityPct).slice(0, 5);
  const dying = allRows.filter(r => r.demand.velocity === "dying")
    .sort((a, b) => a.demand.velocityPct - b.demand.velocityPct).slice(0, 5);
  const newParts = allRows.filter(r => r.demand.velocityPct === 999).slice(0, 5);

  // Health stats
  const reviewCount = allRows.filter(r => r.changed).length;
  const surgingCount = allRows.filter(r => r.demand.velocity === "surging").length;
  const dyingCount = allRows.filter(r => r.demand.velocity === "dying").length;

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Service Usage</div>
          <div class="page-sub mono">${txCount.toLocaleString()} TRANSACTIONS · ${allRows.length} PARTS WITH SALES HISTORY · ${reviewCount} NEED REVIEW</div>
        </div>
        <div class="page-actions">
          <button class="btn primary" onclick="bulkApplyComputedDaily()" ${reviewCount === 0 ? "disabled" : ""}>
            ⚡ Apply ${reviewCount} computed daily rate${reviewCount === 1 ? "" : "s"}
          </button>
        </div>
      </div>

      <!-- Health summary tiles -->
      <div class="kpi-row">
        <div class="kpi">
          <div class="kpi-label">REVIEW</div>
          <div class="kpi-value">${reviewCount}</div>
          <div class="kpi-sub">daily rates differ from computed</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">SURGING</div>
          <div class="kpi-value" style="color: var(--crit)">${surgingCount}</div>
          <div class="kpi-sub">demand up >50% vs baseline</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">DYING</div>
          <div class="kpi-value" style="color: var(--t3)">${dyingCount}</div>
          <div class="kpi-sub">demand down >50% vs baseline</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">PARTS WITH HISTORY</div>
          <div class="kpi-value">${allRows.length}</div>
          <div class="kpi-sub">have sales in last 180d</div>
        </div>
      </div>

      <div class="row gap-md" style="margin-top:14px; align-items: flex-start">
        <!-- Main table -->
        <div style="flex: 1; min-width: 0">
          <div class="panel">
            <div class="filterbar">
              <div class="search-input">
                <input class="input" placeholder="Search part # or description…" value="${esc(SERVICE_USAGE_STATE.search)}" oninput="SERVICE_USAGE_STATE.search = this.value; refresh()">
              </div>
              <select class="select" onchange="SERVICE_USAGE_STATE.sortBy = this.value; refresh()">
                <option value="velocity" ${SERVICE_USAGE_STATE.sortBy==='velocity'?'selected':''}>Sort: biggest velocity shift</option>
                <option value="diff" ${SERVICE_USAGE_STATE.sortBy==='diff'?'selected':''}>Sort: biggest daily change</option>
                <option value="units" ${SERVICE_USAGE_STATE.sortBy==='units'?'selected':''}>Sort: most units sold</option>
                <option value="last" ${SERVICE_USAGE_STATE.sortBy==='last'?'selected':''}>Sort: most recent sale</option>
              </select>
              <div class="grow"></div>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--t2)">
                <input type="checkbox" class="chk" ${SERVICE_USAGE_STATE.showAll ? "checked" : ""} onchange="SERVICE_USAGE_STATE.showAll = this.checked; refresh()">
                Show all parts (not just review list)
              </label>
            </div>
            <div class="panel-body flush">
              ${rows.length === 0 ? `
                <div class="empty">
                  <div class="empty-title">${SERVICE_USAGE_STATE.showAll ? "No matches" : "All daily rates current"}</div>
                  <div class="empty-msg">${SERVICE_USAGE_STATE.showAll ? "Try a different search." : "Every part's daily rate matches its computed value. No review needed."}</div>
                </div>
              ` : `
                <div class="tbl-wrap">
                  <table class="tbl">
                    <thead><tr>
                      <th>Part</th>
                      <th>Description</th>
                      <th class="right">30d Units</th>
                      <th class="right">30d/Day</th>
                      <th class="right">Baseline/Day</th>
                      <th class="right">Velocity</th>
                      <th class="right">Current Daily</th>
                      <th class="right">Computed Daily</th>
                      <th class="right">Δ</th>
                      <th>Last Sale</th>
                    </tr></thead>
                    <tbody>
                      ${rows.slice(0, 500).map(r => _renderRow(r)).join("")}
                    </tbody>
                  </table>
                </div>
                ${rows.length > 500 ? `<div class="muted center tiny" style="padding:14px">Showing first 500 of ${rows.length}. Use search to narrow.</div>` : ""}
              `}
            </div>
          </div>
        </div>

        <!-- Anomaly sidebar -->
        <div style="width: 280px; flex-shrink: 0">
          ${_renderAnomalyPanel("Surging", surging, "crit")}
          ${_renderAnomalyPanel("Dying", dying, "muted")}
          ${_renderAnomalyPanel("New activity", newParts, "info")}
        </div>
      </div>
    </div>`;
});

function _renderRow(r) {
  const d = r.demand;
  const vColor = d.velocity === "surging" || d.velocity === "up" ? "var(--crit)" :
                 d.velocity === "dying" || d.velocity === "down" ? "var(--t3)" :
                 "var(--t2)";
  const vArrow = d.velocity === "surging" ? "▲▲" :
                 d.velocity === "up" ? "▲" :
                 d.velocity === "dying" ? "▼▼" :
                 d.velocity === "down" ? "▼" : "→";
  const vText = d.velocityPct === 999 ? "NEW" : `${d.velocityPct > 0 ? "+" : ""}${d.velocityPct}%`;
  const diffSign = r.diff > 0 ? "+" : "";
  const diffColor = r.diff > 0 ? "var(--crit)" : r.diff < 0 ? "var(--t3)" : "var(--t2)";
  const lastSale = d.lastOrderDate ? fmtDate(d.lastOrderDate) : "—";
  const desc = r.part?.desc || "—";

  return `
    <tr class="clickable" onclick="openServicePartDrawer('${esc(r.pn)}')">
      <td class="pn">${esc(r.pn)}</td>
      <td>${esc(desc)}</td>
      <td class="right num">${fmtNum(d.recentUnits)}</td>
      <td class="right num">${fmtNum(d.recentRate, 2)}</td>
      <td class="right num dim">${fmtNum(d.baselineRate, 2)}</td>
      <td class="right num" style="color:${vColor}">${vArrow} ${vText}</td>
      <td class="right num dim">${fmtNum(r.storedDaily, 2)}</td>
      <td class="right num bold">${fmtNum(r.computedDaily, 2)}</td>
      <td class="right num bold" style="color:${diffColor}">${diffSign}${fmtNum(r.diff, 2)}</td>
      <td class="dim tiny">${lastSale}</td>
    </tr>`;
}

function _renderAnomalyPanel(title, items, tone) {
  return `
    <div class="panel" style="margin-bottom:12px">
      <div class="panel-head">
        <div class="panel-title">${title}</div>
        <div class="panel-sub">${items.length === 0 ? "none" : `top ${items.length}`}</div>
      </div>
      <div class="panel-body flush">
        ${items.length === 0 ? `<div class="muted tiny center" style="padding:14px">No parts in this bucket.</div>` :
          items.map(r => `
            <div class="clickable" onclick="openServicePartDrawer('${esc(r.pn)}')" style="padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer">
              <div class="pn" style="font-size:12px">${esc(r.pn)}</div>
              <div class="dim tiny" style="margin:2px 0">${esc((r.part?.desc || "").slice(0, 40))}</div>
              <div style="font-size:11px;color:var(--${tone === 'crit' ? 'crit' : tone === 'info' ? 'accent' : 't3'})">
                ${r.demand.velocityPct === 999 ? "NEW" : (r.demand.velocityPct > 0 ? "+" : "") + r.demand.velocityPct + "%"} ·
                ${fmtNum(r.demand.recentUnits)}u in 30d
              </div>
            </div>
          `).join("")
        }
      </div>
    </div>`;
}

function openServicePartDrawer(pn) {
  const part = DB.parts.find(p => p.pn === pn);
  const d = computeDemand(pn);
  const txns = (DB.usage || []).filter(u => u.pn === pn).sort((a, b) => new Date(b.ts) - new Date(a.ts));

  const reasoning = d.recentRate > d.baselineRate
    ? `Recent rate (${d.recentRate.toFixed(2)}/day) > baseline (${d.baselineRate.toFixed(2)}/day) → using recent to catch surge.`
    : `Recent rate (${d.recentRate.toFixed(2)}/day) ≤ baseline (${d.baselineRate.toFixed(2)}/day) → using 60/40 blend: 0.6×${d.recentRate.toFixed(2)} + 0.4×${d.baselineRate.toFixed(2)} = ${d.appliedDaily.toFixed(2)}.`;

  openDrawer(`
    <div class="drawer-head">
      <div class="title-block">
        <div class="pre">SERVICE PART</div>
        <div class="title">${esc(pn)}</div>
        <div class="sub">${esc(part?.desc || "—")} · ${esc(part?.supplier || "")}</div>
      </div>
      <button class="drawer-x" data-close>×</button>
    </div>
    <div class="drawer-body">
      <div class="dr-section">Demand math</div>
      <div class="grid-2">
        <div class="field"><label>Total units (last 365d)</label><div class="mono">${fmtNum(d.totalUnits365)}</div></div>
        <div class="field"><label>Last sale</label><div class="mono">${d.lastOrderDate ? fmtDate(d.lastOrderDate) : "—"}</div></div>
        <div class="field"><label>Last 30 days</label><div class="mono">${fmtNum(d.recentUnits)} units · ${d.recentRate.toFixed(3)}/day</div></div>
        <div class="field"><label>Last 180 days (baseline)</label><div class="mono">${fmtNum(d.baselineUnits)} units · ${d.baselineRate.toFixed(3)}/day</div></div>
        <div class="field"><label>Velocity</label><div class="mono">${d.velocity} (${d.velocityPct === 999 ? "NEW" : (d.velocityPct > 0 ? "+" : "") + d.velocityPct + "%"})</div></div>
        <div class="field"><label>Computed daily</label><div class="mono bold">${d.appliedDaily.toFixed(3)}</div></div>
      </div>
      <p class="muted tiny" style="margin:8px 0 16px">${reasoning}</p>

      <div class="dr-section">Apply / Override</div>
      <div class="grid-2">
        <div class="field"><label>Current stored daily</label><div class="mono">${(Number(part?.daily) || 0).toFixed(3)}</div></div>
        <div class="field"><label>New daily (editable)</label><input class="input num" type="number" step="0.001" id="svc-override" value="${d.appliedDaily.toFixed(3)}"></div>
      </div>
      <div class="row gap-md" style="margin-top:10px">
        <button class="btn primary" onclick="applyServicePartDaily('${esc(pn)}')">✓ Apply to part</button>
        <button class="btn" data-close>Cancel</button>
      </div>

      <div class="dr-section" style="margin-top:24px">Transaction history (${txns.length})</div>
      <div class="tbl-wrap" style="max-height:300px;overflow-y:auto">
        <table class="tbl">
          <thead><tr><th>Date</th><th class="right">Qty</th><th>Reason</th><th>Notes</th></tr></thead>
          <tbody>
            ${txns.slice(0, 200).map(u => `
              <tr>
                <td class="tiny">${fmtDate(u.ts)}</td>
                <td class="right num">${fmtNum(u.qty)}</td>
                <td class="dim tiny">${esc(u.reason || "—")}</td>
                <td class="dim tiny">${esc((u.notes || "").slice(0, 40))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
      ${txns.length > 200 ? `<div class="muted tiny center" style="padding:8px">Showing first 200 of ${txns.length}.</div>` : ""}
    </div>`, { wide: true });
}

function applyServicePartDaily(pn) {
  const newDaily = parseFloat($("#svc-override").value) || 0;
  const part = DB.parts.find(p => p.pn === pn);
  if (!part) return;
  const old = Number(part.daily) || 0;
  part.daily = newDaily;
  logAudit("daily-override", `${pn}: daily ${old.toFixed(2)} → ${newDaily.toFixed(2)} (Service Usage override)`, { pn, oldDaily: old, newDaily });
  saveDB();
  bumpStatusCache();
  bumpDemandCache();
  closeDrawer();
  showToast(`${pn} daily updated to ${newDaily.toFixed(2)}`, "ok");
  refresh();
}

function bulkApplyComputedDaily() {
  const demand = getAllDemand();
  let updated = 0;
  const changes = [];
  for (const part of DB.parts) {
    const d = demand.get(part.pn);
    if (!d) continue;
    if (!_isDailyChanged(part.daily, d.appliedDaily)) continue;
    const old = Number(part.daily) || 0;
    part.daily = d.appliedDaily;
    changes.push({ pn: part.pn, old, new: d.appliedDaily });
    updated++;
  }
  if (updated === 0) {
    showToast("No changes to apply", "info");
    return;
  }
  logAudit("daily-bulk-apply", `Applied computed daily rates to ${updated} parts from Service Usage`, { count: updated });
  saveDB();
  bumpStatusCache();
  bumpDemandCache();
  showToast(`Applied new daily rates to ${updated} parts`, "ok", "Bulk update");
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
