/* =====================================================
   06-page-dashboard.js
   Sections: PAGE: DASHBOARD
   ===================================================== */

/* ============================================================
   PAGE: DASHBOARD
   ============================================================ */
registerRoute("dashboard", () => {
  const stats = partsWithStatus();
  // Parts that should feed purchasing signals — excludes the "Do Not Order"
  // item type. DNO parts still appear in `stats` for on-hand value totals.
  const orderable = stats.filter(p => p.itemType !== "do_not_order");
  const crit = orderable.filter(p => p.status === "critical" && !p.isKit);
  const warn = orderable.filter(p => p.status === "warning" && !p.isKit);
  const openPOs = DB.pos.filter(p => p.status === "draft" || p.status === "submitted" || p.status === "in_transit");
  const overduePOs = openPOs.filter(p => p.expectedDate && new Date(p.expectedDate) < TODAY);
  const draftPOs = DB.pos.filter(p => p.status === "draft");

  // Total inventory value
  const invValue = stats.reduce((s, p) => s + (p.onHand || 0) * (p.cost || 0), 0);
  // Total open PO value
  const poValue = DB.pos.reduce((s, po) => {
    if (po.status === "received" || po.status === "closed" || po.status === "cancelled") return s;
    return s + po.lines.reduce((ls, ln) => {
      if (ln.status === "received" || ln.status === "cancelled") return ls;
      const remaining = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
      return ls + remaining * (ln.cost || 0);
    }, 0);
  }, 0);

  // Suggested order $ today
  const suggestedValue = orderable.filter(p => (p.status === "critical" || p.status === "warning") && !p.isKit)
    .reduce((s, p) => s + p._suggestedQty * (p.cost || 0), 0);

  // Top critical
  const topCrit = crit.sort((a,b) => a.urgency - b.urgency).slice(0, 8);

  // Recent activity
  const recent = DB.audit.slice(0, 6);

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Dashboard</div>
          <div class="page-sub mono">${fmtDateLong(TODAY).toUpperCase()} · ${stats.length} PARTS · ${DB.meta.dataSource === "sample" ? "SAMPLE DATA" : "LIVE"}</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="navigate('order-queue')">View order queue →</button>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi ${crit.length ? 'crit' : 'ok'}">
          <div class="kpi-label">⚠ Will Stockout</div>
          <div class="kpi-value">${crit.length}</div>
          <div class="kpi-foot">parts · before reorder arrives</div>
        </div>
        <div class="kpi ${warn.length ? 'warn' : ''}">
          <div class="kpi-label">↗ Approaching Threshold</div>
          <div class="kpi-value">${warn.length}</div>
          <div class="kpi-foot">parts · order soon</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">○ Open POs</div>
          <div class="kpi-value">${openPOs.length}</div>
          <div class="kpi-foot">${overduePOs.length > 0 ? `<span class="text-crit">${overduePOs.length} overdue</span>` : "all on schedule"}</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">$ Open PO Value</div>
          <div class="kpi-value">${fmtMoney(poValue)}</div>
          <div class="kpi-foot">in flight</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">$ On-Hand Value</div>
          <div class="kpi-value">${fmtMoney(invValue)}</div>
          <div class="kpi-foot">at cost</div>
        </div>
        <div class="kpi ${suggestedValue > 0 ? '' : 'ok'}">
          <div class="kpi-label">$ Suggested Order</div>
          <div class="kpi-value">${fmtMoney(suggestedValue)}</div>
          <div class="kpi-foot">${crit.length + warn.length} parts</div>
        </div>
      </div>

      <div class="two-col">
        <div>
          <div class="panel">
            <div class="panel-head">
              <div class="panel-title">Critical · order today</div>
              <div class="panel-sub">${topCrit.length} of ${crit.length}</div>
              <div class="panel-actions">
                <button class="btn sm" onclick="navigate('order-queue')">See all</button>
              </div>
            </div>
            <div class="panel-body flush">
              ${topCrit.length === 0 ? `
                <div class="empty">
                  <div class="empty-title">All clear</div>
                  <div class="empty-msg">No critical reorders right now.</div>
                </div>
              ` : `
                <div class="tbl-wrap">
                  <table class="tbl">
                    <thead><tr>
                      <th>Part</th>
                      <th>Description</th>
                      <th>Supplier</th>
                      <th class="right">Days Cover</th>
                      <th class="right">Lead</th>
                      <th class="right">On Hand</th>
                      <th class="right">On PO</th>
                      <th class="right">Suggest</th>
                      <th></th>
                    </tr></thead>
                    <tbody>
                      ${topCrit.map(p => `
                        <tr class="clickable" onclick="openPartDetail('${esc(p.pn)}')">
                          <td class="pn">${esc(p.pn)}</td>
                          <td>${esc(p.desc)}</td>
                          <td class="dim">${esc(p.supplier)}</td>
                          <td class="right">
                            <span class="meter">
                              <span class="meter-bar crit"><i style="width:${clamp(p.daysOfCover/30*100,5,100)}%"></i></span>
                              <span class="num text-crit bold">${p.daysOfCover === Infinity ? "∞" : p.daysOfCover + "d"}</span>
                            </span>
                          </td>
                          <td class="right num dim">${p.leadDays}d</td>
                          <td class="right num">${fmtNum(p.onHand)}</td>
                          <td class="right num dim">${fmtNum(p.onPO)}</td>
                          <td class="right num bold text-accent">${fmtNum(p._suggestedQty)}</td>
                          <td><button class="btn sm primary" onclick="event.stopPropagation(); quickAddToDraft('${esc(p.pn)}')">+ Order</button></td>
                        </tr>
                      `).join("")}
                    </tbody>
                  </table>
                </div>
              `}
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div class="panel-title">Open Purchase Orders</div>
              <div class="panel-sub">${openPOs.length} active${overduePOs.length ? ` · ${overduePOs.length} overdue` : ""}</div>
              <div class="panel-actions">
                <button class="btn sm" onclick="navigate('pos')">Manage POs</button>
              </div>
            </div>
            <div class="panel-body flush">
              ${openPOs.length === 0 ? `
                <div class="empty"><div class="empty-msg">No open POs.</div></div>
              ` : `
                <div class="tbl-wrap"><table class="tbl">
                  <thead><tr><th>PO #</th><th>Supplier</th><th>Status</th><th class="right">Lines</th><th class="right">Value</th><th>Expected</th><th></th></tr></thead>
                  <tbody>
                    ${openPOs.slice(0,6).map(po => {
                      const open = po.lines.filter(l => l.status !== "received" && l.status !== "cancelled");
                      const val = open.reduce((s,l) => s + Math.max(0,(l.qty||0)-(l.qtyReceived||0)) * (l.cost||0), 0);
                      const overdue = po.expectedDate && new Date(po.expectedDate) < TODAY;
                      return `
                        <tr class="clickable" onclick="openPODetail('${esc(po.id)}')">
                          <td class="pn">${esc(po.num)}</td>
                          <td>${esc(po.supplier)}</td>
                          <td><span class="pill ${poStatusClass(po.status)}">${poStatusLabel(po.status)}</span></td>
                          <td class="right num">${open.length}</td>
                          <td class="right num">${fmtMoney(val)}</td>
                          <td class="num ${overdue ? 'text-crit bold' : 'dim'}">${fmtDate(po.expectedDate)}${overdue ? ' · OVERDUE' : ''}</td>
                          <td><button class="btn sm" onclick="event.stopPropagation(); openPODetail('${esc(po.id)}')">Open</button></td>
                        </tr>`;
                    }).join("")}
                  </tbody>
                </table></div>
              `}
            </div>
          </div>
        </div>

        <div>
          <div class="panel">
            <div class="panel-head">
              <div class="panel-title">Activity</div>
              <div class="panel-sub">last ${recent.length}</div>
              <div class="panel-actions"><button class="btn sm" onclick="navigate('audit')">Full log</button></div>
            </div>
            <div class="panel-body">
              ${recent.length === 0 ? `<div class="muted tiny center" style="padding: 20px 0">No activity yet.</div>` : recent.map(a => `
                <div class="audit-entry ${a.type}">
                  <div class="audit-ts">${fmtTime(a.ts)}</div>
                  <div class="audit-msg">${esc(a.msg)}</div>
                </div>
              `).join("")}
            </div>
          </div>

          <div class="panel">
            <div class="panel-head">
              <div class="panel-title">Quick Actions</div>
            </div>
            <div class="panel-body col">
              <button class="btn lg" onclick="openOnHandQuickModal()">↑ Update on-hand inventory</button>
              <button class="btn lg" onclick="navigate('order-queue')">→ Build today's orders</button>
              <button class="btn lg" onclick="$('#file-input').click()">⇪ Import data</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
});

function poStatusClass(s) {
  return ({
    "draft": "muted",
    "submitted": "info",
    "in_transit": "warn",
    "received": "ok",
    "closed": "muted",
    "cancelled": "muted",
  })[s] || "muted";
}
function poStatusLabel(s) {
  return ({
    "draft": "Draft",
    "submitted": "Submitted",
    "in_transit": "In Transit",
    "received": "Received",
    "closed": "Closed",
    "cancelled": "Cancelled",
  })[s] || s;
}
