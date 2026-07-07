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
function computeFollowUps() {
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

// Nav-badge count — same predicate as the page, so badge === page header.
function followUpCount() {
  try { return computeFollowUps().length; } catch (e) { return 0; }
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
function computeCoverageGap(part, lines) {
  if (!part || !part.pn) return null;
  // Allowlist: only base_bom / options qualify. Anything else (service,
  // do_not_order, blank, future types) is excluded by default.
  if (!_COVERAGE_GAP_ITEM_TYPES.has(part.itemType)) return null;
  // Defense in depth — a kit somehow tagged base_bom/options shouldn't
  // surface here either. The aggregator also filters by p.isKit; this
  // catches direct callers (e.g. a future part-drawer hint).
  if (typeof isKit === "function" && isKit(part.pn)) return null;
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
          // First recovery in the ignore-overdue world (may be -1 if the
          // part never recovers without the late PO). Shortfall is measured
          // over the exposed span so it's meaningful whether or not
          // recovery happens.
          let odRecoverIdx = -1;
          for (let i = odZeroIdx + 1; i < odSeries.length; i++) {
            if (odSeries[i].oh > 0) { odRecoverIdx = i; break; }
          }
          const end = odRecoverIdx === -1 ? odSeries.length : odRecoverIdx;
          let odShortfall = 0;
          for (let i = odZeroIdx; i < end; i++) {
            const deficit = -odSeries[i].oh;
            if (deficit > odShortfall) odShortfall = deficit;
          }
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
function computeCoverageGaps() {
  const stats = (typeof partsWithStatus === "function") ? partsWithStatus() : [];
  const out = [];
  let transitionSuppressedCount = 0;
  const transitionSuppressedSample = [];
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

// Toggle helpers — optimistic local update, then persist; on failure
// revert. NO writes happen inside the realtime handler (see
// 30-supabase.js), so the toggle path here is the only writer.
function toggleFollowupChased(key) {
  // key = `${po.id}::${lineIdOrPn}` from _followupKey. Look up the
  // follow-up in the render stash for poId / pn enrichment.
  const fu = (window._FOLLOWUPS || []).find(f => _followupKey(f) === key);
  if (!fu) { showToast("Follow-up not found — refresh the page", "warn"); return; }
  const rowId = `chased::${key}`;
  const existing = window.followMarks.get(rowId);
  if (existing) {
    // Unmark — optimistic delete + persist.
    window.followMarks.delete(rowId);
    if (typeof deleteFollowMarkCloud === "function") {
      deleteFollowMarkCloud(rowId).then(r => {
        if (!r.ok) {
          window.followMarks.set(rowId, existing);
          showToast("Failed to sync unmark — toggle again to retry", "warn");
          refresh();
        }
      });
    }
  } else {
    const data = {
      type: "chased",
      poId: fu.po.id,
      lineId: (fu.ln && fu.ln.id) || null,
      pn: fu.pn,
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
  refresh();
}

function toggleCoverageGapSent(key) {
  // key = part PN from _coverageGapKey. Look up the coverage gap in
  // the render stash for poId enrichment.
  const g = (window._COVERAGE_GAPS || []).find(x => _coverageGapKey(x) === key);
  if (!g) { showToast("Coverage gap not found — refresh the page", "warn"); return; }
  const rowId = _sentRowId(g);
  const existing = window.followMarks.get(rowId);
  if (existing) {
    window.followMarks.delete(rowId);
    if (typeof deleteFollowMarkCloud === "function") {
      deleteFollowMarkCloud(rowId).then(r => {
        if (!r.ok) {
          window.followMarks.set(rowId, existing);
          showToast("Failed to sync unmark — toggle again to retry", "warn");
          refresh();
        }
      });
    }
  } else {
    // Union all covering-PO poIds and overdue-line poIds so any
    // Follow-Ups "chased" mark on the same part+PO is recognized as
    // already-handled here (and vice versa). See _markPoIds /
    // isPartPoHandled below. rowId scheme is unchanged for backward
    // compat — older sent marks (no coveredPoIds) still work via the
    // poId-fallback in _markPoIds.
    const overdueLineIds = ((g.overdueRisk && g.overdueRisk.overdueLines) || [])
      .map(ol => {
        const rec = ol.po ? (DB.pos || []).find(x => x && x.num === ol.po) : null;
        return rec ? rec.id : null;
      })
      .filter(Boolean);
    const coveredPoIds = Array.from(new Set([
      ...g.coveringPOs.map(c => c.poId).filter(Boolean),
      ...overdueLineIds,
    ]));
    const data = {
      type: "sent",
      poId: (g.coveringPOs[0] && g.coveringPOs[0].poId) || null,
      lineId: null,
      pn: g.part.pn,
      coveredPoIds,
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
  refresh();
}

window.isMarkActive = isMarkActive;

/* ============================================================
   PAGE
   ============================================================ */
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
  // Build the chased marks Map from window.followMarks once per render.
  // Active = within 3 business days (isMarkActive); expired entries
  // fall through and the row renders normal. chasedByKey keys on
  // `${po.id}::${lineId||pn}` — the follow-up line unit. Sent marks
  // (part-level coverage gaps) are consumed on the Coverage Gaps page
  // and not needed here.
  const chasedByKey = new Map();   // `${po.id}::${lineId||pn}` → markedAt (ISO)
  for (const [, mark] of (window.followMarks || new Map()).entries()) {
    if (!mark || !isMarkActive(mark)) continue;
    if (mark.type === "chased" && mark.poId) {
      chasedByKey.set(`${mark.poId}::${mark.lineId || mark.pn}`, mark.markedAt);
    }
  }

  const all = computeFollowUps();
  const total = all.length;                 // header + badge count (full predicate)
  const chasedCount = all.reduce((n, fu) => n + (chasedByKey.has(_followupKey(fu)) ? 1 : 0), 0);

  // Working set: optional hide-chased, then supplier search.
  let working = all;
  if (FOLLOWUP_STATE.hideChased) working = working.filter(fu => !chasedByKey.has(_followupKey(fu)));
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
          <div class="page-sub mono">${total} LATE LINE${total === 1 ? "" : "S"} · OVERDUE &gt; ${FOLLOWUP_DAYS}D${chasedCount ? ` · ${chasedCount} CHASED THIS SESSION` : ""}</div>
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
            <div class="empty" style="padding:48px 16px">
              <div class="empty-title">${total === 0 ? "All caught up" : "Nothing to show"}</div>
              <div class="empty-msg">${total === 0
                ? "No overdue POs to follow up on."
                : (FOLLOWUP_STATE.hideChased && chasedCount ? "Every late line is marked chased. Untick “Hide chased” to see them." : "No suppliers match the current filter.")}</div>
            </div>
          ` : groups.map(g => _followupGroupHtml(g, chasedByKey)).join("")}
        </div>
      </div>
    </div>`;
}

// `chased` is the chasedByKey Map<key, markedAt-ISO> already filtered
// to active marks by the caller.
function _followupGroupHtml(g, chased) {
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
            const chasedAt = chased.get(key) || null;
            const isChased = !!chasedAt;
            const chasedOn = chasedAt && typeof fmtDate === "function"
              ? fmtDate(new Date(chasedAt))
              : "";
            // Cross-page correlation: if this line isn't own-chased but
            // a Coverage-Gaps "sent" mark for the same PN covers this
            // exact PO, another user (or the current user on CG) already
            // sent an expedite. Only "sent" marks count here — a chased
            // mark on a different line for the same PN is unrelated.
            let sentMark = null;
            if (!isChased) {
              const m = partPoHandledBy(fu.pn, fu.po.id);
              if (m && m.type === "sent") sentMark = m;
            }
            const sentOnCG = sentMark && typeof fmtDate === "function"
              ? fmtDate(new Date(sentMark.markedAt))
              : "";
            const lc = fu.partStatus === "critical" ? "crit" : "warn";
            return `
            <tr style="${isChased ? "opacity:0.45" : ""}">
              <td class="pn clickable" onclick="openPODetail('${esc(fu.po.id)}')">${esc(fu.po.num)}</td>
              <td>
                <span class="pn" style="${isChased ? "text-decoration:line-through" : ""}">${esc(fu.pn)}</span>
                ${fu.desc ? `<div class="dim tiny">${esc(fu.desc)}</div>` : ""}
              </td>
              <td class="right num">${fmtNum(fu.openQty)}</td>
              <td class="num dim">${fmtDate(fu.expRaw)}</td>
              <td class="right"><span class="pill ${lc}" style="font-weight:700">${fu.daysPastDue}d late</span></td>
              <td>
                <div style="display:flex; gap:6px; flex-wrap:wrap">
                  <button class="btn sm" onclick="draftFollowupEmailRow(${fu._idx})" title="${sentMark ? `A Coverage Gaps expedite for this part+PO was sent on ${esc(sentOnCG)} — click to draft anyway` : "Draft a chase email for this late line"}">✉ Draft email${sentMark ? " (already sent)" : ""}</button>
                  <button class="btn sm" onclick="openPODetail('${esc(fu.po.id)}')">Open PO</button>
                </div>
              </td>
              <td class="right">
                <label class="row" style="gap:5px; justify-content:flex-end; cursor:pointer" title="${isChased ? `Marked chased on ${chasedOn} (shared across users · uncheck to clear)` : "Mark chased (shared across users for 3 business days)"}">
                  <input type="checkbox" class="chk" ${isChased ? "checked" : ""} onchange="toggleFollowupChased('${esc(key)}')">
                  <span class="muted tiny" style="min-width:42px; text-align:left">${isChased ? `Chased on ${esc(chasedOn)}` : ""}</span>
                </label>
                ${sentMark ? `<div class="dim tiny mono" style="margin-top:3px" title="A Coverage Gaps sent mark for this part+PO is active (shared across users)">Sent via CG · ${esc(sentOnCG)}</div>` : ""}
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table></div>
    </div>`;
}

/* ============================================================
   DRAFT CHASE EMAILS
   No email backend exists, so we build a mailto: draft (opened via a transient
   anchor so the SPA doesn't navigate) AND copy the text to the clipboard as a
   fallback. If the clipboard is unavailable, a modal shows the text to copy by
   hand. Data is read back from the window stash by the index baked into the
   button, so descriptions with quotes/commas never go through an onclick string.
   ============================================================ */
function _followupLineBlock(fu) {
  return [
    `PO ${fu.po.num}`,
    `Part: ${fu.pn}${fu.desc ? " — " + fu.desc : ""}`,
    `Qty open: ${fmtNum(fu.openQty)}`,
    `Original expected date: ${fmtDate(fu.expRaw)}`,
    `Days overdue: ${fu.daysPastDue}`,
  ].join("\n");
}

function draftFollowupEmailRow(idx) {
  const fu = (window._FOLLOWUPS || [])[idx];
  if (!fu) { showToast("Follow-up not found — refresh the page", "warn"); return; }
  const who = (fu.supplier && fu.supplier !== "—") ? fu.supplier : "there";
  const subject = `Follow-up: PO ${fu.po.num} overdue ${fu.daysPastDue} days`;
  const body =
`Hi ${who},

Following up on an overdue purchase order line:

${_followupLineBlock(fu)}

Could you confirm the current status and a revised ship/arrival date?

Thank you.`;
  _openMailDraft(subject, body);
}

function draftFollowupEmailSupplier(gidx) {
  const g = (window._FOLLOWUP_GROUPS || [])[gidx];
  if (!g || !g.lines.length) { showToast("Follow-up group not found — refresh the page", "warn"); return; }
  // Skip lines already handled — either own-chased on this screen, or
  // covered by an active Coverage Gaps "sent" mark for the same
  // part+PO. Same pattern as draftCoverageExpediteAll's dedup, mirrored
  // so a supplier isn't asked twice about the same PO line.
  const chasedRowActive = (fu) => {
    const rowId = `chased::${_followupKey(fu)}`;
    const mark = (window.followMarks || new Map()).get(rowId);
    return !!(mark && isMarkActive(mark));
  };
  const sentElsewhere = (fu) => {
    const m = partPoHandledBy(fu.pn, fu.po.id);
    return !!(m && m.type === "sent");
  };
  const pendingLines = g.lines.filter(fu => !chasedRowActive(fu) && !sentElsewhere(fu));
  if (!pendingLines.length) {
    showToast("Every line for this supplier is already chased or sent", "warn");
    return;
  }
  const who = (g.supplier && g.supplier !== "—") ? g.supplier : "there";
  const worstPending = pendingLines.reduce((m, fu) => Math.max(m, fu.daysPastDue), 0);
  const subject = `Follow-up: ${pendingLines.length} overdue PO line${pendingLines.length === 1 ? "" : "s"} — worst ${worstPending} days`;
  const lines = pendingLines.map(fu => _followupLineBlock(fu).split("\n").map((l, i) => (i === 0 ? `• ${l}` : `  ${l}`)).join("\n")).join("\n\n");
  const body =
`Hi ${who},

We have ${pendingLines.length} overdue purchase order line${pendingLines.length === 1 ? "" : "s"} we'd like to chase:

${lines}

Could you confirm current status and revised dates for each?

Thank you.`;
  _openMailDraft(subject, body);
}

/* ============================================================
   COVERAGE-GAP EMAILS — delivery-move-up draft per row, plus a
   section-level "Draft all expedites" that bundles by supplier.
   Reuses _openMailDraft (mailto: → clipboard → modal) for parity with
   the supplier follow-up drafts above.

   IMPORTANT — supplier-facing wording only. No runout date, no
   "2.5 weeks", no on-hand / daily / shortfall, no current expected.
   The email states only what the supplier needs to act on: PO# (if
   any), part PN + desc, and the requested delivery date (the want-by
   computed internally as runout − 18d). The reasoning behind that
   date is deliberately not exposed.
   ============================================================ */

// PO numbers to reference when composing a chase email: normal covering
// POs when the projection dips + recovers; else the overdue-line PO nums
// from overdueRisk (both are "a PO already on order for this part"). An
// overdue-only row has an overdue PO to chase, not a fresh order to place.
function _chasePoNums(g) {
  if (g.coveringPOs && g.coveringPOs.length) {
    return g.coveringPOs.map(c => c.poNum).filter(Boolean);
  }
  const overdueLines = g.overdueRisk && g.overdueRisk.overdueLines;
  if (overdueLines && overdueLines.length) {
    return overdueLines.map(ol => ol.po).filter(Boolean);
  }
  return [];
}

// Effective want-by for compose paths: normal target when set, else TODAY
// (overdue-only rows have targetArrivalDate === null and their asked
// delivery is "as soon as possible / right now").
function _effectiveWantBy(g) {
  return g.targetArrivalDate || TODAY;
}

// One-line supplier-facing description of an exposed part:
//   "PO <#> for <PN> (<desc>)"   when a covering PO OR overdue PO exists
//   "<PN> (<desc>)"               otherwise
// Used both standalone (per-row) and as the bullet content (bundled).
function _coverageGapLineDescription(g) {
  const p = g.part;
  const partPart = p.desc ? `${p.pn} (${p.desc})` : p.pn;
  const poNums = _chasePoNums(g);
  if (poNums.length) {
    return `PO ${poNums.join(", ")} for ${partPart}`;
  }
  return partPart;
}

function draftCoverageExpediteRow(idx) {
  const g = (window._COVERAGE_GAPS || [])[idx];
  if (!g) { showToast("Coverage gap not found — refresh the page", "warn"); return; }
  const who = (g.primarySupplier && g.primarySupplier !== "—") ? g.primarySupplier : "there";
  const wantBy = fmtDate(_effectiveWantBy(g));
  const poNums = _chasePoNums(g);
  const hasAnyPO = poNums.length > 0;
  const subject = hasAnyPO
    ? `Delivery move-up request: PO ${poNums.join(", ")} by ${wantBy}`
    : `Delivery request: ${g.part.pn} by ${wantBy}`;
  // Single short sentence covering the ask. No runout, no buffer
  // language, no internal numbers.
  const sentence = hasAnyPO
    ? `We need to move up delivery on ${_coverageGapLineDescription(g)}. Could you confirm whether you can deliver by ${wantBy}?`
    : `We'd like to order ${_coverageGapLineDescription(g)}. Could you confirm whether you can deliver by ${wantBy}?`;
  const body = `Hi ${who},\n\n${sentence}\n\nThank you.`;
  _openMailDraft(subject, body);
}

// Section-level "Draft all expedites": one email per supplier covering
// every NOT-YET-SENT exposed line they own. Sent rows are skipped
// regardless of the Hide-sent toggle state — bundling something the
// user already sent would re-spam the supplier.
function draftCoverageExpediteAll() {
  const gaps = (window._COVERAGE_GAPS || []);
  if (!gaps.length) { showToast("No coverage gaps to draft", "warn"); return; }
  // Drop already-sent rows up front — even if they're still visible
  // (Hide-sent off), the supplier was already told about those.
  // Reads window.followMarks filtered to active marks; mirrors the
  // hide-sent / sentByPn logic in renderCoverageGaps so the bundled-draft
  // skips the same rows the row checkboxes consider already sent.
  const isSentActive = (g) => {
    const rowId = _sentRowId(g);
    const mark = (window.followMarks || new Map()).get(rowId);
    return !!(mark && isMarkActive(mark));
  };
  // Also drop rows where the same (part+PO) already has an active
  // chased mark on Follow-Ups. Bulk expedite must not re-contact a
  // supplier for a part the other screen already flagged as chased.
  const _resolveOverduePoId = (poNum) => {
    const rec = poNum ? (DB.pos || []).find(x => x && x.num === poNum) : null;
    return rec ? rec.id : null;
  };
  const isHandledElsewhere = (g) => {
    const overdueLines = (g.overdueRisk && g.overdueRisk.overdueLines) || [];
    const poIds = Array.from(new Set([
      ...(g.coveringPOs || []).map(c => c.poId).filter(Boolean),
      ...overdueLines.map(ol => _resolveOverduePoId(ol.po)).filter(Boolean),
    ]));
    return poIds.some(pid => isPartPoHandled(g.part.pn, pid));
  };
  const pending = gaps.filter(g => !isSentActive(g) && !isHandledElsewhere(g));
  if (!pending.length) {
    const msg = gaps.every(g => isSentActive(g) || isHandledElsewhere(g))
      ? "All at-risk parts already followed up this session"
      : "Every visible coverage gap is already marked sent";
    showToast(msg, "warn");
    return;
  }
  // Group by primarySupplier so each vendor gets one bundled email.
  const bySupplier = new Map();
  for (const g of pending) {
    const key = g.primarySupplier || "—";
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(g);
  }
  // Soonest want-by per supplier drives the subject line. Uses the
  // effective want-by so overdue-only rows (null targetArrivalDate) are
  // pulled in at TODAY rather than throwing a null-compare.
  const earliestOf = (list) => list.reduce((m, g) => {
    const w = _effectiveWantBy(g);
    return (m === null || w < m) ? w : m;
  }, null);
  let opened = 0;
  for (const [supplier, list] of bySupplier.entries()) {
    const who = (supplier && supplier !== "—") ? supplier : "there";
    const earliest = earliestOf(list);
    const subject = `Delivery move-up request: ${list.length} line${list.length === 1 ? "" : "s"} — earliest by ${fmtDate(earliest)}`;
    const bullets = list.map(g => `• ${_coverageGapLineDescription(g)} — deliver by ${fmtDate(_effectiveWantBy(g))}`).join("\n");
    const body = `Hi ${who},\n\nWe need to move up delivery on the following:\n\n${bullets}\n\nCould you confirm what's achievable for each?\n\nThank you.`;
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
      <div class="muted tiny" style="margin-top:4px">No mail handler / clipboard access — copy the text below into your email client.</div>
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
   toggleCoverageGapSent, _chasePoNums, _effectiveWantBy,
   _coverageGapLineDescription) also stay shared — they're keyed by
   part PN or by _idx into window._COVERAGE_GAPS, which this route
   populates the same way the old Follow-Ups render did.
   ============================================================ */
function coverageGapCount() {
  try { return computeCoverageGaps().length; } catch (e) { return 0; }
}

function renderCoverageGaps() {
  // Build the sentByPn map from window.followMarks — same pattern the
  // Follow-Ups render used to use when Coverage Gaps was inline there.
  // Active = within 3 business days (isMarkActive); stale rows fall
  // through and render normal.
  const sentByPn = new Map();      // pn → markedAt (ISO)
  for (const [, mark] of (window.followMarks || new Map()).entries()) {
    if (!mark || !isMarkActive(mark)) continue;
    if (mark.type === "sent" && mark.pn) {
      sentByPn.set(String(mark.pn), mark.markedAt);
    }
  }

  const allCoverageGaps = computeCoverageGaps();
  // Hide-sent filters by ACTIVE-marked rows. Totals stay =
  // allCoverageGaps.length so the header count reflects ALL exposed parts.
  const sentCount = allCoverageGaps.reduce((n, g) => n + (sentByPn.has(_coverageGapKey(g)) ? 1 : 0), 0);
  const overdueRiskCount = allCoverageGaps.reduce((n, g) => n + (g.overdueRisk ? 1 : 0), 0);
  const coverageGaps = FOLLOWUP_STATE.hideSentGaps
    ? allCoverageGaps.filter(g => !sentByPn.has(_coverageGapKey(g)))
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
          <div class="empty" style="padding:48px 16px">
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
                const sentAt = sentByPn.get(sentKey) || null;
                const isSent = !!sentAt;
                const sentOn = sentAt && typeof fmtDate === "function"
                  ? fmtDate(new Date(sentAt))
                  : "";
                const sentRowStyle = isSent ? "opacity:0.45" : "";
                const sentPnStyle = isSent ? "text-decoration:line-through" : "";
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
                  return `<div>${poCell} <span class="dim tiny mono">· ${expDisp}</span></div>`;
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
                // Cross-page correlation: if this row wasn't own-sent but
                // any of its covering/overdue poIds appears in an active
                // Follow-Ups "chased" mark for the same PN, another user
                // (or the current user on Follow-Ups) already chased it.
                // Union the poIds we care about — the same set that goes
                // into the sent-write's coveredPoIds — then look up the
                // matching mark for its markedAt display.
                const rowPoIds = Array.from(new Set([
                  ...g.coveringPOs.map(c => c.poId).filter(Boolean),
                  ...overdueLines.map(ol => _findPoId(ol.po)).filter(Boolean),
                ]));
                let handledMark = null;
                if (!isSent) {
                  for (const pid of rowPoIds) {
                    const m = partPoHandledBy(p.pn, pid);
                    // Only cross-page marks matter here — a legacy "sent"
                    // mark that already surfaces via the sentByPn check
                    // above shouldn't double-count.
                    if (m && m.type === "chased") { handledMark = m; break; }
                  }
                }
                const handledOn = handledMark && typeof fmtDate === "function"
                  ? fmtDate(new Date(handledMark.markedAt))
                  : "";
                const draftLabel = hasAnyPO
                  ? (handledMark ? "✉ Move up (already chased)" : "✉ Move up")
                  : "✉ Order";
                const draftTitle = hasAnyPO
                  ? (handledMark
                      ? `Already chased on Follow-Ups on ${esc(handledOn)} — click to draft anyway`
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
                      <button class="btn sm primary" onclick="event.stopPropagation(); draftCoverageExpediteRow(${g._idx})" title="${draftTitle}">${draftLabel}</button>
                      ${firstPoId ? `<button class="btn sm" onclick="event.stopPropagation(); openPODetail('${esc(firstPoId)}')" title="Open PO ${esc(firstPoNum)}">PO</button>` : ''}
                    </td>
                    <td class="right" style="white-space:normal">
                      <label class="row" style="gap:5px; justify-content:flex-end; cursor:pointer" title="${isSent ? `Marked sent on ${sentOn} (shared across users · uncheck to clear)` : "Mark sent (shared across users for 3 business days)"}"
                             onclick="event.stopPropagation()">
                        <input type="checkbox" class="chk" ${isSent ? "checked" : ""} onchange="toggleCoverageGapSent('${esc(sentKey)}')">
                        <span class="muted tiny" style="min-width:34px; text-align:left">${isSent ? `Sent on ${esc(sentOn)}` : ""}</span>
                      </label>
                      ${handledMark ? `<div class="dim tiny mono" style="margin-top:3px" title="A Follow-Ups chased mark for this part+PO is active (shared across users)">Chased on FU · ${esc(handledOn)}</div>` : ""}
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
}

registerRoute("followups", renderFollowUps);
registerRoute("coverage-gaps", renderCoverageGaps);
