/* =====================================================
   22-page-followups.js
   Sections: SUPPLIER FOLLOW-UPS — overdue open PO lines, grouped & actionable
   (promoted from the dashboard panel to its own BUY page)
   ===================================================== */

// Supplier follow-up threshold (days). DELIBERATELY NOT REDECLARED here —
// FOLLOWUP_DAYS is declared at module scope by js/06-page-dashboard.js (the
// dashboard's existing Supplier Follow-Ups panel uses the same constant).
// In classic <script> tags, top-level `const` lives in the shared script
// scope, so a second `const FOLLOWUP_DAYS = 10;` throws SyntaxError and
// kills the rest of this file before registerRoute can run — that's the
// regression that made clicking Follow-Ups land on "Not found" and held
// the nav badge at 0. We just read the global value here.

/* ============================================================
   SHARED PREDICATE — the overdue open-PO lines behind BOTH the page and the
   nav badge, so their counts can never drift. Same convention used by the
   dashboard panel / chainTransitionRisk / the part-drawer open-PO list:
   ln.expectedDate first, falling back to po.expectedDate; openness via
   isLineOpen (so Completed/Closed POs leaking through the Acumatica feed never
   appear); YYYY-MM-DD strings parsed as LOCAL dates to avoid the off-by-one
   `new Date("2026-05-27")` shift. Returns the flat array, most-overdue first.
   ============================================================ */
function computeFollowUps(minDays) {
  // minDays is the strict-greater-than floor for daysPastDue (matches the
  // legacy `> FOLLOWUP_DAYS` semantics — a line at exactly minDays is
  // NOT included). Defaults to FOLLOWUP_DAYS (10) so no-arg callers keep
  // the same behavior — currently the dashboard panel's inline scan.
  // The Follow-Ups page AND the sidebar badge both pass an explicit 1
  // ("overdue = >1 day late") so they can't drift.
  const floor = (typeof minDays === "number" && isFinite(minDays)) ? minDays : FOLLOWUP_DAYS;
  const stats = (typeof partsWithStatus === "function") ? partsWithStatus() : [];
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
      if (daysPastDue <= floor) continue;
      const pStat = statsByPn.get(ln.pn);
      followUps.push({
        po, ln, expRaw,
        supplier: po.supplier || (pStat && pStat.supplier) || "—",
        pn: ln.pn,
        desc: (pStat && pStat.desc) || ln.desc || "",
        openQty,
        daysPastDue,
        partStatus: (pStat && pStat.status) || null,
      });
    }
  }
  // Most overdue first; tiebreak critical → warning → ok; then supplier alpha.
  const rank = (s) => s === "critical" ? 0 : s === "warning" ? 1 : 2;
  followUps.sort((a, b) => {
    if (b.daysPastDue !== a.daysPastDue) return b.daysPastDue - a.daysPastDue;
    if (rank(a.partStatus) !== rank(b.partStatus)) return rank(a.partStatus) - rank(b.partStatus);
    return String(a.supplier).localeCompare(String(b.supplier));
  });
  return followUps;
}

// Nav-badge count — overdue open-PO lines (daysPastDue > 1). Uses the same
// computeFollowUps predicate as the Follow-Ups page (which also passes 1
// after the "Days late >" toolbar input was removed), so badge === page
// header count by construction. FOLLOWUP_DAYS stays untouched — it still
// drives the dashboard panel filter/label (js/06-page-dashboard.js:109,
// :294) intentionally, on its own separate threshold.
function followUpCount() {
  try { return computeFollowUps(1).length; } catch (e) { return 0; }
}

// Group flat follow-ups by supplier. Lines sorted worst-first within a group;
// groups sorted by worst days-late desc (alpha tiebreak), or by supplier name
// when sortBy === "supplier".
function groupFollowUps(followUps, sortBy) {
  const bySupplier = new Map();
  for (const fu of followUps) {
    if (!bySupplier.has(fu.supplier)) bySupplier.set(fu.supplier, []);
    bySupplier.get(fu.supplier).push(fu);
  }
  const groups = [...bySupplier.entries()].map(([supplier, lines]) => {
    const sorted = lines.slice().sort((a, b) => b.daysPastDue - a.daysPastDue);
    return {
      supplier, lines: sorted, count: sorted.length,
      worst: sorted.length ? sorted[0].daysPastDue : 0,
      worstStatus: sorted.length ? sorted[0].partStatus : null,
    };
  });
  if (sortBy === "supplier") {
    groups.sort((a, b) => String(a.supplier).localeCompare(String(b.supplier)));
  } else {
    groups.sort((a, b) => (b.worst - a.worst) || String(a.supplier).localeCompare(String(b.supplier)));
  }
  return groups;
}

/* ============================================================
   COVERAGE GAPS — part-level "exposed before resupply" detector.

   Catches the trap where current status math reads OK / "∞ cover" because
   on-PO qty is treated as already-covering, but the PO doesn't arrive
   until much later (e.g. 18238: on-hand -6, 600 on PO arriving Aug 8 →
   exposed until 8/8).

   Reuses the existing rate math — `projectOnHand` (js/03-calc.js) does
   workday-aware depletion via effectiveWorkdaysPerWeek / isWorkday and
   credits PO receipts on their expected-date offset (past-due lines
   clamped to today, matching the runway chart and status math). No
   parallel rate logic here.

   A part is EXPOSED iff:
     - itemType is in _COVERAGE_GAP_ITEM_TYPES (explicit allowlist —
       currently base_bom + options). Service, do_not_order, blank/
       untagged, and any future itemType are excluded by default. The
       allowlist sits in one place so adding a type later is a single
       edit; nothing else needs to know about it.
     - NOT a kit per isKit(pn) (kits don't carry their own buy demand;
       redundant with the allowlist today since no "kit" itemType
       exists, but the catalog's kit signal is independent of itemType
       so we keep the guard defensively).
     - daily use > 0 (no real demand → 0-shortfall noise; was the bug
       on the prior pass that listed CP00943/CP00941/19789 etc.)
     - at least one open incoming PO line on this part
     - the forward projection hits balance <= 0 at some point, AND
     - a later PO arrival lifts the balance back > 0 within the horizon
   ============================================================ */
const _COVERAGE_GAP_ITEM_TYPES = new Set(["base_bom", "options"]);

// Overdue-risk horizon — flat 18 calendar days. Lead time is irrelevant
// here: the covering PO is already placed, so a supplier's typical
// resupply time doesn't buy any cushion. The gate answers one question:
// "if the late PO keeps not showing, do we run dry within 18 days?" —
// measured on the ignore-overdue projection (odSeries), same date the
// OUT ON column displays for overdue-only rows.
const OVERDUE_RISK_HORIZON_DAYS = 18;

// Per-render tracker for parts we filtered out of the overdue-risk
// branch because their ignore-overdue runout lies beyond the horizon.
// Reset at the top of computeCoverageGaps and logged at the bottom so
// the console shows what was suppressed on this pass — same shape as
// the transition-suppression log.
let _overdueHorizonSuppressed = { count: 0, sample: [] };

// Chain-shaped coverage gap for parts in an actively-transitioning
// supersession chain. Called from computeCoverageGap when part is
// the chain's representative (successor). Returns null when the
// chain is fully covered AND has no overdue POs — otherwise returns
// a gap object with the same shape the render expects, sourced
// entirely from chainInfo. This is the "single source of truth" —
// no per-part projection is invoked for chain rows.
function _chainCoverageGap(part) {
  const ci = part._chainInfo;
  if (!ci) return null;
  const hasOverdue = (ci.chainPOLines || []).some(l => l.isOverdue);
  // Fully-covered + no overdue exposure → no row. Note we still show
  // the row when the chain is technically "ok" but has an overdue PO —
  // the abdabe9 "late-covered stays visible" principle carries over.
  if (ci.chainStatus === "ok" && (ci.chainShort || 0) === 0 && !hasOverdue) {
    return null;
  }
  // Split PO lines into non-overdue (become coveringPOs) and overdue
  // (become overdueRisk.overdueLines). Supplier for each looked up
  // via DB.pos so we don't need to plumb through here.
  const coveringPOs = [];
  const overdueLines = [];
  let worstDaysPastDue = 0;
  for (const l of (ci.chainPOLines || [])) {
    const po = (DB.pos || []).find(x => x && x.id === l.poId);
    const supplier = po ? (po.supplier || "") : "";
    if (l.isOverdue) {
      overdueLines.push({
        pn: l.pn,
        qty: l.remaining,
        expected: l.expectedDate ? (l.expectedDate.toISOString ? l.expectedDate.toISOString().slice(0, 10) : String(l.expectedDate)) : null,
        po: l.poNum,
      });
      if (l.expectedDate) {
        const d = Math.floor((TODAY.getTime() - l.expectedDate.getTime()) / DAY_MS);
        if (d > worstDaysPastDue) worstDaysPastDue = d;
      }
    } else {
      coveringPOs.push({
        poId: l.poId,
        poNum: l.poNum,
        supplier,
        qty: l.remaining,
        expectedDate: l.expectedDate || ci.chainRunoutDate,
      });
    }
  }
  const primarySupplier = (coveringPOs[0] && coveringPOs[0].supplier)
    || (overdueLines[0] && ((DB.pos || []).find(x => x && x.num === overdueLines[0].po) || {}).supplier)
    || part.supplier
    || "";
  return {
    gapStart: ci.chainRunoutDate,       // chain runout as the row's "Out On" reference
    gapEnd: null,                        // no defined recovery under chain model
    gapDays: null,                       // renders as "—" (matches abdabe9 pattern)
    shortfall: ci.chainShort,            // clamped ≥ 0
    coveringPOs,
    targetArrivalDate: ci.wantByDate,
    primarySupplier,
    overdueRisk: hasOverdue ? {
      runoutDate: ci.chainRunoutDate,
      shortfall: ci.chainShort,
      overdueLines,
      daysPastDue: worstDaysPastDue,
    } : null,
  };
}

function computeCoverageGap(part, lines) {
  if (!part || !part.pn) return null;
  // Allowlist: only base_bom / options qualify. Anything else (service,
  // do_not_order, blank, future types) is excluded by default.
  if (!_COVERAGE_GAP_ITEM_TYPES.has(part.itemType)) return null;
  // Defense in depth — a kit somehow tagged base_bom/options shouldn't
  // surface here either. The aggregator also filters by p.isKit; this
  // catches direct callers (e.g. a future part-drawer hint).
  if (typeof isKit === "function" && isKit(part.pn)) return null;

  // Phase B chain routing: if the part is in an actively-transitioning
  // chain, delegate to the chain model. Non-representative chain
  // members (predecessors) return null so we don't list the same
  // chain twice. The chain's representative (the successor) either
  // returns a chain-shaped gap or null when the chain is fully covered
  // AND has no overdue POs (preserves the "late-covered stays visible"
  // principle from commit abdabe9).
  if (part._chainInfo) {
    if (!part._isChainRepresentative) return null;
    return _chainCoverageGap(part);
  }

  // PRE-LAUNCH GATE (defense-in-depth). A pre-launch chain successor
  // (transitionStartDate in the FUTURE) has no live consumption — its
  // stored `daily` is a placeholder that misleads the projection into
  // depleting phantom stock. The aggregator's own gate at
  // computeCoverageGaps handles the primary suppression + rollup to the
  // demand-carrying predecessor; this guard catches any direct caller
  // (a future part-drawer hint, an audit) so no code path can surface a
  // pre-launch part as its own gap row.
  if (typeof isPreLaunch === "function" && isPreLaunch(part)) return null;

  const daily = Number(part.daily) || 0;
  if (daily <= 0) return null;

  const incoming = (typeof openPOQty === "function") ? openPOQty(part.pn, lines) : 0;
  if (incoming <= 0) return null;

  const series = (typeof projectOnHand === "function") ? projectOnHand(part, 365, lines) : null;
  if (!series || series.length === 0) return null;

  // ── Normal-gap detection ────────────────────────────────────────────────
  // First day balance hits <= 0 (can be today if on-hand is already <= 0).
  let zeroIdx = -1;
  for (let i = 0; i < series.length; i++) {
    if (series[i].oh <= 0) { zeroIdx = i; break; }
  }

  // First day after zeroIdx where balance recovers > 0. Depletion is
  // monotonic non-positive, so a recovery day is always a receipt day.
  let recoverIdx = -1;
  if (zeroIdx !== -1) {
    for (let i = zeroIdx + 1; i < series.length; i++) {
      if (series[i].oh > 0) { recoverIdx = i; break; }
    }
  }

  const hasNormalGap = zeroIdx !== -1 && recoverIdx !== -1;

  // Normal-gap fields — populated only when both boundaries were found.
  // When either is missing the fields stay null/empty so the aggregator
  // and render can tell a normal gap from an overdue-only one.
  let gapStart = null, gapEnd = null, gapDays = null, shortfall = null;
  let coveringPOs = [];
  let targetArrivalDate = null;

  if (hasNormalGap) {
    // Max deficit across the gap (positive units below zero).
    let sf = 0;
    for (let i = zeroIdx; i < recoverIdx; i++) {
      const deficit = -series[i].oh;
      if (deficit > sf) sf = deficit;
    }
    shortfall = sf;

    gapStart = series[zeroIdx].d;
    gapEnd = series[recoverIdx].d;
    gapDays = Math.round((gapEnd.getTime() - gapStart.getTime()) / DAY_MS);

    // Covering PO line(s): open lines whose expected-arrival offset matches
    // recoverIdx. Walks DB.pos directly so we can attach po.num + supplier
    // to the result (projectOnHand's receipts array aggregates qtys and
    // loses PO origin). Same isLineOpen gate as projectOnHand.
    //
    // CRITICAL: offset MUST be computed exactly the way projectOnHand
    // computes it, or the line won't match recoverIdx and the row shows
    // "—". projectOnHand uses `new Date(string)` + setHours, which for
    // YYYY-MM-DD strings (Acumatica's wire format) parses as UTC midnight
    // and lands one calendar day earlier in US-local timezones. We mirror
    // that for the MATCH only; for the DISPLAY date we re-parse YYYY-MM-DD
    // as a local calendar date so the row reads the supplier's actual
    // promise date, not the UTC-shifted internal one.
    for (const po of (DB.pos || [])) {
      for (const ln of (po.lines || [])) {
        if (ln.pn !== part.pn) continue;
        if (!isLineOpen(po, ln)) continue;
        const remaining = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
        if (remaining <= 0) continue;
        const expRaw = ln.expectedDate || po.expectedDate;
        // 1) Offset for MATCHING — mirror projectOnHand's parse exactly.
        let offset;
        const expForMatch = expRaw ? new Date(expRaw) : null;
        if (expForMatch && !isNaN(expForMatch.getTime())) {
          expForMatch.setHours(0, 0, 0, 0);
          offset = Math.round((expForMatch.getTime() - TODAY.getTime()) / DAY_MS);
          if (offset < 0) offset = 0;
        } else {
          offset = (typeof leadTimeDays === "function") ? leadTimeDays(part) : 0;
        }
        if (offset !== recoverIdx) continue;
        // 2) Display date — for YYYY-MM-DD strings, re-parse as a local
        //    calendar date so the row shows what the supplier promised.
        let expForDisplay = expForMatch;
        if (typeof expRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expRaw)) {
          const [y, m, d] = expRaw.split("-").map(Number);
          const local = new Date(y, m - 1, d);
          if (!isNaN(local.getTime())) expForDisplay = local;
        }
        coveringPOs.push({
          poId: po.id,
          poNum: po.num,
          supplier: po.supplier || "",
          qty: remaining,
          expectedDate: expForDisplay || gapEnd,
        });
      }
    }

    // Target arrival = gapStart - 18 calendar days (~2.5 weeks). We want the
    // PO to land before stock hits zero with a buffer. gapStart can be today
    // (or even earlier if on-hand is already <= 0), in which case targetDate
    // sits in the past — the email body frames that as "already overdue,
    // pull in ASAP" and the row's Want-by cell renders red.
    targetArrivalDate = (typeof addDays === "function") ? addDays(gapStart, -18) : new Date(gapStart.getTime() - 18 * DAY_MS);
  }

  // ── Overdue-PO risk detection ───────────────────────────────────────────
  // projectOnHand clamps late receipts to offset 0, which can mask a real
  // exposure: if a covering PO is already past due, the normal projection
  // treats it as arrived today and never dips below zero. Re-project with
  // opts.ignoreOverdue=true to see the world where the late PO doesn't
  // land — if the balance goes negative there, the part is genuinely at
  // risk if the supplier slips further.
  //
  // series.overdueLines is populated by projectOnHand (see 03-calc.js:407)
  // and carries { pn, qty, expected, po }. We use its .slice() as the
  // overdueRisk payload per spec — no re-derivation.
  let overdueRisk = null;
  if ((series.overdueUnits || 0) > 0) {
    const odSeries = projectOnHand(part, 365, lines, { ignoreOverdue: true });
    if (odSeries && odSeries.length) {
      let odZeroIdx = -1;
      for (let i = 0; i < odSeries.length; i++) {
        if (odSeries[i].oh <= 0) { odZeroIdx = i; break; }
      }
      if (odZeroIdx !== -1) {
        // Flat 18-day gate on the ignore-overdue projection. Lead time
        // plays no part — the covering PO is already placed, so what
        // matters is only whether we run dry soon if the late PO keeps
        // not showing. daysToRunout is measured on odSeries so it
        // matches the OUT ON column value on the row (risk.runoutDate
        // = odSeries[odZeroIdx].d), and does NOT gate the normal
        // zero→recover path found above.
        const daysToRunout = Math.round((odSeries[odZeroIdx].d.getTime() - TODAY.getTime()) / DAY_MS);
        if (daysToRunout > OVERDUE_RISK_HORIZON_DAYS) {
          _overdueHorizonSuppressed.count++;
          if (_overdueHorizonSuppressed.sample.length < 8) {
            _overdueHorizonSuppressed.sample.push(`${part.pn} (runout in ${daysToRunout}d)`);
          }
          // Fall through — overdueRisk stays null.
        } else {
          // OVERDUE-ROW SHORTFALL (Option B): count overdue POs as
          // coverage. The old formula measured max deficit in the
          // ignore-overdue projection — but that projection excludes
          // the overdue PO entirely, so when the overdue PO is the
          // only coverage, the deficit accumulated over the full
          // 365-day horizon (producing 1012 / 5858 / 364 — the bug).
          //
          // The corrected definition per user:
          //   SHORT = demand_through_want_by
          //         − (on_hand + ALL open covering POs incl. overdue),
          //   clamped at 0.
          //
          // The overdue PO's timing risk is separately surfaced by the
          // OVERDUE badge on the row — SHORT itself assumes the PO
          // lands. If the PO's qty covers the demand, SHORT is 0.
          //
          // want-by for an overdue-risk-only row (no normal gapStart)
          // matches the render's fallback: `effWantBy = g.targetArrivalDate
          // || TODAY`. Since these rows don't set targetArrivalDate
          // (that's only computed in the normal-gap branch), want-by
          // is TODAY here. daysUntilWantBy = 0 → demand = 0. So the
          // formula reduces to: SHORT = max(0, 0 − (on_hand + all POs))
          // = 0 for any part where on_hand + coverage > 0.
          //
          // For future maintenance: if a future change ever gives
          // overdue-risk rows a non-TODAY want-by, the loop below
          // computes demand accumulation correctly (workday-aware).
          const wantByDate = TODAY;
          const daysUntilWantBy = Math.max(0, Math.round((wantByDate.getTime() - TODAY.getTime()) / DAY_MS));
          const wpw = (typeof effectiveWorkdaysPerWeek === "function") ? effectiveWorkdaysPerWeek() : 5;
          let workdaysToWantBy = 0;
          for (let i = 1; i <= daysUntilWantBy; i++) {
            if (typeof isWorkday === "function" && isWorkday(addDays(TODAY, i), wpw)) workdaysToWantBy++;
          }
          const daily = Number(part.daily) || 0;
          const demandThroughWantBy = workdaysToWantBy * daily;

          // Coverage = on-hand + ALL open PO qty on this part, overdue
          // included. Walks DB.pos with the same isLineOpen gate the
          // rest of the app uses so a leaked Completed PO can't inflate
          // coverage.
          const onHand = Number(part.onHand) || 0;
          let allPOQty = 0;
          for (const po of (DB.pos || [])) {
            for (const ln of (po.lines || [])) {
              if (ln.pn !== part.pn) continue;
              if (!isLineOpen(po, ln)) continue;
              allPOQty += Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
            }
          }
          const odShortfall = Math.max(0, demandThroughWantBy - (onHand + allPOQty));
          // daysPastDue = worst overdue line across the set. expected can
          // be a YYYY-MM-DD string (local parse) or a full timestamp
          // (UTC parse) — parseDateLocal handles both consistently.
          let worstDaysPastDue = 0;
          for (const ol of (series.overdueLines || [])) {
            if (!ol.expected) continue;
            const exp = (typeof parseDateLocal === "function")
              ? parseDateLocal(ol.expected)
              : new Date(ol.expected);
            if (!exp || isNaN(exp.getTime())) continue;
            const d = Math.floor((TODAY.getTime() - exp.getTime()) / DAY_MS);
            if (d > worstDaysPastDue) worstDaysPastDue = d;
          }
          overdueRisk = {
            runoutDate: odSeries[odZeroIdx].d,
            shortfall: odShortfall,
            overdueLines: (series.overdueLines || []).slice(),
            daysPastDue: worstDaysPastDue,
          };
        }
      }
    }
  }

  // Nothing to surface — no normal gap, no overdue-risk exposure.
  if (!hasNormalGap && !overdueRisk) return null;

  // Primary supplier for grouping the section-level "Draft all expedites"
  // bundle — first normal covering PO's supplier when we have one, else
  // the part's own supplier (which also serves overdue-only rows).
  const primarySupplier = (coveringPOs[0] && coveringPOs[0].supplier) || part.supplier || "";

  return { gapStart, gapEnd, gapDays, shortfall, coveringPOs, targetArrivalDate, primarySupplier, overdueRisk };
}

// Aggregator: scan partsWithStatus, apply the cheap pre-filters (kits,
// daily<=0, onPO<=0 — all unconditionally not-exposed), call the detector
// for each survivor, sort soonest-exposure first with widest-gap as tiebreak.
// PRE-LAUNCH ROLLUP helper. Given a pre-launch part `p` suppressed by the
// gate in computeCoverageGaps, returns the overdue PO lines (if any)
// currently sitting on that part's own pn — for routing to the demand-
// carrying predecessor. Same isLineOpen gate the rest of the app uses,
// plus a `expected < TODAY` filter to isolate genuinely overdue lines.
// Returns { overdueLines: [], daysPastDue: number }. When the part has
// no overdue lines, both fields are empty/zero and the caller skips it.
function _collectOverdueLinesForRollup(p) {
  const overdueLines = [];
  let worstDaysPastDue = 0;
  for (const po of (DB.pos || [])) {
    for (const ln of (po.lines || [])) {
      if (!ln || ln.pn !== p.pn) continue;
      if (typeof isLineOpen === "function" && !isLineOpen(po, ln)) continue;
      const remaining = Math.max(0, (ln.qty || 0) - (ln.qtyReceived || 0));
      if (remaining <= 0) continue;
      const expRaw = ln.expectedDate || po.expectedDate;
      if (!expRaw) continue;
      let exp = null;
      if (typeof expRaw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(expRaw) && typeof parseDateLocal === "function") {
        exp = parseDateLocal(expRaw);
      } else {
        exp = new Date(expRaw);
        if (exp) exp.setHours(0, 0, 0, 0);
      }
      if (!exp || isNaN(exp.getTime())) continue;
      if (exp.getTime() >= TODAY.getTime()) continue;
      overdueLines.push({
        pn: p.pn,             // suppressed part's PN — the render key for "(on <pn>)"
        qty: remaining,
        expected: expRaw,
        po: po.num || null,
      });
      const days = Math.floor((TODAY.getTime() - exp.getTime()) / DAY_MS);
      if (days > worstDaysPastDue) worstDaysPastDue = days;
    }
  }
  return { overdueLines, daysPastDue: worstDaysPastDue };
}

function computeCoverageGaps() {
  const stats = (typeof partsWithStatus === "function") ? partsWithStatus() : [];
  const out = [];
  let transitionSuppressedCount = 0;
  const transitionSuppressedSample = [];
  // PRE-LAUNCH ROLLUP queue — populated by the pre-launch gate below when a
  // suppressed pre-launch part has an overdue covering PO. Processed after
  // the main loop so we can merge into an existing demand-member row when
  // possible. Also stashed on window._preLaunchRollupActions so the
  // audit helper can report per-part outcomes (merged / synthesized /
  // skipped).
  const rollupQueue = [];
  const rollupActions = [];
  // Reset the horizon-suppression tracker so its counts are per-pass.
  // computeCoverageGap increments it whenever its overdue-risk branch
  // gets gated for being too far out — the log at the bottom of this
  // function surfaces the total.
  _overdueHorizonSuppressed = { count: 0, sample: [] };
  for (const p of stats) {
    // Allowlist gate up front — same Set the detector uses. Excludes
    // service / do_not_order / blank / any future itemType by default.
    if (!_COVERAGE_GAP_ITEM_TYPES.has(p.itemType)) continue;
    if (p.isKit) continue;
    if ((Number(p.daily) || 0) <= 0) continue;
    if ((Number(p.onPO) || 0) <= 0) continue;
    // PRE-LAUNCH GATE. A pre-launch part (transitionStartDate in the
    // FUTURE) has no live consumption; its placeholder daily is a data
    // artifact, not a demand signal. Instead of surfacing a phantom
    // self-row, collect any overdue POs for rollup to the demand-
    // carrying predecessor after this loop. Live parts (no cutin, or
    // cutin already passed) skip this branch and behave byte-identically
    // to today.
    if (typeof isPreLaunch === "function" && isPreLaunch(p)) {
      const rolled = _collectOverdueLinesForRollup(p);
      if (rolled.overdueLines.length > 0) {
        rollupQueue.push({ suppressedPart: p, ...rolled });
      } else {
        rollupActions.push({
          suppressedPn: p.pn, demandMember: "-", overduePoNum: "-",
          daysPastDue: 0, action: "no overdue lines",
        });
      }
      continue;
    }
    const gap = computeCoverageGap(p);
    if (!gap) continue;

    // Pre-launch cut-in suppression. If the part has a planner-owned
    // transitionStartDate (same field the Model Year page and isPreLaunch
    // read) and the earliest covering PO lands on OR before that date, the
    // resupply arrives before the part is live — no real exposure, so
    // don't surface it as a gap. Additive to the existing rules; parts
    // without a transitionStartDate keep their normal behavior.
    // Timezone-safe: parseDateLocal for the cut-in, and coveringPOs[i]
    // .expectedDate is already a local-midnight Date built by the
    // detector's YYYY-MM-DD-as-local re-parse. Both sides share the same
    // anchor, so the <= compare is calendar-day accurate.
    //
    // NOT applied when gap.overdueRisk is set — a genuinely overdue
    // covering PO always wins over the pre-launch bypass. Otherwise a
    // late resupply on a live/transitioning part would be silently hidden.
    if (p.transitionStartDate && !gap.overdueRisk) {
      const startDate = (typeof parseDateLocal === "function")
        ? parseDateLocal(p.transitionStartDate) : null;
      if (startDate) {
        // Earliest covering-PO arrival across all covering lines at
        // recoverIdx — they share the same offset but their display
        // dates can differ by a day when some raws are YYYY-MM-DD
        // (local parse) and others are ISO timestamps (UTC parse).
        let earliestCoveringMs = null;
        for (const co of (gap.coveringPOs || [])) {
          const t = co.expectedDate ? co.expectedDate.getTime() : null;
          if (t != null && (earliestCoveringMs == null || t < earliestCoveringMs)) {
            earliestCoveringMs = t;
          }
        }
        if (earliestCoveringMs != null && earliestCoveringMs <= startDate.getTime()) {
          transitionSuppressedCount++;
          if (transitionSuppressedSample.length < 8) transitionSuppressedSample.push(p.pn);
          continue;
        }
      }
    }

    out.push({ part: p, ...gap });
  }
  // PRE-LAUNCH ROLLUP pass. For every pre-launch part suppressed above
  // that had an overdue covering PO, route the overdue lines to the
  // demand-carrying predecessor. Resolve via supersessionLineage (walks
  // both directions unconditionally; no phasingOut gate). The demand
  // member is the first non-pre-launch lineage member with daily > 0.
  // MERGE if that member already has a row; SYNTHESIZE otherwise. The
  // rolled-up overdue line keeps its original .pn (the suppressed
  // successor), so the render can annotate "(on <successor>)" when
  // ol.pn !== g.part.pn — the natural signal from the data.
  if (rollupQueue.length > 0) {
    const partsByPn = new Map((DB.parts || []).map(x => [x && x.pn, x]));
    const statsByPn = new Map(stats.map(x => [x && x.pn, x]));
    for (const rollup of rollupQueue) {
      const p = rollup.suppressedPart;
      // FIX A: no supersessionLineage predecessor AND no demand-carrying
      // member → surface the pre-launch part on its OWN row as a normal
      // overdue-only row (gapStart null, shortfall 0, overdueRisk
      // populated). The gate no longer hides a genuinely late PO on a
      // no-chain pre-launch part — the JP00002/…/JP00023 case where the
      // overdue PO is the only inbound. Falls through to the same
      // synthesize-shape block below via a null demandStat sentinel.
      const lineage = (typeof supersessionLineage === "function") ? supersessionLineage(p.pn) : [];
      const members = (lineage && lineage.length >= 2)
        ? lineage.map(pn => partsByPn.get(pn)).filter(Boolean) : [];
      const demandMember = members.find(m => {
        if (!m) return false;
        if (Number(m.daily) <= 0) return false;
        if (typeof isPreLaunch === "function" && isPreLaunch(m)) return false;
        return true;
      });
      // No demand-carrying predecessor found. Surface the pre-launch
      // part on its own overdue-only row rather than hide it — a late PO
      // on a no-chain pre-launch part has nowhere else to route.
      if (!demandMember) {
        const suppressedStat = statsByPn.get(p.pn) || p;
        // runoutDate for a pre-launch overdue-only row: use the earliest
        // overdue line's expected-arrival date (the "should have arrived
        // by" signal), not TODAY. Pre-launch parts have no natural
        // runout — using TODAY as a sort anchor mis-rendered as "runs
        // out today" (bug fixed alongside the demand-member rollup).
        // Falls back to null when no expected date is parseable —
        // render will show "—" and the sort will slot the row via
        // whatever fallback the sort handles null with.
        let _fbRunoutDate = null;
        for (const ol of rollup.overdueLines) {
          if (!ol || !ol.expected) continue;
          let d;
          if (typeof ol.expected === "string" && /^\d{4}-\d{2}-\d{2}$/.test(ol.expected) && typeof parseDateLocal === "function") {
            d = parseDateLocal(ol.expected);
          } else {
            d = new Date(ol.expected);
            if (d) d.setHours(0, 0, 0, 0);
          }
          if (!d || isNaN(d.getTime())) continue;
          if (!_fbRunoutDate || d.getTime() < _fbRunoutDate.getTime()) _fbRunoutDate = d;
        }
        out.push({
          part: suppressedStat,
          gapStart: null,
          gapEnd: null,
          gapDays: null,
          shortfall: 0,
          coveringPOs: [],
          targetArrivalDate: null,
          primarySupplier: suppressedStat.supplier || "",
          overdueRisk: {
            runoutDate: _fbRunoutDate,
            shortfall: 0,
            overdueLines: [...rollup.overdueLines],
            daysPastDue: rollup.daysPastDue,
          },
          _syntheticFromRollup: true,
        });
        rollupActions.push({
          suppressedPn: p.pn,
          demandMember: "-",
          overduePoNum: rollup.overdueLines.map(l => l.po).join(","),
          daysPastDue: rollup.daysPastDue,
          action: "kept on own row (no demand-carrying predecessor)",
        });
        continue;
      }
      // The demand member's own enhanced part row (from partsWithStatus) —
      // that's the one that would appear in `out` if it had a normal gap.
      const demandStat = statsByPn.get(demandMember.pn) || demandMember;
      // Coverage check: does the demand member ALREADY have its own
      // exposure? computeCoverageGap returns null iff there is no normal
      // gap AND no overdue-risk on the demand member — i.e. its own
      // on-hand + open POs cover projected demand. In that case the
      // pre-launch part's overdue PO is genuinely someone else's
      // problem; surfacing the demand member here would falsely flag a
      // healthy part.
      //
      // Prior bug: this pass unconditionally routed a suppressed
      // pre-launch part's overdue PO onto its demand member's row with
      // `runoutDate: TODAY` (a sort anchor mis-rendered as a real
      // stockout date), producing rows like "18555-2 · out today · 78
      // on hand · covered by CP00663's on-hold PO" when 18555-2 in
      // fact had 205 on POC0006776 arriving Aug 25 covering demand to
      // ~Nov 8.
      const _demandMemberGap = computeCoverageGap(demandStat);
      if (!_demandMemberGap) {
        rollupActions.push({
          suppressedPn: p.pn,
          demandMember: demandMember.pn,
          overduePoNum: rollup.overdueLines.map(l => l.po).join(","),
          daysPastDue: rollup.daysPastDue,
          action: "skipped — demand member covered by own supply",
        });
        continue;
      }
      // Real runout for the demand member from its own gap detector:
      // gapStart when a normal gap was found, else the overdue-risk
      // runout date. Never TODAY.
      const _dmActualRunoutDate = _demandMemberGap.gapStart
        || (_demandMemberGap.overdueRisk && _demandMemberGap.overdueRisk.runoutDate)
        || null;
      const existingIdx = out.findIndex(r => r.part && r.part.pn === demandMember.pn);
      if (existingIdx >= 0) {
        // MERGE. CONFIRM C: distinguish where the existing row came from
        // so the audit reports the true reason:
        //   normal-gap → existing.gapStart is non-null (demand member has
        //     its own coverage gap; the rollup piggybacks on it).
        //   own overdue-risk → existing has overdueRisk but no gapStart,
        //     and wasn't synthesized by an earlier rollup this pass
        //     (demand member itself has a late PO).
        //   synthesized-earlier → existing._syntheticFromRollup is true
        //     (a prior rollup this pass created the row; we're adding to it).
        const existing = out[existingIdx];
        let mergedFrom;
        if (existing.gapStart) mergedFrom = "merged: existing normal-gap row";
        else if (existing._syntheticFromRollup) mergedFrom = "merged: synthesized by earlier rollup";
        else mergedFrom = "merged: existing overdue-risk on demand member";
        if (!existing.overdueRisk) {
          // Existing row came from a normal gap — existing.gapStart is
          // truthy by construction (computeCoverageGap only pushes when
          // it has hasNormalGap or overdueRisk; no overdueRisk here means
          // hasNormalGap → gapStart set). Fall back to the demand
          // member's detector-computed runout if for any reason the
          // gapStart is missing. Never TODAY.
          existing.overdueRisk = {
            runoutDate: existing.gapStart || _dmActualRunoutDate,
            shortfall: 0,
            overdueLines: [],
            daysPastDue: 0,
          };
        }
        existing.overdueRisk.overdueLines.push(...rollup.overdueLines);
        existing.overdueRisk.daysPastDue = Math.max(
          Number(existing.overdueRisk.daysPastDue) || 0,
          rollup.daysPastDue
        );
        rollupActions.push({
          suppressedPn: p.pn,
          demandMember: demandMember.pn,
          overduePoNum: rollup.overdueLines.map(l => l.po).join(","),
          daysPastDue: rollup.daysPastDue,
          action: mergedFrom,
        });
      } else {
        // SYNTHESIZE — overdue-only row keyed on the demand member.
        // Reachable when demandMember was filtered out of the normal
        // loop (itemType allowlist, isKit, onPO<=0, transitionStartDate
        // suppression) but computeCoverageGap still reported a real
        // exposure just now. Use the demand member's ACTUAL runout
        // date from its own detector — never TODAY-as-sort-anchor.
        out.push({
          part: demandStat,
          gapStart: null,
          gapEnd: null,
          gapDays: null,
          shortfall: 0,
          coveringPOs: [],
          targetArrivalDate: null,
          primarySupplier: demandStat.supplier || "",
          overdueRisk: {
            runoutDate: _dmActualRunoutDate,
            shortfall: 0,
            overdueLines: [...rollup.overdueLines],
            daysPastDue: rollup.daysPastDue,
          },
          _syntheticFromRollup: true,
        });
        rollupActions.push({
          suppressedPn: p.pn,
          demandMember: demandMember.pn,
          overduePoNum: rollup.overdueLines.map(l => l.po).join(","),
          daysPastDue: rollup.daysPastDue,
          action: "synthesized",
        });
      }
    }
  }
  // Stash actions for the audit helper. Reset each aggregator pass.
  if (typeof window !== "undefined") window._preLaunchRollupActions = rollupActions;
  // Sort by gapStart when present, else overdueRisk.runoutDate — so
  // overdue-only rows interleave with normal gaps by their soonest-dry
  // date. Tiebreak by widest gap (null gapDays → 0 for overdue-only, so
  // real gaps float above overdue-only rows on the same date).
  out.sort((a, b) => {
    const aStart = a.gapStart || (a.overdueRisk && a.overdueRisk.runoutDate) || null;
    const bStart = b.gapStart || (b.overdueRisk && b.overdueRisk.runoutDate) || null;
    const aMs = aStart ? aStart.getTime() : 0;
    const bMs = bStart ? bStart.getTime() : 0;
    const da = aMs - bMs;
    if (da !== 0) return da;
    return (b.gapDays || 0) - (a.gapDays || 0);
  });
  if (transitionSuppressedCount > 0) {
    console.info(
      `[coverage-gaps] Suppressed ${transitionSuppressedCount} pre-launch part(s) whose covering PO lands on or before transitionStartDate` +
      (transitionSuppressedSample.length
        ? ` (sample: ${transitionSuppressedSample.join(", ")}${transitionSuppressedCount > transitionSuppressedSample.length ? ", …" : ""})`
        : "")
    );
  }
  if (_overdueHorizonSuppressed.count > 0) {
    console.info(
      `[coverage-gaps] Suppressed ${_overdueHorizonSuppressed.count} overdue-risk part(s) with ignore-overdue runout beyond ${OVERDUE_RISK_HORIZON_DAYS} days` +
      (_overdueHorizonSuppressed.sample.length
        ? ` (sample: ${_overdueHorizonSuppressed.sample.join(", ")}${_overdueHorizonSuppressed.count > _overdueHorizonSuppressed.sample.length ? ", …" : ""})`
        : "")
    );
  }
  return out;
}

/* ============================================================
   CROSS-USER PERSISTED MARKS — Sent (Coverage Gaps) + Chased (supplier
   follow-ups). Backed by the `follow_marks` Supabase table; loaded into
   window.followMarks on boot by js/30-supabase.js, kept in sync across
   tabs/users via realtime, mutated IN PLACE so the same Map reference
   stays valid for any downstream consumer.

   Dated checkmark only — no user, no name. Active = within 3 business
   days of markedAt (computed at READ time in isMarkActive). Stale rows
   render as inactive automatically; they are NEVER deleted on load
   (deleting during boot fires DELETE events that re-enter the realtime
   handler — earlier attempt looped because of that).

   Optimistic UI: local Map mutates first, then the Supabase write
   fires; on failure the local change is reverted. The realtime echo
   for the same content is detected and skipped by 30-supabase.js's
   _handleRealtimeFollowMark via content-equality, so writer + echo
   can never ping-pong.

   The legacy sessionStorage keys (followups.chased.v1,
   followups.coverage.sent.v1) are gone. Nothing in this module reads
   or writes sessionStorage for marks — single source of truth is
   window.followMarks.
   ============================================================ */

// Eager init; cloudInit will .clear() + populate after the boot fetch.
// Never reassign — only .set/.delete/.clear — so any reference held
// elsewhere stays current.
if (!window.followMarks) window.followMarks = new Map();

// Stable line key for follow-ups (matches the existing convention used
// by the chased indicator).
function _followupKey(fu) {
  const lnId = (fu.ln && fu.ln.id) ? fu.ln.id : fu.pn;
  return `${fu.po.id}::${lnId}`;
}
// Stable part key for coverage gaps (one gap per part by detector
// contract, so the PN is uniquely identifying).
function _coverageGapKey(g) {
  return (g && g.part && g.part.pn) ? String(g.part.pn) : "";
}
// Full row ids include the type prefix so the same line can carry an
// independent "sent" and "chased" record (different rows in
// follow_marks). For sent, the "po" portion is the first covering
// PO's id when present; "__no_po__" for No-PO coverage gaps.
function _chasedRowId(fu) { return `chased::${_followupKey(fu)}`; }
function _sentRowId(g) {
  const poId = (g.coveringPOs && g.coveringPOs[0] && g.coveringPOs[0].poId) || "__no_po__";
  return `sent::${poId}::${_coverageGapKey(g)}`;
}

// Active-mark check — 3 business days from markedAt, weekends + non-
// workdays skipped per the effectiveWorkdaysPerWeek setting in the
// calc engine. Computed at READ time; no deletion required for expiry.
function isMarkActive(mark) {
  if (!mark || !mark.markedAt) return false;
  const from = new Date(mark.markedAt);
  if (isNaN(from.getTime())) return false;
  from.setHours(0, 0, 0, 0);
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (typeof isWorkday !== "function") return true; // defensive — treat as active
  let count = 0;
  let cursor = from.getTime();
  for (let i = 0; i < 365; i++) {
    cursor += 86400000;
    if (cursor > now.getTime()) break;
    if (isWorkday(new Date(cursor))) count++;
    if (count >= 3) return false;
  }
  return true;
}

/* ============================================================
   CROSS-PAGE CORRELATION — the same (part, PO) is often exposed on
   both screens (a stocked-out part with an overdue covering PO shows
   up as a Coverage Gap AND as a Follow-Up line). Marking it in one
   place should show as handled in the other so a supplier isn't
   contacted twice by two users.

   Sent writes carry an authoritative coveredPoIds[] array (see
   toggleCoverageGapSent). Chased writes are line-scoped and carry a
   single poId. _markPoIds normalizes both — falling back to legacy
   sent marks (no coveredPoIds) via the poId field so pre-existing
   rows in follow_marks still correlate correctly.

   READ-side only. No auto-writes across the boundary — the render
   just annotates that another user (or the current user on the other
   screen) already handled this pair. Cross-user via the existing
   follow_marks realtime path; no changes to the sync layer.
   ============================================================ */
function _markPoIds(mark) {
  if (!mark) return [];
  if (Array.isArray(mark.coveredPoIds) && mark.coveredPoIds.length) return mark.coveredPoIds;
  return mark.poId ? [mark.poId] : [];
}
// True if ANY active mark (sent OR chased) covers this exact part+PO.
function isPartPoHandled(pn, poId) {
  if (!pn || !poId) return false;
  for (const [, m] of (window.followMarks || new Map())) {
    if (!m || !isMarkActive(m)) continue;
    if (String(m.pn) !== String(pn)) continue;
    if (_markPoIds(m).some(id => String(id) === String(poId))) return true;
  }
  return false;
}
// Returns the covering mark (for label/date) or null.
function partPoHandledBy(pn, poId) {
  if (!pn || !poId) return null;
  for (const [, m] of (window.followMarks || new Map())) {
    if (!m || !isMarkActive(m)) continue;
    if (String(m.pn) !== String(pn)) continue;
    if (_markPoIds(m).some(id => String(id) === String(poId))) return m;
  }
  return null;
}

/* ============================================================
   UNIFIED HANDLED-MARK MODEL — one canonical record per (pn, poId).
   Both tabs write and read the SAME record so a checkbox on either
   tab reflects the shared state:

     - Toggling a Follow-Ups line writes/removes ONE handled mark for
       (fu.pn, fu.po.id).
     - Toggling a Coverage Gaps row writes/removes N marks — one per
       covering PO (normal-gap coveringPOs + overdue-line resolutions).
     - CG box is checked when ALL of the row's covering POs are handled;
       partial coverage renders as indeterminate (native browser style,
       no new CSS); zero coverage is unchecked.
     - FU box is checked when the row's exact (pn, po.id) is handled.

   Compat: legacy sent::…::pn and chased::${po.id}::${lineId||pn} marks
   are still recognized via isPartPoHandled + _markPoIds. Unchecking
   wipes them out too, so users can naturally decommission the old
   scheme by unchecking a box.
   ============================================================ */
function _handledRowId(pn, poId) { return `handled::${poId}::${pn}`; }

// Enumerate the (poId, poNum) pairs a coverage-gap row targets.
// Unions coveringPOs + overdueRisk.overdueLines (poNum → poId via DB.pos).
// Preserves first-seen poNum per poId so display can show the number.
function _coverageGapPoIds(g) {
  const out = new Map(); // poId → poNum
  for (const c of (g.coveringPOs || [])) {
    if (c.poId && !out.has(c.poId)) out.set(c.poId, c.poNum || "");
  }
  const overdueLines = (g.overdueRisk && g.overdueRisk.overdueLines) || [];
  for (const ol of overdueLines) {
    const rec = ol.po ? (DB.pos || []).find(x => x && x.num === ol.po) : null;
    if (rec && rec.id && !out.has(rec.id)) out.set(rec.id, ol.po || rec.num || "");
  }
  return [...out.entries()].map(([poId, poNum]) => ({ poId, poNum }));
}

// Read the (pn, poId)-handled state for a coverage-gap row.
//   all:     every covering poId has an active mark → checkbox checked
//   partial: SOME but not all handled            → checkbox indeterminate
//   any:     at least one handled                → used by button dim etc
//   marks:   parallel array of active marks (null where absent) for label/date
function _cgHandledState(g) {
  const pairs = _coverageGapPoIds(g);
  const marks = pairs.map(({ poId }) => partPoHandledBy(g.part.pn, poId));
  const activeCount = marks.filter(Boolean).length;
  return {
    all: pairs.length > 0 && activeCount === pairs.length,
    any: activeCount > 0,
    partial: activeCount > 0 && activeCount < pairs.length,
    pairs,
    marks,
    activeCount,
  };
}

// Earliest markedAt across active marks (or null) — CG "Sent on <date>"
// label reads this so a partial-then-completed row shows the ORIGINAL
// mark date, not the most recent write.
function _earliestActiveDate(marks) {
  let min = null;
  for (const m of marks) {
    if (!m || !m.markedAt) continue;
    const d = new Date(m.markedAt);
    if (isNaN(d.getTime())) continue;
    if (min === null || d < min) min = d;
  }
  return min;
}

// Write a canonical handled mark for (pn, poId). Optimistic local set,
// then cloud upsert; revert on failure. Idempotent — if a legacy mark
// already covers this pair, the new-canonical is still written (harmless
// duplicate; unchecking clears both).
function _writeHandledMark(pn, poId, poNum) {
  if (!pn || !poId) return;
  const rowId = _handledRowId(pn, poId);
  const data = {
    type: "handled",
    pn: String(pn),
    poId: String(poId),
    poNum: poNum || "",
    // Keep coveredPoIds so the existing _markPoIds() correlation helpers
    // treat the new type identically to legacy sent marks.
    coveredPoIds: [String(poId)],
    markedAt: new Date().toISOString(),
  };
  window.followMarks.set(rowId, data);
  if (typeof upsertFollowMarkCloud === "function") {
    upsertFollowMarkCloud(rowId, data).then(r => {
      if (!r.ok) {
        window.followMarks.delete(rowId);
        showToast("Failed to sync mark — toggle again to retry", "warn");
        refresh();
      }
    });
  }
}

// Delete every ACTIVE mark that covers (pn, poId) — new-canonical AND
// legacy sent/chased. Optimistic local delete + cloud delete per row;
// revert individual rows on failure so a partial failure doesn't leave
// the client and cloud out of sync.
function _clearHandledMarks(pn, poId) {
  if (!pn || !poId) return;
  const targets = [];
  for (const [rowId, m] of (window.followMarks || new Map())) {
    if (!m || !isMarkActive(m)) continue;
    if (String(m.pn) !== String(pn)) continue;
    if (!_markPoIds(m).some(id => String(id) === String(poId))) continue;
    targets.push({ rowId, snapshot: m });
  }
  for (const t of targets) window.followMarks.delete(t.rowId);
  if (typeof deleteFollowMarkCloud === "function") {
    for (const t of targets) {
      deleteFollowMarkCloud(t.rowId).then(r => {
        if (!r.ok) {
          window.followMarks.set(t.rowId, t.snapshot);
          showToast("Failed to sync unmark — toggle again to retry", "warn");
          refresh();
        }
      });
    }
  }
}

// Toggle helpers — optimistic local update, then persist; on failure
// revert. NO writes happen inside the realtime handler (see
// 30-supabase.js), so the toggle path here is the only writer.
function toggleFollowupChased(key) {
  // key = `${po.id}::${lineIdOrPn}` from _followupKey. Look up the
  // follow-up in the render stash for pn/poId/poNum enrichment.
  const fu = (window._FOLLOWUPS || []).find(f => _followupKey(f) === key);
  if (!fu) { showToast("Follow-up not found — refresh the page", "warn"); return; }
  const wasHandled = isPartPoHandled(fu.pn, fu.po.id);
  if (wasHandled) {
    _clearHandledMarks(fu.pn, fu.po.id);
  } else {
    _writeHandledMark(fu.pn, fu.po.id, fu.po.num);
  }
  refresh();
}

function toggleCoverageGapSent(key) {
  // key = part PN from _coverageGapKey. Look up the coverage gap in
  // the render stash so we can enumerate ALL its covering POs.
  const g = (window._COVERAGE_GAPS || []).find(x => _coverageGapKey(x) === key);
  if (!g) { showToast("Coverage gap not found — refresh the page", "warn"); return; }
  const st = _cgHandledState(g);
  if (st.pairs.length === 0) {
    showToast("No covering PO on this row — nothing to mark", "warn");
    return;
  }
  // "checked" = all handled. Click toggles the ROW: fully checked → clear
  // all; not-fully-checked (unchecked OR indeterminate) → check all.
  const targetOn = !st.all;
  for (const { poId, poNum } of st.pairs) {
    if (targetOn) {
      // Skip if already handled — leaves any existing legacy mark alone
      // so we don't churn cross-user sync when the row was already fully
      // covered by legacy records.
      if (isPartPoHandled(g.part.pn, poId)) continue;
      _writeHandledMark(g.part.pn, poId, poNum);
    } else {
      _clearHandledMarks(g.part.pn, poId);
    }
  }
  refresh();
}

// Post-render helper: apply the DOM-only `indeterminate` property to
// checkboxes that carry data-indeterminate="1". Called at the end of
// renderCoverageGaps after `$("#main").innerHTML = …` lands. Native
// browser affordance — dash-in-box glyph. No CSS class involved.
function _applyIndeterminateBoxes() {
  const main = document.getElementById("main");
  if (!main) return;
  main.querySelectorAll('input[type="checkbox"][data-indeterminate="1"]').forEach(el => {
    el.indeterminate = true;
  });
}

window.isMarkActive = isMarkActive;

/* ============================================================
   PAGE
   ============================================================ */
// Follow-Ups page state. `minDaysLate` was previously a user-tunable field
// (persisted via localStorage `landmaster.followups.minDaysLate`) driving
// a "Days late >" toolbar input; removed because Dylan's rule pinned
// overdue = >1 day late for both the page AND the sidebar badge. Any
// pre-existing localStorage value under that key is now orphaned and
// ignored — harmless (no code path reads it). Chased state is unaffected;
// it lives in follow_marks keyed by part+PO independently.
let FOLLOWUP_STATE = { search: "", sort: "worst", hideChased: false, hideSentGaps: false };

// Debounced supplier filter that keeps input focus across the re-render
// (same pattern as the Service Usage search box).
let _followupSearchTimer = null;
function _followupSearchInput(value) {
  FOLLOWUP_STATE.search = value;
  clearTimeout(_followupSearchTimer);
  _followupSearchTimer = setTimeout(() => {
    refresh();
    const inp = document.getElementById("followup-search");
    if (inp) { inp.focus(); inp.setSelectionRange(value.length, value.length); }
  }, 200);
}

function renderFollowUps() {
  // Under the unified handled-mark model a line is "chased" iff its
  // (pn, po.id) is handled by ANY active mark — new-canonical handled,
  // or legacy sent/chased. No pre-built Map here; isPartPoHandled does
  // the lookup and is cheap for the row count we're dealing with.
  // Overdue = daysPastDue > 1. Pinned floor (previously user-tunable via
  // the removed "Days late >" toolbar input) — matches followUpCount()
  // exactly so the sidebar badge and this header can never drift.
  const all = computeFollowUps(1);
  const total = all.length;
  const chasedCount = all.reduce((n, fu) => n + (isPartPoHandled(fu.pn, fu.po.id) ? 1 : 0), 0);

  // Working set: optional hide-chased, then supplier search.
  let working = all;
  if (FOLLOWUP_STATE.hideChased) working = working.filter(fu => !isPartPoHandled(fu.pn, fu.po.id));
  const q = FOLLOWUP_STATE.search.trim().toLowerCase();
  if (q) working = working.filter(fu => String(fu.supplier).toLowerCase().includes(q));

  // Stash for the email actions to look rows/groups back up by index.
  working.forEach((fu, i) => { fu._idx = i; });
  window._FOLLOWUPS = working;
  const groups = groupFollowUps(working, FOLLOWUP_STATE.sort);
  groups.forEach((g, i) => { g._idx = i; });
  window._FOLLOWUP_GROUPS = groups;

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Supplier Follow-Ups</div>
          <div class="page-sub mono">${total} LATE LINE${total === 1 ? "" : "S"} · OVERDUE &gt; 1D${chasedCount ? ` · ${chasedCount} CHASED THIS SESSION` : ""}</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="navigate('pos')">All POs →</button>
        </div>
      </div>

      <div class="panel">
        <div class="filterbar">
          <div class="search-input">
            <input class="input" id="followup-search" placeholder="Filter by supplier…" value="${esc(FOLLOWUP_STATE.search)}" oninput="_followupSearchInput(this.value)">
          </div>
          <select class="select" onchange="FOLLOWUP_STATE.sort = this.value; refresh()">
            <option value="worst"    ${FOLLOWUP_STATE.sort === "worst"    ? "selected" : ""}>Sort: worst days-late</option>
            <option value="supplier" ${FOLLOWUP_STATE.sort === "supplier" ? "selected" : ""}>Sort: supplier name</option>
          </select>
          <label class="row" style="gap:6px; align-items:center; cursor:pointer" title="Hide lines marked chased this session">
            <input type="checkbox" class="chk" ${FOLLOWUP_STATE.hideChased ? "checked" : ""} onchange="FOLLOWUP_STATE.hideChased = this.checked; refresh()">
            <span class="muted tiny">Hide chased</span>
          </label>
          <div class="grow"></div>
          <span class="muted tiny">${working.length} of ${total} shown</span>
        </div>
        <div class="panel-body flush">
          ${groups.length === 0 ? `
            <div class="empty empty-lg">
              <div class="empty-title">${total === 0 ? "All caught up" : "Nothing to show"}</div>
              <div class="empty-msg">${total === 0
                ? "No overdue POs to follow up on."
                : (FOLLOWUP_STATE.hideChased && chasedCount ? "Every late line is marked chased. Untick “Hide chased” to see them." : "No suppliers match the current filter.")}</div>
            </div>
          ` : groups.map(g => _followupGroupHtml(g)).join("")}
        </div>
      </div>
    </div>`;
}

// Renders one supplier group. Per-row "handled" state is computed
// inline via isPartPoHandled — no external map to thread through.
function _followupGroupHtml(g) {
  const sev = g.worstStatus === "critical" ? "crit" : "warn"; // every line here is overdue > threshold
  return `
    <div class="followup-group">
      <div class="filterbar" style="justify-content:space-between; padding:10px 14px; background:var(--bg-2); border-top:1px solid var(--line)">
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap">
          <span class="pn" style="font-size:13px; font-weight:700">${esc(g.supplier)}</span>
          <span class="pill ${sev}">${g.count} late · worst ${g.worst}d</span>
        </div>
        <button class="btn sm" onclick="draftFollowupEmailSupplier(${g._idx})" title="Draft one email covering every late line for ${esc(g.supplier)}">✉ Draft email (all lines)</button>
      </div>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr>
          <th>PO #</th>
          <th>Part</th>
          <th class="right">Qty Open</th>
          <th>Expected</th>
          <th class="right">Days Late</th>
          <th>Actions</th>
          <th class="right">Chased</th>
        </tr></thead>
        <tbody>
          ${g.lines.map(fu => {
            const key = _followupKey(fu);
            // Unified handled state — checked when the canonical
            // (fu.pn, fu.po.id) pair has ANY active mark of any type
            // (new-canonical handled OR legacy sent OR legacy chased).
            // The checkbox on either tab writes/removes the SAME record,
            // so the two tabs stay in sync per (pn, poId).
            const isHandled = isPartPoHandled(fu.pn, fu.po.id);
            const mark = isHandled ? partPoHandledBy(fu.pn, fu.po.id) : null;
            const chasedOn = mark && typeof fmtDate === "function"
              ? fmtDate(new Date(mark.markedAt))
              : "";
            const chasedBoxTitle = isHandled
              ? `Marked chased on ${chasedOn} (shared across users · uncheck to clear)`
              : "Mark chased (shared across users for 3 business days)";
            const emailBtnStyle = isHandled ? "opacity:0.55" : "";
            const emailBtnTitle = isHandled
              ? `Marked chased on ${esc(chasedOn)} — click to draft again`
              : "Draft a chase email for this late line";
            const lc = fu.partStatus === "critical" ? "crit" : "warn";
            return `
            <tr style="${isHandled ? "opacity:0.45" : ""}">
              <td class="pn clickable" onclick="openPODetail('${esc(fu.po.id)}')">${esc(fu.po.num)}</td>
              <td>
                <span class="pn" style="${isHandled ? "text-decoration:line-through" : ""}">${esc(fu.pn)}</span>
                ${fu.desc ? `<div class="dim tiny">${esc(fu.desc)}</div>` : ""}
              </td>
              <td class="right num">${fmtNum(fu.openQty)}</td>
              <td class="num dim">${fmtDate(fu.expRaw)}</td>
              <td class="right"><span class="pill ${lc}" style="font-weight:700">${fu.daysPastDue}d late</span></td>
              <td>
                <div style="display:flex; gap:6px; flex-wrap:wrap">
                  <button class="btn sm" style="${emailBtnStyle}" onclick="draftFollowupEmailRow(${fu._idx})" title="${emailBtnTitle}">✉ Draft email</button>
                  <button class="btn sm" onclick="openPODetail('${esc(fu.po.id)}')">Open PO</button>
                </div>
              </td>
              <td class="right">
                <label class="row" style="gap:5px; justify-content:flex-end; cursor:pointer" title="${chasedBoxTitle}">
                  <input type="checkbox" class="chk" ${isHandled ? "checked" : ""} onchange="toggleFollowupChased('${esc(key)}')">
                  <span class="muted tiny" style="min-width:42px; text-align:left">${isHandled ? `Chased on ${esc(chasedOn)}` : ""}</span>
                </label>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table></div>
    </div>`;
}

/* ============================================================
   DRAFT CHASE EMAILS — shared voice across Follow-Ups + Coverage Gaps.

   No email backend exists, so we build a mailto: draft (opened via a
   transient anchor so the SPA doesn't navigate) AND copy the text to
   the clipboard as a fallback. If the clipboard is unavailable, a
   modal shows the text to copy by hand. Data is read back from the
   window stash by index, so descriptions with quotes/commas never
   round-trip through an onclick string.

   The voice — greeting rule, INTRO/ASK/CLOSE lines, subject
   template, per-line bullet format — is defined ONCE below and
   every drafter reuses it. To reword any of it, change the const or
   helper here, never inside a specific drafter.
   ============================================================ */

// ── Shared voice ─────────────────────────────────────────────────
const CHASE_INTRO = "This is an automated message. Our system flagged the line below as overdue, and we're following up — a short, quick reply would be great.";
const CHASE_ASK   = "Please reply with the current status and a revised ship date. If something's holding it up, let us know and we'll help however we can.";
const CHASE_CLOSE = "Thanks for the help.";

// Pluralization is a small swap on the same INTRO const — not a
// separate string — so a future INTRO rewrite can't drift between
// the singular and plural variants.
function _chaseIntro(multi) {
  return multi ? CHASE_INTRO.replace("the line below", "the lines below") : CHASE_INTRO;
}

// Full 4-digit year — never "Jun 19, 26". fmtDate in js/02-utils.js
// uses year:"2-digit" for on-screen density; supplier-facing dates
// must not truncate the year. YYYY-MM-DD strings parse as local
// dates to avoid the UTC-midnight off-by-one in US timezones.
function _fmtDateForEmail(d) {
  if (!d) return "";
  let dt;
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) && typeof parseDateLocal === "function") {
    dt = parseDateLocal(d);
  } else {
    dt = (d instanceof Date) ? d : new Date(d);
  }
  if (!dt || isNaN(dt.getTime())) return "";
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

// Greeting name: strip a trailing legal suffix so
// "Schafer Driveline, LLC" reads "Schafer Driveline team", not
// "Schafer Driveline, LLC team". Suffix can be preceded by a comma
// or plain space; trailing period is optional. Falls back to "there"
// for empty or dash-placeholder supplier names.
function _supplierGreetingName(name) {
  const s = String(name || "").trim();
  if (!s || s === "—") return "there";
  const stripped = s.replace(/,?\s+(l\.?l\.?c|l\.?l\.?p|inc|corp(?:oration)?|co|company|ltd|limited)\.?\s*$/i, "").trim();
  return stripped || s;
}
function _chaseGreeting(name) {
  const clean = _supplierGreetingName(name);
  return clean === "there" ? "Hi there," : `Hi ${clean} team,`;
}

// Per-line bullet block — one shape, two phrasings depending on
// whether the line is literally overdue (daysPastDue > 0) or a
// pull-in request (covering PO is still future). All four drafters
// normalize their source data into this input shape so the wording
// lives in one place.
function _chaseBulletForLine({ pn, desc, openQty, expectedDate, daysPastDue, wantByDate }) {
  const isOverdue = daysPastDue != null && daysPastDue > 0;
  const partLine = `  • Part ${pn}${desc ? ` — ${desc}` : ""}`;
  const qtyLine  = `    Qty open: ${fmtNum(openQty)}`;
  const dateLine = isOverdue
    ? `    Originally expected: ${_fmtDateForEmail(expectedDate)} (${daysPastDue} days overdue)`
    : (wantByDate
        ? `    Currently expected: ${_fmtDateForEmail(expectedDate)} — needed by ${_fmtDateForEmail(wantByDate)}`
        : `    Currently expected: ${_fmtDateForEmail(expectedDate)}`);
  return [partLine, qtyLine, dateLine].join("\n");
}
function _chasePOBlock(poNum, lines) {
  return `PO ${poNum}\n${lines.map(_chaseBulletForLine).join("\n")}`;
}
function _assembleChaseEmail({ supplier, multi, poBlocks }) {
  return [
    _chaseGreeting(supplier),
    "",
    _chaseIntro(multi),
    "",
    poBlocks.join("\n\n"),
    "",
    CHASE_ASK,
    "",
    CHASE_CLOSE,
  ].join("\n");
}
function _chaseSubjectSingleOverdue(poNum, pn, days) {
  return `Action needed — PO ${poNum} overdue (Part ${pn}, ${days} days)`;
}
function _chaseSubjectSinglePullIn(poNum, pn) {
  return `Action needed — PO ${poNum} delivery pull-in requested (Part ${pn})`;
}
function _chaseSubjectBundle(lineCount, anyOverdue) {
  const today = _fmtDateForEmail(new Date());
  return anyOverdue
    ? `Action needed — ${lineCount} overdue line${lineCount === 1 ? "" : "s"} (as of ${today})`
    : `Action needed — ${lineCount} line${lineCount === 1 ? "" : "s"} needing attention (as of ${today})`;
}

// ── Follow-Ups drafters ─────────────────────────────────────────
function draftFollowupEmailRow(idx) {
  const fu = (window._FOLLOWUPS || [])[idx];
  if (!fu) { showToast("Follow-up not found — refresh the page", "warn"); return; }
  const line = {
    pn: fu.pn,
    desc: fu.desc || "",
    openQty: fu.openQty,
    expectedDate: fu.expRaw,
    daysPastDue: fu.daysPastDue,
    wantByDate: null,
  };
  const subject = _chaseSubjectSingleOverdue(fu.po.num, fu.pn, fu.daysPastDue);
  const body = _assembleChaseEmail({
    supplier: fu.supplier,
    multi: false,
    poBlocks: [_chasePOBlock(fu.po.num, [line])],
  });
  _openMailDraft(subject, body);
}

function draftFollowupEmailSupplier(gidx) {
  const g = (window._FOLLOWUP_GROUPS || [])[gidx];
  if (!g || !g.lines.length) { showToast("Follow-up group not found — refresh the page", "warn"); return; }
  // Skip lines already handled — unified predicate: any active mark
  // (new-canonical handled, legacy sent, legacy chased) for this
  // (pn, po.id) counts. A supplier is never asked twice about the
  // same PO line, regardless of which tab made the mark.
  const pendingLines = g.lines.filter(fu => !isPartPoHandled(fu.pn, fu.po.id));
  if (!pendingLines.length) {
    showToast("Every line for this supplier is already chased or sent", "warn");
    return;
  }
  // Group by PO within this supplier so a supplier with multiple
  // late lines on one PO sees them clustered under that PO, not
  // scattered as top-level bullets.
  const byPo = new Map();
  for (const fu of pendingLines) {
    if (!byPo.has(fu.po.num)) byPo.set(fu.po.num, []);
    byPo.get(fu.po.num).push({
      pn: fu.pn,
      desc: fu.desc || "",
      openQty: fu.openQty,
      expectedDate: fu.expRaw,
      daysPastDue: fu.daysPastDue,
      wantByDate: null,
    });
  }
  const poBlocks = [...byPo.entries()].map(([poNum, lines]) => _chasePOBlock(poNum, lines));
  const subject = _chaseSubjectBundle(pendingLines.length, true);   // Follow-Ups: always literally overdue
  const body = _assembleChaseEmail({
    supplier: g.supplier,
    multi: pendingLines.length > 1,
    poBlocks,
  });
  _openMailDraft(subject, body);
}

// ── Expedite helpers (Coverage Gaps only) ───────────────────────
// The Coverage Gaps expedite email splits from the Follow-Ups chase
// template in two places: (1) an added "if we don't receive this by
// <need-by>" line naming the stockout deadline (runout − cushion),
// and (2) a non-overdue variant that never says "overdue" for rows
// whose covering PO is still future (pull-in case). Greeting rule,
// ask, and close are shared with chase — reference the same consts /
// helpers so any future rewording of shared voice stays in one place.

// Named cushion so the "safety margin" is tunable in one line.
const STOCKOUT_CUSHION_DAYS = 3;

// Row-level overdue predicate — matches the "PO Nd OVERDUE" pill
// which fires iff g.overdueRisk exists (see renderCoverageGaps).
// The pill and the email MUST agree so a supplier never receives a
// mail claiming a PO is overdue when the UI shows no overdue tag.
function _isOverdueGap(g) { return !!g.overdueRisk; }

// Runout date — the OUT ON column source: normal gapStart when set,
// else overdueRisk.runoutDate. Matches effOutOnDate in the row render.
function _runoutDate(g) {
  return g.gapStart || (g.overdueRisk && g.overdueRisk.runoutDate) || null;
}

// Need-by = runoutDate − STOCKOUT_CUSHION_DAYS. Calendar days,
// preserved as a local Date so downstream _fmtDateForEmail's
// month-day-year formatting reads the same in every timezone.
function _needByDate(g) {
  const runout = _runoutDate(g);
  if (!runout) return null;
  const d = new Date(runout.getTime());
  d.setDate(d.getDate() - STOCKOUT_CUSHION_DAYS);
  return d;
}

// Past-date guard for the stockout line. Never print a past need-by:
// if the calculated date sits at TODAY or earlier the email would
// name a date the supplier can't hit, so say "immediately" instead.
// Two indent columns match the surrounding bullet.
function _needByLine(needBy) {
  if (!needBy || needBy.getTime() <= TODAY.getTime()) {
    return "    If we don't receive this immediately we will be out of stock.";
  }
  return `    If we don't receive this by ${_fmtDateForEmail(needBy)} we will be out of stock.`;
}

// Intros — three variants driven by the mix of overdue vs pull-in
// rows in the outgoing email. Bundle emails that carry BOTH kinds
// use the neutral intro; each block's date line then carries its
// own "Originally expected" / "Currently scheduled" status word.
const EXPEDITE_INTRO_OVERDUE_SINGLE = "This is an automated message. Our system flagged the line below as overdue, and we're following up — a short, quick reply would be great.";
const EXPEDITE_INTRO_OVERDUE_MULTI  = "This is an automated message. Our system flagged the lines below as overdue, and we're following up — a short, quick reply would be great.";
const EXPEDITE_INTRO_PULLIN_SINGLE  = "This is an automated message. Our system flagged the line below — we'll run out before your scheduled date, and we're following up — a short, quick reply would be great.";
const EXPEDITE_INTRO_PULLIN_MULTI   = "This is an automated message. Our system flagged the lines below — we'll run out before your scheduled dates, and we're following up — a short, quick reply would be great.";
const EXPEDITE_INTRO_MIXED          = "This is an automated message. Our system flagged the lines below and we're following up — a short, quick reply would be great.";
function _expediteIntro({ multi, anyOverdue, anyPullIn }) {
  if (anyOverdue && anyPullIn) return EXPEDITE_INTRO_MIXED;
  if (anyOverdue) return multi ? EXPEDITE_INTRO_OVERDUE_MULTI : EXPEDITE_INTRO_OVERDUE_SINGLE;
  return multi ? EXPEDITE_INTRO_PULLIN_MULTI : EXPEDITE_INTRO_PULLIN_SINGLE;
}

// Per-line bullet: 4-line block. Overdue rows say "Originally
// expected: <date> (<D> days overdue)"; non-overdue rows say
// "Currently scheduled: <date>" and MUST NOT say "overdue" per the
// row-level truth check (isOverdue is derived from g.overdueRisk, not
// from any per-line daysPastDue heuristic).
function _expediteBulletForLine({ pn, desc, openQty, expectedDate, daysPastDue, isOverdue, needByDate }) {
  const partLine = `  • Part ${pn}${desc ? ` — ${desc}` : ""}`;
  const qtyLine  = `    Qty open: ${fmtNum(openQty)}`;
  const dateLine = isOverdue
    ? `    Originally expected: ${_fmtDateForEmail(expectedDate)} (${daysPastDue} days overdue)`
    : `    Currently scheduled: ${_fmtDateForEmail(expectedDate)}`;
  const nbLine   = _needByLine(needByDate);
  return [partLine, qtyLine, dateLine, nbLine].join("\n");
}

function _expeditePOBlock(poNum, lines) {
  return `PO ${poNum}\n${lines.map(_expediteBulletForLine).join("\n")}`;
}

// Subject — single-row overdue matches the user's template verbatim.
// Non-overdue single substitutes "at risk" for "overdue" so the
// no-lie rule holds. Bundle uses a line-count summary and the
// earliest need-by across the supplier's rows.
function _needByForSubject(needBy) {
  if (!needBy || needBy.getTime() <= TODAY.getTime()) return "ASAP";
  return _fmtDateForEmail(needBy);
}
function _expediteSubjectSingleOverdue(poNum, needBy, pn) {
  return `Action needed — PO ${poNum} overdue, needed by ${_needByForSubject(needBy)} (Part ${pn})`;
}
function _expediteSubjectSinglePullIn(poNum, needBy, pn) {
  return `Action needed — PO ${poNum} at risk, needed by ${_needByForSubject(needBy)} (Part ${pn})`;
}
function _expediteSubjectBundle(lineCount, anyOverdue, anyPullIn, earliestNeedBy) {
  const today = _fmtDateForEmail(new Date());
  const nb = _needByForSubject(earliestNeedBy);
  const plural = lineCount === 1 ? "" : "s";
  // Mixed rows must not label the whole email "overdue" — some lines
  // aren't. Fall back to a neutral phrase in that case so the subject
  // never lies about lines the supplier hasn't missed yet.
  const label = (anyOverdue && !anyPullIn) ? `overdue line${plural}`
              : (anyPullIn && !anyOverdue) ? `line${plural} at risk`
              : `line${plural} needing attention`;
  return `Action needed — ${lineCount} ${label}, deliver by ${nb} (as of ${today})`;
}

// Full assembly — reuses greeting rule, ask, and close from chase.
function _assembleExpediteEmail({ supplier, intro, poBlocks }) {
  return [
    _chaseGreeting(supplier),
    "",
    intro,
    "",
    poBlocks.join("\n\n"),
    "",
    CHASE_ASK,
    "",
    CHASE_CLOSE,
  ].join("\n");
}

// ── Coverage Gaps drafters ──────────────────────────────────────
// Build normalized expedite lines from one gap. Overdue rows walk
// overdueLines (literally overdue POs); non-overdue rows walk
// coveringPOs (future-expected, delivery needs pull-in). Each line
// carries the row-level isOverdue flag and the shared needByDate so
// the bullet builder has everything it needs.
function _coverageGapExpediteLines(g) {
  const lines = [];
  const isOverdue = _isOverdueGap(g);
  const needByDate = _needByDate(g);
  const overdueLines = (g.overdueRisk && g.overdueRisk.overdueLines) || [];
  if (isOverdue && overdueLines.length) {
    for (const ol of overdueLines) {
      const exp = ol.expected
        ? (typeof parseDateLocal === "function" ? parseDateLocal(ol.expected) : new Date(ol.expected))
        : null;
      const days = (exp && !isNaN(exp.getTime()))
        ? Math.floor((TODAY.getTime() - exp.getTime()) / DAY_MS)
        : 0;
      lines.push({
        poNum: ol.po || "",
        pn: g.part.pn,
        desc: g.part.desc || "",
        openQty: ol.qty || 0,
        expectedDate: exp || ol.expected,
        daysPastDue: days,
        isOverdue: true,
        needByDate,
      });
    }
  } else {
    for (const c of (g.coveringPOs || [])) {
      lines.push({
        poNum: c.poNum || "",
        pn: g.part.pn,
        desc: g.part.desc || "",
        openQty: c.qty || 0,
        expectedDate: c.expectedDate,
        daysPastDue: 0,
        isOverdue: false,
        needByDate,
      });
    }
  }
  return lines;
}

function draftCoverageExpediteRow(idx) {
  const g = (window._COVERAGE_GAPS || [])[idx];
  if (!g) { showToast("Coverage gap not found — refresh the page", "warn"); return; }
  const expLines = _coverageGapExpediteLines(g);
  if (!expLines.length) {
    showToast("No PO on this row to reference — nothing to draft", "warn");
    return;
  }
  // Group by PO — a row can carry multiple covering/overdue POs, and
  // grouping keeps each PO's lines clustered under its own header.
  const byPo = new Map();
  for (const l of expLines) {
    if (!byPo.has(l.poNum)) byPo.set(l.poNum, []);
    byPo.get(l.poNum).push(l);
  }
  const poBlocks = [...byPo.entries()].map(([poNum, lines]) => _expeditePOBlock(poNum, lines));
  // Row-level overdue truth comes from g.overdueRisk (matches the pill)
  // and is byte-identical across every line of the row. anyPullIn is
  // false for a single-row draft because a row is uniformly overdue or
  // uniformly pull-in — the mixed intro is bundle-only.
  const anyOverdue = _isOverdueGap(g);
  const anyPullIn  = !anyOverdue;
  const firstPo    = expLines[0].poNum;
  const needBy     = expLines[0].needByDate;
  const subject = anyOverdue
    ? _expediteSubjectSingleOverdue(firstPo, needBy, g.part.pn)
    : _expediteSubjectSinglePullIn(firstPo, needBy, g.part.pn);
  const intro = _expediteIntro({ multi: expLines.length > 1, anyOverdue, anyPullIn });
  const body = _assembleExpediteEmail({
    supplier: g.primarySupplier || "",
    intro,
    poBlocks,
  });
  _openMailDraft(subject, body);
}

// Section-level "Draft all expedites": one email per supplier
// covering every NOT-YET-SENT + NOT-HANDLED-ELSEWHERE exposed line
// they own. Per-supplier fan-out is critical — bundling parts from
// different suppliers into one email is never correct.
function draftCoverageExpediteAll() {
  const gaps = (window._COVERAGE_GAPS || []);
  if (!gaps.length) { showToast("No coverage gaps to draft", "warn"); return; }
  // Under the unified handled-mark model, a CG row is considered
  // "handled" (skip in bulk draft) iff EVERY covering PO carries an
  // active mark — same predicate the checkbox uses for its checked
  // state. Partial rows (indeterminate box) still get drafted so the
  // remaining POs are chased. `_st` was precomputed by the render.
  const rowHandled = (g) => (g._st ? g._st.all : _cgHandledState(g).all);
  const pending = gaps.filter(g => !rowHandled(g));
  if (!pending.length) {
    showToast("All at-risk parts already followed up this session", "warn");
    return;
  }
  // Group by primarySupplier — ONE email per supplier, always.
  // Cross-supplier bundling would send factually wrong content
  // (a supplier reading about parts they don't own).
  const bySupplier = new Map();
  for (const g of pending) {
    const key = g.primarySupplier || "—";
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(g);
  }
  let opened = 0;
  for (const [supplier, list] of bySupplier.entries()) {
    // Flatten every gap for this supplier into expedite lines, then
    // group by PO within THIS supplier's email so the same email
    // never spans multiple suppliers but does cluster multiple lines
    // under a shared PO header when relevant. Each line carries its
    // own row-derived isOverdue + needByDate so the mixed-intro path
    // and per-block status wording drop out of the data.
    const allExpLines = list.flatMap(_coverageGapExpediteLines);
    if (!allExpLines.length) continue;
    const byPo = new Map();
    for (const l of allExpLines) {
      if (!byPo.has(l.poNum)) byPo.set(l.poNum, []);
      byPo.get(l.poNum).push(l);
    }
    const poBlocks = [...byPo.entries()].map(([poNum, lines]) => _expeditePOBlock(poNum, lines));
    const anyOverdue = allExpLines.some(l => l.isOverdue);
    const anyPullIn  = allExpLines.some(l => !l.isOverdue);
    // Earliest need-by across the supplier's lines drives the
    // subject. Any missing needByDate collapses to ASAP so the
    // subject never names a stockout deadline we can't back up.
    let earliestNeedBy = null;
    for (const l of allExpLines) {
      if (!l.needByDate) { earliestNeedBy = null; break; }
      if (!earliestNeedBy || l.needByDate < earliestNeedBy) earliestNeedBy = l.needByDate;
    }
    const subject = _expediteSubjectBundle(allExpLines.length, anyOverdue, anyPullIn, earliestNeedBy);
    const intro = _expediteIntro({ multi: allExpLines.length > 1, anyOverdue, anyPullIn });
    const body = _assembleExpediteEmail({ supplier, intro, poBlocks });
    _openMailDraft(subject, body);
    opened++;
  }
  showToast(`Drafted ${opened} email${opened === 1 ? "" : "s"} (one per supplier)`, "ok", "Coverage expedites");
}

function _openMailDraft(subject, body) {
  let opened = false;
  try {
    const a = document.createElement("a");
    a.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    opened = true;
  } catch (e) { /* fall through to clipboard / modal */ }

  const clip = `Subject: ${subject}\n\n${body}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(clip).then(
      () => showToast(`Draft copied to clipboard${opened ? " · mail app opened" : ""}`, "ok", "Draft email"),
      () => { if (!opened) _followupCopyModal(subject, body); else showToast("Mail app opened", "ok", "Draft email"); }
    );
  } else if (!opened) {
    _followupCopyModal(subject, body);
  } else {
    showToast("Mail app opened", "ok", "Draft email");
  }
}

function _followupCopyModal(subject, body) {
  openModal(`
    <div class="modal-head">
      <div style="font-size:13px;font-weight:600">Draft email</div>
      <div class="muted tiny mt-xs">No mail handler / clipboard access — copy the text below into your email client.</div>
    </div>
    <div class="modal-body">
      <div class="field"><label>Subject</label>
        <input class="input" readonly value="${esc(subject)}" onclick="this.select()">
      </div>
      <div class="field" style="margin-top:10px"><label>Body</label>
        <textarea class="textarea" readonly style="min-height:220px" onclick="this.select()">${esc(body)}</textarea>
      </div>
    </div>
    <div class="modal-foot"><button class="btn" data-close>Close</button></div>
  `);
}

/* ============================================================
   COVERAGE GAPS PAGE — was formerly a banner+table on Supplier
   Follow-Ups. Split into its own route so late-lines chase work and
   at-risk-parts monitoring don't crowd one screen. computeCoverageGap
   / computeCoverageGaps / _COVERAGE_GAP_ITEM_TYPES stay defined above
   as shared engine bits; only this page's render moved. All row
   handlers (draftCoverageExpediteRow, draftCoverageExpediteAll,
   toggleCoverageGapSent, _chasePoNums,
   _coverageGapLineDescription) also stay shared — they're keyed by
   part PN or by _idx into window._COVERAGE_GAPS, which this route
   populates the same way the old Follow-Ups render did.
   ============================================================ */
function coverageGapCount() {
  try { return computeCoverageGaps().length; } catch (e) { return 0; }
}

function renderCoverageGaps() {
  const allCoverageGaps = computeCoverageGaps();
  // Attach unified handled-state per gap ONCE. Used by header count,
  // hide-sent filter, row-render checkbox state, and PN-strikethrough /
  // row-dim styling. Reads window.followMarks via isPartPoHandled —
  // legacy sent/chased marks are still recognized so anything already
  // checked stays checked on load.
  for (const g of allCoverageGaps) g._st = _cgHandledState(g);
  // "Sent this session" = fully-handled rows (every covering PO marked).
  // Partial state is NOT counted here — the row is still exposed and
  // needs the remaining POs chased.
  const sentCount = allCoverageGaps.reduce((n, g) => n + (g._st.all ? 1 : 0), 0);
  const overdueRiskCount = allCoverageGaps.reduce((n, g) => n + (g.overdueRisk ? 1 : 0), 0);
  const coverageGaps = FOLLOWUP_STATE.hideSentGaps
    ? allCoverageGaps.filter(g => !g._st.all)
    : allCoverageGaps;
  // _idx assigned on the post-filter array so per-row Draft buttons still
  // resolve when hide-sent is on. Mirrors the earlier inline behavior.
  coverageGaps.forEach((g, i) => { g._idx = i; });
  window._COVERAGE_GAPS = coverageGaps;

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Coverage Gaps</div>
          <div class="page-sub mono">${allCoverageGaps.length} AT RISK${overdueRiskCount ? ` · ${overdueRiskCount} WITH OVERDUE PO` : ""}${sentCount ? ` · ${sentCount} SENT THIS SESSION` : ""}</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="navigate('followups')">Follow-Ups →</button>
        </div>
      </div>

      ${allCoverageGaps.length === 0 ? `
      <div class="panel">
        <div class="panel-body">
          <div class="empty empty-lg">
            <div class="empty-title">All parts covered</div>
            <div class="empty-msg">No base-BOM or option parts stock out before their covering PO arrives.</div>
          </div>
        </div>
      </div>
      ` : `
      <div class="panel" style="border-color: var(--crit-bd); background: linear-gradient(180deg, var(--crit-soft) 0%, var(--bg-1) 80%);">
        <div class="panel-head" style="border-bottom-color: var(--crit-bd);">
          <div class="panel-title" style="color: var(--crit);">⚠ Coverage Gaps</div>
          <div class="panel-sub">${allCoverageGaps.length} part${allCoverageGaps.length === 1 ? '' : 's'} stocked out before resupply arrives${overdueRiskCount ? ` · ${overdueRiskCount} with overdue PO` : ''} · Want-by = runout − 18 days${sentCount ? ` · ${sentCount} sent this session` : ''}</div>
          <div class="panel-actions" style="display:flex; gap:8px; align-items:center">
            <label class="row" style="gap:6px; align-items:center; cursor:pointer" title="Hide rows marked sent this session">
              <input type="checkbox" class="chk" ${FOLLOWUP_STATE.hideSentGaps ? "checked" : ""} onchange="FOLLOWUP_STATE.hideSentGaps = this.checked; refresh()">
              <span class="muted tiny">Hide sent</span>
            </label>
            <button class="btn sm" onclick="draftCoverageExpediteAll()" title="One email per supplier bundling every NOT-YET-SENT exposed line they own">✉ Draft all expedites</button>
          </div>
        </div>
        <div class="panel-body flush">
          ${coverageGaps.length === 0 ? `
            <div class="empty" style="padding:32px 16px">
              <div class="empty-msg">Every coverage gap is marked sent. Untick “Hide sent” to see them.</div>
            </div>
          ` : `
          <div class="tbl-wrap" style="overflow-x:hidden"><table class="tbl" style="table-layout:fixed">
            <thead><tr>
              <th>Part</th>
              <th class="right" style="width:70px">On Hand</th>
              <th class="right" style="width:60px">Daily</th>
              <th style="width:90px">Out On</th>
              <th>Covering PO</th>
              <th style="width:90px">Want By</th>
              <th class="right" style="width:55px">Gap</th>
              <th class="right" style="width:65px">Short</th>
              <th style="width:138px">Actions</th>
              <th class="right" style="width:118px">Sent</th>
            </tr></thead>
            <tbody>
              ${coverageGaps.map(g => {
                const p = g.part;
                const sentKey = _coverageGapKey(g);
                // Unified handled state per row (precomputed in the page
                // header). Fully-handled = every covering PO carries an
                // active mark; partial = at least one but not all.
                const st = g._st;
                const earliestDate = _earliestActiveDate(st.marks);
                const sentOn = earliestDate && typeof fmtDate === "function"
                  ? fmtDate(earliestDate)
                  : "";
                const sentRowStyle = st.all ? "opacity:0.45" : "";
                const sentPnStyle = st.all ? "text-decoration:line-through" : "";
                // Overdue-risk fallbacks (see computeCoverageGap): when
                // the normal-gap projection didn't dip (because the late
                // PO was clamped to today) but ignoring the overdue line
                // shows a runout, g.overdueRisk carries the runoutDate,
                // shortfall, and overdueLines. In that case the Out On /
                // Short columns are populated from overdueRisk, and the
                // Covering PO cell lists the overdue lines instead of
                // rendering "No PO".
                const hasCoveringPO = g.coveringPOs.length > 0;
                const risk = g.overdueRisk || null;
                const overdueLines = risk ? (risk.overdueLines || []) : [];
                const hasOverdueLines = overdueLines.length > 0;
                // OVERDUE pill sits on its own line under the PO list so
                // multiple PO refs can stack cleanly in a narrow column.
                // Retains the .pill.crit style used elsewhere for the
                // "Nd late" pill on the Follow-Ups page.
                const overdueTagBlock = risk
                  ? `<div style="margin-top:2px"><span class="pill crit" style="font-weight:700" title="Covering PO past due — exposure surfaces once the late PO is ignored">PO ${fmtNum(risk.daysPastDue)}d overdue</span></div>`
                  : "";
                const _findPoId = (poNum) => {
                  const rec = poNum ? (DB.pos || []).find(x => x && x.num === poNum) : null;
                  return rec ? rec.id : null;
                };
                // Each PO reference renders as its own <div> block so the
                // cell stacks vertically instead of running across a wide
                // horizontal line. Fits a narrow COVERING PO column
                // without forcing horizontal scroll.
                const overdueLinesHtml = overdueLines.map(ol => {
                  const expDisp = ol.expected
                    ? (typeof parseDateLocal === "function"
                        ? fmtDate(parseDateLocal(ol.expected))
                        : fmtDate(new Date(ol.expected)))
                    : "?";
                  const poId = _findPoId(ol.po);
                  const poCell = poId
                    ? `<a href="javascript:void(0)" onclick="event.stopPropagation(); openPODetail('${esc(poId)}')" class="mono" style="color: var(--accent); text-decoration: none">${esc(ol.po || '?')}</a>`
                    : `<span class="mono">${esc(ol.po || '?')}</span>`;
                  // ROLLUP ANNOTATION — when the overdue line's pn differs
                  // from the row's part.pn, the PO physically sits on a
                  // (typically pre-launch) chain successor and has been
                  // rolled up to the demand-carrying predecessor. Show
                  // "xQTY (on <successorPn>)" so the buyer knows which
                  // member owns the physical PO AND can distinguish
                  // multiple lines that share the same PO number (e.g.
                  // a sample + a production qty on the same POC0007283).
                  // ASCII only.
                  const onPnBadge = (ol.pn && g.part && ol.pn !== g.part.pn)
                    ? ` <span class="dim tiny">x${fmtNum(ol.qty || 0)} (on ${esc(ol.pn)})</span>`
                    : "";
                  return `<div>${poCell}${onPnBadge} <span class="dim tiny mono">· ${expDisp}</span></div>`;
                }).join("");
                const coveredCell = hasCoveringPO
                  ? g.coveringPOs.map(c =>
                      `<div><a href="javascript:void(0)" onclick="event.stopPropagation(); openPODetail('${esc(c.poId)}')" class="mono" style="color: var(--accent); text-decoration: none">${esc(c.poNum)}</a> <span class="dim tiny mono">· ${fmtDate(g.gapEnd)}</span></div>`
                    ).join("") + overdueTagBlock
                  : hasOverdueLines
                    ? overdueLinesHtml + overdueTagBlock
                    : `<span class="pill warn" title="Exposed with nothing on order — this is an order-needed case, not a chase">No PO</span>`;
                const effOutOnDate = g.gapStart || (risk && risk.runoutDate) || null;
                const effWantBy = g.targetArrivalDate || TODAY;
                const effGapDays = g.gapDays;
                const effShortfall = g.shortfall != null
                  ? g.shortfall
                  : (risk ? risk.shortfall : 0);
                const outOnLabel = effOutOnDate && effOutOnDate.getTime() <= TODAY.getTime()
                  ? `<span class="text-crit bold">Today</span>`
                  : effOutOnDate
                    ? `<span class="mono">${fmtDate(effOutOnDate)}</span>`
                    : `<span class="dim">—</span>`;
                const wantByPast = effWantBy.getTime() <= TODAY.getTime();
                const wantByCell = wantByPast
                  ? `<span class="text-crit bold mono" title="No cushion left — request ASAP">${fmtDate(effWantBy)}</span>`
                  : `<span class="text-accent mono">${fmtDate(effWantBy)}</span>`;
                const firstOverduePoId = hasOverdueLines ? _findPoId(overdueLines[0].po) : null;
                const firstPoId = hasCoveringPO ? g.coveringPOs[0].poId : firstOverduePoId;
                const firstPoNum = hasCoveringPO
                  ? g.coveringPOs[0].poNum
                  : (hasOverdueLines ? (overdueLines[0].po || "") : "");
                const hasAnyPO = hasCoveringPO || hasOverdueLines;
                // Checkbox state derives from the row-level `st` object.
                // Three-state affordance:
                //   all handled     → checked
                //   partial handled → indeterminate (native browser dash
                //                     glyph, set via _applyIndeterminateBoxes
                //                     after render)
                //   none handled    → unchecked
                const cgBoxTitle = st.all
                  ? `Marked sent on ${esc(sentOn)} — all ${st.pairs.length} covering PO${st.pairs.length === 1 ? '' : 's'} handled (shared across users · uncheck to clear)`
                  : (st.partial
                      ? `${st.activeCount} of ${st.pairs.length} covering POs marked handled — click to mark all (shared across users)`
                      : "Mark sent (shared across users for 3 business days)");
                const cgBoxLabel = st.all
                  ? `Sent on ${esc(sentOn)}`
                  : (st.partial ? `Sent ${st.activeCount}/${st.pairs.length}` : "");
                // Draft button: label stays short; opacity dims when the
                // row is fully handled so the "already dealt with" signal
                // is visually apparent without changing the button width.
                const draftLabel = hasAnyPO ? "✉ Move up" : "✉ Order";
                const draftBtnStyle = st.all ? "opacity:0.55" : "";
                const draftTitle = hasAnyPO
                  ? (st.any
                      ? `Marked sent on ${esc(sentOn)} — click to draft again`
                      : `Draft delivery move-up email to ${esc(g.primarySupplier || "supplier")} for PO ${esc(firstPoNum)} — deliver by ${esc(fmtDate(effWantBy))}`)
                  : `Draft order/quote request to ${esc(g.primarySupplier || "supplier")} — deliver by ${esc(fmtDate(effWantBy))}`;
                return `
                  <tr class="clickable" onclick="openPartDetail('${esc(p.pn)}')" style="${sentRowStyle}">
                    <td class="pn" style="white-space:normal;word-break:break-word"><span style="${sentPnStyle}">${esc(p.pn)}</span><div class="dim tiny" style="font-family:var(--f-ui);margin-top:2px">${esc(p.desc || '')}</div></td>
                    <td class="right num ${Number(p.onHand) <= 0 ? 'text-crit bold' : ''}">${fmtNum(p.onHand)}</td>
                    <td class="right num dim">${fmtNum(p.daily, 2)}</td>
                    <td>${outOnLabel}</td>
                    <td style="white-space:normal">${coveredCell}</td>
                    <td>${wantByCell}</td>
                    <td class="right num bold text-crit">${effGapDays != null ? fmtNum(effGapDays) + 'd' : '<span class="dim">—</span>'}</td>
                    <td class="right num">${effShortfall != null ? fmtNum(effShortfall) : '<span class="dim">—</span>'}</td>
                    <td>
                      <button class="btn sm primary" style="${draftBtnStyle}" onclick="event.stopPropagation(); draftCoverageExpediteRow(${g._idx})" title="${draftTitle}">${draftLabel}</button>
                      ${firstPoId ? `<button class="btn sm" onclick="event.stopPropagation(); openPODetail('${esc(firstPoId)}')" title="Open PO ${esc(firstPoNum)}">PO</button>` : ''}
                    </td>
                    <td class="right" style="white-space:normal">
                      <label class="row" style="gap:5px; justify-content:flex-end; cursor:pointer" title="${cgBoxTitle}"
                             onclick="event.stopPropagation()">
                        <input type="checkbox" class="chk" ${st.all ? "checked" : ""} ${st.partial ? 'data-indeterminate="1"' : ''} onchange="toggleCoverageGapSent('${esc(sentKey)}')">
                        <span class="muted tiny" style="min-width:34px; text-align:left">${cgBoxLabel}</span>
                      </label>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table></div>
          `}
        </div>
      </div>
      `}
    </div>
  `;
  // The `indeterminate` state of a checkbox is a DOM-only property and
  // can't be set via HTML attribute — apply it now that the innerHTML
  // has landed. Partial-handled multi-PO rows use this native affordance
  // (dash-in-box glyph) with no new CSS.
  _applyIndeterminateBoxes();
}

registerRoute("followups", renderFollowUps);
registerRoute("coverage-gaps", renderCoverageGaps);
