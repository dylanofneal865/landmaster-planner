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

function draftOrderAdd(pn, qty) {
  const existing = DRAFT_ORDER.find(d => d.pn === pn);
  const split = _computeBlanketSplit(pn, qty);
  const first = split.releases[0] || null;
  // Legacy top-level fields kept in lockstep so any external reader that
  // still looks at `blanketPoNum` (e.g. queue "in draft" pill logic, older
  // realtime sync consumers) sees a coherent primary linkage without
  // needing to know about _releases.
  const legacyBlanketPoNum = first ? first.blanketPoNum : null;
  const legacyBlanketOpenQty = first ? first.blanketOpenQty : 0;
  if (existing) {
    // In-place mutation only — DRAFT_ORDER identity is preserved so realtime
    // sync's hash / delta path keeps working.
    existing.qty = qty;
    existing.blanketPoNum = legacyBlanketPoNum;
    existing.blanketOpenQty = legacyBlanketOpenQty;
    existing._releases = split.releases;
    existing._normalQty = split.normalQty;
    existing._exhaustedBlanketPoNum = split.exhaustedBlanketPoNum;
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
    const part = DB.parts.find(p => p.pn === item.pn);
    if (!part) continue;
    const supplier = part.supplier || "(No supplier)";
    if (!groups[supplier]) groups[supplier] = { lines: [], subtotal: 0 };
    const noCost = hasNoOrderCost(part);
    const unit = noCost ? 0 : orderUnitCost(part);
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
  const qty = suggestedQty({ ...part, onPO: openPOQty(pn), daily: part.daily });
  draftOrderAdd(pn, qty);
  showToast(`${pn} × ${fmtNum(qty)} added to Draft Order`, "ok", "Added");
}

function openDraftOrderDrawer() {
  const { itemCount, grandTotal, supplierGroups } = draftOrderTotals();
  const supplierKeys = Object.keys(supplierGroups).sort();

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
      ${itemCount === 0 ? `
        <div class="empty">
          <div class="empty-title">No items yet</div>
          <div class="empty-msg">Add parts from the Order Queue, Dashboard, or Parts Catalog to build your draft.</div>
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
                if (line._splitIsFirst) {
                  const totalQty = line._splitTotalQty;
                  const totalLineTotal = line._splitTotalLineTotal;
                  // Header note under the PN — three shapes:
                  //   split (2+ lines):    "319 needed · split against blanket + new order"
                  //   single release:      "↳ Release against POx (Y left after)"
                  //   normal + exhausted:  "POy fully consumed — ordering normally"
                  //   normal:              (none)
                  let releaseNote = "";
                  if (isSplit) {
                    releaseNote = `<div class="tiny mono" style="margin-top:2px;color:var(--accent-d)">${fmtNum(totalQty)} needed · cap-and-split below</div>`;
                  } else if (blanketPoNum) {
                    const leftAfter = Math.max(0, (blanketOpenQty || 0) - qty);
                    const leftTxt = blanketOpenQty > 0
                      ? (qty >= blanketOpenQty ? " (blanket fully consumed)" : ` (${fmtNum(leftAfter)} left after)`)
                      : "";
                    releaseNote = `<div class="tiny mono" style="margin-top:2px;color:var(--accent-d)">↳ Release against ${esc(blanketPoNum)}${leftTxt}</div>`;
                  } else if (line._exhaustedBlanketPoNum) {
                    releaseNote = `<div class="dim tiny" style="margin-top:2px" title="This part has a blanket PO but its authorized qty is fully consumed — this order is being placed normally.">${esc(line._exhaustedBlanketPoNum)} fully consumed — ordering normally</div>`;
                  }
                  return `
                    <tr data-draft-pn="${esc(part.pn)}" data-draft-supplier="${esc(s)}" data-draft-primary>
                      <td>
                        <div class="pn">${esc(part.pn)}</div>
                        <div class="dim tiny">${esc(part.desc || '—')}</div>
                        ${releaseNote}
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

function draftOrderUpdateQty(pn, value) {
  const qty = Math.max(0, parseFloat(value) || 0);
  const existing = DRAFT_ORDER.find(d => d.pn === pn);
  if (!existing) return;
  // Snapshot the OLD split shape so we can decide whether an in-place DOM
  // patch preserves the input's focus or we need a full drawer re-render.
  const oldSplitCount = Array.isArray(existing._releases)
    ? existing._releases.length + (Number(existing._normalQty || 0) > 0 ? 1 : 0)
    : (existing.blanketPoNum ? 1 : 1);
  const oldExhausted = existing._exhaustedBlanketPoNum || null;

  // Recompute the split at the new total. In-place mutation only.
  const split = _computeBlanketSplit(pn, qty);
  const first = split.releases[0] || null;
  existing.qty = qty;
  existing.blanketPoNum = first ? first.blanketPoNum : null;
  existing.blanketOpenQty = first ? first.blanketOpenQty : 0;
  existing._releases = split.releases;
  existing._normalQty = split.normalQty;
  existing._exhaustedBlanketPoNum = split.exhaustedBlanketPoNum;
  draftOrderSave();

  const newSplitCount = split.releases.length + (split.normalQty > 0 ? 1 : 0) || 1;
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
  const part = DB.parts.find(p => p.pn === pn);
  const noCost = part ? hasNoOrderCost(part) : true;
  const unit = (part && !noCost) ? orderUnitCost(part) : 0;
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
    for (const { part, qty, unit, lineTotal, noCost, blanketPoNum } of grp.lines) {
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
      const descWithRelease = blanketPoNum
        ? (desc ? `${desc} — Release against ${blanketPoNum}` : `Release against ${blanketPoNum}`)
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
