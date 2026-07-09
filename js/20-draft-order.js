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

function draftOrderAdd(pn, qty) {
  const existing = DRAFT_ORDER.find(d => d.pn === pn);
  // Snapshot the source blanket (if any) at add-time so the draft line, drawer,
  // and PDF all render as a release against that blanket. Held on the item as
  // { blanketPoNum, blanketOpenQty } — a null blanketPoNum means "normal order".
  const blk = (typeof findOpenBlanketForPart === "function") ? findOpenBlanketForPart(pn) : null;
  const blanketPoNum = blk ? blk.po.num : null;
  const blanketOpenQty = blk ? blk.open : 0;
  if (existing) {
    existing.qty = qty;
    // Preserve manual clears: only OVERWRITE the linkage when we actually
    // resolve a blanket now. If the user later un-blankets (blanket exhausted)
    // and re-adds, they'll get the new snapshot.
    if (blanketPoNum) {
      existing.blanketPoNum = blanketPoNum;
      existing.blanketOpenQty = blanketOpenQty;
    }
  } else {
    DRAFT_ORDER.push({ pn, qty, addedAt: new Date().toISOString(), blanketPoNum, blanketOpenQty });
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
    const lineTotal = (item.qty || 0) * unit;
    // Pass the blanket linkage through to the drawer/PDF renderers so the line
    // reads as a release, not a fresh order. Null blanketPoNum = normal.
    groups[supplier].lines.push({
      part, qty: item.qty, unit, lineTotal, noCost,
      blanketPoNum: item.blanketPoNum || null,
      blanketOpenQty: item.blanketOpenQty || 0,
    });
    if (!noCost) {
      groups[supplier].subtotal += lineTotal;
      grandTotal += lineTotal;
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
              ${grp.lines.map(({ part, qty, unit, lineTotal, noCost, blanketPoNum }) => `
                <tr data-draft-pn="${esc(part.pn)}" data-draft-supplier="${esc(s)}">
                  <td>
                    <div class="pn">${esc(part.pn)}</div>
                    <div class="dim tiny">${esc(part.desc || '—')}</div>
                    ${blanketPoNum ? `<div class="tiny mono" style="margin-top:2px;color:var(--accent-d)">↳ Release against ${esc(blanketPoNum)}</div>` : ''}
                  </td>
                  <td class="right" style="width:90px">
                    <input class="input num" type="number" min="0" value="${qty}" oninput="draftOrderUpdateQty('${esc(part.pn)}', this.value)">
                  </td>
                  <td class="right num">${noCost ? '—' : fmtMoneyDec(unit)}</td>
                  <td class="right num bold" data-draft-line-total>${noCost ? '—' : fmtMoney(lineTotal)}</td>
                  <td><button class="btn sm ghost" onclick="draftOrderRemoveLine('${esc(part.pn)}')" title="Remove">×</button></td>
                </tr>
              `).join("")}
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

function draftOrderUpdateQty(pn, value) {
  const qty = Math.max(0, parseFloat(value) || 0);
  const existing = DRAFT_ORDER.find(d => d.pn === pn);
  if (!existing) return;
  existing.qty = qty;
  draftOrderSave();

  // Patch DOM in place so the input keeps focus.
  const part = DB.parts.find(p => p.pn === pn);
  const noCost = part ? hasNoOrderCost(part) : true;
  const unit = (part && !noCost) ? orderUnitCost(part) : 0;
  const lineTotal = qty * unit;
  const row = $(`tr[data-draft-pn="${pn}"]`);
  if (row) {
    const cell = row.querySelector("[data-draft-line-total]");
    if (cell) cell.textContent = noCost ? '—' : fmtMoney(lineTotal);
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
      const cover = stat.daysOfCover === Infinity ? "—" : `${stat.daysOfCover}d`;
      // Pricing source: orderUnitCost (last PO → stored cost fallback), pulled
      // from draftOrderTotals so the PDF and drawer can't drift apart. No-
      // cost rows render "—" rather than a misleading $0.
      // Blanket linkage: for release lines, append "↳ Release against {po#}"
      // to the description so the PDF reads as a release, not a fresh order.
      const desc = part.desc || "";
      const descWithRelease = blanketPoNum
        ? (desc ? `${desc}\n↳ Release against ${blanketPoNum}` : `↳ Release against ${blanketPoNum}`)
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
      rowStatuses.push(stat.status);
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
