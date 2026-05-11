/* =====================================================
   15-cmd-palette.js
   Sections: COMMAND PALETTE — Cmd/Ctrl+K to search anything
   ===================================================== */

/* ============================================================
   COMMAND PALETTE — Cmd/Ctrl+K to search anything
   ============================================================ */
const CMD_PAL = { open: false, query: "", items: [], active: 0 };

function openCommandPalette() {
  CMD_PAL.open = true;
  CMD_PAL.query = "";
  CMD_PAL.active = 0;
  $("#cmdpal-bd").classList.add("open");
  setTimeout(() => {
    const inp = $("#cmdpal-input");
    inp.value = "";
    inp.focus();
    renderCommandPalette();
  }, 30);
}

function closeCommandPalette() {
  CMD_PAL.open = false;
  $("#cmdpal-bd").classList.remove("open");
}

function buildCmdItems(query) {
  const q = (query || "").toLowerCase().trim();
  const out = [];

  // Built-in actions
  const actions = [
    { kind: "action", icon: "⚡", label: "Quick on-hand adjustment", sub: "Update a single part's on-hand count", run: () => { closeCommandPalette(); openOnHandQuickModal(); } },
    { kind: "action", icon: "⇪", label: "Bulk paste on-hand update", sub: "Paste many PN/qty rows at once", run: () => { closeCommandPalette(); openOnHandBulkModal(); } },
    { kind: "action", icon: "+", label: "Add new part", sub: "Add a part to the catalog", run: () => { closeCommandPalette(); openAddPartModal(); } },
    { kind: "action", icon: "↗", label: "Build today's orders", sub: "Open the order queue", run: () => { closeCommandPalette(); navigate("order-queue"); } },
    { kind: "action", icon: "⇪", label: "Import inventory from spreadsheet", sub: "XLSX or CSV", run: () => { closeCommandPalette(); $("#file-input").click(); } },
    { kind: "action", icon: "⇩", label: "Export full database", sub: "JSON backup", run: () => { closeCommandPalette(); exportFullDB(); } },
    // Nav
    { kind: "nav", icon: "▦", label: "Go to Dashboard", sub: "g d", run: () => { closeCommandPalette(); navigate("dashboard"); } },
    { kind: "nav", icon: "≡", label: "Go to Order Queue", sub: "g q", run: () => { closeCommandPalette(); navigate("order-queue"); } },
    { kind: "nav", icon: "▤", label: "Go to Purchase Orders", sub: "g p", run: () => { closeCommandPalette(); navigate("pos"); } },
    { kind: "nav", icon: "▣", label: "Go to On-Hand Update", sub: "g o", run: () => { closeCommandPalette(); navigate("onhand"); } },
    { kind: "nav", icon: "◉", label: "Go to Parts Catalog", sub: "", run: () => { closeCommandPalette(); navigate("parts"); } },
    { kind: "nav", icon: "△", label: "Go to Suppliers", sub: "", run: () => { closeCommandPalette(); navigate("suppliers"); } },
    { kind: "nav", icon: "≣", label: "Go to Audit Log", sub: "", run: () => { closeCommandPalette(); navigate("audit"); } },
    { kind: "nav", icon: "✱", label: "Go to Settings", sub: "", run: () => { closeCommandPalette(); navigate("settings"); } },
  ];
  for (const a of actions) if (!q || a.label.toLowerCase().includes(q) || (a.sub||"").toLowerCase().includes(q)) out.push(a);

  if (q) {
    // Parts (limit 8)
    const parts = DB.parts.filter(p =>
      p.pn.toLowerCase().includes(q) || (p.desc||"").toLowerCase().includes(q)
    ).slice(0, 8);
    for (const p of parts) {
      out.push({
        kind: "part",
        icon: "P",
        label: p.pn,
        sub: `${p.desc} · ${p.supplier} · OH ${fmtNum(p.onHand)}`,
        run: () => { closeCommandPalette(); openPartDetail(p.pn); }
      });
    }
    // POs
    const pos = DB.pos.filter(po =>
      po.num.toLowerCase().includes(q) || (po.supplier||"").toLowerCase().includes(q)
    ).slice(0, 5);
    for (const po of pos) {
      out.push({
        kind: "po",
        icon: "#",
        label: po.num,
        sub: `${po.supplier} · ${poStatusLabel(po.status)} · ${po.lines.length} line${po.lines.length===1?'':'s'}`,
        run: () => { closeCommandPalette(); openPODetail(po.id); }
      });
    }
    // Suppliers
    const sups = [...new Set(DB.parts.map(p => p.supplier))]
      .filter(s => s && s.toLowerCase().includes(q))
      .slice(0, 5);
    for (const s of sups) {
      const cnt = DB.parts.filter(p => p.supplier === s).length;
      out.push({
        kind: "supplier",
        icon: "△",
        label: s,
        sub: `${cnt} part${cnt===1?'':'s'}`,
        run: () => { closeCommandPalette(); openSupplierDetail(s); }
      });
    }
  }
  return out;
}

function renderCommandPalette() {
  const items = buildCmdItems(CMD_PAL.query);
  CMD_PAL.items = items;
  if (CMD_PAL.active >= items.length) CMD_PAL.active = Math.max(0, items.length - 1);
  const results = $("#cmdpal-results");
  if (!items.length) {
    results.innerHTML = `<div class="cmdpal-empty">No matches.</div>`;
    return;
  }
  // Group by kind
  const groups = { action: "Actions", nav: "Navigate", part: "Parts", po: "Purchase Orders", supplier: "Suppliers" };
  const buckets = {};
  items.forEach((it, idx) => {
    if (!buckets[it.kind]) buckets[it.kind] = [];
    buckets[it.kind].push({ ...it, idx });
  });
  let html = "";
  for (const k of Object.keys(groups)) {
    if (!buckets[k]) continue;
    html += `<div class="cmdpal-section">${groups[k]}</div>`;
    for (const it of buckets[k]) {
      html += `
        <div class="cmdpal-item ${it.idx === CMD_PAL.active ? 'active' : ''}" data-idx="${it.idx}">
          <span class="cmd-icon">${esc(it.icon)}</span>
          <span class="cmd-label">${esc(it.label)}</span>
          ${it.sub ? `<span class="cmd-sub">${esc(it.sub)}</span>` : ''}
        </div>
      `;
    }
  }
  results.innerHTML = html;
  $$(".cmdpal-item", results).forEach(el => {
    el.onclick = () => {
      const idx = parseInt(el.dataset.idx);
      const item = CMD_PAL.items[idx];
      if (item) item.run();
    };
    el.onmouseenter = () => {
      CMD_PAL.active = parseInt(el.dataset.idx);
      $$(".cmdpal-item", results).forEach((e, i) => e.classList.toggle("active", parseInt(e.dataset.idx) === CMD_PAL.active));
    };
  });
  // Scroll active into view
  const activeEl = $(`.cmdpal-item[data-idx="${CMD_PAL.active}"]`, results);
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}
