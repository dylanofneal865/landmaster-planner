/* =====================================================
   20-draft-order.js
   Sections: DRAFT ORDER — staging area for parts to order, exported as PDF for approval
   ===================================================== */

const DRAFT_ORDER_KEY = "landmaster.draftOrder.v1";
let DRAFT_ORDER = [];

function draftOrderLoad() {
  try {
    const raw = localStorage.getItem(DRAFT_ORDER_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      DRAFT_ORDER.length = 0;
      DRAFT_ORDER.push(...parsed.filter(d => d && typeof d.pn === "string"));
    }
  } catch (e) { /* ignore */ }
}

function draftOrderSave() {
  try { localStorage.setItem(DRAFT_ORDER_KEY, JSON.stringify(DRAFT_ORDER)); }
  catch (e) { /* ignore */ }
}

function draftOrderHas(pn) {
  return DRAFT_ORDER.some(d => d.pn === pn);
}

// Compute the cap-and-split for `pn` at total `qty`. Returns:
//   { releases: [{ blanketPoNum, releaseQty, blanketOpenQty }], normalQty,
//     exhaustedBlanketPoNum }
// - releases: ordered list, each capped at that blanket's blanketOpenQty
//   (never over-releasing based on the last-synced remaining). Iterates
//   findOpenBlanketsForPart which orders earliest-expiring first, so the
//   soonest-expiring blanket is consumed first.
// - normalQty: whatever's left after all open blankets are exhausted; goes
//   as a regular (blanket-less) order line. May be 0.
// - exhaustedBlanketPoNum: if the part has NO open blanket but HAS a blanket
//   that's fully consumed (open=0), we surface its PO # so the drawer can
//   say "POW0001289 fully consumed — ordering normally" instead of silently
//   showing a normal order.
//
// Never releases more than blanketOpenQty per blanket — that's the
// staleness safety per the cap-and-split spec: the synced open number is
// an authoritative CAP even if it may be a bit stale.
function _computeBlanketSplit(pn, qty) {
  const total = Math.max(0, Number(qty) || 0);
  if (total <= 0) {
    return { releases: [], normalQty: 0, exhaustedBlanketPoNum: null };
  }
  const blankets = (typeof findOpenBlanketsForPart === "function")
    ? findOpenBlanketsForPart(pn) : [];
  const releases = [];
  let remaining = total;
  for (const b of blankets) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, b.open);
    if (take > 0) {
      releases.push({
        blanketPoNum: b.po.num,
        releaseQty: take,
        blanketOpenQty: b.open,
      });
      remaining -= take;
    }
  }
  let exhaustedBlanketPoNum = null;
  if (releases.length === 0 && typeof findExhaustedBlanketForPart === "function") {
    const ex = findExhaustedBlanketForPart(pn);
    if (ex && ex.po && ex.po.num) exhaustedBlanketPoNum = ex.po.num;
  }
  return { releases, normalQty: remaining, exhaustedBlanketPoNum };
}

// Normalize a DRAFT_ORDER item to its display lines. Handles the two shapes
// that can appear on disk:
//   NEW (post-cap-and-split): item._releases is an array; item._normalQty is
//                              the balance qty. Emits one line per release +
//                              one for normal (when > 0).
//   LEGACY (pre-cap-and-split): item has {blanketPoNum, blanketOpenQty} but
//                                no _releases. Treated as a single line —
//                                release-of-full-qty if blanketPoNum set,
//                                else normal-of-full-qty. This preserves
//                                already-persisted drafts without migration.
// Every returned line has: { blanketPoNum, qty, blanketOpenQty, kind }
// where kind is "release" or "normal".
function _draftItemLines(item) {
  // Per-line "Release against blanket" toggle. When explicitly turned OFF
  // (_releaseAgainstBlanket === false), collapse the whole item to a single
  // normal line at the stored total qty. Downstream consumers read
  // blanketPoNum off the emitted line, so annotations, sub-rows, and the
  // PDF "Release against POx" description suffix all vanish automatically.
  // Undefined / true → default ON behavior below.
  if (item && item._releaseAgainstBlanket === false) {
    const total = Number(item.qty || 0);
    return [{ blanketPoNum: null, qty: total, blanketOpenQty: 0, kind: "normal" }];
  }
  if (item && Array.isArray(item._releases)) {
    const out = item._releases.map(r => ({
      blanketPoNum: r.blanketPoNum,
      qty: Number(r.releaseQty || 0),
      blanketOpenQty: Number(r.blanketOpenQty || 0),
      kind: "release",
    }));
    const normal = Number(item._normalQty || 0);
    if (normal > 0) {
      out.push({ blanketPoNum: null, qty: normal, blanketOpenQty: 0, kind: "normal" });
    }
    // Handle edge case where total is 0 (item stub): emit a single zero-line
    // so downstream renderers don't skip the row entirely.
    if (out.length === 0) {
      out.push({ blanketPoNum: null, qty: 0, blanketOpenQty: 0, kind: "normal" });
    }
    return out;
  }
  // Legacy shape.
  const q = Number((item && item.qty) || 0);
  const bpn = (item && item.blanketPoNum) || null;
  return [{
    blanketPoNum: bpn,
    qty: q,
    blanketOpenQty: Number((item && item.blanketOpenQty) || 0),
    kind: bpn ? "release" : "normal",
  }];
}

function draftOrderAdd(pn, qty, qtySource, extra) {
  const existing = DRAFT_ORDER.find(d => d.pn === pn);
  const split = _computeBlanketSplit(pn, qty);
  const first = split.releases[0] || null;
  // Legacy top-level fields kept in lockstep so any external reader that
  // still looks at `blanketPoNum` (e.g. queue "in draft" pill logic, older
  // realtime sync consumers) sees a coherent primary linkage without
  // needing to know about _releases.
  const legacyBlanketPoNum = first ? first.blanketPoNum : null;
  const legacyBlanketOpenQty = first ? first.blanketOpenQty : 0;
  // qtySource: "cycle" when the qty came from cycleAwareSuggestedQty for a
  // cycled supplier, "standard" for plain suggestedQty. Persisted per item
  // so _printDraftQtyAudit can surface pre-cycle-wire items still holding
  // old quantities. Absent (no arg) → don't touch; defaults to "standard"
  // for new items and preserves existing on updates.
  const resolvedQtySource = qtySource || "standard";
  if (existing) {
    // In-place mutation only — DRAFT_ORDER identity is preserved so realtime
    // sync's hash / delta path keeps working. _releaseAgainstBlanket is NOT
    // touched on re-add: if the user already toggled it off, re-adding the
    // part must not silently flip it back on.
    existing.qty = qty;
    existing.blanketPoNum = legacyBlanketPoNum;
    existing.blanketOpenQty = legacyBlanketOpenQty;
    existing._releases = split.releases;
    existing._normalQty = split.normalQty;
    existing._exhaustedBlanketPoNum = split.exhaustedBlanketPoNum;
    if (qtySource) existing.qtySource = qtySource;
  } else {
    DRAFT_ORDER.push({
      pn,
      qty,
      addedAt: new Date().toISOString(),
      blanketPoNum: legacyBlanketPoNum,
      blanketOpenQty: legacyBlanketOpenQty,
      _releases: split.releases,
      _normalQty: split.normalQty,
      _exhaustedBlanketPoNum: split.exhaustedBlanketPoNum,
      qtySource: resolvedQtySource,
      // Default ON — cap-and-split runs and releases render as today.
      // The user can opt out per-item via the drawer's toggle.
      _releaseAgainstBlanket: true,
      // Per-line supplier override — null / empty means use the part's
      // primary supplier (current behavior). Set via the drawer's supplier
      // input. Never writes back to part.supplier.
      _supplierOverride: null,
      // Per-line vendor-cost override — set at supplier-pick time when the
      // chosen vendor has PO history (suppliersForPart returns their
      // lastCost + lastDate). null means use orderUnitCost(part) — the
      // current cost provenance path (last PO / manual, newer wins). Never
      // writes back to part.cost.
      _costOverride: null,
      _costOverrideDate: null,
      // v-draft-manual-add: optional extra fields for a NEW line only.
      // Today that is just the one-off flags (custom / customDesc /
      // customSupplier / customCost). Absent on every queue / catalog add.
      ...((extra && typeof extra === "object") ? extra : {}),
    });
  }
  draftOrderSave();
  updateDraftOrderPill();
}

function draftOrderRemove(pn) {
  const i = DRAFT_ORDER.findIndex(d => d.pn === pn);
  if (i >= 0) DRAFT_ORDER.splice(i, 1);
  draftOrderSave();
  updateDraftOrderPill();
}

function draftOrderClear() {
  DRAFT_ORDER.length = 0;
  draftOrderSave();
  updateDraftOrderPill();
  // Force-persist the empty state immediately, bypassing debounce/hash gate,
  // so a cleared draft can't be resurrected by a stale realtime echo.
  if (typeof _forcePushDraftNow === "function") _forcePushDraftNow();
}

function draftOrderTotals() {
  // Pricing source: orderUnitCost(part) — last PO price → stored cost fallback.
  // Parts with no usable purchase price contribute 0 to subtotals/grand total
  // (they render as "—" in the drawer and PDF rather than a misleading $0).
  //
  // Cap-and-split emit shape: one PN entry can yield MULTIPLE lines — one per
  // release blanket + one balance (normal) line if the request exceeds all
  // open blanket qty. Each emitted line has its own qty and its own
  // blanketPoNum (null for normal). ItemCount still increments once per PN
  // (one DRAFT_ORDER entry = one item, regardless of how many split lines
  // it renders as).
  const groups = {};
  let itemCount = 0;
  let grandTotal = 0;
  for (const item of DRAFT_ORDER) {
    // v-draft-manual-add: a one-off line (item.custom === true) has no
    // DB.parts row; _draftPartFor hands back a stand-in built from the
    // line's own description / supplier / cost. Catalog lines resolve
    // exactly as before.
    const part = _draftPartFor(item);
    if (!part) continue;
    // Per-line supplier override: user-chosen supplier wins over the part's
    // primary. Empty / null / whitespace-only override → fall back to
    // primary (current behavior). This is the SINGLE resolution site;
    // drawer group render + PDF row builder both consume groups keyed on
    // this value, so the override propagates automatically. part.supplier
    // is NEVER written from here.
    const override = (item._supplierOverride && String(item._supplierOverride).trim()) || "";
    const supplier = override || part.supplier || "(No supplier)";
    if (!groups[supplier]) groups[supplier] = { lines: [], subtotal: 0 };
    // Per-line vendor-cost override — when the user picked a supplier that
    // had PO history, _costOverride carries that vendor's lastCost at pick
    // time. Null → fall through to orderUnitCost(part) (current provenance:
    // newer of manual cost / last PO, per orderUnitCostSource). part.cost is
    // NEVER written from here.
    const hasCostOverride = item._costOverride != null && Number.isFinite(Number(item._costOverride));
    const isCustom = part._custom === true;
    const noCost = hasCostOverride ? false : (isCustom ? !(part.cost > 0) : hasNoOrderCost(part));
    const unit = hasCostOverride
      ? Number(item._costOverride)
      : (noCost ? 0 : (isCustom ? part.cost : orderUnitCost(part)));
    const totalQty = Number(item.qty || 0);
    const totalLineTotal = totalQty * unit;
    const parts = _draftItemLines(item);
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const lineTotal = p.qty * unit;
      groups[supplier].lines.push({
        part, qty: p.qty, unit, lineTotal, noCost,
        blanketPoNum: p.blanketPoNum,
        blanketOpenQty: p.blanketOpenQty,
        // Item-level qtySource surfaced onto each emitted line so
        // the drawer / PDF render can distinguish a "release"
        // (full-blanket release seeded by quickAddToDraft) from a
        // regular "cycle"/"standard" draft without re-looking up
        // the DRAFT_ORDER item.
        _qtySource: item.qtySource || null,
        // One-off line flag: the drawer renders an editable description /
        // supplier / cost row and the PDF prints "—" for stock columns.
        _custom: isCustom,
        // Split-awareness for the drawer: the drawer collapses a multi-line
        // split into one editable primary row + read-only sub-rows so the
        // math is transparent without duplicating the qty input. The PDF
        // path iterates every line independently — each split line becomes
        // its own physical PDF row.
        _splitIndex: i,
        _splitCount: parts.length,
        _splitTotalQty: totalQty,
        _splitTotalLineTotal: totalLineTotal,
        _splitIsFirst: i === 0,
        _splitIsLast: i === parts.length - 1,
        _exhaustedBlanketPoNum: (i === 0 && item._exhaustedBlanketPoNum) || null,
        // Supplier-override flag on the emitted line so the drawer's primary
        // row can render its ↷ indicator + typo-hint without re-looking up
        // the item. True iff the override resolved to something different
        // from the part's primary supplier.
        _supplierOverridden: !!override && override !== (part.supplier || ""),
        _supplierPrimary: part.supplier || "",
        // Cost-override provenance on the line. `_costOverridden` fires the
        // dated cost pill; `_costOverrideDate` sourced from the item at
        // supplier-pick time so the pill shows the vendor's PO date, not
        // "now."
        _costOverridden: hasCostOverride,
        _costOverrideDate: hasCostOverride ? (item._costOverrideDate || null) : null,
      });
      if (!noCost) {
        groups[supplier].subtotal += lineTotal;
        grandTotal += lineTotal;
      }
    }
    itemCount++;
  }
  return { itemCount, grandTotal, supplierGroups: groups };
}

function updateDraftOrderPill() {
  const btn = $("#btn-draft-order");
  if (!btn) return;
  const { itemCount, grandTotal } = draftOrderTotals();
  btn.textContent = itemCount === 0
    ? "+ DRAFT ORDER"
    : `DRAFT ORDER (${itemCount}) · ${fmtMoney(grandTotal)}`;
}

function quickAddToDraft(pn) {
  const part = DB.parts.find(p => p.pn === pn);
  if (!part) return;
  if (typeof isKit === "function" && isKit(pn)) {
    showToast(`${pn} is a kit — order its components instead`, "warn", "Can't add kit to draft");
    return;
  }
  // Route through cycleAwareSuggestedQty — for cycled suppliers (Sensourcing
  // today) this returns qty sized for cycle.intervalDays instead of the
  // 30-day horizon in suggestedQty; for every non-cycled supplier
  // getSupplierCycle returns null and cycleAwareSuggestedQty delegates to
  // plain suggestedQty (byte-identical). MOQ / packSize / phasingOut /
  // boost logic all inherited from the shared helpers, so CP00238's 500
  // MOQ floor still applies after the swap.
  const partForQty = { ...part, onPO: openPOQty(pn), daily: part.daily };
  let qty = (typeof cycleAwareSuggestedQty === "function")
    ? cycleAwareSuggestedQty(partForQty)
    : suggestedQty(partForQty);
  const cycleForPart = (typeof getSupplierCycle === "function") ? getSupplierCycle(part.supplier) : null;
  let qtySource = cycleForPart ? "cycle" : "standard";
  // RELEASE PATH — Sensourcing full-blanket release.
  //
  // When a Sensourcing part enters the release trigger window
  // (blanketReleaseDecision returns kind "release" -- projected runout
  // or blanket expiry within BLANKET_RELEASE_WINDOW_DAYS; carried on
  // the row as _blanketQueue), cycleAwareSuggestedQty
  // returns 0 because blanketIncomingQty nets the demand fully
  // into `have` — the blanket already covers everything. But the
  // business rule is that a release converts the FULL remaining
  // blanketOpenQty to a normal PO, never partial. Without this
  // path the row lands in the draft as qty 0 / $0.
  //
  // Detect: qty <= 0 AND cycled supplier AND an open blanket
  // exists for this pn. Re-set qty to the blanket balance and
  // stamp qtySource="release" so drawer + PDF wording flip to
  // the full-release phrasing. Non-cycled or blanket-less parts
  // keep today's 0-qty stub behavior (nothing to release against).
  if (qty <= 0 && cycleForPart) {
    // Route through findOpenBlanketsForPart (plural) — its sort now
    // picks the blanket due soonest, matching _computeBlanketSplit's
    // allocation order. Using singular findOpenBlanketForPart here
    // would revert to the largest-open blanket, which can differ from
    // the one that actually tripped the release window.
    const _blks = (typeof findOpenBlanketsForPart === "function") ? findOpenBlanketsForPart(pn) : [];
    const b = _blks[0] || null;
    if (b && b.open > 0) {
      qty = b.open;
      qtySource = "release";
    }
  }
  draftOrderAdd(pn, qty, qtySource);
  showToast(`${pn} × ${fmtNum(qty)} added to Draft Order`, "ok", "Added");
}

function openDraftOrderDrawer(opts) {
  const { itemCount, grandTotal, supplierGroups } = draftOrderTotals();
  const supplierKeys = Object.keys(supplierGroups).sort();
  // ALL suppliers in DB.parts — used ONLY by the typo-hint guard (scope
  // choice: catch typos of any known catalog vendor, not just this pn's
  // historical vendors, since alternate-sourcing means the target vendor
  // hasn't necessarily supplied THIS pn before). The per-part vendor
  // datalist below is populated separately from suppliersForPart(pn).
  const _allSuppliers = [...new Set((DB.parts || []).map(p => p && p.supplier).filter(Boolean))].sort();

  const html = `
    <div class="drawer-head">
      <div class="title-block">
        <div class="pre">DRAFT ORDER</div>
        <div class="title" data-draft-header-total>${itemCount} item${itemCount===1?'':'s'} · ${fmtMoney(grandTotal)}</div>
        <div class="sub">Review and adjust before generating PDF for approval</div>
      </div>
      <button class="drawer-x" data-close>×</button>
    </div>
    <div class="drawer-body">
      ${_draftAddRowHtml(_allSuppliers)}
      ${itemCount === 0 ? `
        <div class="empty" style="padding:36px 20px">
          <div class="empty-title">No items yet</div>
          <div class="empty-msg">Search above to add a part by hand, or add parts from the Order Queue, Dashboard, or Parts Catalog.</div>
        </div>
      ` : supplierKeys.map(s => {
        const grp = supplierGroups[s];
        return `
          <div class="dr-section" style="display:flex;justify-content:space-between;align-items:center">
            <span>${esc(s)}</span>
            <span class="mono dim" data-draft-supplier-subtotal="${esc(s)}">${fmtMoney(grp.subtotal)}</span>
          </div>
          <div class="tbl-wrap"><table class="lines-tbl">
            <thead><tr>
              <th>Part</th>
              <th class="right">Qty</th>
              <th class="right">Unit Cost</th>
              <th class="right">Line Total</th>
              <th></th>
            </tr></thead>
            <tbody>
              ${grp.lines.map(line => {
                const { part, qty, unit, lineTotal, noCost, blanketPoNum, blanketOpenQty } = line;
                const isSplit = line._splitCount > 1;
                // PRIMARY row — one per PN entry. Rendered on the FIRST split
                // slice; carries the editable TOTAL qty input and the total
                // line total. Sub-rows below reference this by data-draft-pn.
                // One-off line: its own editable row (never splits, never
                // has a blanket), rendered by _draftRenderCustomRow.
                if (line._custom) return _draftRenderCustomRow(part, line, s);
                if (line._splitIsFirst) {
                  const totalQty = line._splitTotalQty;
                  const totalLineTotal = line._splitTotalLineTotal;
                  // Resolve the underlying draft item to check the release
                  // toggle and whether the pn actually has an open blanket
                  // right now (findOpenBlanketForPart is authoritative;
                  // stored _releases can be stale after a sync). The toggle
                  // renders only when there's an active blanket to release
                  // against — exhausted-only rows don't get one.
                  const _item = DRAFT_ORDER.find(d => d.pn === part.pn);
                  const _releaseFlag = _item ? (_item._releaseAgainstBlanket !== false) : true;
                  const _blkNow = (typeof findOpenBlanketForPart === "function") ? findOpenBlanketForPart(part.pn) : null;
                  const _hasBlanketBacking = !!_blkNow;
                  // Header note under the PN — six shapes now:
                  //   toggle-off:          "will place as new order" (muted)
                  //   split (2+ lines):    "319 needed · cap-and-split below"
                  //   full release:        "Release full blanket balance — N against POx (expires M/D/YY)"
                  //   single release:      "↳ Release against POx (Y left after)"
                  //   normal + exhausted:  "POy fully consumed — ordering normally"
                  //   normal:              (none)
                  //
                  // Full-release wins over the plain "Release against POx"
                  // wording when qtySource === "release" (seeded by
                  // quickAddToDraft for parts inside the release trigger
                  // window). It LOSES to isSplit — if the blanket balance
                  // shrunk after the row was added and the qty no longer
                  // fits in one release, the split banner is more
                  // informative than "full release" (which is no longer
                  // true). Manual qty edits reset qtySource → "cycle"
                  // (draftOrderUpdateQty), so this branch also drops out
                  // as soon as the user touches the qty.
                  let releaseNote = "";
                  if (_hasBlanketBacking && !_releaseFlag) {
                    releaseNote = `<div class="dim tiny mono" style="margin-top:2px">will place as new order</div>`;
                  } else if (isSplit) {
                    releaseNote = `<div class="tiny mono" style="margin-top:2px;color:var(--accent-d)">${fmtNum(totalQty)} needed · cap-and-split below</div>`;
                  } else if (_item && _item.qtySource === "release" && blanketPoNum) {
                    const _blks = (typeof findOpenBlanketsForPart === "function") ? findOpenBlanketsForPart(part.pn) : [];
                    const _matchBlk = _blks.find(b => b && b.po && b.po.num === blanketPoNum);
                    const _expRaw = _matchBlk && _matchBlk.blanketExpires;
                    // Build the parenthetical inline so "(no expiry)" reads
                    // naturally instead of the tautological "(expires no
                    // expiry)". Prefix "expires " only when we have a real
                    // parsed date.
                    let _expClause = "no expiry";
                    if (_expRaw && typeof parseDateLocal === "function") {
                      const _dt = parseDateLocal(_expRaw);
                      if (_dt) _expClause = `expires ${_dt.getMonth() + 1}/${_dt.getDate()}/${String(_dt.getFullYear()).slice(-2)}`;
                    }
                    releaseNote = `<div class="tiny mono" style="margin-top:2px;color:var(--accent-d)">Release full blanket balance &mdash; ${fmtNum(qty)} against ${esc(blanketPoNum)} (${esc(_expClause)})</div>`;
                  } else if (blanketPoNum) {
                    const leftAfter = Math.max(0, (blanketOpenQty || 0) - qty);
                    const leftTxt = blanketOpenQty > 0
                      ? (qty >= blanketOpenQty ? " (blanket fully consumed)" : ` (${fmtNum(leftAfter)} left after)`)
                      : "";
                    releaseNote = `<div class="tiny mono" style="margin-top:2px;color:var(--accent-d)">↳ Release against ${esc(blanketPoNum)}${leftTxt}</div>`;
                  } else if (line._exhaustedBlanketPoNum) {
                    releaseNote = `<div class="dim tiny" style="margin-top:2px" title="This part has a blanket PO but its authorized qty is fully consumed — this order is being placed normally.">${esc(line._exhaustedBlanketPoNum)} fully consumed — ordering normally</div>`;
                  }
                  // Checkbox: renders only when the pn has an open blanket
                  // right now. Unchecked = "will place as new order" — the
                  // draft line becomes a plain standalone PO and no
                  // "Release against POx" text appears in the drawer or PDF.
                  const toggleHtml = _hasBlanketBacking ? `
                    <div class="tiny" style="margin-top:4px">
                      <label style="cursor:pointer;user-select:none;display:inline-flex;align-items:center;gap:6px">
                        <input type="checkbox" ${_releaseFlag ? "checked" : ""} onchange="draftOrderToggleRelease('${esc(part.pn)}', this.checked)">
                        <span class="dim">Release against blanket</span>
                      </label>
                    </div>` : "";
                  // Supplier override input — datalist combobox populated
                  // PER-PART from suppliersForPart(pn) so buyers see vendors
                  // that have actually supplied this pn, with each option
                  // labeled by lastCost + PO-date. Free text still works for
                  // vendors with no history. The typo-hint runs against the
                  // full DB.parts supplier list (option b) — catches typos of
                  // any known catalog vendor, which is the whole alternate-
                  // sourcing case. The ↷ indicator on the PN line signals a
                  // supplier override is active; a separate dated cost pill
                  // fires when a picked vendor's lastCost lands on the line.
                  const _overrideRaw = _item ? (_item._supplierOverride || "") : "";
                  const _primary = part.supplier || "";
                  const _isOverridden = !!(_overrideRaw && _overrideRaw.trim() && _overrideRaw.trim() !== _primary);
                  const _typoHint = _overrideRaw
                    ? _draftSupplierTypoHint(_overrideRaw, _allSuppliers)
                    : null;
                  const _typoHintHtml = _typoHint
                    ? `<div class="tiny" style="margin-top:2px;color:var(--warn-d,var(--warn,#c47500))">did you mean <a href="#" onclick="event.preventDefault(); draftOrderSetSupplier('${esc(part.pn)}', ${JSON.stringify(_typoHint).replace(/"/g,'&quot;')})" style="color:inherit;text-decoration:underline">${esc(_typoHint)}</a>?</div>`
                    : "";
                  // Per-part vendor history — powers the per-row datalist and
                  // is also used to render the dated cost pill format.
                  const _vendorHistory = (typeof suppliersForPart === "function")
                    ? suppliersForPart(part.pn) : [];
                  const _datalistId = `draft-supplier-list-${part.pn}`;
                  const _fmtDateShort = (d) => {
                    if (!d) return "?";
                    const dd = d instanceof Date ? d : new Date(d);
                    if (isNaN(dd)) return "?";
                    return dd.toLocaleDateString("en-US", { month: "short", year: "numeric" });
                  };
                  // Per-part datalist. Option label = "SUPPLIER — $X.XX (Mon
                  // YYYY)" so the buyer sees each vendor's last-cost + date
                  // inline in the combobox suggestions. `value` remains the
                  // canonical supplier string so exact-match cost lookup at
                  // pick time succeeds.
                  const _datalistHtml = `<datalist id="${esc(_datalistId)}">${
                    _vendorHistory.map(h => {
                      const label = `${h.supplier} — $${Number(h.lastCost).toFixed(2)} (${_fmtDateShort(h.lastDate)})`;
                      return `<option value="${esc(h.supplier)}" label="${esc(label)}"></option>`;
                    }).join("")
                  }</datalist>`;
                  // Cost-override pill — fires when _costOverride landed on
                  // the line (vendor with PO history was picked). Shows the
                  // dated cost so a two-year-old price looks two years old.
                  const _costPillHtml = line._costOverridden
                    ? `<span class="pill info" style="font-size:9px;padding:1px 5px;margin-left:6px;letter-spacing:0.04em" title="Line unit cost overridden from ${esc(_overrideRaw)}'s last PO (${line._costOverrideDate ? _fmtDateShort(line._costOverrideDate) : "?"}). Cleared by clearing the supplier input.">↷ $${Number(unit).toFixed(2)} (${line._costOverrideDate ? _fmtDateShort(line._costOverrideDate) : "?"})</span>`
                    : "";
                  const supplierInputHtml = `
                    ${_datalistHtml}
                    <div class="tiny" style="margin-top:6px;display:flex;flex-direction:column;gap:2px">
                      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                        <span class="dim" style="min-width:56px">Supplier:</span>
                        <input class="input" list="${esc(_datalistId)}" value="${esc(_overrideRaw)}"
                               placeholder="${esc(_primary || 'no primary supplier')}"
                               onchange="draftOrderSetSupplier('${esc(part.pn)}', this.value)"
                               style="max-width:240px;padding:2px 6px;font-size:11px">
                        ${_isOverridden ? `<span class="pill info" style="font-size:9px;padding:1px 5px;letter-spacing:0.04em" title="Supplier overridden — differs from ${esc(_primary || '(no primary)')}. Cleared by emptying the input.">↷ overridden</span>` : ""}
                        ${_costPillHtml}
                      </div>
                      ${_typoHintHtml}
                    </div>`;
                  return `
                    <tr data-draft-pn="${esc(part.pn)}" data-draft-supplier="${esc(s)}" data-draft-primary>
                      <td>
                        <div class="pn">${esc(part.pn)}${_isOverridden ? ` <span class="dim tiny" style="font-size:10px" title="Grouped under overridden supplier '${esc(s)}'; part's primary is '${esc(_primary || '(none)')}'">↷</span>` : ""}</div>
                        <div class="dim tiny">${esc(part.desc || '—')}</div>
                        ${releaseNote}
                        ${toggleHtml}
                        ${supplierInputHtml}
                      </td>
                      <td class="right" style="width:90px">
                        <input class="input num" type="number" min="0" value="${totalQty}" oninput="draftOrderUpdateQty('${esc(part.pn)}', this.value)">
                      </td>
                      <td class="right num">${noCost ? '—' : fmtMoneyDec(unit)}</td>
                      <td class="right num bold" data-draft-line-total>${noCost ? '—' : fmtMoney(totalLineTotal)}</td>
                      <td><button class="btn sm ghost" onclick="draftOrderRemoveLine('${esc(part.pn)}')" title="Remove">×</button></td>
                    </tr>
                    ${isSplit ? _draftRenderSubLine(part, line, unit, noCost) : ""}
                  `;
                }
                // SUB row — subsequent split slices (release-2/3 or the balance
                // normal line). Non-editable, indented, no remove button. The
                // primary row above owns editing/removal for the whole entry.
                return _draftRenderSubLine(part, line, unit, noCost);
              }).join("")}
            </tbody>
          </table></div>
        `;
      }).join("")}
    </div>
    <div class="drawer-foot">
      <button class="btn danger" onclick="draftOrderClearConfirm()" ${itemCount===0?'disabled':''}>Clear Draft</button>
      <div class="grow" style="flex:1"></div>
      <span class="mono" style="padding:0 12px">Total: <strong data-draft-footer-total>${fmtMoney(grandTotal)}</strong></span>
      <button class="btn primary" onclick="generateDraftOrderPDF()" ${itemCount===0?'disabled':''}>Generate PDF</button>
    </div>
  `;
  openDrawer(html, { wide: true });
  // The Add part row was just rebuilt with the rest of the drawer, so its
  // search state starts clean. Put the cursor in the search box when the
  // draft is empty (nothing else to act on) or when a manual add asked for
  // it (opts.focusAdd), so several parts can be added in a row. The top-bar
  // pill passes its click event here; that has no focusAdd and is ignored.
  _draftAddReset();
  if (itemCount === 0 || (opts && opts.focusAdd === true)) _draftAddFocusSearch();
}

// Render one sub-row inside a cap-and-split. Read-only qty display, indented
// PN cell with the release target or "new order" tag, dim numeric styling to
// visually subordinate it to the primary row above. No remove button.
//
// Row kind is derived from blanketPoNum, NOT from a `kind` field on the line
// — draftOrderTotals's grp.lines carries blanketPoNum per slice (null for the
// balance slice, PO# for release slices) and that's the single source of
// truth. Deriving here avoids a plumbing bug where a missing `kind` field
// silently falls back to the "new order" label on release rows (which is
// what shipped in the previous cut and mislabelled the 150-release row as
// "new order"). Same signal the PDF uses at line 672, so drawer + PDF now
// tell exactly the same story.
function _draftRenderSubLine(part, line, unit, noCost) {
  const { qty, blanketPoNum, blanketOpenQty } = line;
  const lineTotal = qty * unit;
  const isRelease = !!blanketPoNum;
  const tagHtml = isRelease
    ? `<span class="mono">↳ ${fmtNum(qty)} released against ${esc(blanketPoNum)}</span>${qty >= (blanketOpenQty || 0) ? ' <span class="dim">(blanket consumed)</span>' : ` <span class="dim">(${fmtNum((blanketOpenQty || 0) - qty)} left after)</span>`}`
    : `<span class="mono">↳ ${fmtNum(qty)} new order</span> <span class="dim">(balance beyond blanket)</span>`;
  return `
    <tr data-draft-pn="${esc(part.pn)}" data-draft-sub data-draft-sub-index="${line._splitIndex}">
      <td style="padding-left:32px;background:var(--bg-1)">
        <div class="tiny" style="color:var(--t2)">${tagHtml}</div>
      </td>
      <td class="right num dim" style="background:var(--bg-1)">${fmtNum(qty)}</td>
      <td class="right num dim" style="background:var(--bg-1)">${noCost ? '—' : fmtMoneyDec(unit)}</td>
      <td class="right num dim" style="background:var(--bg-1)">${noCost ? '—' : fmtMoney(lineTotal)}</td>
      <td style="background:var(--bg-1)"></td>
    </tr>
  `;
}

/* =====================================================
   MANUAL ADD (v-draft-manual-add)
   The "Add part" row at the top of the drawer, plus one-off lines.

   Catalog parts go through draftOrderAdd(pn, qty, "manual") — the same
   add path the queues use, so supplier grouping, cost, blanket split and
   totals are identical to a queue add.

   One-off lines are draft items flagged custom:true. They are NOT in
   DB.parts and are never written there. Each carries customDesc /
   customSupplier / customCost and a synthetic pn ("ONEOFF-…") so every
   pn-keyed path (qty edit, remove, row lookup, cloud sync) works as-is.
   ===================================================== */

const DRAFT_ONEOFF_PREFIX = "ONEOFF-";
const DRAFT_ADD_MAX_RESULTS = 8;

// Stand-in "part" for a one-off line, shaped like the fields the drawer,
// totals and PDF read off a catalog part. null for anything not flagged.
function _draftCustomPart(item) {
  if (!item || item.custom !== true) return null;
  const cost = Number(item.customCost);
  return {
    pn: item.pn,
    desc: String(item.customDesc || ""),
    supplier: String(item.customSupplier || ""),
    cost: (Number.isFinite(cost) && cost > 0) ? cost : 0,
    _custom: true,
  };
}

// The part behind a draft item: the catalog row, or the stand-in for a
// one-off line. undefined / null when a catalog pn no longer exists.
function _draftPartFor(item) {
  if (!item) return null;
  if (item.custom === true) return _draftCustomPart(item);
  return DB.parts.find(p => p.pn === item.pn);
}

// Search every part in DB.parts (any item type). Ranking: part number
// starts with the text (exact match first), then part number contains it,
// then description contains every word typed. Returns the first `limit`
// plus the full match count so the list can say "8 of 35".
function draftAddSearchParts(query, limit) {
  const max = limit || DRAFT_ADD_MAX_RESULTS;
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { list: [], total: 0 };
  const words = q.split(/\s+/);
  const prefix = [], pnHas = [], descHas = [];
  for (const p of (DB.parts || [])) {
    if (!p || typeof p.pn !== "string" || !p.pn) continue;
    const pn = p.pn.toLowerCase();
    if (pn.startsWith(q)) { prefix.push(p); continue; }
    if (pn.includes(q)) { pnHas.push(p); continue; }
    const desc = String(p.desc || "").toLowerCase();
    if (desc && words.every(w => desc.includes(w))) descHas.push(p);
  }
  const byPn = (a, b) => a.pn.localeCompare(b.pn, undefined, { numeric: true, sensitivity: "base" });
  prefix.sort((a, b) => ((a.pn.length === q.length ? 0 : 1) - (b.pn.length === q.length ? 0 : 1)) || byPn(a, b));
  pnHas.sort(byPn);
  descHas.sort(byPn);
  const all = prefix.concat(pnHas, descHas);
  return { list: all.slice(0, max), total: all.length };
}

// Default qty for a hand-added part: MOQ or pack size, whichever is
// larger, never below 1.
function draftAddDefaultQty(part) {
  const moq = Number(part && part.moq) || 0;
  const pack = Number(part && part.packSize) || 0;
  return Math.max(1, moq, pack);
}

// Snap a typed supplier to the catalog's spelling when it is the same name
// apart from case, spacing and punctuation ("cp global sourcing llc" ->
// "CP GLOBAL SOURCING, LLC"), so a one-off line groups with that
// supplier's other lines instead of opening a near-duplicate group.
// Anything else is kept as typed.
function _draftCanonSupplier(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const loose = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  const norm = loose(raw);
  if (!norm) return raw;
  let hit = null;
  for (const p of (DB.parts || [])) {
    const s = p && p.supplier;
    if (!s) continue;
    if (s === raw) return raw;
    if (!hit && loose(s) === norm) hit = s;
  }
  return hit || raw;
}

function _draftNewOneOffId() {
  let id;
  do {
    id = DRAFT_ONEOFF_PREFIX + (Date.now().toString(36) + Math.random().toString(36).slice(2, 6)).toUpperCase();
  } while (draftOrderHas(id) || (DB.parts || []).some(p => p && p.pn === id));
  return id;
}

// Add-row UI state. Lives only as long as one render of the drawer —
// openDraftOrderDrawer resets it right after rebuilding the DOM.
let _draftAdd = null;
function _draftAddReset() {
  _draftAdd = { list: [], total: 0, hi: 0, noMatch: false, pickedPn: null, customOpen: false, qtyAuto: true };
}
_draftAddReset();

function _draftAddFocusSearch() {
  const el = $("#draft-add-search");
  if (!el) return;
  // preventScroll: the drawer is still sliding in on a fresh open.
  try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
}

function _draftAddRowHtml(allSuppliers) {
  return `
    <style>
      .draft-add { margin-bottom: 16px; }
      .draft-add-bar { display: flex; gap: 8px; align-items: flex-start; }
      .draft-add-search { position: relative; flex: 1; min-width: 0; }
      .draft-add-results { position: absolute; left: 0; right: 0; top: calc(100% + 4px); z-index: 30; background: var(--bg-2); border: 1px solid var(--line-strong); border-radius: 6px; box-shadow: var(--shadow-md); max-height: 360px; overflow-y: auto; }
      .draft-add-opt { display: grid; grid-template-columns: 104px minmax(0, 1fr) minmax(0, 170px) 76px; gap: 10px; align-items: center; padding: 7px 10px; font-size: 12px; color: var(--t2); cursor: pointer; border-bottom: 1px solid var(--line-soft); }
      .draft-add-opt:last-child { border-bottom: 0; }
      .draft-add-opt.hi { background: var(--bg-3); box-shadow: inset 2px 0 0 var(--accent); }
      .draft-add-opt > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .draft-add-opt .pn, .draft-add-opt .cost { color: var(--t1); }
      .draft-add-opt .cost { text-align: right; }
      .draft-add-opt.oneoff { display: block; color: var(--t1); }
      .draft-add-opt .tag { font-size: 9px; padding: 1px 5px; margin-right: 6px; letter-spacing: 0.04em; }
      .draft-add-more { padding: 6px 10px; font-size: 11px; color: var(--t3); }
      .draft-add-picked { margin-top: 6px; font-size: 11px; color: var(--t2); }
      .draft-add-custom { margin-top: 8px; padding: 10px 12px; border: 1px dashed var(--line-strong); border-radius: 6px; background: var(--bg-1); }
      .draft-add-custom-fields { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) 110px; gap: 8px; }
      .draft-add-custom label { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--t3); margin-bottom: 3px; }
      @media (max-width: 640px) {
        .draft-add-custom-fields { grid-template-columns: 1fr; }
        .draft-add-opt { grid-template-columns: 92px minmax(0, 1fr) 70px; }
        .draft-add-opt .sup { display: none; }
      }
    </style>
    <div class="draft-add" id="draft-add">
      <div class="dr-section" style="margin-top:0">Add part</div>
      <div class="draft-add-bar">
        <div class="draft-add-search">
          <input class="input" id="draft-add-search" type="text" autocomplete="off" spellcheck="false"
                 placeholder="Search part # or description"
                 role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="draft-add-results" aria-label="Search parts to add"
                 oninput="draftAddOnSearch(this.value)" onkeydown="draftAddOnSearchKey(event)"
                 onfocus="draftAddOnSearchFocus()" onblur="draftAddOnSearchBlur()">
          <div class="draft-add-results" id="draft-add-results" role="listbox" hidden></div>
        </div>
        <input class="input num" id="draft-add-qty" type="number" min="0" step="1" value="1" style="width:88px;text-align:right"
               aria-label="Quantity" title="Quantity"
               oninput="draftAddOnQtyInput()" onkeydown="draftAddOnQtyKey(event)">
        <button class="btn primary" id="draft-add-btn" onclick="draftAddSubmit()">Add</button>
      </div>
      <div class="draft-add-picked" id="draft-add-picked" hidden></div>
      <div class="draft-add-custom" id="draft-add-custom" hidden>
        <div class="tiny" style="color:var(--t2);margin-bottom:8px">One-off line. It goes on this draft and its PDF only, and is not added to the Parts Catalog.</div>
        <div class="draft-add-custom-fields">
          <div>
            <label for="draft-add-c-desc">Description</label>
            <input class="input" id="draft-add-c-desc" type="text" autocomplete="off" onkeydown="draftAddOnCustomKey(event)">
          </div>
          <div>
            <label for="draft-add-c-supplier">Supplier</label>
            <input class="input" id="draft-add-c-supplier" type="text" autocomplete="off" list="draft-add-supplier-list" onkeydown="draftAddOnCustomKey(event)">
          </div>
          <div>
            <label for="draft-add-c-cost">Unit cost</label>
            <input class="input num" id="draft-add-c-cost" type="number" min="0" step="0.01" placeholder="0.00" style="text-align:right" onkeydown="draftAddOnCustomKey(event)">
          </div>
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:10px">
          <button class="btn sm" onclick="draftAddCancelCustom()">Cancel</button>
          <button class="btn sm primary" onclick="draftAddSubmit()">Add one-off line</button>
        </div>
      </div>
      <datalist id="draft-add-supplier-list">${(allSuppliers || []).map(s => `<option value="${esc(s)}"></option>`).join("")}</datalist>
    </div>
  `;
}

function _draftAddHideResults() {
  const box = $("#draft-add-results");
  if (box) { box.hidden = true; box.innerHTML = ""; }
  const input = $("#draft-add-search");
  if (input) { input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
}

function _draftAddResultsOpen() {
  const box = $("#draft-add-results");
  return !!(box && !box.hidden);
}

function _draftAddRenderResults(q) {
  const box = $("#draft-add-results");
  const input = $("#draft-add-search");
  if (!box) return;
  const st = _draftAdd;
  if (!q) { _draftAddHideResults(); return; }
  if (st.noMatch) {
    box.innerHTML = `<div class="draft-add-opt oneoff hi" id="draft-add-opt-0" role="option" aria-selected="true" onmousedown="event.preventDefault(); draftAddOpenCustom()">Add '${esc(q)}' as a one-off line <span style="color:var(--t3)">· no part matches</span></div>`;
  } else {
    box.innerHTML = st.list.map((p, i) => {
      const noCost = hasNoOrderCost(p);
      const tags = [];
      if (draftOrderHas(p.pn)) tags.push(`<span class="pill muted tag">IN DRAFT</span>`);
      if (p.itemType === "kit") tags.push(`<span class="pill warn tag">KIT</span>`);
      if (p.itemType === "do_not_order") tags.push(`<span class="pill warn tag">DO NOT ORDER</span>`);
      if (p.phasingOut) tags.push(`<span class="pill warn tag">PHASING OUT</span>`);
      return `
        <div class="draft-add-opt${i === st.hi ? " hi" : ""}" id="draft-add-opt-${i}" role="option" aria-selected="${i === st.hi ? "true" : "false"}"
             onmousedown="event.preventDefault(); draftAddPick(${i})" onmousemove="draftAddHover(${i})">
          <span class="pn mono" style="font-weight:600" title="${esc(p.pn)}">${esc(p.pn)}</span>
          <span title="${esc(p.desc || "")}">${tags.join("")}${esc(p.desc || "—")}</span>
          <span class="sup" title="${esc(p.supplier || "")}">${esc(p.supplier || "—")}</span>
          <span class="cost mono">${noCost ? "—" : fmtMoneyDec(orderUnitCost(p))}</span>
        </div>`;
    }).join("") + (st.total > st.list.length
      ? `<div class="draft-add-more">Showing ${st.list.length} of ${fmtNum(st.total)} matches. Keep typing to narrow.</div>`
      : "");
  }
  box.hidden = false;
  if (input) {
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", "draft-add-opt-" + st.hi);
  }
}

function _draftAddSetHi(i, viaKeyboard) {
  const st = _draftAdd;
  const n = st.noMatch ? 1 : st.list.length;
  if (!n) return;
  const next = ((i % n) + n) % n;
  if (next === st.hi && !viaKeyboard) return;
  st.hi = next;
  $$("#draft-add-results .draft-add-opt").forEach((el, idx) => {
    el.classList.toggle("hi", idx === st.hi);
    el.setAttribute("aria-selected", idx === st.hi ? "true" : "false");
  });
  const input = $("#draft-add-search");
  if (input) input.setAttribute("aria-activedescendant", "draft-add-opt-" + st.hi);
  if (viaKeyboard) {
    const el = $("#draft-add-opt-" + st.hi);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest" });
  }
}

function draftAddHover(i) { _draftAddSetHi(i, false); }

// Drop the picked part (if any) so the search box is a search again.
function _draftAddClearPick() {
  const st = _draftAdd;
  st.pickedPn = null;
  const picked = $("#draft-add-picked");
  if (picked) { picked.hidden = true; picked.innerHTML = ""; }
  // A qty the row filled in for the old pick should not carry over.
  if (st.qtyAuto) { const qtyEl = $("#draft-add-qty"); if (qtyEl) qtyEl.value = 1; }
}

function _draftAddHideCustom() {
  _draftAdd.customOpen = false;
  const form = $("#draft-add-custom");
  if (form) form.hidden = true;
}

// Back to a blank Add row (search text, results, pick, one-off form, qty).
function _draftAddClear() {
  _draftAddReset();
  const input = $("#draft-add-search");
  if (input) input.value = "";
  _draftAddHideResults();
  const picked = $("#draft-add-picked");
  if (picked) { picked.hidden = true; picked.innerHTML = ""; }
  const form = $("#draft-add-custom");
  if (form) form.hidden = true;
  const qtyEl = $("#draft-add-qty");
  if (qtyEl) qtyEl.value = 1;
}

function draftAddOnSearch(value) {
  const st = _draftAdd;
  // Typing again after a pick, or with the one-off form open, starts over.
  if (st.pickedPn) _draftAddClearPick();
  if (st.customOpen) _draftAddHideCustom();
  const q = String(value || "").trim();
  const res = draftAddSearchParts(q, DRAFT_ADD_MAX_RESULTS);
  st.list = res.list;
  st.total = res.total;
  st.hi = 0;
  st.noMatch = !!q && res.total === 0;
  _draftAddRenderResults(q);
}

function draftAddOnSearchFocus() {
  const st = _draftAdd;
  const input = $("#draft-add-search");
  if (!input || st.pickedPn || st.customOpen) return;
  if (input.value.trim() && !_draftAddResultsOpen()) draftAddOnSearch(input.value);
}

function draftAddOnSearchBlur() {
  // Option clicks use mousedown + preventDefault, so focus never leaves the
  // box for those. Any real blur closes the list.
  setTimeout(() => {
    const input = $("#draft-add-search");
    if (input && document.activeElement !== input) _draftAddHideResults();
  }, 0);
}

function draftAddOnSearchKey(e) {
  const st = _draftAdd;
  const open = _draftAddResultsOpen();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    if (!open) return;
    e.preventDefault();
    _draftAddSetHi(st.hi + (e.key === "ArrowDown" ? 1 : -1), true);
  } else if (e.key === "Enter") {
    e.preventDefault();
    draftAddSubmit();
  } else if (e.key === "Escape") {
    // Close the list (or the one-off form) first; a second Escape reaches
    // the global handler and closes the drawer as usual.
    if (open) { e.stopPropagation(); _draftAddHideResults(); }
    else if (st.customOpen) { e.stopPropagation(); draftAddCancelCustom(); }
  }
}

function draftAddOnQtyInput() { _draftAdd.qtyAuto = false; }

function draftAddOnQtyKey(e) {
  if (e.key === "Enter") { e.preventDefault(); draftAddSubmit(); }
}

function draftAddOnCustomKey(e) {
  if (e.key === "Enter") { e.preventDefault(); draftAddSubmit(); }
  else if (e.key === "Escape") { e.stopPropagation(); draftAddCancelCustom(); }
}

// The primary (editable) drawer row for a pn. Matched on the dataset value
// instead of a CSS attribute selector so odd characters in a pn can't
// break the lookup.
function _draftPrimaryRow(pn) {
  return $$("#drawer tr[data-draft-primary]").find(r => r.dataset.draftPn === pn) || null;
}

// The part is already on the draft: no second line. Point at the one that
// is there instead.
function _draftAddFocusExisting(pn) {
  _draftAddClear();
  showToast("Already in the draft — qty is editable here", "info");
  const row = _draftPrimaryRow(pn);
  const qtyInput = row ? row.querySelector('input[type="number"]') : null;
  if (!qtyInput) return;
  if (row.scrollIntoView) row.scrollIntoView({ block: "center" });
  try { qtyInput.focus({ preventScroll: true }); } catch (e) { qtyInput.focus(); }
  if (qtyInput.select) qtyInput.select();
}

// Pick result #i: show what was picked, default the qty, move to the qty
// field. Enter there (or Add) puts it on the draft.
function draftAddPick(i) {
  const st = _draftAdd;
  const part = st.list[i];
  if (!part) return;
  if (draftOrderHas(part.pn)) { _draftAddFocusExisting(part.pn); return; }
  st.pickedPn = part.pn;
  const input = $("#draft-add-search");
  if (input) input.value = part.pn;
  _draftAddHideResults();
  const qtyEl = $("#draft-add-qty");
  if (qtyEl) { qtyEl.value = draftAddDefaultQty(part); st.qtyAuto = true; }
  const picked = $("#draft-add-picked");
  if (picked) {
    const noCost = hasNoOrderCost(part);
    const bits = [];
    if (Number(part.moq) > 0) bits.push(`MOQ ${fmtNum(Number(part.moq))}`);
    if (Number(part.packSize) > 1) bits.push(`pack ${fmtNum(Number(part.packSize))}`);
    const caution = part.itemType === "kit"
      ? ` <span style="color:var(--warn)">· kit, normally ordered as its components</span>`
      : (part.itemType === "do_not_order" ? ` <span style="color:var(--warn)">· marked do not order</span>` : "");
    picked.innerHTML = `<span class="mono" style="color:var(--t1);font-weight:600">${esc(part.pn)}</span> · ${esc(part.desc || "—")} · ${esc(part.supplier || "(No supplier)")} · ${noCost ? "no cost on file" : fmtMoneyDec(orderUnitCost(part))}${bits.length ? ` · ${bits.join(" · ")}` : ""}${caution}`;
    picked.hidden = false;
  }
  if (qtyEl) { qtyEl.focus(); if (qtyEl.select) qtyEl.select(); }
}

// "Add '<text>' as a one-off line": open the three fields, description
// pre-filled with what was typed.
function draftAddOpenCustom() {
  const st = _draftAdd;
  const input = $("#draft-add-search");
  const text = input ? input.value.trim() : "";
  if (!text) return;
  _draftAddHideResults();
  st.customOpen = true;
  const form = $("#draft-add-custom");
  if (form) form.hidden = false;
  const descEl = $("#draft-add-c-desc"), supEl = $("#draft-add-c-supplier"), costEl = $("#draft-add-c-cost");
  if (descEl) descEl.value = text;
  if (supEl) supEl.value = "";
  if (costEl) costEl.value = "";
  if (st.qtyAuto) { const qtyEl = $("#draft-add-qty"); if (qtyEl) qtyEl.value = 1; }
  if (supEl) supEl.focus();
}

function draftAddCancelCustom() {
  _draftAddHideCustom();
  _draftAddFocusSearch();
}

function _draftAddReadQty() {
  const qtyEl = $("#draft-add-qty");
  const qty = Math.max(0, parseFloat(qtyEl ? qtyEl.value : "") || 0);
  if (qty > 0) return qty;
  showToast("Enter a quantity greater than 0", "warn");
  if (qtyEl) { qtyEl.focus(); if (qtyEl.select) qtyEl.select(); }
  return 0;
}

// After any manual add: flip the queue row underneath to IN DRAFT, redraw
// the drawer (which clears the Add row) and put the cursor back in search.
function _draftAddAfterAdd() {
  _refreshQueueIfActive();
  openDraftOrderDrawer({ focusAdd: true });
}

// Add button, Enter in the search box, Enter in the qty field, and Enter
// in the one-off fields all land here.
function draftAddSubmit() {
  const st = _draftAdd;
  if (st.customOpen) { _draftAddSubmitCustom(); return; }
  const input = $("#draft-add-search");
  if (!st.pickedPn) {
    // Nothing picked yet: behave like Enter on the result list.
    const q = input ? input.value.trim() : "";
    if (!q) { _draftAddFocusSearch(); return; }
    if (!_draftAddResultsOpen()) draftAddOnSearch(q);
    if (st.noMatch) draftAddOpenCustom();
    else if (st.list.length) draftAddPick(st.hi);
    return;
  }
  const pn = st.pickedPn;
  const part = DB.parts.find(p => p.pn === pn);
  if (!part) {
    showToast(`${pn} is no longer in the planner`, "warn");
    _draftAddClear();
    _draftAddFocusSearch();
    return;
  }
  if (draftOrderHas(pn)) { _draftAddFocusExisting(pn); return; }
  const qty = _draftAddReadQty();
  if (!(qty > 0)) return;
  draftOrderAdd(pn, qty, "manual");
  showToast(`${pn} × ${fmtNum(qty)} added to Draft Order`, "ok", "Added", 2000);
  _draftAddAfterAdd();
}

function _draftAddSubmitCustom() {
  const descEl = $("#draft-add-c-desc"), supEl = $("#draft-add-c-supplier"), costEl = $("#draft-add-c-cost");
  const desc = descEl ? descEl.value.trim() : "";
  if (!desc) {
    showToast("Give the one-off line a description", "warn");
    if (descEl) descEl.focus();
    return;
  }
  const costRaw = costEl ? String(costEl.value).trim() : "";
  const cost = costRaw === "" ? 0 : Number(costRaw);
  if (!Number.isFinite(cost) || cost < 0) {
    showToast("Unit cost must be 0 or more", "warn");
    if (costEl) costEl.focus();
    return;
  }
  const qty = _draftAddReadQty();
  if (!(qty > 0)) return;
  const supplier = _draftCanonSupplier(supEl ? supEl.value : "");
  draftOrderAdd(_draftNewOneOffId(), qty, "manual", {
    custom: true,
    customDesc: desc,
    customSupplier: supplier,
    customCost: cost,
  });
  showToast(`${desc} × ${fmtNum(qty)} added as a one-off line`, "ok", "Added", 2000);
  _draftAddAfterAdd();
}

// Drawer row for a one-off line. Same five columns as a catalog row, but
// description, supplier and unit cost are the line's own editable fields.
function _draftRenderCustomRow(part, line, supplierKey) {
  const pn = esc(part.pn);
  const totalQty = line._splitTotalQty;
  return `
    <tr data-draft-pn="${pn}" data-draft-supplier="${esc(supplierKey)}" data-draft-primary data-draft-custom>
      <td>
        <div class="pn"><span class="pill info" style="font-size:9px;padding:1px 6px;letter-spacing:0.04em" title="One-off line: on this draft and its PDF only, not in the Parts Catalog.">ONE-OFF</span></div>
        <div style="margin-top:4px">
          <input class="input" type="text" value="${esc(part.desc)}" placeholder="Description" aria-label="Description"
                 onchange="draftOrderSetCustom('${pn}', 'desc', this.value)"
                 style="max-width:360px;font-size:12px">
        </div>
        <div class="tiny" style="margin-top:6px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span class="dim" style="min-width:56px">Supplier:</span>
          <input class="input" type="text" list="draft-add-supplier-list" value="${esc(part.supplier)}"
                 placeholder="no supplier" aria-label="Supplier"
                 onchange="draftOrderSetCustom('${pn}', 'supplier', this.value)"
                 style="max-width:240px;padding:2px 6px;font-size:11px">
        </div>
      </td>
      <td class="right" style="width:90px">
        <input class="input num" type="number" min="0" value="${totalQty}" aria-label="Quantity" oninput="draftOrderUpdateQty('${pn}', this.value)">
      </td>
      <td class="right" style="width:110px">
        <input class="input num" type="number" min="0" step="0.01" value="${part.cost > 0 ? part.cost : ""}" placeholder="0.00" aria-label="Unit cost"
               oninput="draftOrderSetCustom('${pn}', 'cost', this.value)" style="width:96px">
      </td>
      <td class="right num bold" data-draft-line-total>${line.noCost ? '—' : fmtMoney(line._splitTotalLineTotal)}</td>
      <td><button class="btn sm ghost" onclick="draftOrderRemoveLine('${pn}')" title="Remove">×</button></td>
    </tr>
  `;
}

// Edit one field of a one-off line from its drawer row.
//   desc     — saved in place (blank is ignored; the old text stays).
//   cost     — saved, then line / supplier / grand totals are patched in
//              place so the cost box keeps focus while typing.
//   supplier — saved, then a full redraw because the row changes group.
function draftOrderSetCustom(pn, field, value) {
  const item = DRAFT_ORDER.find(d => d.pn === pn);
  if (!item || item.custom !== true) return;
  if (field === "desc") {
    const v = String(value || "").trim();
    if (!v) {
      const row = _draftPrimaryRow(pn);
      const el = row ? row.querySelector('input[type="text"]') : null;
      if (el) el.value = item.customDesc || "";
      return;
    }
    item.customDesc = v;
    draftOrderSave();
  } else if (field === "cost") {
    const n = Number(String(value).trim());
    item.customCost = (String(value).trim() !== "" && Number.isFinite(n) && n > 0) ? n : 0;
    // draftOrderUpdateQty at the unchanged qty re-saves and runs its
    // in-place totals patch, which reads the new cost via _draftPartFor.
    draftOrderUpdateQty(pn, item.qty);
  } else if (field === "supplier") {
    item.customSupplier = _draftCanonSupplier(value);
    draftOrderSave();
    openDraftOrderDrawer();
    updateDraftOrderPill();
  }
}

function draftOrderUpdateQty(pn, value) {
  const qty = Math.max(0, parseFloat(value) || 0);
  const existing = DRAFT_ORDER.find(d => d.pn === pn);
  if (!existing) return;
  // Snapshot the OLD split shape so we can decide whether an in-place DOM
  // patch preserves the input's focus or we need a full drawer re-render.
  // When the release toggle is OFF, the render collapses to a single line
  // regardless of what _releases contains — snap split counts to 1 so we
  // don't force a full redraw on every keystroke against an unchecked item.
  const releaseFlag = existing._releaseAgainstBlanket !== false;
  const oldSplitCount = !releaseFlag
    ? 1
    : (Array.isArray(existing._releases)
        ? existing._releases.length + (Number(existing._normalQty || 0) > 0 ? 1 : 0)
        : (existing.blanketPoNum ? 1 : 1));
  const oldExhausted = existing._exhaustedBlanketPoNum || null;

  // Recompute the split at the new total. In-place mutation only. Runs
  // regardless of the toggle so _releases stays fresh if the user later
  // re-checks (the re-check handler ALSO recomputes at that moment, but
  // keeping the stored value fresh here means the drawer redraw path can
  // display a preview immediately without a fetch).
  const split = _computeBlanketSplit(pn, qty);
  const first = split.releases[0] || null;
  existing.qty = qty;
  existing.blanketPoNum = first ? first.blanketPoNum : null;
  existing.blanketOpenQty = first ? first.blanketOpenQty : 0;
  existing._releases = split.releases;
  existing._normalQty = split.normalQty;
  existing._exhaustedBlanketPoNum = split.exhaustedBlanketPoNum;
  // Manual qty edit detaches the row from its full-blanket-release seed;
  // downstream wording drops back to the standard "Release against POx"
  // phrasing on drawer + PDF. Left alone on non-release rows.
  if (existing.qtySource === "release") existing.qtySource = "cycle";
  draftOrderSave();

  const newSplitCount = !releaseFlag
    ? 1
    : (split.releases.length + (split.normalQty > 0 ? 1 : 0) || 1);
  const newExhausted = split.exhaustedBlanketPoNum || null;

  // Split shape changed → sub-row count differs → re-render the drawer.
  // Accepts focus loss on this edit, but this only fires when the split
  // topology actually flips (typing through a boundary), not on every
  // keystroke.
  if (newSplitCount !== oldSplitCount || newExhausted !== oldExhausted) {
    openDraftOrderDrawer();
    updateDraftOrderPill();
    return;
  }

  // Same split shape — patch DOM in place so the input keeps focus.
  const part = _draftPartFor(existing);
  const isCustom = !!(part && part._custom === true);
  const noCost = part ? (isCustom ? !(part.cost > 0) : hasNoOrderCost(part)) : true;
  const unit = (part && !noCost) ? (isCustom ? part.cost : orderUnitCost(part)) : 0;
  const totalLineTotal = qty * unit;
  const row = $(`tr[data-draft-pn="${pn}"][data-draft-primary]`);
  if (row) {
    const cell = row.querySelector("[data-draft-line-total]");
    if (cell) cell.textContent = noCost ? '—' : fmtMoney(totalLineTotal);
  }
  // If there ARE sub rows, refresh their qty/line-total text in place too.
  // Iterate DOM sub-rows in order and pair them with the freshly-computed
  // split slices (same order guaranteed by _computeBlanketSplit + _draftItemLines).
  const subRows = document.querySelectorAll(`tr[data-draft-pn="${pn}"][data-draft-sub]`);
  if (subRows.length > 0) {
    const parts = _draftItemLines(existing);
    subRows.forEach((sr, i) => {
      const p = parts[i];
      if (!p) return;
      const subLineTotal = p.qty * unit;
      // 2nd cell = qty, 4th cell = line total (0-indexed: 1 and 3).
      const cells = sr.querySelectorAll("td");
      if (cells[1]) cells[1].textContent = fmtNum(p.qty);
      if (cells[3]) cells[3].textContent = noCost ? '—' : fmtMoney(subLineTotal);
    });
  }
  const { itemCount, grandTotal, supplierGroups } = draftOrderTotals();
  const supplier = row?.dataset.draftSupplier;
  if (supplier && supplierGroups[supplier]) {
    const sub = $(`[data-draft-supplier-subtotal="${supplier}"]`);
    if (sub) sub.textContent = fmtMoney(supplierGroups[supplier].subtotal);
  }
  const headerTotal = $("[data-draft-header-total]");
  if (headerTotal) headerTotal.textContent = `${itemCount} item${itemCount===1?'':'s'} · ${fmtMoney(grandTotal)}`;
  const footerTotal = $("[data-draft-footer-total]");
  if (footerTotal) footerTotal.textContent = fmtMoney(grandTotal);
  updateDraftOrderPill();
}

function draftOrderRemoveLine(pn) {
  draftOrderRemove(pn);
  openDraftOrderDrawer();
  // Drawer is an overlay — the queue page beneath it doesn't know a line was
  // just removed, so its IN DRAFT pill would stay stuck. Flip it back to +Add
  // by re-running the queue renderer (scroll-preserving). No-op off-queue.
  _refreshQueueIfActive();
}

// Normalization for the supplier typo guard. Lowercase, collapse internal
// whitespace, trim leading/trailing whitespace and trailing punctuation
// commonly found in company suffixes. Deliberately basic — any near-miss
// falls through to the raw-compare below rather than trying to be clever.
function _normalizeSupplierForCompare(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?\s]+$/g, "");
}

// Typo guard for the per-line supplier input. Returns the closest existing
// supplier that the user's input probably meant, or null if none matches.
// Rules (in order):
//   (1) User's input exactly matches an existing supplier's raw form → no
//       hint (they picked something valid on purpose).
//   (2) Normalized user input equals an existing supplier's normalized form
//       → hint that existing supplier. E.g. "Sensourcing Trading Co" vs
//       "Sensourcing Trading Co." → matches, hint the canonical form.
//   (3) Normalized user input is a prefix of an existing supplier
//       (min 4 chars user input) → hint. Catches "Sensourcing" typed as
//       a shorthand for "Sensourcing Trading Co."
//   (4) Otherwise null.
// Deliberately NOT Levenshtein / fuzzy — the user asked for a basic guard,
// and false-positive hints on unrelated names would be worse than misses.
function _draftSupplierTypoHint(value, existingSuppliers) {
  const raw = String(value || "");
  if (!raw.trim()) return null;
  const uNorm = _normalizeSupplierForCompare(raw);
  if (!uNorm) return null;
  // (1) Exact raw match → user picked a valid existing supplier, silence.
  for (const s of existingSuppliers) if (s === raw) return null;
  // (2) Normalized-equal match.
  for (const s of existingSuppliers) {
    if (_normalizeSupplierForCompare(s) === uNorm) return s;
  }
  // (3) Prefix match, min 4 chars on the input side.
  if (uNorm.length >= 4) {
    for (const s of existingSuppliers) {
      const sNorm = _normalizeSupplierForCompare(s);
      if (sNorm.length > uNorm.length && sNorm.startsWith(uNorm)) return s;
    }
  }
  return null;
}

// Per-line supplier override handler. Sets item._supplierOverride and,
// when the chosen vendor has PO history for this pn, sets _costOverride
// to that vendor's lastCost + lastDate. Free-text / unknown vendor
// clears _costOverride so the line keeps orderUnitCost(part). Empty /
// whitespace-only value clears both. part.supplier and part.cost are
// NEVER written from here — the overrides live only on the draft item.
function draftOrderSetSupplier(pn, value) {
  const existing = DRAFT_ORDER.find(d => d.pn === pn);
  if (!existing) return;
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    // Clear both — reverts to part primary + orderUnitCost.
    existing._supplierOverride = null;
    existing._costOverride = null;
    existing._costOverrideDate = null;
  } else {
    existing._supplierOverride = trimmed;
    // Look up the chosen vendor in this pn's PO history. Match on exact
    // supplier name (case-sensitive — dropdown values are the canonical
    // po.supplier strings the sync writes). Free-text vendors won't match
    // → _costOverride stays null → line keeps the current cost provenance.
    const history = (typeof suppliersForPart === "function") ? suppliersForPart(pn) : [];
    const match = history.find(h => h.supplier === trimmed);
    if (match && Number.isFinite(Number(match.lastCost)) && match.lastCost > 0) {
      existing._costOverride = Number(match.lastCost);
      existing._costOverrideDate = match.lastDate ? (match.lastDate instanceof Date ? match.lastDate.toISOString() : String(match.lastDate)) : null;
    } else {
      // Free-text or historical vendor with zero cost — leave the line's
      // cost on orderUnitCost(part). No dated pill fires.
      existing._costOverride = null;
      existing._costOverrideDate = null;
    }
  }
  draftOrderSave();
  // Full redraw — the row may have moved to a different group, invalidating
  // the in-place patch paths (data-draft-supplier attribute mismatch,
  // supplier-subtotal cell lookup, group-header presence). Same pattern
  // draftOrderToggleRelease uses.
  openDraftOrderDrawer();
  updateDraftOrderPill();
}

// Per-line "Release against blanket" toggle handler. When RE-CHECKED, the
// cap-and-split is recomputed FRESH against current blanket data — the
// stored _releases may be stale (nightly sync could have consumed the
// blanket while the item sat unchecked, and a blind restore would show a
// release against authorization that no longer exists). Uncheck is
// simpler: flip the flag; _releases is left in place but ignored by the
// _draftItemLines collapse. Qty is never modified.
function draftOrderToggleRelease(pn, checked) {
  const existing = DRAFT_ORDER.find(d => d.pn === pn);
  if (!existing) return;
  existing._releaseAgainstBlanket = !!checked;
  if (checked) {
    // Recompute against CURRENT DB.pos blanket state.
    const split = _computeBlanketSplit(pn, Number(existing.qty || 0));
    const first = split.releases[0] || null;
    existing.blanketPoNum = first ? first.blanketPoNum : null;
    existing.blanketOpenQty = first ? first.blanketOpenQty : 0;
    existing._releases = split.releases;
    existing._normalQty = split.normalQty;
    existing._exhaustedBlanketPoNum = split.exhaustedBlanketPoNum;
  }
  draftOrderSave();
  // Full redraw — toggling changes row count (N release rows + 1 balance
  // row ↔ 1 collapsed normal row), so an in-place patch would fight the
  // structural shift. Same pattern draftOrderRemoveLine uses.
  openDraftOrderDrawer();
  updateDraftOrderPill();
}

// Re-run the current queue route handler with scroll preservation, but only
// if the active route is actually one of the order queues. Mirrors the +Add
// path that flips +Add → IN DRAFT instantly; this is the inverse half.
function _refreshQueueIfActive() {
  const route = document.querySelector(".nav-item.active")?.dataset?.route;
  if (route !== "base-bom-queue" && route !== "options-queue"
      && route !== "service-queue" && route !== "order-queue") return;
  if (typeof oqRerenderPreservingScroll === "function") oqRerenderPreservingScroll();
}

function draftOrderClearConfirm() {
  openModal(`
    <div class="modal-head"><div style="font-size:13px;font-weight:600">Clear Draft Order?</div></div>
    <div class="modal-body">
      <p>Removes all ${DRAFT_ORDER.length} item${DRAFT_ORDER.length===1?'':'s'} from the draft. This cannot be undone.</p>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn danger" onclick="draftOrderClearAndClose()">Clear Draft</button>
    </div>
  `);
}

function draftOrderClearAndClose() {
  draftOrderClear();
  closeModal();
  openDraftOrderDrawer();
  _refreshQueueIfActive();
}

/* =====================================================
   PDF GENERATION (Phase 3)
   Lazy-loads jsPDF + jspdf-autotable from CDN on first use.
   ===================================================== */

let _pdfLibLoading = null;

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Failed to load " + src));
    document.head.appendChild(s);
  });
}

function ensurePdfLib() {
  if (window.jspdf && window.jspdf.jsPDF && new window.jspdf.jsPDF().autoTable) {
    return Promise.resolve();
  }
  if (_pdfLibLoading) return _pdfLibLoading;
  _pdfLibLoading = (async () => {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      await _loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    }
    // jspdf-autotable attaches to jsPDF.prototype
    await _loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js");
  })();
  return _pdfLibLoading;
}

// Landmaster brand palette
const PDF_COLORS = {
  dark:       [28, 33, 41],     // brand mast
  accent:     [184, 200, 43],   // signature green-yellow
  accentDark: [142, 156, 30],   // darker accent for text on white
  ink:        [33, 37, 41],     // body text
  inkSoft:    [73, 80, 87],     // secondary text
  muted:      [134, 142, 150],  // labels
  line:       [222, 226, 230],  // hairlines
  alt:        [250, 251, 252],  // alt row
  crit:       [200, 60, 60],
  warn:       [200, 130, 30],
  white:      [255, 255, 255],
};

function _pdfBanner(doc, pageW) {
  // Dark bar
  doc.setFillColor(...PDF_COLORS.dark);
  doc.rect(0, 0, pageW, 44, "F");

  // Wordmark
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(...PDF_COLORS.white);
  doc.text("LANDMASTER", 36, 28);

  // Accent stripe under banner
  doc.setFillColor(...PDF_COLORS.accent);
  doc.rect(0, 44, pageW, 3, "F");
}

function _pdfFooter(doc, pageW, pageH, M, pageNum, totalPages, dateStr, buyer) {
  doc.setDrawColor(...PDF_COLORS.line);
  doc.setLineWidth(0.5);
  doc.line(M, pageH - 28, pageW - M, pageH - 28);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  doc.setTextColor(...PDF_COLORS.muted);
  doc.text("LANDMASTER PURCHASING", M, pageH - 16);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...PDF_COLORS.muted);
  doc.text(`${dateStr}  ·  ${buyer}`, M + 130, pageH - 16);

  doc.text(`Page ${pageNum} of ${totalPages}`, pageW - M, pageH - 16, { align: "right" });
}

function _pdfStat(doc, x, y, label, value, accent) {
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7);
  doc.setTextColor(...PDF_COLORS.muted);
  doc.text(label, x, y);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  const col = accent ? PDF_COLORS.accentDark : PDF_COLORS.ink;
  doc.setTextColor(col[0], col[1], col[2]);
  doc.text(value, x, y + 16);
}

async function generateDraftOrderPDF() {
  const { itemCount, grandTotal, supplierGroups } = draftOrderTotals();
  if (itemCount === 0) {
    showToast("Draft Order is empty", "warn");
    return;
  }

  showToast("Building PDF…", "info");

  try {
    await ensurePdfLib();
  } catch (e) {
    showToast("Couldn't load PDF library: " + e.message, "crit");
    return;
  }

  try {
    await _buildDraftOrderPDF();
  } catch (e) {
    console.error("PDF generation failed:", e);
    showToast("PDF generation failed: " + (e.message || e), "crit");
  }
}

async function _buildDraftOrderPDF() {
  const { itemCount, grandTotal, supplierGroups } = draftOrderTotals();
  if (itemCount === 0) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 36;
  const BANNER_H = 47;
  const FOOTER_H = 38;
  const CONT_TOP = BANNER_H + 14;

  const today = new Date();
  const dateStr = today.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const pad = n => String(n).padStart(2, "0");
  const isoStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const buyer = (DB.settings && DB.settings.defaultBuyer) || "Landmaster Purchasing";
  const supplierKeys = Object.keys(supplierGroups).sort();

  // ---- TITLE BLOCK (page 1) ----
  const titleY = BANNER_H + 30; // 77

  doc.setFont("helvetica", "bold");
  doc.setFontSize(26);
  doc.setTextColor(...PDF_COLORS.ink);
  doc.text("Order Approval", M, titleY);

  // Accent underline beneath title
  doc.setDrawColor(...PDF_COLORS.accent);
  doc.setLineWidth(2);
  doc.line(M, titleY + 6, M + 64, titleY + 6);

  // Subtitle
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(...PDF_COLORS.muted);
  doc.text(`Generated ${dateStr}   ·   Prepared by ${buyer}`, M, titleY + 22);

  // ---- STAT STRIP (right side, page 1) ----
  // Three label/value pairs, right-aligned
  const statY = titleY - 14;
  const statSpacing = 96;
  const statRight = pageW - M;
  // Render right-to-left to keep alignment clean
  _pdfStat(doc, statRight - 60, statY, "TOTAL", fmtMoney(grandTotal), true);
  _pdfStat(doc, statRight - 60 - statSpacing, statY, "SUPPLIERS", String(supplierKeys.length), false);
  _pdfStat(doc, statRight - 60 - statSpacing * 2, statY, "ITEMS", String(itemCount), false);

  // ---- FLAT TABLE: one row per part, supplier as column ----
  // Flatten all rows, sorted by supplier (alpha), and keep status meta in parallel
  const allRows = [];
  const rowStatuses = [];
  for (const supplier of supplierKeys) {
    const grp = supplierGroups[supplier];
    for (const { part, qty, unit, lineTotal, noCost, blanketPoNum, _qtySource, _custom } of grp.lines) {
      // v-draft-manual-add: a one-off line has no catalog part, so there is
      // no stock, cover, lead time or status to print. Same nine columns,
      // "—" in the three planner-derived cells (em-dash is WinAnsi-safe,
      // see the note below).
      if (_custom) {
        allRows.push([
          supplier,
          "ONE-OFF",
          part.desc || "",
          "—",
          "—",
          "—",
          fmtNum(qty),
          noCost ? "—" : fmtMoneyDec(unit),
          noCost ? "—" : fmtMoney(lineTotal),
        ]);
        rowStatuses.push(null);
        continue;
      }
      const stat = partStatus(part);
      // CHAIN-AWARE Days Cover on the PDF — the draft-order path bypasses
      // partsWithStatus (it looks up parts via DB.parts.find in
      // draftOrderTotals), so the Phase B chain override never reached
      // this render. Route through getChainInfo() with a null fallback so
      // chain successors print the chain's combined-supply runout (same
      // value the detail drawer shows via its own getChainInfo override
      // at js/10-page-parts.js:57) and non-chain parts keep the exact
      // per-part number they had before. For CP00938 this swaps a 77d
      // per-part pre-launch flat-hold value for the chain's 101d (276
      // combined on-hand at 3.82/day). Non-chain 19931/19180/18556/CP00238
      // are untouched.
      const chainInfo = (typeof getChainInfo === "function") ? getChainInfo(part.pn) : null;
      const effectiveDaysOfCover = chainInfo ? chainInfo.chainRunoutDays : stat.daysOfCover;
      const cover = effectiveDaysOfCover === Infinity ? "—" : `${effectiveDaysOfCover}d`;
      // Pricing source: orderUnitCost (last PO → stored cost fallback), pulled
      // from draftOrderTotals so the PDF and drawer can't drift apart. No-
      // cost rows render "—" rather than a misleading $0.
      // Blanket linkage: for release lines, append "Release against {po#}"
      // to the description so the PDF reads as a release, not a fresh order.
      //
      // WinAnsi-safe glyphs on this path — jsPDF's default helvetica is
      // WinAnsi-encoded (the font dict declares /Encoding /WinAnsiEncoding),
      // and the drawer's "↳" (U+21B3) is unmappable there. When jsPDF
      // hits the unmappable codepoint it falls into a per-glyph text-
      // drawing path for the rest of the cell, which renders every
      // character letter-spaced and the "↳" itself as "!³" (0xB3 = "³"
      // in WinAnsi). We drop the arrow entirely and use an em-dash
      // separator (U+2014 → WinAnsi 0x97, verified via a headless jsPDF
      // 2.5.1 + autoTable 3.8.2 dump) instead of "\n" so the annotation
      // stays inline and never triggers autoTable's multi-line cell path.
      // The drawer's HTML template still uses "↳" — that path renders in
      // the browser font and doesn't have the WinAnsi limitation.
      const desc = part.desc || "";
      // Full-release rows (qtySource "release") use distinct wording so
      // the buyer sees this is the SCHEDULED full-balance release, not a
      // partial draw against a blanket that still has qty left afterward.
      const _fullRelease = _qtySource === "release";
      const _releasePhrase = _fullRelease
        ? `RELEASE full blanket ${blanketPoNum}`
        : `Release against ${blanketPoNum}`;
      const descWithRelease = blanketPoNum
        ? (desc ? `${desc} — ${_releasePhrase}` : _releasePhrase)
        : desc;
      allRows.push([
        supplier,
        part.pn || "",
        descWithRelease,
        fmtNum(part.onHand || 0),
        cover,
        `${part.ltWeeks || 0}w`,
        fmtNum(qty),
        noCost ? "—" : fmtMoneyDec(unit),
        noCost ? "—" : fmtMoney(lineTotal),
      ]);
      // Chain-aware row coloring — pair with the Days Cover override above.
      // A chain successor with 0 own on-hand computes per-part status
      // "critical" (per-part days-cover = 0), which would color the row red
      // in the approval PDF even though the CHAIN is comfortably covered.
      // chainInfo?.chainStatus wins when the part is in an actively-
      // transitioning chain; non-chain parts fall through to stat.status
      // unchanged. Same accessor the drawer / queues / dashboard use, so
      // the PDF row colors now agree with every other view.
      rowStatuses.push(chainInfo ? chainInfo.chainStatus : stat.status);
    }
  }

  const tableStartY = titleY + 38;

  doc.autoTable({
    head: [["Supplier", "Part #", "Description", "On Hand", "Days Cover", "Lead", "Qty", "Unit Cost", "Line Total"]],
    body: allRows,
    startY: tableStartY,
    margin: { left: M, right: M, top: CONT_TOP, bottom: FOOTER_H + 10 },
    theme: "plain",
    styles: {
      fontSize: 9,
      cellPadding: 7,
      textColor: PDF_COLORS.ink,
      lineColor: PDF_COLORS.line,
      lineWidth: 0.3,
      overflow: "linebreak",
      valign: "middle",
    },
    headStyles: {
      fillColor: PDF_COLORS.white,
      textColor: PDF_COLORS.inkSoft,
      fontStyle: "bold",
      fontSize: 8,
      lineWidth: 0,
      cellPadding: { top: 6, right: 7, bottom: 8, left: 7 },
    },
    alternateRowStyles: { fillColor: PDF_COLORS.alt },
    columnStyles: {
      0: { fontStyle: "bold", textColor: PDF_COLORS.accentDark, cellWidth: 130 },
      1: { fontStyle: "bold", cellWidth: 70 },
      2: { cellWidth: "auto" },
      3: { halign: "right", cellWidth: 50 },
      4: { halign: "right", cellWidth: 58 },
      5: { halign: "right", cellWidth: 38 },
      6: { halign: "right", cellWidth: 46, fontStyle: "bold" },
      7: { halign: "right", cellWidth: 60 },
      8: { halign: "right", cellWidth: 66, fontStyle: "bold" },
    },
    didParseCell: (data) => {
      if (data.section === "body" && data.column.index === 4) {
        const s = rowStatuses[data.row.index];
        if (s === "critical") {
          data.cell.styles.textColor = PDF_COLORS.crit;
          data.cell.styles.fontStyle = "bold";
        } else if (s === "warning") {
          data.cell.styles.textColor = PDF_COLORS.warn;
        }
      }
    },
    didDrawCell: (data) => {
      // Draw 2pt accent underline beneath every header cell (forms a continuous line)
      if (data.section === "head") {
        const { x, y, height, width } = data.cell;
        doc.setDrawColor(...PDF_COLORS.accent);
        doc.setLineWidth(1.6);
        doc.line(x, y + height, x + width, y + height);
      }
    },
  });

  let cursorY = doc.lastAutoTable.finalY + 18;

  // ---- TOTAL ROW ----
  // Page-break guard
  if (cursorY + 36 > pageH - FOOTER_H) {
    doc.addPage();
    cursorY = CONT_TOP;
  }

  // Strong accent line above total
  doc.setDrawColor(...PDF_COLORS.accent);
  doc.setLineWidth(2);
  doc.line(pageW - M - 240, cursorY, pageW - M, cursorY);
  cursorY += 18;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...PDF_COLORS.muted);
  doc.text("TOTAL", pageW - M - 240, cursorY);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(...PDF_COLORS.ink);
  doc.text(fmtMoney(grandTotal), pageW - M, cursorY, { align: "right" });

  // ---- BANNER + FOOTER ON EVERY PAGE ----
  const pageCount = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    _pdfBanner(doc, pageW);
    _pdfFooter(doc, pageW, pageH, M, i, pageCount, dateStr, buyer);
  }

  const filename = `Order Approval - ${isoStr}.pdf`;
  doc.save(filename);
  showToast(`Saved ${filename}`, "ok", "PDF ready");
}
