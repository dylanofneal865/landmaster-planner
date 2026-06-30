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

  // First day balance hits <= 0 (can be today if on-hand is already <= 0).
  let zeroIdx = -1;
  for (let i = 0; i < series.length; i++) {
    if (series[i].oh <= 0) { zeroIdx = i; break; }
  }
  if (zeroIdx === -1) return null;

  // First day after zeroIdx where balance recovers > 0. Depletion is
  // monotonic non-positive, so a recovery day is always a receipt day.
  let recoverIdx = -1;
  for (let i = zeroIdx + 1; i < series.length; i++) {
    if (series[i].oh > 0) { recoverIdx = i; break; }
  }
  if (recoverIdx === -1) return null;

  // Max deficit across the gap (positive units below zero).
  let shortfall = 0;
  for (let i = zeroIdx; i < recoverIdx; i++) {
    const deficit = -series[i].oh;
    if (deficit > shortfall) shortfall = deficit;
  }

  const gapStart = series[zeroIdx].d;
  const gapEnd = series[recoverIdx].d;
  const gapDays = Math.round((gapEnd.getTime() - gapStart.getTime()) / DAY_MS);

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
  const coveringPOs = [];
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
  const targetArrivalDate = (typeof addDays === "function") ? addDays(gapStart, -18) : new Date(gapStart.getTime() - 18 * DAY_MS);

  // Primary supplier for grouping the section-level "Draft all expedites"
  // bundle — first covering PO's supplier, falling back to the part's
  // supplier when no covering PO is identified.
  const primarySupplier = (coveringPOs[0] && coveringPOs[0].supplier) || part.supplier || "";

  return { gapStart, gapEnd, gapDays, shortfall, coveringPOs, targetArrivalDate, primarySupplier };
}

// Aggregator: scan partsWithStatus, apply the cheap pre-filters (kits,
// daily<=0, onPO<=0 — all unconditionally not-exposed), call the detector
// for each survivor, sort soonest-exposure first with widest-gap as tiebreak.
function computeCoverageGaps() {
  const stats = (typeof partsWithStatus === "function") ? partsWithStatus() : [];
  const out = [];
  for (const p of stats) {
    // Allowlist gate up front — same Set the detector uses. Excludes
    // service / do_not_order / blank / any future itemType by default.
    if (!_COVERAGE_GAP_ITEM_TYPES.has(p.itemType)) continue;
    if (p.isKit) continue;
    if ((Number(p.daily) || 0) <= 0) continue;
    if ((Number(p.onPO) || 0) <= 0) continue;
    const gap = computeCoverageGap(p);
    if (gap) out.push({ part: p, ...gap });
  }
  out.sort((a, b) => {
    const da = a.gapStart.getTime() - b.gapStart.getTime();
    if (da !== 0) return da;
    return b.gapDays - a.gapDays;
  });
  return out;
}

/* ============================================================
   SESSION "MARK CHASED" — per-line, sessionStorage only (no schema change).
   A line key is `${po.id}::${ln.id}` (falls back to PN if a line has no id).
   Chased lines are de-emphasized in place, and can be hidden via the toolbar
   toggle. Cleared when the tab closes.
   ============================================================ */
const _FOLLOWUP_CHASED_KEY = "followups.chased.v1";

function _followupKey(fu) {
  const lnId = (fu.ln && fu.ln.id) ? fu.ln.id : fu.pn;
  return `${fu.po.id}::${lnId}`;
}
function _getChasedSet() {
  try {
    const raw = sessionStorage.getItem(_FOLLOWUP_CHASED_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) { return new Set(); }
}
function _saveChasedSet(set) {
  try { sessionStorage.setItem(_FOLLOWUP_CHASED_KEY, JSON.stringify([...set])); } catch (e) { /* ignore */ }
}
function toggleFollowupChased(key) {
  const set = _getChasedSet();
  if (set.has(key)) set.delete(key); else set.add(key);
  _saveChasedSet(set);
  refresh();
}

/* ============================================================
   SESSION "MARK SENT" for Coverage Gaps — mirrors the chased pattern
   above. Per-row, sessionStorage only, cleared when the tab closes. A
   gap key is the part PN (computeCoverageGap returns one gap per part,
   so PN is uniquely identifying).
   ============================================================ */
const _COVERAGE_SENT_KEY = "followups.coverage.sent.v1";

function _coverageGapKey(g) {
  return (g && g.part && g.part.pn) ? String(g.part.pn) : "";
}
function _getSentSet() {
  try {
    const raw = sessionStorage.getItem(_COVERAGE_SENT_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) { return new Set(); }
}
function _saveSentSet(set) {
  try { sessionStorage.setItem(_COVERAGE_SENT_KEY, JSON.stringify([...set])); } catch (e) { /* ignore */ }
}
function toggleCoverageGapSent(key) {
  const set = _getSentSet();
  if (set.has(key)) set.delete(key); else set.add(key);
  _saveSentSet(set);
  refresh();
}

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
  // Coverage Gaps — part-level "exposed before resupply" list. Distinct
  // from the PO-line supplier follow-ups below; computed independently so
  // search / sort / hide-chased on the follow-up panel don't affect it.
  const allCoverageGaps = computeCoverageGaps();
  // Session-scoped "sent" tracking, mirroring the chased pattern below.
  const sent = _getSentSet();
  const sentCount = allCoverageGaps.reduce((n, g) => n + (sent.has(_coverageGapKey(g)) ? 1 : 0), 0);
  // Optional hide-sent filter. Total stays = allCoverageGaps.length so
  // the section header reflects ALL exposed parts, not just the visible
  // ones — same convention as the chased counter on the supplier list.
  const coverageGaps = FOLLOWUP_STATE.hideSentGaps
    ? allCoverageGaps.filter(g => !sent.has(_coverageGapKey(g)))
    : allCoverageGaps;
  // Stash for the email-draft handlers to look rows back up by index
  // (mirrors window._FOLLOWUPS / window._FOLLOWUP_GROUPS). Indexes are
  // assigned on the post-filter array so the per-row Draft button still
  // resolves correctly when hide-sent is on.
  coverageGaps.forEach((g, i) => { g._idx = i; });
  window._COVERAGE_GAPS = coverageGaps;

  const all = computeFollowUps();
  const total = all.length;                 // header + badge count (full predicate)
  const chased = _getChasedSet();
  const chasedCount = all.reduce((n, fu) => n + (chased.has(_followupKey(fu)) ? 1 : 0), 0);

  // Working set: optional hide-chased, then supplier search.
  let working = all;
  if (FOLLOWUP_STATE.hideChased) working = working.filter(fu => !chased.has(_followupKey(fu)));
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

      ${allCoverageGaps.length > 0 ? `
      <div class="panel" style="border-color: var(--crit-bd); background: linear-gradient(180deg, var(--crit-soft) 0%, var(--bg-1) 80%); margin-bottom: 16px;">
        <div class="panel-head" style="border-bottom-color: var(--crit-bd);">
          <div class="panel-title" style="color: var(--crit);">⚠ Coverage Gaps</div>
          <div class="panel-sub">${allCoverageGaps.length} part${allCoverageGaps.length === 1 ? '' : 's'} stocked out before resupply arrives · Want-by = runout − 18 days${sentCount ? ` · ${sentCount} sent this session` : ''}</div>
          <div class="panel-actions" style="display:flex; gap:8px; align-items:center">
            <label class="row" style="gap:6px; align-items:center; cursor:pointer" title="Hide rows marked sent this session">
              <input type="checkbox" class="chk" ${FOLLOWUP_STATE.hideSentGaps ? "checked" : ""} onchange="FOLLOWUP_STATE.hideSentGaps = this.checked; refresh()">
              <span class="muted tiny">Hide sent</span>
            </label>
            <button class="btn sm" onclick="draftCoverageExpediteAll()" title="One email per supplier bundling every NOT-YET-SENT exposed line they own — same compose pattern as the supplier follow-up groups below">✉ Draft all expedites</button>
          </div>
        </div>
        <div class="panel-body flush">
          ${coverageGaps.length === 0 ? `
            <div class="empty" style="padding:32px 16px">
              <div class="empty-msg">Every coverage gap is marked sent. Untick “Hide sent” to see them.</div>
            </div>
          ` : `
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr>
              <th>Part</th>
              <th class="right">On Hand</th>
              <th class="right">Daily</th>
              <th>Out On</th>
              <th>Covering PO</th>
              <th>Want By</th>
              <th class="right">Gap</th>
              <th class="right">Short</th>
              <th>Actions</th>
              <th class="right">Sent</th>
            </tr></thead>
            <tbody>
              ${coverageGaps.map(g => {
                const p = g.part;
                const sentKey = _coverageGapKey(g);
                const isSent = sent.has(sentKey);
                // Sent rows are de-emphasized in place — same opacity +
                // PN strike-through treatment as chased rows on the
                // supplier list below.
                const sentRowStyle = isSent ? "opacity:0.45" : "";
                const sentPnStyle = isSent ? "text-decoration:line-through" : "";
                // PO #(s) clickable to open the PO drawer; row click opens
                // the part drawer. Multiple covering POs on the same
                // recovery day are comma-joined; expected date shown once
                // (it's gapEnd by construction).
                const hasCoveringPO = g.coveringPOs.length > 0;
                const coveredCell = hasCoveringPO
                  ? g.coveringPOs.map(c =>
                      `<a href="javascript:void(0)" onclick="event.stopPropagation(); openPODetail('${esc(c.poId)}')" class="mono" style="color: var(--accent); text-decoration: none">${esc(c.poNum)}</a>`
                    ).join(", ") + ` <span class="dim tiny mono">· ${fmtDate(g.gapEnd)}</span>`
                  : `<span class="pill warn" title="Exposed with nothing on order — this is an order-needed case, not a chase">No PO</span>`;
                const outOnLabel = (g.gapStart.getTime() <= TODAY.getTime())
                  ? `<span class="text-crit bold">Today</span>`
                  : `<span class="mono">${fmtDate(g.gapStart)}</span>`;
                // Want-by is gapStart − 18d. Red-bold if today/past (no
                // cushion possible; needs ASAP), accent otherwise.
                const wantByPast = g.targetArrivalDate.getTime() <= TODAY.getTime();
                const wantByCell = wantByPast
                  ? `<span class="text-crit bold mono" title="No cushion left — request ASAP">${fmtDate(g.targetArrivalDate)}</span>`
                  : `<span class="text-accent mono">${fmtDate(g.targetArrivalDate)}</span>`;
                const firstPoId = hasCoveringPO ? g.coveringPOs[0].poId : null;
                const firstPoNum = hasCoveringPO ? g.coveringPOs[0].poNum : "";
                // Draft button text changes with the email type — move-up
                // when there's a covering PO to pull in, order/quote when
                // the part has nothing on order at all.
                const draftLabel = hasCoveringPO ? "✉ Move up" : "✉ Order";
                const draftTitle = hasCoveringPO
                  ? `Draft delivery move-up email to ${esc(g.primarySupplier || "supplier")} for PO ${esc(firstPoNum)} — deliver by ${esc(fmtDate(g.targetArrivalDate))}`
                  : `Draft order/quote request to ${esc(g.primarySupplier || "supplier")} — deliver by ${esc(fmtDate(g.targetArrivalDate))}`;
                return `
                  <tr class="clickable" onclick="openPartDetail('${esc(p.pn)}')" style="${sentRowStyle}">
                    <td class="pn"><span style="${sentPnStyle}">${esc(p.pn)}</span><div class="dim tiny" style="font-family:var(--f-ui);margin-top:2px">${esc(p.desc || '')}</div></td>
                    <td class="right num ${Number(p.onHand) <= 0 ? 'text-crit bold' : ''}">${fmtNum(p.onHand)}</td>
                    <td class="right num dim">${fmtNum(p.daily, 2)}</td>
                    <td>${outOnLabel}</td>
                    <td>${coveredCell}</td>
                    <td>${wantByCell}</td>
                    <td class="right num bold text-crit">${fmtNum(g.gapDays)}d</td>
                    <td class="right num">${fmtNum(g.shortfall)}</td>
                    <td>
                      <button class="btn sm primary" onclick="event.stopPropagation(); draftCoverageExpediteRow(${g._idx})" title="${draftTitle}">${draftLabel}</button>
                      ${firstPoId ? `<button class="btn sm" onclick="event.stopPropagation(); openPODetail('${esc(firstPoId)}')" title="Open PO ${esc(firstPoNum)}">PO</button>` : ''}
                    </td>
                    <td class="right">
                      <label class="row" style="gap:5px; justify-content:flex-end; cursor:pointer" title="Mark sent for this session"
                             onclick="event.stopPropagation()">
                        <input type="checkbox" class="chk" ${isSent ? "checked" : ""} onchange="toggleCoverageGapSent('${esc(sentKey)}')">
                        <span class="muted tiny" style="min-width:34px; text-align:left">${isSent ? "Sent" : ""}</span>
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
      ` : ''}

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
          ` : groups.map(g => _followupGroupHtml(g, chased)).join("")}
        </div>
      </div>
    </div>`;
}

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
            const isChased = chased.has(key);
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
                  <button class="btn sm" onclick="draftFollowupEmailRow(${fu._idx})">✉ Draft email</button>
                  <button class="btn sm" onclick="openPODetail('${esc(fu.po.id)}')">Open PO</button>
                </div>
              </td>
              <td class="right">
                <label class="row" style="gap:5px; justify-content:flex-end; cursor:pointer" title="Mark chased for this session">
                  <input type="checkbox" class="chk" ${isChased ? "checked" : ""} onchange="toggleFollowupChased('${esc(key)}')">
                  <span class="muted tiny" style="min-width:42px; text-align:left">${isChased ? "Chased" : ""}</span>
                </label>
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
  const who = (g.supplier && g.supplier !== "—") ? g.supplier : "there";
  const subject = `Follow-up: ${g.count} overdue PO line${g.count === 1 ? "" : "s"} — worst ${g.worst} days`;
  const lines = g.lines.map(fu => _followupLineBlock(fu).split("\n").map((l, i) => (i === 0 ? `• ${l}` : `  ${l}`)).join("\n")).join("\n\n");
  const body =
`Hi ${who},

We have ${g.count} overdue purchase order line${g.count === 1 ? "" : "s"} we'd like to chase:

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

// One-line supplier-facing description of an exposed part:
//   "PO <#> for <PN> (<desc>)"   when a covering PO exists
//   "<PN> (<desc>)"               otherwise
// Used both standalone (per-row) and as the bullet content (bundled).
function _coverageGapLineDescription(g) {
  const p = g.part;
  const partPart = p.desc ? `${p.pn} (${p.desc})` : p.pn;
  if (g.coveringPOs.length) {
    const ids = g.coveringPOs.map(c => c.poNum).join(", ");
    return `PO ${ids} for ${partPart}`;
  }
  return partPart;
}

function draftCoverageExpediteRow(idx) {
  const g = (window._COVERAGE_GAPS || [])[idx];
  if (!g) { showToast("Coverage gap not found — refresh the page", "warn"); return; }
  const who = (g.primarySupplier && g.primarySupplier !== "—") ? g.primarySupplier : "there";
  const wantBy = fmtDate(g.targetArrivalDate);
  const hasCoveringPO = g.coveringPOs.length > 0;
  const subject = hasCoveringPO
    ? `Delivery move-up request: PO ${g.coveringPOs.map(c => c.poNum).join(", ")} by ${wantBy}`
    : `Delivery request: ${g.part.pn} by ${wantBy}`;
  // Single short sentence covering the ask. No runout, no buffer
  // language, no internal numbers.
  const sentence = hasCoveringPO
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
  const sent = _getSentSet();
  const pending = gaps.filter(g => !sent.has(_coverageGapKey(g)));
  if (!pending.length) { showToast("Every visible coverage gap is already marked sent", "warn"); return; }
  // Group by primarySupplier so each vendor gets one bundled email.
  const bySupplier = new Map();
  for (const g of pending) {
    const key = g.primarySupplier || "—";
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(g);
  }
  // Soonest want-by per supplier drives the subject line.
  const earliestOf = (list) => list.reduce((m, g) => (m === null || g.targetArrivalDate < m ? g.targetArrivalDate : m), null);
  let opened = 0;
  for (const [supplier, list] of bySupplier.entries()) {
    const who = (supplier && supplier !== "—") ? supplier : "there";
    const earliest = earliestOf(list);
    const subject = `Delivery move-up request: ${list.length} line${list.length === 1 ? "" : "s"} — earliest by ${fmtDate(earliest)}`;
    const bullets = list.map(g => `• ${_coverageGapLineDescription(g)} — deliver by ${fmtDate(g.targetArrivalDate)}`).join("\n");
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

registerRoute("followups", renderFollowUps);
