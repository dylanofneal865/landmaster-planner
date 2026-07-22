/* =====================================================
   10-page-parts.js
   Sections: PART DETAIL DRAWER — full part info, projection chart, edit, PAGE: PARTS CATALOG — search, filter, edit any part
   ===================================================== */

/* ============================================================
   PART DETAIL DRAWER — full part info, projection chart, edit
   ============================================================ */
function openPartDetail(pn) {
  const part = DB.parts.find(p => p.pn === pn);
  if (!part) { showToast("Part not found: " + pn, "warn"); return; }
  renderPartDetail(part);
}

function renderPartDetail(part) {
  const onPO = openPOQty(part.pn);

  // Phase 2: every member of an actively-transitioning chain gets an
  // effective view (cumulativeStockThroughThis, chainRate) fed into
  // partStatus / daysUntilStockout / projectOnHand. Models sequential
  // burn-down — each part only depletes after the parts ahead of it run
  // dry. chainBoost (final-part only) is still useful for the Quick-actions
  // paragraph that explains the suggested-qty sizing.
  const chainView = (typeof chainSequentialView === "function") ? chainSequentialView(part) : null;
  const chainBoost = (typeof _supersessionDemandBoost === "function") ? _supersessionDemandBoost(part) : null;
  // HARD CUT-IN chart mode — when the chain has a transitionStartDate, the
  // chart plots predecessor stock burning down during phase 1, strands the
  // leftover at cut-in, then shows ownStock + own POs in phase 2. Passed to
  // projectOnHand below via opts.hardCutin. Absent → legacy chart (flat-hold
  // of cumulativeStockThroughThis until launch, then depletion) still fires
  // via the projectOnHand transitionStartDate branch — byte-identical to
  // today for parts without a chain hard cut-in.
  const hardCutin = chainView && chainView.hardCutin ? chainView.hardCutin : null;
  const effectivePart = chainView
    ? {
        ...part,
        // Chart's phase 2 stock is ownStock (successor's own) when hardCutin
        // is active; predecessor stock is plotted separately by projectOnHand
        // via opts.hardCutin. Non-hardCutin chains keep the legacy cumulative
        // input so their chart is unchanged.
        onHand: hardCutin ? hardCutin.ownStock : chainView.cumulativeStockThroughThis,
        daily: Math.max(Number(part.daily) || 0, chainView.chainRate),
      }
    : part;

  // Chain-aware daily for the stat cell AND the edit form. Non-anchor members
  // of an actively-transitioning chain inherit the anchor's rate for display
  // (and lock their edit field so the stored value can't drift). Anchor and
  // non-chain parts behave exactly as before.
  const dailySrc = (typeof chainDisplayDailySource === "function")
    ? chainDisplayDailySource(part)
    : { daily: Number(part.daily) || 0, anchorPn: null, transitioning: false, isAnchor: false };
  const dailyInherited = dailySrc.transitioning && !dailySrc.isAnchor;
  // Service parts: part.daily is OWNED by the service-usage feed (the
  // 06:00 UTC Acumatica sync). The drawer surfaces the stored value
  // read-only so no one can hand-edit it here — the sync is the single
  // source. Normalization mirrors the sync's own gate.
  const _svcOwned = String(part?.itemType || "").toLowerCase().trim() === "service";
  const _dailyLocked = dailyInherited || _svcOwned;

  const status = partStatus(effectivePart);
  // PRE-LAUNCH: a superseding part whose transitionStartDate is still in the
  // future isn't live demand yet. Reuse the shared isPreLaunch predicate (the
  // same one partsWithStatus applies to drop it from queues/KPIs) so the drawer
  // doesn't render a false STOCKED OUT / reorder-overdue runway. Neutralize the
  // displayed status to "ok" so the header pill, Days-Cover tile, and order
  // affordances stop showing it as critical. The runway banner below gets a
  // dedicated pre-launch state.
  const preLaunch = (typeof isPreLaunch === "function") && isPreLaunch(part);
  if (preLaunch) status.status = "ok";

  // CHAIN AWARENESS (Phase B): when this part is in an actively-transitioning
  // chain, the drawer's status pill and primary days-cover reflect the CHAIN,
  // not this part's isolated per-part runout. Both members of a chain show
  // the same chainStatus and chainRunout. Per-part own runout is preserved
  // as a footnote below. The runway CHART stays per-part (each member's own
  // depletion is meaningful context), but the STATUS PILL and BANNER speak
  // for the chain.
  const chainInfo = (typeof getChainInfo === "function") ? getChainInfo(part.pn) : null;
  if (chainInfo) {
    status.status = chainInfo.chainStatus;
    // daysOfCover is used by downstream drawer code; override so the Days
    // Cover stat cell reads the chain runout, not per-part.
    status.daysOfCover = chainInfo.chainRunoutDays;
    status.stockoutDay = chainInfo.chainRunoutDays;
  }
  const sq = suggestedQty({...part, onPO, daily: part.daily});

  // Pricing provenance for the Unit Cost tile. Source resolution lives in
  // orderUnitCostSource() (js/03-calc.js) — newer of (manual cost edit date,
  // last PO date) wins. We just narrate which side won so the user can see
  // why a draft is priced the way it is.
  const costSrc = orderUnitCostSource(part);
  const noOrderCost = costSrc.cost <= 0;
  let costMeta;
  if (costSrc.source === "manual") {
    const dateLabel = costSrc.date ? ` (updated ${fmtDate(costSrc.date)})` : "";
    costMeta = `<div class="dim tiny" style="margin-top:2px">using manual cost${dateLabel}</div>`;
  } else if (costSrc.source === "po") {
    const dateLabel = costSrc.date ? fmtDate(costSrc.date) : "—";
    costMeta = `<div class="dim tiny mono" style="margin-top:2px">using last PO ${fmtMoneyDec(costSrc.cost)} (${dateLabel}${costSrc.poNum ? `, ${esc(costSrc.poNum)}` : ""})</div>`;
  } else {
    costMeta = `<div class="tiny" style="margin-top:2px"><span class="pill warn">NO COST</span></div>`;
  }

  // Build projection with dynamic horizon — extend enough to show both the
  // stockout day and the lead-time landing day, capped at 365 so slow movers
  // don't flatten the chart.
  const coverDays = daysUntilStockout(effectivePart);
  const leadDays = leadTimeDays(part);
  const finiteCover = Number.isFinite(coverDays) ? coverDays : 0;
  let horizon = Math.max(90, finiteCover + 14, leadDays + 14);
  // Bump horizon ONLY when hardCutin is active so a chain successor's cut-in
  // day AND its lead-time-based PO landing are visible in the chart. Chains
  // without a transitionStartDate keep their pre-fix horizon math (byte-
  // identical to today).
  if (hardCutin && hardCutin.hardCutinDate) {
    const cutinDays = Math.round((hardCutin.hardCutinDate.getTime() - TODAY.getTime()) / DAY_MS);
    horizon = Math.max(horizon, cutinDays + leadDays + 14);
    if (chainInfo && Number.isFinite(chainInfo.chainRunoutDays)) {
      horizon = Math.max(horizon, chainInfo.chainRunoutDays + 14);
    }
  }
  horizon = Math.min(horizon, 365);
  // Pass hardCutin opts so projectOnHand plots phase 1 (predecessor burn) →
  // strand cliff → phase 2 (ownStock + POs). Non-hardCutin path is unchanged.
  const series = projectOnHand(effectivePart, horizon, undefined, hardCutin ? { hardCutin } : {});
  // Clamp the visual scale to 0..peak so long horizons of deeply negative
  // on-hand don't crush the meaningful band into a sliver. The stockout
  // index is still found on the unclamped series; only the drawn path is
  // capped at the baseline.
  const minOH = 0;
  const maxOH = Math.max(...series.map(s => s.oh), part.onHand || 0, 1);
  const stockoutIdx = series.findIndex(s => s.oh <= 0);

  // Open POs containing this part. Same isLineOpen gate as the rest of
  // the open-supply math so a leaked Completed PO doesn't pad the drawer's
  // PO list with lines the supplier already shipped.
  const linesForPart = [];
  for (const po of DB.pos) {
    for (const ln of (po.lines || [])) {
      if (ln.pn !== part.pn) continue;
      if (!isLineOpen(po, ln)) continue;
      const remaining = Math.max(0, (ln.qty||0) - (ln.qtyReceived||0));
      if (remaining > 0) linesForPart.push({ po, ln, remaining });
    }
  }

  // Recent transactions involving this part
  const txns = DB.audit.filter(a => a.detail && a.detail.pn === part.pn).slice(0, 8);

  // Inventory runway SVG. Three layouts share this geometry:
  //   (normal)    H=180, PB=28 — labels sit above the line near their markers
  //   (early-stockout) H=220, PB=76 — stockout AND lead both land in the
  //   left ~25% of the plot, so all four labels stack BELOW the baseline
  //   in a single left-anchored column to avoid piling on TODAY + y-axis.
  // PL=90 gives the y-axis its own column so the peak/0 numbers, the today
  // line, the today label, and the overdue dot don't pile in the same gutter.
  const W = 720, PL = 90, PR = 80, PT = 24;
  const hasGap = Number.isFinite(coverDays) && leadDays > coverDays;
  const _denom = Math.max(1, series.length - 1);
  const stockoutInLeftZone = stockoutIdx >= 0 && stockoutIdx / _denom < 0.25;
  const leadInLeftZone = leadDays > 0 && leadDays / _denom < 0.25;
  const earlyStockoutMode = stockoutInLeftZone && leadInLeftZone && hasGap;
  const PB = earlyStockoutMode ? 76 : 28;
  const H = earlyStockoutMode ? 220 : 180;
  const xS = i => PL + (i / _denom) * (W - PL - PR);
  const yS = v => H - PB - ((v - minOH) / Math.max(1, maxOH - minOH)) * (H - PT - PB);

  // Drawn path clamps each point's oh to >= 0 so the curve flatlines on
  // the baseline once stock crosses zero, rather than diving negative.
  const linePath = series.map((s,i) => `${i===0?'M':'L'}${xS(i)},${yS(Math.max(0, s.oh))}`).join(" ");
  const areaPath = `${linePath} L${xS(series.length-1)},${H-PB} L${xS(0)},${H-PB} Z`;
  const todayMark = `<line x1="${xS(0)}" y1="${PT}" x2="${xS(0)}" y2="${H-PB}" stroke="var(--accent)" stroke-width="1" opacity="0.6"/>`;
  const zeroLine = `<line x1="${PL}" y1="${yS(0)}" x2="${W-PR}" y2="${yS(0)}" class="spark-zero"/>`;

  // PO receipt dots + labels. Two crowding rules:
  //   (a) if a dot is within 55px of the left gutter, anchor the label start
  //       at dot.x+6 so it can't land on the y-axis numbers or today line;
  //   (b) if two dots are within 45px of each other, label only the LATER
  //       one with the COMBINED "+N" (sum across the cluster). All dots are
  //       drawn — only labels are merged.
  const _recvHits = [];
  series.forEach((s, i) => {
    if (!s.recv || s.recv <= 0) return;
    _recvHits.push({ cx: xS(i), cy: yS(Math.max(0, s.oh)), recv: s.recv });
  });
  const _recvLabels = [];
  for (const h of _recvHits) {
    const last = _recvLabels.length > 0 ? _recvLabels[_recvLabels.length - 1] : null;
    if (last && h.cx - last.cx < 45) {
      last.cx = h.cx;
      last.cy = h.cy;
      last.recv += h.recv;
    } else {
      _recvLabels.push({ cx: h.cx, cy: h.cy, recv: h.recv });
    }
  }
  const recvMarkers = [
    _recvHits.map(h => `<circle cx="${h.cx}" cy="${h.cy}" r="3" fill="#4aa3f2"/>`).join(""),
    _recvLabels.map(h => {
      const closeToLeft = h.cx - PL < 55;
      const lx = closeToLeft ? h.cx + 6 : h.cx;
      const anchor = closeToLeft ? "start" : "middle";
      return `<text x="${lx}" y="${h.cy - 8}" text-anchor="${anchor}" fill="#4aa3f2" font-size="9" font-family="var(--f-mono)">+${fmtNum(h.recv)}</text>`;
    }).join(""),
  ].join("");

  // Thin gap strip on the baseline — drawn above the area fill, below the
  // line stroke. The "N-day gap" caption is dropped here; in early-stockout
  // mode it appears in the label stack, in normal mode the strip + lead /
  // stockout markers carry the meaning.
  const gapBand = hasGap ? `
    <rect x="${xS(coverDays)}" y="${yS(0) - 3}" width="${xS(leadDays) - xS(coverDays)}" height="6" fill="var(--crit)" opacity="0.5"/>
  ` : "";

  // Y-axis: exactly two right-anchored labels in the left gutter — peak and 0.
  const yAxis = `
    <text x="${PL - 8}" y="${yS(maxOH) + 3}" text-anchor="end" fill="var(--t3)" font-size="9" font-family="var(--f-mono)">${fmtNum(maxOH)}</text>
    <text x="${PL - 8}" y="${yS(0) + 3}" text-anchor="end" fill="var(--t3)" font-size="9" font-family="var(--f-mono)">0</text>
  `;

  // X-axis month tick labels — drop a "Mon" abbrev each day the month
  // changes. On horizons longer than ~6 months, label every other change so
  // the row doesn't smear into one continuous block of text.
  const _monAbbrev = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const _labelEveryOther = horizon > 180;
  let _prevMonth = series[0]?.d ? series[0].d.getMonth() : -1;
  let _monthChangeCount = 0;
  const xAxis = series.map((s, i) => {
    if (i === 0) return ""; // skip i=0 to avoid colliding with the today label
    const m = s.d.getMonth();
    if (m === _prevMonth) return "";
    _prevMonth = m;
    _monthChangeCount++;
    if (_labelEveryOther && (_monthChangeCount % 2 === 0)) return "";
    return `<text x="${xS(i)}" y="${H - 8}" text-anchor="middle" fill="var(--t3)" font-size="9" font-family="var(--f-mono)">${_monAbbrev[m]}</text>`;
  }).join("");

  // Stockout marker + lead-line label. Three layouts:
  //   (a) early-stockout: all four labels stacked below the baseline
  //   (b) collision sub-case of normal: stockout + lead within ~120px →
  //       co-locate lead one line above the stockout group
  //   (c) normal: stockout above its dot, lead by its line (with the
  //       right-edge end-anchor flip + clamp from the prior pass).
  let leadLine = "";
  let stockoutMarker = "";
  if (earlyStockoutMode) {
    if (leadDays > 0 && leadDays <= horizon) {
      leadLine = `<line x1="${xS(leadDays)}" y1="${PT}" x2="${xS(leadDays)}" y2="${H-PB}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="3 3" opacity="0.85"/>`;
    }
    const sx = xS(stockoutIdx);
    const sy = yS(0);
    const stackX = Math.max(PL + 4, Math.min(W - 6, sx + 8));
    stockoutMarker = `
      <circle cx="${sx}" cy="${sy}" r="4" fill="var(--crit)"/>
      <text x="${stackX}" y="${sy + 14}" fill="var(--crit)" font-size="10" font-family="var(--f-mono)">out of stock</text>
      <text x="${stackX}" y="${sy + 26}" fill="var(--crit)" font-size="9" font-family="var(--f-mono)">day ${stockoutIdx} · ${stockoutDateStr(stockoutIdx)}</text>
      <text x="${stackX}" y="${sy + 40}" fill="var(--warn)" font-size="9" font-family="var(--f-mono)">order today → arrives day ${leadDays}</text>
      <text x="${stackX}" y="${sy + 52}" fill="var(--warn)" font-size="9" font-family="var(--f-mono)">${leadDays - coverDays}-day gap</text>
    `;
  } else {
    // Compute stockout label anchor first so the lead label can co-locate.
    let sTx = 0;
    let sAnchor = "";
    const sy = yS(0);
    if (stockoutIdx >= 0) {
      const sx = xS(stockoutIdx);
      const STOCKOUT_LABEL_WIDTH = 110; // ≈ "day NNN · M/D/YY"
      const wouldOverflow = sx + 6 + STOCKOUT_LABEL_WIDTH > W - 6;
      sTx = wouldOverflow ? Math.min(W - 6, sx - 6) : Math.max(PL + 2, sx + 6);
      sAnchor = wouldOverflow ? ` text-anchor="end"` : "";
      stockoutMarker = `
        <circle cx="${sx}" cy="${sy}" r="4" fill="var(--crit)"/>
        <text x="${sTx}" y="${sy-12}"${sAnchor} fill="var(--crit)" font-size="10" font-family="var(--f-mono)">out of stock</text>
        <text x="${sTx}" y="${sy-2}"${sAnchor} fill="var(--crit)" font-size="9" font-family="var(--f-mono)">day ${stockoutIdx} · ${stockoutDateStr(stockoutIdx)}</text>
      `;
    }
    if (leadDays > 0 && leadDays <= horizon) {
      const lx = xS(leadDays);
      const leadVerticalLine = `<line x1="${lx}" y1="${PT}" x2="${lx}" y2="${H-PB}" stroke="var(--warn)" stroke-width="1" stroke-dasharray="3 3" opacity="0.85"/>`;
      const closeToStockout = stockoutIdx >= 0 && Math.abs(xS(stockoutIdx) - lx) < 120;
      if (closeToStockout) {
        // (b) Stack lead one line above the stockout group at same x/anchor.
        leadLine = `
          ${leadVerticalLine}
          <text x="${sTx}" y="${sy-24}"${sAnchor} fill="var(--warn)" font-size="9" font-family="var(--f-mono)">order today → arrives day ${leadDays}</text>
        `;
      } else {
        // (c) Normal: end-anchored to the LEFT of the lead line, clamped so
        // the label end can never push past the right inner edge.
        const ltx = Math.min(lx - 6, W - PR - 4);
        leadLine = `
          ${leadVerticalLine}
          <text x="${ltx}" y="${PT+10}" text-anchor="end" fill="var(--warn)" font-size="9" font-family="var(--f-mono)">order today → arrives day ${leadDays}</text>
        `;
      }
    }
  }

  // Status banner — plain-language summary placed above the chart.
  let runwayBanner;
  if (chainInfo) {
    // CHAIN AWARENESS (Phase B + reorder-by surfacing) — this part is in
    // an actively-transitioning supersession chain. The banner speaks for
    // the CHAIN: primary runout is chainInfo.chainRunoutDate at the anchor
    // rate applied to combined chain inventory; reorder-by is the LAST
    // calendar day the SUCCESSOR must be ordered so stock lands before
    // runout. Per-part own runout is shown as a footnote so users can
    // still see this part's individual position, but the primary signal
    // is the chain's story.
    //
    // Role phrasing (D) is decoupled from status: whether ok/warn/crit
    // we always name the successor as the part to reorder, never the
    // anchor. The anchor is phasing out and is never itself reordered —
    // even when chainStatus is critical, its drawer says "reorder
    // <successor> by <date>", NOT "<anchor> reorder overdue."
    const chainRunoutTxt = chainInfo.chainRunoutDate
      ? fmtDate(chainInfo.chainRunoutDate)
      : "—";
    const chainStatusTxt = chainInfo.chainStatus === "ok" ? "covered"
      : chainInfo.chainStatus === "warning" ? "warning"
      : "critical";
    const chainStatusColor = chainInfo.chainStatus === "ok" ? "var(--ok)"
      : chainInfo.chainStatus === "warning" ? "var(--warn)"
      : "var(--crit)";
    // Role — status-independent phrasing. Anchor sees "Phasing out —
    // successor <PN>"; successor sees "Chain successor — <anchor>
    // phasing out"; middle members (rare) get a neutral label.
    const successorPnHtml = `<span class="mono">${esc(chainInfo.finalPn)}</span>`;
    const roleTxt = chainInfo.anchorPn === part.pn
      ? `Phasing out — successor ${successorPnHtml}`
      : chainInfo.finalPn === part.pn
        ? `Chain successor — <span class="mono">${esc(chainInfo.anchorPn)}</span> phasing out`
        : `Chain member`;
    // Reorder-by — always names the SUCCESSOR (finalPn) as the part to
    // order, on both the anchor's and the successor's drawer. When the
    // reorder-by day is in the past, the phrase turns red and reads
    // "ORDER-BY PASSED" — same treatment as the pre-launch order-by pill.
    const roByDateTxt = chainInfo.chainReorderByDate
      ? fmtDate(chainInfo.chainReorderByDate)
      : "—";
    const roByDaysTxt = chainInfo.chainReorderByDays === Infinity
      ? "∞"
      : `${chainInfo.chainReorderByDays}d`;
    const reorderByHtml = !chainInfo.chainReorderByDate
      ? `reorder ${successorPnHtml}: no deadline (runout beyond horizon)`
      : chainInfo.chainReorderByPassed
        ? `reorder ${successorPnHtml} <span style="color:var(--crit);font-weight:700">by ${roByDateTxt} — ORDER-BY PASSED</span>`
        : `reorder ${successorPnHtml} by ${roByDateTxt} (${roByDaysTxt})`;
    // Per-part own runout footnote — from the raw partStatus computed above
    // via effectivePart. Meaningful for the anchor (its own stock burning
    // down); for the final it agrees with chain runout already.
    const ownRunoutTxt = Number.isFinite(coverDays)
      ? ` <span class="dim">(this part alone: runs out ${stockoutDateStr(coverDays)})</span>`
      : "";
    // HARD CUT-IN banner variant — used when the successor has a
    // transitionStartDate. Reports usable supply and the strand in the SAME
    // sentence so the header text can never contradict the chart or the
    // runout.
    //
    // COVERAGE RESUME (Item 3, r3): when a PO for the successor lands AFTER
    // the runout date, tell the reader when coverage resumes and how many
    // calendar days the gap is. Uses chainInfo.chainPOLines (the same list
    // getChainInfo already built, blanket-blind via isLineOpen) — the first
    // PO whose expected date is strictly after chainRunoutDate is the
    // resume day. Gap is measured in whole CALENDAR days between them.
    // If no PO lands after the runout, keep the current out-of-coverage
    // wording. Non-hardCutin chains fall through to the original banner
    // below, byte-identical to today.
    if (chainInfo.hardCutin) {
      const hc = chainInfo.hardCutin;
      const cutinDateTxt = hc.hardCutinDate ? fmtDate(hc.hardCutinDate) : "—";
      const strandedTxt = fmtNum(Math.round(hc.strandedPredecessorQty || 0));
      const rawTotal = Number(chainInfo.chainOnHand) || 0;
      const ownTxt = fmtNum(Math.round(hc.ownStock || 0));
      const onPOTxt = fmtNum(chainInfo.chainOnPO);
      // Find the FIRST covering PO landing after runout. chainPOLines is
      // sorted by insertion order (walk of DB.pos); we scan and take the
      // earliest expectedDate strictly > chainRunoutDate.
      let resumeDate = null;
      if (chainInfo.chainRunoutDate && Array.isArray(chainInfo.chainPOLines)) {
        const runoutMs = chainInfo.chainRunoutDate.getTime();
        for (const l of chainInfo.chainPOLines) {
          if (!l || !l.expectedDate || !l.remaining) continue;
          const ems = l.expectedDate.getTime();
          if (ems <= runoutMs) continue;
          if (resumeDate === null || ems < resumeDate.getTime()) resumeDate = l.expectedDate;
        }
      }
      const coverageClause = resumeDate
        ? `no coverage ${chainRunoutTxt} → ${fmtDate(resumeDate)} (${Math.round((resumeDate.getTime() - chainInfo.chainRunoutDate.getTime()) / DAY_MS)} days short)`
        : `chain out of coverage ${chainRunoutTxt}`;
      runwayBanner = `<div class="tiny" style="margin-bottom:8px;color:${chainStatusColor};font-weight:600">${roleTxt}. Cut-in ${cutinDateTxt}. ${fmtNum(rawTotal)} in chain, ~${strandedTxt} strand at cut-in (unusable on successor). Own stock ${ownTxt} + ${onPOTxt} on PO — ${coverageClause}. ${reorderByHtml} — status ${chainStatusTxt}.${ownRunoutTxt}</div>`;
    } else {
      runwayBanner = `<div class="tiny" style="margin-bottom:8px;color:${chainStatusColor};font-weight:600">${roleTxt}. Chain runs out ${chainRunoutTxt} (${chainInfo.chainRunoutDays}d at ${fmtNum(chainInfo.chainRate, 2)}/day across ${fmtNum(chainInfo.chainOnHand)} on-hand + ${fmtNum(chainInfo.chainOnPO)} on PO) · ${reorderByHtml} — status ${chainStatusTxt}.${ownRunoutTxt}</div>`;
    }
  } else if (preLaunch) {
    // Case-A pre-launch: no consumption until transitionStartDate. The
    // runway (chart above) now correctly holds flat at onHand until
    // launch, then depletes — so coverDays reflects the true runout
    // counted from launch, not from today. The order-by is the shared
    // helper's min() of the two constraints (see preLaunchOrderBy in
    // js/03-calc.js): "have stock by launch" and "reorder before
    // stockout." order-by-passed is surfaced when the deadline is in
    // the past — the queue-badge OK doesn't blind us to a missed order
    // window.
    const startD = parseDateLocal(part.transitionStartDate);
    const ob = (typeof preLaunchOrderBy === "function") ? preLaunchOrderBy(part) : null;
    const orderByD = ob && ob.orderByDate ? ob.orderByDate : null;
    const orderByTxt = !orderByD ? "—"
      : (ob.orderByPassed ? `<span style="color:var(--crit);font-weight:700">now — ORDER-BY PASSED (${fmtDate(orderByD)})</span>` : fmtDate(orderByD));
    // Projected runout from the fixed coverDays. addDays takes a Date;
    // TODAY is that Date, coverDays is calendar days from today.
    const runoutTxt = Number.isFinite(coverDays)
      ? `Projected runout ${fmtDate(addDays(TODAY, coverDays))} · `
      : "";
    runwayBanner = `<div class="tiny" style="margin-bottom:8px;color:var(--accent);font-weight:600">Pre-launch — phases in ${fmtDate(startD)}; no consumption yet. ${runoutTxt}order by ${orderByTxt}. Not counted in live-demand queues.</div>`;
  } else if (!Number.isFinite(coverDays)) {
    runwayBanner = `<div class="dim tiny" style="margin-bottom:8px">No projected stockout at current demand.</div>`;
  } else if (leadDays > coverDays) {
    runwayBanner = `<div class="tiny" style="margin-bottom:8px;color:var(--crit);font-weight:600">Runs out in ${coverDays}d (${stockoutDateStr(coverDays)}). Resupply takes ${leadDays}d — reorder overdue by ${leadDays - coverDays}d.</div>`;
  } else {
    runwayBanner = `<div class="tiny" style="margin-bottom:8px;color:var(--warn);font-weight:500">Runs out in ${coverDays}d (${stockoutDateStr(coverDays)}). Reorder by day ${Math.max(0, coverDays - leadDays)} to stay covered.</div>`;
  }


  // Overdue advisory — projection still treats past-due lines as arrived
  // today (math unchanged), but surface the assumption so the runway
  // doesn't silently bake in late inbound. series.overdueUnits/Lines are
  // populated by projectOnHand.
  const overdueUnits = series.overdueUnits || 0;
  const overdueLines = series.overdueLines || [];
  const overdueBanner = overdueUnits > 0 ? `
    <div class="tiny" style="margin-bottom:8px;color:var(--warn)">${overdueLines.length} PO line${overdueLines.length === 1 ? '' : 's'} past due (${fmtNum(overdueUnits)} units) — projection assumes they've arrived. Confirm with supplier.</div>
  ` : "";
  // Overdue cue is the hollow amber circle ONLY — the detail lives in the
  // banner row above the chart, so no in-plot text label is needed.
  const overdueMarker = overdueUnits > 0 ? `
    <circle cx="${xS(0)}" cy="${yS(0)}" r="4" stroke="var(--warn)" stroke-width="1.5" fill="none"/>
  ` : "";

  const partIsKit = typeof isKit === "function" && isKit(part);
  // Resolve components through the shared resolver (bom_links → stripped →
  // kit_boms) so the kit drawer shows whatever the resolver picked, plus its
  // provenance (sourcePN/source) — surfaced below when the source PN differs.
  const kitResolved = partIsKit && typeof resolveKitComponents === "function"
    ? resolveKitComponents(part.pn)
    : { components: [], sourcePN: null, source: null };
  const kitComponents = kitResolved.components;

  // Per-component buildable: floor(onHand / qtyPerKit) for each component.
  // `builds: null` means qtyPerKit <= 0 — excluded from the kit-wide minimum
  // as a divide-by-zero guard. A component missing from DB.parts contributes
  // onHand=0 and stays in the calc, so it surfaces as a bottleneck rather
  // than being silently dropped. Snapshot-on-render; no caching.
  const kitBuildRows = partIsKit ? kitComponents.map(c => {
    const compPart = DB.parts.find(pp => pp.pn === c.pn);
    const inCatalog = !!compPart;
    const onHand = inCatalog ? (Number(compPart.onHand) || 0) : 0;
    const qtyPerKit = Number(c.qty) || 0;
    const builds = qtyPerKit > 0 ? Math.floor(onHand / qtyPerKit) : null;
    return { c, compPart, inCatalog, onHand, qtyPerKit, builds };
  }) : [];
  const kitLimitingRows = kitBuildRows.filter(r => r.builds !== null);
  const kitBuildable = partIsKit
    ? (kitLimitingRows.length === 0 ? 0 : Math.min(...kitLimitingRows.map(r => r.builds)))
    : 0;
  const kitBottleneckCount = partIsKit
    ? kitBuildRows.filter(r => r.builds !== null && r.builds === kitBuildable).length
    : 0;

  // Supersession lineage including predecessors (so viewing the live part
  // still shows the full history). hasChain == true iff the open part sits
  // anywhere in a multi-hop chain.
  const lineage = typeof supersessionLineage === "function" ? supersessionLineage(part.pn) : [part.pn];
  const hasChain = lineage.length > 1;
  const partCatalogPns = new Set(DB.parts.map(p => p.pn));
  const successorMissing = part.supersededBy && !partCatalogPns.has(String(part.supersededBy).trim());

  const html = `
    <div class="drawer-head">
      <div class="title-block">
        <div class="pre">${partIsKit ? 'KIT' : `PART · ${esc(part.partClass||"")}`}</div>
        <div class="title">${esc(part.pn)}</div>
        <div class="sub">${esc(part.desc)} · <span class="pill ${partIsKit ? 'ok' : (status.status==='critical'?'crit':status.status==='warning'?'warn':'ok')}" ${partIsKit ? 'style="background:var(--accent-soft,#eef);color:var(--accent,#36c)"' : ''}>${partIsKit ? 'KIT · ' + kitComponents.length + ' COMPONENTS' : status.status.toUpperCase()}</span>${partIsKit ? ` · <span class="pill ${kitBuildable === 0 ? 'crit' : 'ok'}" style="font-weight:700;letter-spacing:0.04em">CAN BUILD: ${fmtNum(kitBuildable)}</span>` : ''}</div>
      </div>
      <button class="drawer-x" data-close>×</button>
    </div>
    <div class="drawer-body">
      ${(hasChain || part.phasingOut) ? `
        <div style="padding:10px 0 12px;border-bottom:1px solid var(--line);margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          ${hasChain ? `
            <span class="muted tiny">Supersession:</span>
            <span style="font-size:12px;display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
              ${lineage.map((pn, i) => {
                const isCurrent = pn === part.pn;
                const inCat = partCatalogPns.has(pn);
                const linkable = inCat && !isCurrent;
                const sepBefore = i > 0 ? '<span class="dim" style="font-size:14px">→</span>' : '';
                const baseStyle = isCurrent
                  ? 'background:var(--bg-3);padding:2px 8px;border-radius:3px;font-weight:700'
                  : (linkable ? 'cursor:pointer;text-decoration:underline' : '');
                const click = linkable ? `onclick="event.stopPropagation(); openPartDetail('${esc(pn)}')"` : '';
                const notInCat = !inCat ? ' <span class="pill warn" style="font-size:9px;padding:1px 4px;text-transform:none;letter-spacing:0">not in catalog</span>' : '';
                return `${sepBefore}<span class="pn" ${click} style="${baseStyle}">${esc(pn)}${notInCat}</span>`;
              }).join("")}
            </span>
          ` : ''}
          ${part.phasingOut ? `
            <span class="pill warn" style="font-weight:700;letter-spacing:0.04em">PHASING OUT — not reordering</span>
          ` : ''}
        </div>
      ` : ''}
      ${partIsKit ? `
        <div class="stat-strip" style="margin-bottom:14px">
          <div class="stat">
            <div class="stat-label">Can Build</div>
            <div class="stat-value ${kitBuildable === 0 ? 'crit' : ''}" style="font-size:30px;line-height:1.1">${fmtNum(kitBuildable)}</div>
            <div class="dim tiny">complete kit${kitBuildable === 1 ? '' : 's'} from on-hand</div>
          </div>
          <div class="stat">
            <div class="stat-label">Components</div>
            <div class="stat-value">${kitComponents.length}</div>
            <div class="dim tiny">in this kit BOM</div>
          </div>
          <div class="stat">
            <div class="stat-label">Bottleneck</div>
            <div class="stat-value ${kitBuildable === 0 ? 'crit' : 'warn'}">${kitBottleneckCount}</div>
            <div class="dim tiny">part${kitBottleneckCount === 1 ? '' : 's'} at min</div>
          </div>
        </div>
        <div class="dr-section">Kit components</div>
        ${(() => {
          const srcLabel = { bom_links: "LM Planner BOM", bom_links_stripped: "LM Planner BOM", kit_boms: "kit_boms import" }[kitResolved.source] || "";
          const stripped = kitResolved.source === "bom_links_stripped";
          if (kitResolved.sourcePN && kitResolved.sourcePN !== part.pn) {
            return `<div class="tiny ${stripped ? 'text-warn' : 'muted'}" style="margin:-4px 0 8px">components from BOM <span class="mono">${esc(kitResolved.sourcePN)}</span>${stripped ? ' (auto-matched by stripping suffix — verify this is correct)' : ''}${srcLabel ? ` · ${srcLabel}` : ''}</div>`;
          }
          return srcLabel ? `<div class="muted tiny" style="margin:-4px 0 8px">source: ${srcLabel}</div>` : "";
        })()}
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr>
            <th>Component</th>
            <th>Description</th>
            <th class="right">Qty per Kit</th>
            <th class="right">On Hand</th>
            <th class="right">Builds</th>
            <th class="dim">Type</th>
          </tr></thead>
          <tbody>
            ${kitBuildRows.map(({ c, compPart, inCatalog, onHand, qtyPerKit, builds }) => {
              const qtyStr = qtyPerKit % 1 === 0 ? fmtNum(qtyPerKit) : fmtNum(qtyPerKit, 2);
              const isBottleneck = (builds !== null && builds === kitBuildable);
              const rowStyle = isBottleneck ? 'background:var(--crit-soft)' : '';
              const buildsCell = builds === null ? '—' : fmtNum(builds);
              const onHandCell = inCatalog
                ? fmtNum(onHand)
                : `<span class="dim">—</span> <span class="pill warn" title="Not in parts catalog" style="font-size:9px;padding:1px 5px;margin-left:4px;text-transform:none;letter-spacing:0">not in catalog</span>`;
              return `
                <tr ${inCatalog ? `class="clickable" onclick="openPartDetail('${esc(c.pn)}')"` : ''} style="${rowStyle}">
                  <td class="pn">${esc(c.pn)}</td>
                  <td>${esc(compPart?.desc || c.desc || '—')}</td>
                  <td class="right num bold">${qtyStr}</td>
                  <td class="right num">${onHandCell}</td>
                  <td class="right num bold ${isBottleneck ? 'text-crit' : ''}">${buildsCell}</td>
                  <td class="dim tiny">${c.isStock === true ? 'Stock' : c.isStock === false ? 'Non-stock' : '—'}</td>
                </tr>
              `;
            }).join("")}
          </tbody>
        </table></div>
        <p class="muted tiny" style="margin-top:8px;line-height:1.5">When this kit ships, each component's daily-use is automatically credited based on Qty per kit. Kits never generate purchase suggestions — their components do.${kitBuildable === 0 ? ` <strong class="text-crit">Can't build this kit right now</strong> — highlighted rows are blocking it.` : kitBottleneckCount > 0 ? ` Highlighted row${kitBottleneckCount === 1 ? '' : 's'} cap the build at ${fmtNum(kitBuildable)} — order more to lift it.` : ''}</p>
      ` : ''}
      ${(() => {
        const parentKits = typeof getKitsForComponent === "function" ? getKitsForComponent(part.pn) : [];
        if (!parentKits.length) return '';
        return `
          <div class="dr-section">Used in ${parentKits.length} kit${parentKits.length === 1 ? '' : 's'}</div>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th>Kit</th>
              <th>Description</th>
              <th class="right">Qty per kit</th>
              <th class="dim">Type</th>
            </tr></thead>
            <tbody>
              ${parentKits.map(k => {
                const qtyStr = k.qty_per_kit % 1 === 0 ? fmtNum(k.qty_per_kit) : fmtNum(k.qty_per_kit, 2);
                const kitInCatalog = DB.parts.some(pp => pp.pn === k.kit_pn);
                return `
                  <tr ${kitInCatalog ? `class="clickable" onclick="openPartDetail('${esc(k.kit_pn)}')"` : ''}>
                    <td class="pn">${esc(k.kit_pn)}${!kitInCatalog ? ' <span class="pill warn" title="Kit BOM exists but kit is not in parts catalog">⚠</span>' : ''}</td>
                    <td>${esc(k.kit_desc || '—')}</td>
                    <td class="right num bold">${qtyStr}</td>
                    <td class="dim tiny">${k.isStock ? 'Stock' : 'Non-stock'}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table></div>
          <p class="muted tiny" style="margin-top:8px;line-height:1.5">Every sale of these kits credits this component's daily-use rate based on Qty per kit. This is part of why the part's demand is what it is today.</p>
        ` ;
      })()}
      <div class="stat-strip">
        <div class="stat">
          <div class="stat-label">On Hand</div>
          <div class="stat-value">${fmtNum(part.onHand)}</div>
          ${chainBoost && chainBoost._predecessorStockRaw > 0 ? `<div class="dim tiny" style="margin-top:2px">+ ${fmtNum(chainBoost._predecessorStockRaw)} in chain (burning down${chainBoost._hardCutin && chainBoost._hardCutin.strandedPredecessorQty > 0 ? `, strands ~${fmtNum(chainBoost._hardCutin.strandedPredecessorQty)} at cut-in ${chainBoost._hardCutin.hardCutinDate ? fmtDate(chainBoost._hardCutin.hardCutinDate) : ''}` : ''})</div>` : ''}
        </div>
        <div class="stat"><div class="stat-label">On PO</div><div class="stat-value ${onPO>0?'':'dim'}">${fmtNum(onPO)}</div></div>
        <div class="stat">
          <div class="stat-label">Daily Use</div>
          <div class="stat-value">${fmtNum(dailySrc.daily, 2)}</div>
          ${dailyInherited ? `<div class="dim tiny" style="margin-top:2px">from chain anchor ${esc(dailySrc.anchorPn)}</div>` : ''}
        </div>
        <div class="stat"><div class="stat-label">Days Cover</div><div class="stat-value ${status.status==='critical'?'crit':status.status==='warning'?'warn':'ok'}">${status.daysOfCover === Infinity ? '∞' : status.daysOfCover + 'd'}</div>${(() => { const s = stockoutDateStr(status.daysOfCover); return s ? `<div class="dim tiny mono" style="margin-top:2px">${s}</div>` : ''; })()}</div>
        <div class="stat"><div class="stat-label">Lead Time</div><div class="stat-value">${part.ltWeeks||0}w</div></div>
        <div class="stat"><div class="stat-label">Unit Cost</div><div class="stat-value">${fmtMoneyDec(part.cost)}</div>${costMeta}</div>
      </div>

      <div class="dr-section">Inventory runway</div>
      ${runwayBanner}
      ${overdueBanner}
      <div class="spark-wrap">
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;display:block">
          ${zeroLine}
          ${todayMark}
          ${leadLine}
          <path d="${areaPath}" class="spark-area" style="fill-opacity:0.08"/>
          ${gapBand}
          <path d="${linePath}" class="spark-line"/>
          ${recvMarkers}
          ${stockoutMarker}
          ${overdueMarker}
          ${yAxis}
          ${xAxis}
          <text x="${PL}" y="${PT - 6}" fill="var(--t3)" font-size="9" font-family="var(--f-mono)">today</text>
          <text x="${W-6}" y="${PT - 6}" text-anchor="end" fill="var(--t3)" font-size="9" font-family="var(--f-mono)">+${horizon}D</text>
        </svg>
      </div>

      <div class="dr-section">Quick actions</div>
      <div class="row gap-md flex-wrap">
        <button class="btn primary" onclick="closeDrawer(); openOnHandQuickModal('${esc(part.pn)}')">⚡ Update on-hand</button>
        ${!partIsKit && !part.phasingOut && (status.status === "critical" || status.status === "warning" || sq > 0) ? `<button class="btn primary" onclick="quickAddToDraft('${esc(part.pn)}'); closeDrawer()">+ Order ${fmtNum(sq)}</button>` : ""}
        <button class="btn" onclick="closeDrawer(); navigate('order-queue')">View order queue</button>
      </div>
      ${chainBoost ? `<p class="muted tiny" style="margin-top:8px;line-height:1.5">Suggested qty sized against the chain's combined on-hand (${fmtNum(chainBoost.combinedOnHand)} total${(chainBoost.combinedOnHand - (Number(part.onHand) || 0)) > 0 ? ` — incl. ${fmtNum(chainBoost.combinedOnHand - (Number(part.onHand) || 0))} on-hand from predecessors being burned down` : ''}) at ${fmtNum(chainBoost.dailyRate, 2)}/day from anchor ${esc(chainBoost.anchorPn)}.</p>` : ''}

      <div class="dr-section">Edit part</div>
      <div class="grid-2">
        <div class="field"><label>Part #</label><input class="input" id="pd-pn" value="${esc(part.pn)}"></div>
        <div class="field"><label>Description</label><input class="input" id="pd-desc" value="${esc(part.desc||"")}"></div>
        <div class="field"><label>Supplier</label><input class="input" id="pd-supplier" value="${esc(part.supplier||"")}"></div>
        <div class="field"><label>Buyer</label><input class="input" id="pd-buyer" value="${esc(part.buyer||"")}"></div>
        <div class="field"><label>On Hand</label><input class="input num" type="number" min="0" id="pd-oh" value="${part.onHand||0}"></div>
        <div class="field">
          <label>${_svcOwned && !dailyInherited ? 'Daily use — from service usage (auto)' : 'Daily Use (avg)'}</label>
          <input class="input num" type="number" min="0" step="0.01" id="pd-daily"
            value="${dailyInherited ? fmtNum(dailySrc.daily, 2) : (part.daily||0)}"
            ${_dailyLocked ? 'disabled style="opacity:0.55;cursor:not-allowed"' : ''}>
          ${dailyInherited
            ? `<div class="muted tiny mt-xs">inherited from chain anchor ${esc(dailySrc.anchorPn)} — edit there</div>`
            : (_svcOwned
              ? `<div class="muted tiny mt-xs">auto-computed from sales orders in the last 180 days — see the Service Usage tab</div>`
              : '')}
        </div>
        <div class="field"><label>Unit Cost</label><input class="input num" type="number" min="0" step="0.01" id="pd-cost" value="${part.cost||0}"></div>
        <div class="field"><label>Lead Time (weeks)</label><input class="input num" type="number" min="0" step="0.5" id="pd-lt" value="${part.ltWeeks||0}"></div>
        <div class="field"><label>MOQ</label><input class="input num" type="number" min="0" id="pd-moq" value="${part.moq||0}"></div>
        <div class="field"><label>Pack Size</label><input class="input num" type="number" min="1" id="pd-pack" value="${part.packSize||1}"></div>
        <div class="field"><label>Class</label>
          <select class="select" id="pd-class">
            <option value="A" ${part.partClass==="A"?"selected":""}>A · high value/critical</option>
            <option value="B" ${part.partClass==="B"?"selected":""}>B · medium</option>
            <option value="C" ${part.partClass==="C"?"selected":""}>C · low</option>
          </select>
        </div>
        <div class="field"><label>Category</label>
          <input class="input" id="pd-cat" value="${esc(part.category||"")}">
        </div>
        <div class="field"><label>Item Type</label>
          ${(() => { const _t = String(part.itemType || "").toLowerCase().trim(); return `
          <select class="select" id="pd-itemtype">
            <option value=""             ${!_t                    ? "selected" : ""}>—</option>
            <option value="base_bom"     ${_t === "base_bom"      ? "selected" : ""}>Base BOM</option>
            <option value="options"      ${_t === "options"       ? "selected" : ""}>Options</option>
            <option value="service"      ${_t === "service"       ? "selected" : ""}>Service</option>
            <option value="kit"          ${_t === "kit"           ? "selected" : ""}>Kit</option>
            <option value="do_not_order" ${_t === "do_not_order"  ? "selected" : ""}>Do Not Order</option>
          </select>
          `; })()}
        </div>
        <div class="field">
          <label>Superseded by</label>
          <input class="input" id="pd-superseded" value="${esc(part.supersededBy||"")}" placeholder="e.g. CP00668">
          ${successorMissing ? `<div class="text-warn tiny" style="margin-top:4px">⚠ successor not in catalog</div>` : ''}
        </div>
        <div class="field">
          <label>Transition start date</label>
          <input class="input" type="date" id="pd-transition-start" value="${esc((part.transitionStartDate||"").slice(0,10))}" oninput="this.dataset.touched='1'" onchange="this.dataset.touched='1'">
          <div class="muted tiny mt-xs">Cut-in date this part goes live. Before it, the part is pre-launch — excluded from queues &amp; stockout flags; order-by = this date − lead time.</div>
        </div>
        <div class="field">
          <label>Phasing out</label>
          <label class="row" style="gap:8px;cursor:pointer;align-items:center;padding:6px 0">
            <input type="checkbox" class="chk" id="pd-phasing" ${part.phasingOut ? 'checked' : ''}>
            <span class="muted tiny">Stop reordering — burn down existing stock</span>
          </label>
        </div>
      </div>
      <div class="field" style="margin-top:12px"><label>Notes</label>
        <textarea class="textarea" id="pd-notes">${esc(part.notes||"")}</textarea>
      </div>

      ${linesForPart.length > 0 ? `
        <div class="dr-section">Open PO lines for this part</div>
        <div class="tbl-wrap"><table class="tbl">
          <thead><tr><th>PO</th><th>Status</th><th class="right">Open Qty</th><th>Expected</th></tr></thead>
          <tbody>
            ${linesForPart.map(({po, ln, remaining}) => {
              const expRaw = ln.expectedDate || po.expectedDate;
              let isPastDue = false;
              if (expRaw) {
                const exp = new Date(expRaw);
                if (!isNaN(exp)) {
                  exp.setHours(0, 0, 0, 0);
                  isPastDue = exp.getTime() < TODAY.getTime();
                }
              }
              return `
              <tr class="clickable" onclick="openPODetail('${esc(po.id)}')">
                <td class="pn">${esc(po.num)}</td>
                <td><span class="pill ${poStatusClass(po.status)}">${poStatusLabel(po.status)}</span></td>
                <td class="right num">${fmtNum(remaining)}</td>
                <td class="num ${isPastDue ? 'text-warn bold' : 'dim'}">${fmtDate(expRaw)}${isPastDue ? ' <span class="pill warn" style="margin-left:4px">PAST DUE</span>' : ''}</td>
              </tr>
            `;}).join("")}
          </tbody>
        </table></div>
      ` : ""}

      ${txns.length > 0 ? `
        <div class="dr-section">Recent activity</div>
        <div>
          ${txns.map(a => `
            <div class="audit-entry ${a.type}">
              <div class="audit-ts">${fmtTime(a.ts)}</div>
              <div class="audit-msg">${esc(a.msg)}</div>
            </div>
          `).join("")}
        </div>
      ` : ""}
    </div>
    <div class="drawer-foot">
      <button class="btn danger" onclick="confirmDeletePart('${esc(part.pn)}')">Delete</button>
      <div class="grow flex-1"></div>
      <button class="btn ghost" data-close>Close</button>
      <button class="btn primary" onclick="savePartFromDetail('${esc(part.pn)}')">Save changes</button>
    </div>
  `;
  openDrawer(html, { wide: true });
}

function savePartFromDetail(originalPn) {
  const part = DB.parts.find(p => p.pn === originalPn);
  if (!part) return;
  const newPN = $("#pd-pn").value.trim();
  if (!newPN) { showToast("Part # required", "warn"); return; }
  if (newPN !== originalPn && DB.parts.some(p => p.pn === newPN)) {
    showToast("Part # already exists", "warn"); return;
  }
  // Daily-use edits are gated by the same 4616 password as delete actions.
  // Check up-front (before any field mutation lands on `part`) so a cancel
  // or wrong password leaves the persisted record exactly as it was.
  // Chain-inheriting parts skip the gate — their #pd-daily input is rendered
  // disabled because the anchor is the single source of truth.
  const dailyInput = document.getElementById("pd-daily");
  if (dailyInput && !dailyInput.disabled) {
    const proposedDaily = Math.max(0, parseFloat(dailyInput.value) || 0);
    const oldDaily = Number(part.daily) || 0;
    if (proposedDaily !== oldDaily && !gateEdit()) return;
  }
  const oldOh = part.onHand || 0;
  part.pn = newPN;
  part.desc = $("#pd-desc").value.trim();
  part.supplier = $("#pd-supplier").value.trim();
  part.buyer = $("#pd-buyer").value.trim();
  part.onHand = Math.max(0, Math.round(parseFloat($("#pd-oh").value) || 0));
  // Chain-inheriting parts render the Daily Use field disabled (anchor is the
  // single source of truth). Skip the write so the displayed anchor rate
  // never gets copied into this part's stored daily — derivation only.
  // `dailyInput` is already in scope from the gate-check block above.
  if (dailyInput && !dailyInput.disabled) {
    part.daily = Math.max(0, parseFloat(dailyInput.value) || 0);
  }
  // Stamp costUpdatedAt only when the cost actually changes — this is what
  // lets orderUnitCostSource() decide "newer wins" against the last PO date.
  // Bumping on every save would defeat the comparison.
  const newCost = Math.max(0, parseFloat($("#pd-cost").value) || 0);
  const oldCost = Number(part.cost) || 0;
  if (newCost !== oldCost) {
    part.costUpdatedAt = new Date().toISOString();
  }
  part.cost = newCost;
  part.ltWeeks = Math.max(0, parseFloat($("#pd-lt").value) || 0);
  part.moq = Math.max(0, parseInt($("#pd-moq").value) || 0);
  part.packSize = Math.max(1, parseInt($("#pd-pack").value) || 1);
  part.partClass = $("#pd-class").value;
  part.category = $("#pd-cat").value.trim();
  part.itemType = $("#pd-itemtype").value || null;
  // Supersession (Phase 1): forward-link only, plus a "phasing out" flag that
  // zeros suggestedQty in js/03-calc.js. Successor demand-routing comes in
  // Phase 2 — this just records the link and silences reorders.
  const supEl = document.getElementById("pd-superseded");
  const phaseEl = document.getElementById("pd-phasing");
  if (supEl) part.supersededBy = supEl.value.trim() || "";
  if (phaseEl) part.phasingOut = !!phaseEl.checked;
  // Transition start date (cut-in) — a planner-owned field. It rides along in
  // the part's `data` blob to Supabase and survives the Acumatica sync, which
  // only overrides onHand (see netlify/functions/acumatica-sync.js). Stored as
  // a bare "YYYY-MM-DD" string (or null when cleared).
  //
  // WRITE ONLY IF TOUCHED — <input type="date"> is unique among the drawer's
  // inputs: it silently rejects any stored value that isn't strict ISO
  // YYYY-MM-DD, leaving .value empty. If the save handler unconditionally
  // wrote transEl.value, an unrelated edit (say a description change) on a
  // part whose stored cutin was ever non-ISO — OR simply on a part whose
  // stored value never populated the input — would destroy the cutin. We
  // guard by setting dataset.touched="1" only from oninput/onchange events,
  // so absent user interaction we leave part.transitionStartDate exactly
  // as-is. When the user DOES touch (sets a date or clears one), we honor
  // the new value: non-empty → the ISO date, empty → null. Every other
  // input in this drawer is text/number/select, which return their initial
  // rendered value from .value reliably; only this one needed the guard.
  const transEl = document.getElementById("pd-transition-start");
  if (transEl && transEl.dataset.touched === "1") {
    part.transitionStartDate = transEl.value ? transEl.value.slice(0, 10) : null;
  }
  part.notes = $("#pd-notes").value.trim();
  // If PN changed, update PO line refs
  if (newPN !== originalPn) {
    for (const po of DB.pos) for (const ln of po.lines) if (ln.pn === originalPn) ln.pn = newPN;
  }
  if (oldOh !== part.onHand) {
    logAudit("oh-edit", `${newPN}: ${fmtNum(oldOh)} → ${fmtNum(part.onHand)} (part edit)`, { pn: newPN, oldQ: oldOh, newQ: part.onHand, delta: part.onHand - oldOh });
  } else {
    logAudit("part-edit", `Edited ${newPN}`, { pn: newPN });
  }
  saveDB();
  bumpStatusCache();
  closeDrawer();
  showToast(`${newPN} updated`, "ok");
  refresh();
}

function confirmDeletePart(pn) {
  if (!gateDelete()) return;
  openModal(`
    <div class="modal-head"><div class="head-sm">Delete part?</div></div>
    <div class="modal-body">
      <p>This will permanently remove <span class="pn">${esc(pn)}</span> from the catalog.</p>
      <p class="muted tiny">Open PO lines for this part will remain but will reference a missing part. This cannot be undone.</p>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn danger" onclick="deletePart('${esc(pn)}')">Delete permanently</button>
    </div>
  `);
}

function deletePart(pn) {
  const idx = DB.parts.findIndex(p => p.pn === pn);
  if (idx < 0) return;
  // Snapshot BEFORE splice so the tombstone carries a lossless copy
  // for un-delete. splice mutates DB.parts in place — never reassign.
  const snapshot = { ...DB.parts[idx] };
  DB.parts.splice(idx, 1);
  // Local tombstone — the Map lives on DB.deletedParts, mutated in
  // place (never reassigned) same as window.followMarks.
  const tombstoneMeta = {
    deletedAt: new Date().toISOString(),
    deletedBy: null,      // no auth today; reserved for future attribution
    snapshot,
  };
  if (!(DB.deletedParts instanceof Map)) DB.deletedParts = new Map();
  DB.deletedParts.set(pn, tombstoneMeta);
  logAudit("part-del", `Deleted part ${pn}`, { pn });
  saveDB();
  bumpStatusCache();
  // Cloud persistence — TWO writes: upsert the tombstone AND delete
  // the parts row so no future load resurrects it. Both are optimistic;
  // on failure the local state is reverted so the client and cloud
  // stay in sync. deleted_parts uses `id` as the PK column (matching
  // follow_marks); the pn goes in the id column, the metadata + snapshot
  // in the data jsonb.
  if (typeof upsertDeletedPartCloud === "function") {
    upsertDeletedPartCloud(pn, { pn, ...tombstoneMeta }).then(r => {
      if (!r.ok) {
        DB.deletedParts.delete(pn);
        DB.parts.push(snapshot);
        showToast("Failed to persist delete — refresh & try again", "warn");
        refresh();
      }
    });
  }
  if (typeof deletePartRowCloud === "function") {
    deletePartRowCloud(pn).then(r => {
      // Non-fatal on failure — the tombstone still stops resurrection
      // via the cloudInit filter and the realtime-parts guard. Log
      // for diagnostics.
      if (!r.ok) console.warn(`[parts] cloud delete of ${pn} failed:`, r.error && r.error.message);
    });
  }
  closeModal();
  closeDrawer();
  showToast(`${pn} deleted`, "warn");
  refresh();
}

// Un-delete: restore a tombstoned part from its snapshot. Console-
// callable this turn (window.undeletePart); a Settings-page list can
// come later. Reverses every effect of deletePart: pushes the snapshot
// back into DB.parts (in place), removes the tombstone locally and in
// cloud, and re-upserts the parts row so other clients pick it up
// via realtime. Legacy tombstones without a snapshot are refused with
// a toast — the delete predates this feature and can't be auto-
// restored.
function undeletePart(pn) {
  if (!(DB.deletedParts instanceof Map)) DB.deletedParts = new Map();
  const meta = DB.deletedParts.get(pn);
  if (!meta) { showToast(`${pn} is not tombstoned`, "warn"); return; }
  if (!meta.snapshot || typeof meta.snapshot !== "object") {
    showToast(`${pn}: no snapshot to restore (delete predates this feature)`, "warn");
    return;
  }
  const restored = { ...meta.snapshot };
  DB.parts.push(restored);
  DB.deletedParts.delete(pn);
  logAudit("part-undel", `Un-deleted part ${pn}`, { pn });
  saveDB();
  bumpStatusCache();
  if (typeof upsertPartCloud === "function") {
    upsertPartCloud(pn, restored).then(r => {
      if (!r.ok) {
        const idx = DB.parts.findIndex(p => p.pn === pn);
        if (idx >= 0) DB.parts.splice(idx, 1);
        DB.deletedParts.set(pn, meta);
        showToast("Failed to restore — refresh & try again", "warn");
        refresh();
      }
    });
  }
  if (typeof deleteDeletedPartCloud === "function") {
    deleteDeletedPartCloud(pn).then(r => {
      if (!r.ok) console.warn(`[parts] cloud tombstone delete of ${pn} failed:`, r.error && r.error.message);
    });
  }
  showToast(`${pn} restored`, "ok");
  refresh();
}
window.undeletePart = undeletePart;

/* ============================================================
   PAGE: PARTS CATALOG — search, filter, edit any part
   ============================================================ */
let PARTS_STATE = {
  search: "",
  supplier: "",
  category: "",
  partClass: "",
  sortBy: "pn",
  sortDir: "asc",
  headerFilters: { pn: "", desc: "", supplier: "", cls: "", status: "" },
  hiddenFilters: { pn: [], desc: [], supplier: [], cls: [], status: [] },
  headerOptions: {},
  openHeaderMenu: "",
};

/* ----- Excel-style header dropdowns (mirrors Order Queue / POs) ----- */
function partsToggleHeaderMenu(key) {
  PARTS_STATE.openHeaderMenu = PARTS_STATE.openHeaderMenu === key ? "" : key;
  refresh();
}
function partsClearHeaderFilter(key) {
  PARTS_STATE.headerFilters[key] = "";
  PARTS_STATE.hiddenFilters[key] = [];
  PARTS_STATE.openHeaderMenu = "";
  refresh();
}
function partsToggleHeaderValue(key, value, checked) {
  let hidden = PARTS_STATE.hiddenFilters[key] || [];
  if (checked) hidden = hidden.filter(v => v !== value);
  else if (!hidden.includes(value)) hidden.push(value);
  PARTS_STATE.hiddenFilters[key] = hidden;
  partsRerenderPreservingScroll();
}
function partsToggleAllHeaderValues(key, checked) {
  const values = PARTS_STATE.headerOptions[key] || [];
  PARTS_STATE.hiddenFilters[key] = checked ? [] : [...values];
  partsRerenderPreservingScroll();
}

// Re-run the parts route handler in place so header-dropdown changes flow
// through partsApplyHeaderFilters BEFORE the 500-row slice, then restore the
// main viewport's scroll so the user doesn't jump to top. We bypass refresh()
// /navigate() because those reset scrollTop and rebuild the top bar etc. —
// none of which we need for a header-filter toggle.
function partsRerenderPreservingScroll() {
  const main = document.getElementById("main");
  const savedScrollTop = main ? main.scrollTop : 0;
  if (typeof ROUTES !== "undefined" && ROUTES.parts) ROUTES.parts();
  if (main) requestAnimationFrame(() => { main.scrollTop = savedScrollTop; });
}
function partsReapplyHeaderFiltersInPlace() {
  const hidden = PARTS_STATE.hiddenFilters || { pn: [], desc: [], supplier: [], cls: [], status: [] };
  const text = PARTS_STATE.headerFilters || { pn: "", desc: "", supplier: "", cls: "", status: "" };
  const tpn = String(text.pn || "").toLowerCase();
  const td  = String(text.desc || "").toLowerCase();
  const tsu = String(text.supplier || "").toLowerCase();
  const tcl = String(text.cls || "").toLowerCase();
  const tst = String(text.status || "").toLowerCase();
  const rows = document.querySelectorAll('[data-parts-row]');
  let visibleCount = 0;
  rows.forEach(row => {
    const pn = row.dataset.ptPn || "";
    const desc = row.dataset.ptDesc || "";
    const supplier = row.dataset.ptSupplier || "";
    const cls = row.dataset.ptCls || "";
    const status = row.dataset.ptStatus || "";
    const textMatch = pn.toLowerCase().includes(tpn) && desc.toLowerCase().includes(td) && supplier.toLowerCase().includes(tsu) && cls.toLowerCase().includes(tcl) && status.toLowerCase().includes(tst);
    const valueMatch = !hidden.pn.includes(pn) && !hidden.desc.includes(desc) && !hidden.supplier.includes(supplier) && !hidden.cls.includes(cls) && !hidden.status.includes(status);
    const visible = textMatch && valueMatch;
    row.style.display = visible ? "" : "none";
    if (visible) visibleCount++;
  });
  const empty = document.querySelector('#parts-empty-row');
  if (empty) empty.style.display = visibleCount > 0 ? "none" : "";
}
function partsInstallOutsideClick() {
  if (!PARTS_STATE.openHeaderMenu) {
    if (PARTS_STATE._outsideClick) {
      document.removeEventListener("click", PARTS_STATE._outsideClick);
      PARTS_STATE._outsideClick = null;
    }
    return;
  }
  if (PARTS_STATE._outsideClick) return;
  const handler = () => {
    document.removeEventListener("click", handler);
    PARTS_STATE._outsideClick = null;
    PARTS_STATE.openHeaderMenu = "";
    refresh();
  };
  PARTS_STATE._outsideClick = handler;
  setTimeout(() => document.addEventListener("click", handler), 0);
}
function partsMenuSearchValues(key, term) {
  const q = String(term || "").toLowerCase();
  document.querySelectorAll(`[data-parts-option="${key}"]`).forEach(row => {
    const value = row.dataset.search || "";
    row.style.display = value.includes(q) ? "flex" : "none";
  });
}
function partsSortHeader(key, dir) {
  PARTS_STATE.sortBy = key;
  PARTS_STATE.sortDir = dir;
  PARTS_STATE.openHeaderMenu = "";
  refresh();
}

// Repurposes the "cls" column to show ITEM TYPE while keeping the header-filter
// plumbing keyed on "cls" so data attributes and hidden-value matching keep
// working unchanged. The toolbar "All classes" dropdown and the part-detail
// drawer's Class field still use partClass.
function partItemTypeLabel(p) {
  if (p.isKit) return "Kit";
  switch (p.itemType) {
    case "base_bom":     return "Base BOM";
    case "options":      return "Options";
    case "service":      return "Service";
    case "do_not_order": return "Do Not Order";
    default:             return "Untagged";
  }
}

function partsHeaderValue(p, key) {
  let value = "";
  if (key === "pn") value = p.pn || "";
  if (key === "desc") value = p.desc || "";
  if (key === "supplier") value = p.supplier || "";
  if (key === "cls") value = partItemTypeLabel(p);
  if (key === "status") value = p.isKit ? "Kit" : p.itemType === "do_not_order" ? "Do Not Order" : p.status === "critical" ? "Critical" : p.status === "warning" ? "Warning" : "OK";
  return String(value).trim() || "(Blanks)";
}
function partsUniqueHeaderValues(rows, key) {
  return [...new Set(rows.map(p => partsHeaderValue(p, key)).filter(Boolean))]
    .sort((a, b) => String(a).localeCompare(String(b)));
}
function partsApplyHeaderFilters(rows) {
  return rows.filter(p => {
    const pn = String(p.pn || "").toLowerCase();
    const desc = String(p.desc || "").toLowerCase();
    const supplier = String(p.supplier || "").toLowerCase();
    const cls = partItemTypeLabel(p).toLowerCase();
    const statusLabel = (p.itemType === "do_not_order" ? "Do Not Order" : p.status === "critical" ? "Critical" : p.status === "warning" ? "Warning" : "OK").toLowerCase();
    const hidden = PARTS_STATE.hiddenFilters || { pn: [], desc: [], supplier: [], cls: [], status: [] };

    const textMatch =
      pn.includes(PARTS_STATE.headerFilters.pn.toLowerCase()) &&
      desc.includes(PARTS_STATE.headerFilters.desc.toLowerCase()) &&
      supplier.includes(PARTS_STATE.headerFilters.supplier.toLowerCase()) &&
      cls.includes(PARTS_STATE.headerFilters.cls.toLowerCase()) &&
      statusLabel.includes(PARTS_STATE.headerFilters.status.toLowerCase());

    const valueMatch =
      !hidden.pn.includes(partsHeaderValue(p, "pn")) &&
      !hidden.desc.includes(partsHeaderValue(p, "desc")) &&
      !hidden.supplier.includes(partsHeaderValue(p, "supplier")) &&
      !hidden.cls.includes(partsHeaderValue(p, "cls")) &&
      !hidden.status.includes(partsHeaderValue(p, "status"));

    return textMatch && valueMatch;
  });
}

function partsHeaderDropdown(key, label, rows) {
  const open = PARTS_STATE.openHeaderMenu === key;
  const values = partsUniqueHeaderValues(rows, key);
  PARTS_STATE.headerOptions[key] = values;

  const hidden = PARTS_STATE.hiddenFilters[key] || [];
  const hiddenHere = hidden.filter(v => values.includes(v));
  const active = (PARTS_STATE.headerFilters[key] || hiddenHere.length) ? "active" : "";
  const allChecked = hiddenHere.length === 0;

  return `
    <th>
      <div class="excel-th">
        <span>${label}</span>
        <button class="excel-drop ${active}" onclick="event.stopPropagation(); partsToggleHeaderMenu('${key}')">▾</button>

        ${open ? `
          <div class="excel-menu" onclick="event.stopPropagation()">
            <button class="excel-menu-btn" onclick="partsSortHeader('${key}', 'asc')">Sort A to Z</button>
            <button class="excel-menu-btn" onclick="partsSortHeader('${key}', 'desc')">Sort Z to A</button>

            <div class="excel-menu-line"></div>

            <button class="excel-menu-btn ${active ? "" : "disabled"}" onclick="partsClearHeaderFilter('${key}')">
              Clear Filter from '${label}'
            </button>

            <div class="excel-menu-line"></div>

            <input
              class="excel-menu-search"
              placeholder="Search"
              oninput="partsMenuSearchValues('${key}', this.value)"
            >

            <div class="excel-values">
              <label class="excel-check-row">
                <input
                  type="checkbox"
                  ${allChecked ? "checked" : ""}
                  onchange="partsToggleAllHeaderValues('${key}', this.checked)"
                >
                <span>Select All</span>
              </label>

              ${values.map(v => {
                const checked = !hidden.includes(v);
                return `
                  <label class="excel-check-row" data-parts-option="${key}" data-search="${esc(String(v).toLowerCase())}">
                    <input
                      type="checkbox"
                      ${checked ? "checked" : ""}
                      onchange="partsToggleHeaderValue('${key}', decodeURIComponent('${encodeURIComponent(v)}'), this.checked)"
                    >
                    <span>${esc(v)}</span>
                  </label>
                `;
              }).join("")}
            </div>

          </div>
        ` : ""}
      </div>
    </th>
  `;
}

registerRoute("parts", () => {
  const stats = partsWithStatus();
  let parts = stats.slice();

  if (PARTS_STATE.search) {
    const q = PARTS_STATE.search.toLowerCase();
    parts = parts.filter(p => p.pn.toLowerCase().includes(q) || (p.desc||"").toLowerCase().includes(q) || (p.supplier||"").toLowerCase().includes(q));
  }
  if (PARTS_STATE.supplier) parts = parts.filter(p => p.supplier === PARTS_STATE.supplier);
  if (PARTS_STATE.category) parts = parts.filter(p => p.category === PARTS_STATE.category);
  if (PARTS_STATE.partClass) parts = parts.filter(p => p.partClass === PARTS_STATE.partClass);

  // Dropdown option list is built from the post-toolbar, pre-header set so
  // unchecked values stay visible (and re-checkable) in the dropdown.
  const headerFilterRows = parts;
  // Header-dropdown filters must apply BEFORE the render-time 500-row slice,
  // otherwise the dropdown could only filter within the first 500 of 1625
  // parts (rest never reach the DOM).
  parts = partsApplyHeaderFilters(parts);

  const dir = PARTS_STATE.sortDir === "desc" ? -1 : 1;
  parts.sort((a, b) => {
    let cmp = 0;
    switch (PARTS_STATE.sortBy) {
      case "desc":
        cmp = (a.desc || "").localeCompare(b.desc || ""); break;
      case "supplier":
        cmp = (a.supplier || "").localeCompare(b.supplier || ""); break;
      case "cls":
        cmp = partItemTypeLabel(a).localeCompare(partItemTypeLabel(b)); break;
      case "status":
        cmp = partsHeaderValue(a, "status").localeCompare(partsHeaderValue(b, "status")); break;
      case "onhand":
        cmp = (a.onHand || 0) - (b.onHand || 0); break;
      case "value":
        cmp = (a.onHand || 0) * (a.cost || 0) - (b.onHand || 0) * (b.cost || 0); break;
      case "leadtime":
        cmp = (a.ltWeeks || 0) - (b.ltWeeks || 0); break;
      case "pn":
      default:
        cmp = (a.pn || "").localeCompare(b.pn || ""); break;
    }
    return cmp * dir;
  });

  const suppliers = [...new Set(stats.map(p => p.supplier))].sort();
  const categories = [...new Set(stats.map(p => p.category).filter(Boolean))].sort();
  const totalValue = parts.reduce((s,p) => s + (p.onHand||0)*(p.cost||0), 0);

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Parts Catalog</div>
          <div class="page-sub mono">${parts.length} OF ${stats.length} PARTS · ${fmtMoney(totalValue)} ON-HAND VALUE</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="exportPartsAsCSV()">⇩ Export CSV</button>
          <button class="btn primary" onclick="openAddPartModal()">+ Add part</button>
        </div>
      </div>

      <div class="panel">
        <div class="filterbar">
          <div class="search-input">
            <input class="input" placeholder="Search part # or description…" value="${esc(PARTS_STATE.search)}" onchange="PARTS_STATE.search = this.value; refresh()" onkeydown="if(event.key === 'Enter'){ PARTS_STATE.search = this.value; refresh(); }">
          </div>
          <select class="select" onchange="PARTS_STATE.supplier = this.value; refresh()">
            <option value="">All suppliers</option>
            ${suppliers.map(s => `<option value="${esc(s)}" ${PARTS_STATE.supplier===s?'selected':''}>${esc(s)}</option>`).join("")}
          </select>
          ${categories.length > 0 ? `
            <select class="select" onchange="PARTS_STATE.category = this.value; refresh()">
              <option value="">All categories</option>
              ${categories.map(c => `<option value="${esc(c)}" ${PARTS_STATE.category===c?'selected':''}>${esc(c)}</option>`).join("")}
            </select>
          ` : ""}
          <select class="select" onchange="PARTS_STATE.partClass = this.value; refresh()">
            <option value="">All classes</option>
            <option value="A" ${PARTS_STATE.partClass==='A'?'selected':''}>Class A</option>
            <option value="B" ${PARTS_STATE.partClass==='B'?'selected':''}>Class B</option>
            <option value="C" ${PARTS_STATE.partClass==='C'?'selected':''}>Class C</option>
          </select>
          <div class="grow"></div>
          <span class="muted tiny">Sort:</span>
          <select class="select" onchange="PARTS_STATE.sortBy = this.value; PARTS_STATE.sortDir = (['onhand','value','leadtime'].includes(this.value) ? 'desc' : 'asc'); refresh()">
            <option value="pn" ${PARTS_STATE.sortBy==='pn'?'selected':''}>Part #</option>
            <option value="desc" ${PARTS_STATE.sortBy==='desc'?'selected':''}>Description</option>
            <option value="supplier" ${PARTS_STATE.sortBy==='supplier'?'selected':''}>Supplier</option>
            <option value="onhand" ${PARTS_STATE.sortBy==='onhand'?'selected':''}>On-hand qty</option>
            <option value="value" ${PARTS_STATE.sortBy==='value'?'selected':''}>$ value</option>
            <option value="leadtime" ${PARTS_STATE.sortBy==='leadtime'?'selected':''}>Lead time</option>
          </select>
        </div>
        <div class="panel-body flush">
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr>
                ${partsHeaderDropdown("pn", "Part", headerFilterRows)}
                ${partsHeaderDropdown("desc", "Description", headerFilterRows)}
                ${partsHeaderDropdown("supplier", "Supplier", headerFilterRows)}
                ${partsHeaderDropdown("cls", "Type", headerFilterRows)}
                <th class="right">On Hand</th>
                <th class="right">On PO</th>
                <th class="right">Daily</th>
                <th class="right">Lead</th>
                <th class="right">Cost</th>
                <th class="right">$ Value</th>
                ${partsHeaderDropdown("status", "Status", headerFilterRows)}
              </tr></thead>
              <tbody>
                <tr id="parts-empty-row" style="display:none"><td colspan="11" class="muted center" style="padding:28px">
                  No parts match the current filters. Adjust the column dropdowns or toolbar above.
                </td></tr>
                ${parts.slice(0, 500).map(p => `
                  <tr class="clickable" data-parts-row data-pt-pn="${esc(partsHeaderValue(p, "pn"))}" data-pt-desc="${esc(partsHeaderValue(p, "desc"))}" data-pt-supplier="${esc(partsHeaderValue(p, "supplier"))}" data-pt-cls="${esc(partsHeaderValue(p, "cls"))}" data-pt-status="${esc(partsHeaderValue(p, "status"))}" onclick="openPartDetail('${esc(p.pn)}')">
                    <td class="pn">${esc(p.pn)}${hasNoOrderCost(p) ? ' <span class="pill warn">NO COST</span>' : ''}${p.phasingOut ? ' <span class="pill warn" style="font-size:9px;padding:1px 5px;margin-left:4px;text-transform:none;letter-spacing:0">phasing out</span>' : ''}${p._preLaunchOrderByPassed ? ' <span class="pill crit" style="font-size:9px;padding:1px 6px;margin-left:4px;letter-spacing:0.04em" title="Pre-launch part — order-by deadline has passed">ORDER NOW</span>' : ''}</td>
                    <td>${esc(p.desc)}</td>
                    <td class="dim">${esc(p.supplier)}</td>
                    <td class="dim">${p.isKit ? '<span class="pill" style="background:var(--accent-soft,#eef);color:var(--accent,#36c)">KIT</span>' : esc(partItemTypeLabel(p))}</td>
                    <td class="right num">${fmtNum(p.onHand)}</td>
                    <td class="right num dim">${fmtNum(p.onPO)}</td>
                    <td class="right num dim">${fmtNum(chainDisplayDaily(p), 2)}</td>
                    <td class="right num dim">${p.ltWeeks || 0}w</td>
                    <td class="right num">${fmtMoneyDec(p.cost)}</td>
                    <td class="right num">${fmtMoney((p.onHand||0)*(p.cost||0))}</td>
                    <td>${p.isKit ? '<span class="pill" style="background:var(--accent-soft,#eef);color:var(--accent,#36c)">KIT</span>' : p.itemType === 'do_not_order' ? '<span class="pill muted">DNO</span>' : `<span class="pill ${p.status==='critical'?'crit':p.status==='warning'?'warn':'ok'}">${p.status==='critical'?'CRIT':p.status==='warning'?'WARN':'OK'}</span>`}</td>
                  </tr>
                `).join("")}
                ${parts.length > 500 ? `<tr><td colspan="11" class="muted center tiny" style="padding:14px">Showing first 500 of ${parts.length} — use filters to narrow.</td></tr>` : ""}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;

  partsReapplyHeaderFiltersInPlace();
  partsInstallOutsideClick();
});

function openAddPartModal() {
  openModal(`
    <div class="modal-head"><div class="head-sm">Add new part</div></div>
    <div class="modal-body">
      <div class="grid-2">
        <div class="field"><label>Part # *</label><input class="input lg" id="ap-pn" autofocus></div>
        <div class="field"><label>Description *</label><input class="input lg" id="ap-desc"></div>
        <div class="field"><label>Supplier *</label><input class="input lg" id="ap-supplier" list="ap-supplier-list">
          <datalist id="ap-supplier-list">${[...new Set(DB.parts.map(p=>p.supplier))].sort().map(s => `<option value="${esc(s)}">`).join("")}</datalist>
        </div>
        <div class="field"><label>Buyer</label><input class="input lg" id="ap-buyer" value="${esc(DB.settings.defaultBuyer||"")}"></div>
        <div class="field"><label>On Hand</label><input class="input lg num" type="number" min="0" id="ap-oh" value="0"></div>
        <div class="field"><label>Daily Use</label><input class="input lg num" type="number" min="0" step="0.01" id="ap-daily" value="1"></div>
        <div class="field"><label>Unit Cost</label><input class="input lg num" type="number" min="0" step="0.01" id="ap-cost" value="0"></div>
        <div class="field"><label>Lead (weeks)</label><input class="input lg num" type="number" min="0" step="0.5" id="ap-lt" value="4"></div>
        <div class="field"><label>MOQ</label><input class="input lg num" type="number" min="0" id="ap-moq" value="1"></div>
        <div class="field"><label>Class</label>
          <select class="select" id="ap-class">
            <option value="A">A</option><option value="B" selected>B</option><option value="C">C</option>
          </select>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn primary" onclick="doAddPart()">+ Add part</button>
    </div>
  `);
}

function doAddPart() {
  const pn = $("#ap-pn").value.trim();
  if (!pn) { showToast("Part # required", "warn"); return; }
  if (DB.parts.some(p => p.pn === pn)) { showToast("Part # already exists", "warn"); return; }
  const desc = $("#ap-desc").value.trim();
  const supplier = $("#ap-supplier").value.trim();
  if (!desc || !supplier) { showToast("Description and supplier required", "warn"); return; }
  const part = {
    pn, desc, supplier,
    buyer: $("#ap-buyer").value.trim() || DB.settings.defaultBuyer,
    onHand: Math.max(0, Math.round(parseFloat($("#ap-oh").value) || 0)),
    daily: Math.max(0, parseFloat($("#ap-daily").value) || 0),
    cost: Math.max(0, parseFloat($("#ap-cost").value) || 0),
    ltWeeks: Math.max(0, parseFloat($("#ap-lt").value) || 0),
    moq: Math.max(0, parseInt($("#ap-moq").value) || 0),
    packSize: 1,
    partClass: $("#ap-class").value,
    category: "",
    notes: "",
    kanban: false,
    reasonCode: "MRP",
  };
  DB.parts.push(part);
  logAudit("part-add", `Added new part ${pn}`, { pn });
  saveDB();
  bumpStatusCache();
  closeModal();
  showToast(`${pn} added to catalog`, "ok");
  refresh();
}

function exportPartsAsCSV() {
  const headers = ["Part #","Description","Supplier","Buyer","Class","Category","On Hand","On PO","Daily Use","Cost","Lead Weeks","MOQ","Pack","Notes"];
  const stats = partsWithStatus();
  const rows = [headers].concat(stats.map(p => [
    p.pn, p.desc||"", p.supplier||"", p.buyer||"", p.partClass||"", p.category||"",
    p.onHand||0, p.onPO||0, p.daily||0, p.cost||0, p.ltWeeks||0, p.moq||0, p.packSize||1, (p.notes||"").replace(/"/g,'""')
  ]));
  const csv = rows.map(r => r.map(c => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(",")).join("\n");
  downloadFile(csv, `parts-catalog-${isoDate(TODAY)}.csv`, "text/csv");
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime + ";charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}
