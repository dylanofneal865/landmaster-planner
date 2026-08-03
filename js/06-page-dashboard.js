/* =====================================================
   06-page-dashboard.js
   Sections: PAGE: DASHBOARD
   ===================================================== */

// Supplier follow-up threshold (days). Open PO lines whose expected date
// is more than this many days in the past surface in the dashboard's
// Supplier Follow-Ups panel. Single knob so the cutoff is easy to retune.
const FOLLOWUP_DAYS = 10;

/* ============================================================
   PAGE: DASHBOARD
   ============================================================ */
registerRoute("dashboard", () => {
  const stats = partsWithStatus();
  // Critical & warning counts must EQUAL the topbar and the sum of
  // visible rows across the three order queues. queueParts() is the
  // single source of truth shared with renderOrderQueueFor and
  // updateTopBar — same isQueueEligible predicate, same exclusions
  // (kits, phasing-out, muted suppliers, untagged itemType, DNO).
  // See js/03-calc.js.
  const queueEligible = queueParts();
  const crit = queueEligible.filter(p => p.status === "critical");
  const warn = queueEligible.filter(p => p.status === "warning");

  // Safety net: critical parts that don't have a queue itemType won't
  // appear in any queue and aren't counted in crit/warn above. Surface
  // them (a) in the console so the user can fix the itemType, and
  // (b) as a "(+N untagged)" suffix on the Will Stockout kpi-foot so
  // they aren't silently invisible. Excludes kits, DNO, and phasing-out
  // parts (those are intentionally not orderable).
  const untaggedCritical = stats.filter(p =>
    p.status === "critical" &&
    !isQueueEligible(p) &&
    !p.isKit &&
    p.itemType !== "do_not_order" &&
    !p.phasingOut
  );
  if (untaggedCritical.length > 0) {
    console.warn(`[Landmaster] ${untaggedCritical.length} critical part(s) have no queue itemType — they won't appear in Base BOM / Options / Service queues. Set itemType via the part drawer to surface them:`);
    for (const p of untaggedCritical) {
      console.warn(`  ${p.pn} — ${p.desc || "(no description)"}`);
    }
  }
  // Open POs KPI uses isActivePO — same predicate as the Purchase Orders
  // nav badge and the PO list "Active" tab, so all three numbers reconcile.
  // Excludes only received/closed/cancelled (po.status) and the Acumatica
  // Completed/Rejected/Canceled rollups (po.acumStatus); every other status
  // counts as active. overduePOs inherits the same base so a closed-but-
  // past-its-date PO never inflates the overdue subcount.
  // Both the "Open POs" KPI value and the "N overdue" subcount now
  // derive from poState() (js/03-calc.js) — the single source of truth
  // for PO classification. Previously openPOs used isActivePO (header-
  // only, could count POs whose header hadn't rolled over even though
  // every line was received per Acumatica's Open Qty), inflating both
  // the KPI value and every downstream count. Under poState.active, a
  // PO is only counted when the header is active AND at least one line
  // is genuinely open — matching the PO-list Active/Open/Overdue tabs
  // and the sidebar PO badge exactly.
  const openPOs = DB.pos.filter(p => poState(p).active);
  const overduePOs = openPOs.filter(p => poState(p).overdue);
  const draftPOs = DB.pos.filter(p => p.status === "draft");

  // Total inventory value
  const invValue = stats.reduce((s, p) => s + (p.onHand || 0) * (p.cost || 0), 0);
  // Total open PO value — sum remaining qty * cost across genuinely-open
  // lines only, so a leaked Completed PO can't inflate the KPI.
  const poValue = DB.pos.reduce((s, po) => {
    return s + (po.lines || []).reduce((ls, ln) => {
      if (!isLineOpen(po, ln)) return ls;
      const remaining = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
      return ls + remaining * (ln.cost || 0);
    }, 0);
  }, 0);

  // Suggested order $ today. Uses orderUnitCost (last PO price → stored
  // cost fallback). Same queueParts() base as the crit/warn counts above
  // so the $ figure and the "${crit.length + warn.length} parts" footer
  // describe the same set. Drop parts with no usable purchase price (no
  // PO history AND no stored cost — typically built kits/FG) so they
  // can't dilute the total with implicit $0 contributions.
  const suggestedValue = queueEligible.filter(p => !hasNoOrderCost(p))
    .reduce((s, p) => s + p._suggestedQty * orderUnitCost(p), 0);

  // Top critical
  const topCrit = crit.sort((a,b) => a.urgency - b.urgency).slice(0, 8);

  // Recent activity
  const recent = DB.audit.slice(0, 6);

  // Supplier Follow-Ups: every open PO line whose expected date is more
  // than FOLLOWUP_DAYS in the past. Uses ln.expectedDate first, falls
  // back to po.expectedDate — same convention as chainTransitionRisk and
  // the part-drawer open-PO list. Open-ness is decided by isLineOpen so
  // Completed/Closed POs leaking through the Acumatica feed never appear
  // as follow-ups. YYYY-MM-DD strings (from the Acumatica sync) are
  // parsed as local dates to avoid the off-by-one shift
  // `new Date("2026-05-27")` would introduce.
  const statsByPn = new Map(stats.map(p => [p.pn, p]));
  const followUps = [];
  for (const po of (DB.pos || [])) {
    for (const ln of (po.lines || [])) {
      if (!isLineOpen(po, ln)) continue;
      const openQty = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
      if (openQty <= 0) continue;
      const expRaw = ln.expectedDate || po.expectedDate;
      if (!expRaw) continue;
      let exp;
      if (typeof expRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expRaw)) {
        const [y, m, d] = expRaw.split("-").map(Number);
        exp = new Date(y, m - 1, d);
      } else {
        exp = new Date(expRaw);
      }
      if (isNaN(exp.getTime())) continue;
      exp.setHours(0, 0, 0, 0);
      const daysPastDue = Math.floor((TODAY.getTime() - exp.getTime()) / DAY_MS);
      if (daysPastDue <= FOLLOWUP_DAYS) continue;
      const pStat = statsByPn.get(ln.pn);
      followUps.push({
        po, ln, expRaw,
        supplier: po.supplier || (pStat && pStat.supplier) || "—",
        pn: ln.pn,
        desc: (pStat && pStat.desc) || ln.desc || "",
        openQty,
        daysPastDue,
        partStatus: (pStat && pStat.status) || null,
        daysOfCover: pStat ? pStat.daysOfCover : null,
      });
    }
  }
  // Sort: most overdue first; tiebreak critical → warning → ok so the
  // hurting parts float to the top inside the same days-late bucket;
  // then supplier alphabetical so a vendor's follow-ups group together.
  const followUpStatusRank = (s) => s === "critical" ? 0 : s === "warning" ? 1 : 2;
  followUps.sort((a, b) => {
    if (b.daysPastDue !== a.daysPastDue) return b.daysPastDue - a.daysPastDue;
    if (followUpStatusRank(a.partStatus) !== followUpStatusRank(b.partStatus)) {
      return followUpStatusRank(a.partStatus) - followUpStatusRank(b.partStatus);
    }
    return String(a.supplier).localeCompare(String(b.supplier));
  });

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
        <div class="kpi ${crit.length ? 'crit' : 'ok'}" style="cursor:pointer" onclick="navigate('order-queue')" title="Open the combined order queue">
          <div class="kpi-label">⚠ Will Stockout</div>
          <div class="kpi-value">${crit.length}</div>
          <div class="kpi-foot">parts · before reorder arrives${untaggedCritical.length > 0 ? ` <span class="text-warn" title="These critical parts have no queue itemType — set itemType via the part drawer to surface them in Base BOM / Options / Service. See console for the list.">(+${untaggedCritical.length} untagged)</span>` : ''}</div>
        </div>
        <div class="kpi ${warn.length ? 'warn' : ''}" style="cursor:pointer" onclick="navigate('order-queue')" title="Open the combined order queue">
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
                              ${(() => { const s = stockoutDateStr(p.daysOfCover); return s ? `<span class="dim tiny mono" style="margin-left:6px">· ${s}</span>` : ''; })()}
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
                      const open = (po.lines || []).filter(l => isLineOpen(po, l));
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
              <div class="panel-title">Supplier Follow-Ups</div>
              <div class="panel-sub">${followUps.length} · overdue &gt; ${FOLLOWUP_DAYS}d</div>
              ${followUps.length ? `<div class="panel-actions"><button class="btn sm" onclick="navigate('pos')">All POs</button></div>` : ''}
            </div>
            <div class="panel-body" style="${followUps.length ? 'padding:0' : ''}">
              ${followUps.length === 0 ? `
                <div class="empty" style="padding:36px 16px">
                  <div class="empty-title">All caught up</div>
                  <div class="empty-msg">No overdue POs to follow up on.</div>
                </div>
              ` : `
                <div style="max-height:560px; overflow-y:auto; padding:12px 14px 4px">
                  ${followUps.map(fu => {
                    const isCrit = fu.partStatus === "critical";
                    const isWarn = fu.partStatus === "warning";
                    const borderColor = isCrit ? 'var(--crit)' : isWarn ? 'var(--warn)' : 'var(--line)';
                    const bgTint = isCrit ? 'background: var(--crit-soft);' : isWarn ? 'background: var(--warn-soft);' : '';
                    const lateClass = isCrit ? 'text-crit' : isWarn ? 'text-warn' : 'muted';
                    const coverShow = (fu.daysOfCover !== null && fu.daysOfCover !== undefined && fu.daysOfCover !== Infinity);
                    const coverText = coverShow ? `${fu.daysOfCover}d cover` : null;
                    const coverClass = isCrit ? 'text-crit bold' : isWarn ? 'text-warn bold' : 'dim';
                    return `
                    <div class="audit-entry" style="cursor:pointer; border-left-width:3px; border-left-color:${borderColor}; ${bgTint}"
                         onclick="openPODetail('${esc(fu.po.id)}')"
                         title="Open PO ${esc(fu.po.num)}">
                      <div class="audit-ts" style="display:flex; justify-content:space-between; align-items:center; gap:8px">
                        <span style="color: var(--t2)">${esc(fu.supplier)} · PO ${esc(fu.po.num)}</span>
                        <span class="${lateClass} bold mono" style="font-size:11px; letter-spacing:0.04em; white-space:nowrap">${fu.daysPastDue} DAYS LATE</span>
                      </div>
                      <div class="audit-msg" style="margin-top:4px"><span class="mono">${esc(fu.pn)}</span>${fu.desc ? ` <span class="dim">· ${esc(fu.desc)}</span>` : ''}</div>
                      <div class="audit-detail" style="display:flex; flex-wrap:wrap; gap:2px 12px; margin-top:4px">
                        <span>Open ${fmtNum(fu.openQty)}</span>
                        <span>Exp ${fmtDate(fu.expRaw)}</span>
                        ${coverText ? `<span class="${coverClass}">${coverText}</span>` : ''}
                      </div>
                    </div>
                    `;
                  }).join("")}
                </div>
              `}
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
