/* =====================================================
   12-page-audit.js
   Sections: PAGE: AUDIT LOG
   ===================================================== */

/* ============================================================
   PAGE: AUDIT LOG
   ============================================================ */
let AUDIT_STATE = { search: "", type: "all" };

registerRoute("audit", () => {
  let entries = DB.audit.slice();
  if (AUDIT_STATE.type !== "all") entries = entries.filter(e => e.type === AUDIT_STATE.type);
  if (AUDIT_STATE.search) {
    const q = AUDIT_STATE.search.toLowerCase();
    entries = entries.filter(e => (e.msg||"").toLowerCase().includes(q));
  }

  const types = [...new Set(DB.audit.map(e => e.type))].sort();

  $("#main").innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">Audit Log</div>
          <div class="page-sub mono">${entries.length} OF ${DB.audit.length} EVENTS · CHRONOLOGICAL CHANGES TO YOUR INVENTORY</div>
        </div>
        <div class="page-actions">
          <button class="btn" onclick="exportAuditAsCSV()">⇩ Export CSV</button>
          <button class="btn danger" onclick="confirmClearAudit()">Clear log</button>
        </div>
      </div>

      <div class="panel">
        <div class="filterbar">
          <div class="search-input">
            <input class="input" id="audit-search" placeholder="Search events…" value="${esc(AUDIT_STATE.search)}"
              oninput="AUDIT_STATE.search = this.value; AUDIT_STATE._refocusSearch = true; clearTimeout(AUDIT_STATE._searchT); AUDIT_STATE._searchT = setTimeout(() => refresh(), 200);">
          </div>
          <select class="select" onchange="AUDIT_STATE.type = this.value; refresh()">
            <option value="all">All types</option>
            ${types.map(t => `<option value="${esc(t)}" ${AUDIT_STATE.type===t?'selected':''}>${esc(t)}</option>`).join("")}
          </select>
        </div>
        <div class="panel-body">
          ${entries.length === 0 ? `
            <div class="empty"><div class="empty-msg">No events.</div></div>
          ` : entries.slice(0, 500).map(a => `
            <div class="audit-entry ${a.type}">
              <div class="audit-ts">${fmtTime(a.ts)}<br><span class="tag">${esc(a.type)}</span></div>
              <div class="audit-msg">${esc(a.msg)}</div>
            </div>
          `).join("")}
          ${entries.length > 500 ? `<div class="muted center tiny" style="padding:14px">Showing first 500 of ${entries.length}.</div>` : ""}
        </div>
      </div>
    </div>`;

  // Live search debounces the refresh; after we re-render, put the cursor
  // back where the user was typing.
  if (AUDIT_STATE._refocusSearch) {
    AUDIT_STATE._refocusSearch = false;
    setTimeout(() => {
      const inp = $("#audit-search");
      if (inp) {
        inp.focus();
        const len = inp.value.length;
        inp.setSelectionRange(len, len);
      }
    }, 0);
  }
});

function exportAuditAsCSV() {
  const rows = [["Timestamp","Type","Message"]].concat(DB.audit.map(a => [a.ts, a.type, (a.msg||"").replace(/"/g,'""')]));
  const csv = rows.map(r => r.map(c => {
    const s = String(c ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(",")).join("\n");
  downloadFile(csv, `audit-log-${isoDate(TODAY)}.csv`, "text/csv");
}

function confirmClearAudit() {
  openModal(`
    <div class="modal-head"><div style="font-size:13px;font-weight:600">Clear audit log?</div></div>
    <div class="modal-body">
      <p>This permanently deletes all ${DB.audit.length} log entries.</p>
      <p class="muted tiny">Your parts, POs, and inventory data are not affected.</p>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close>Cancel</button>
      <button class="btn danger" onclick="DB.audit = []; saveDB(); closeModal(); showToast('Audit log cleared', 'warn'); refresh();">Clear log</button>
    </div>
  `);
}
