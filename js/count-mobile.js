/* =====================================================
   js/count-mobile.js -- Cycle Counts MOBILE COUNTER app.

   Loaded ONLY by count.html. NEVER imported by the planner and
   NEVER imports planner code. If it grows a dependency on the
   planner side (js/01 / js/03 / js/25 / etc.), the mobile page's
   isolation invariant is broken and the bundle balloons.

   Data path:
     * Reads cycle_count_items + cycle_count_item_locations from
       Supabase via the anon publishable key (RLS anon SELECT
       allows this; same read the planner does).
     * Writes go through /.netlify/functions/cycle-count-write
       with x-fs-edit-token + x-app-build headers, byte-identical
       to the planner's postCycleCountBatch. Server enforcement
       (variance -> recount, sum-of-locations = counted_qty,
       blind counter rule, build guard) is unchanged.

   Isolation from the planner:
     * No shared code, no shared globals, no navigation link
       back into the planner. This page can't drive anyone to
       the dashboard by accident.
     * Baked config (CC_CONFIG in count.html) mirrors the planner's
       constants but is its own copy; the honest note in
       js/01-config.js about the token being an app-build
       credential applies here too.

   Per-counter attribution (NOT auth):
     * URL ?c=<token> resolves against COUNTERS below; a match
       pre-fills and LOCKS counted_by for the session.
     * Without a token, we prompt for a name once and keep it in
       localStorage. Anyone can type any name; this is stamping,
       not identity verification. Recount blind rule is enforced
       server-side against the value we send.
   ===================================================== */

(function () {
  "use strict";

  // ---------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------
  const CFG = window.CC_CONFIG || {};
  // Placeholder names -- operator edits this block to point each
  // physical device / bookmark at a person. Tokens can be any URL-
  // safe string; keep them opaque so a supplier / random URL guess
  // doesn't casually attribute counts to a real name.
  const COUNTERS = {
    "c1-marisol": "Marisol",
    "c2-james":   "James",
    "c3-alex":    "Alex",
    "c4-taylor":  "Taylor",
  };
  // localStorage keys.
  const LS_NAME  = "cc.mobile.name";
  const LS_QUEUE = "cc.mobile.retryQueue.v1";
  const LS_LATER = "cc.mobile.later.v1";  // pn ids the counter chose "Later" on this session

  // Poll interval to keep the queue fresh in the background.
  const POLL_MS = 30000;
  // Auto-advance delay after a result.
  const RESULT_ADVANCE_MS = 1500;
  // Recount tolerance shown in copy (matches server-side constant
  // in cycle-count-write.js).
  const TOL_UNITS = 5;
  const TOL_PCT   = 0.10;

  // ---------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------
  const S = {
    name: null,
    nameLocked: false,
    supa: null,
    items: [],                  // cycle_count_items rows (pending/recount only)
    locsByItem: new Map(),       // item_id -> Array<location snapshot rows>
    parentByChildId: new Map(),  // child_item_id -> parent item (for blind gate)
    queue: [],                   // ordered pn queue for this session
    laterIds: new Set(),         // items pushed to end via Later
    activeItemId: null,          // when counting
    counted: 0,                  // this shift
    total: 0,                    // total items this shift
    countedThisShift: new Set(), // item_ids we've completed in this session
    retryQueue: [],              // pending POSTs
    retryTimer: null,
    pollTimer: null,
    binIdx: 0,
    binValues: [],               // [{location, location_desc, system, entered}]
    extraBins: [],               // found-elsewhere entries
    skipReason: null,
  };

  // ---------------------------------------------------------------
  // UTIL
  // ---------------------------------------------------------------
  const $  = (id) => document.getElementById(id);
  const esc = (s) => String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
  const show = (id) => {
    document.querySelectorAll(".screen").forEach(el => el.classList.remove("on"));
    const el = $(id); if (el) el.classList.add("on");
  };
  const flash = (msg, ms) => {
    const el = document.createElement("div"); el.className = "flash"; el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms || 2200);
  };
  const humanReason = (item) => {
    const r = String(item.reason || "").toLowerCase();
    if (item.recount_of) return "Recount -- don't peek at the prior count. Fresh eyes only.";
    if (r.startsWith("operator flag")) return "Someone on the line flagged this. Check what they found.";
    if (r.startsWith("transition at risk")) return "Chain handoff at risk -- count this AND its partner. Both ends matter.";
    if (r.startsWith("transition --")) return "Chain is about to switch parts -- verify what's left on this one.";
    if (r.startsWith("cut-in --")) return "New part just launched -- verify initial stock.";
    if (r.includes("negative on-hand")) return "System says NEGATIVE -- something's wrong upstream. Count it.";
    if (r === "zero on-hand") return "System says zero. Confirm the bin is truly empty (or find the stock).";
    if (r.startsWith("critical")) return "Almost out of stock. Verify what's really left.";
    if (r.startsWith("runway")) return "Running short soon. Get an accurate number for the buyer.";
    if (r.startsWith("rotation")) return "Time for its rotation count -- no drama expected, just verify.";
    return r ? item.reason : "Cycle count.";
  };
  const tierChip = (item) => {
    if (item.recount_of) return `<span class="chip recount">recount</span>`;
    const t = String(item.tier || "");
    const cls = t === "hot" ? "crit" : t === "runway" ? "warn" : "";
    return `<span class="chip ${cls}">${esc(t)}</span>`;
  };
  const partClsChip = (item) => item.partClass ? `<span class="chip">class ${esc(item.partClass)}</span>` : "";
  const inTol = (sys, cnt) => {
    const abs = Math.abs((Number(cnt)||0) - (Number(sys)||0));
    if (abs <= TOL_UNITS) return true;
    const s = Math.abs(Number(sys)||0);
    const pct = s < 1e-9 ? (cnt === 0 ? 0 : 1) : abs / s;
    return pct <= TOL_PCT;
  };

  // ---------------------------------------------------------------
  // NAME / TOKEN
  // ---------------------------------------------------------------
  function resolveName() {
    // 1. URL ?c=<token> wins and locks.
    const params = new URLSearchParams(location.search);
    const tok = params.get("c");
    if (tok && Object.prototype.hasOwnProperty.call(COUNTERS, tok)) {
      S.name = COUNTERS[tok];
      S.nameLocked = true;
      $("name-chip").textContent = S.name;
      $("name-chip").classList.add("locked");
      $("name-chip").title = "URL locks this device to " + S.name + ". Change by opening a different /count?c=... link.";
      return true;
    }
    // 2. localStorage
    try {
      const v = localStorage.getItem(LS_NAME);
      if (v && v.trim()) { S.name = v.trim(); $("name-chip").textContent = S.name; return true; }
    } catch (_) {}
    // 3. Prompt.
    openNameModal();
    return false;
  }
  function openNameModal() {
    if (S.nameLocked) return;
    $("name-input").value = S.name || "";
    $("name-save").disabled = !S.name;
    $("name-modal").classList.add("on");
    setTimeout(() => $("name-input").focus(), 100);
  }
  function closeNameModal() { $("name-modal").classList.remove("on"); }

  // ---------------------------------------------------------------
  // SUPABASE
  // ---------------------------------------------------------------
  function initSupabase() {
    if (!window.supabase || !window.supabase.createClient) {
      throw new Error("supabase-js failed to load (CDN blocked?)");
    }
    S.supa = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);
  }

  async function fetchQueue() {
    // Pull all pending + recount items assigned within the last
    // 30 days (a stale HOT item from three weeks ago is still work).
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const { data: items, error: e1 } = await S.supa
      .from("cycle_count_items")
      .select("id, pn, tier, reason, system_qty_at_assign, status, recount_of, note, assigned_date, counted_by")
      .in("status", ["pending", "recount"])
      .gte("assigned_date", cutoff)
      .order("tier", { ascending: true })
      .order("assigned_date", { ascending: true });
    if (e1) throw new Error("items fetch failed: " + e1.message);
    // Locations for those items.
    const ids = (items || []).map(r => r.id);
    let locs = [];
    if (ids.length > 0) {
      // Chunked -- Supabase URL limit.
      for (let i = 0; i < ids.length; i += 200) {
        const batch = ids.slice(i, i + 200);
        const { data: chunk, error: e2 } = await S.supa
          .from("cycle_count_item_locations")
          .select("id, item_id, location, location_desc, system_qty_at_assign")
          .in("item_id", batch);
        if (e2) throw new Error("locations fetch failed: " + e2.message);
        locs.push(...(chunk || []));
      }
    }
    // Also grab any parent items referenced by recounts so we can
    // enforce blind + prevent showing the prior count to the same
    // counter that made it.
    const parentIds = [...new Set((items || []).map(r => r.recount_of).filter(Boolean))];
    const parents = [];
    if (parentIds.length > 0) {
      const { data: pchunk } = await S.supa
        .from("cycle_count_items")
        .select("id, counted_by, counted_qty")
        .in("id", parentIds);
      if (pchunk) parents.push(...pchunk);
    }
    // Also pull part descriptions + class for the queue's display
    // (dedup pns; parts is small enough to scan by pn IN list).
    const partPns = [...new Set((items || []).map(r => r.pn))];
    const descByPn = new Map();
    if (partPns.length > 0) {
      for (let i = 0; i < partPns.length; i += 200) {
        const batch = partPns.slice(i, i + 200);
        const { data: pchunk, error: pe } = await S.supa
          .from("parts")
          .select("pn, data")
          .in("pn", batch);
        if (!pe && pchunk) {
          for (const p of pchunk) descByPn.set(p.pn, { desc: (p.data && p.data.desc) || "", cls: (p.data && p.data.partClass) || "" });
        }
      }
    }

    // Enrich items with desc + class + parent counter info.
    const parentByChildId = new Map();
    for (const it of (items || [])) {
      const d = descByPn.get(it.pn) || {};
      it.desc = d.desc || "";
      it.partClass = d.cls || "";
      if (it.recount_of) {
        const p = parents.find(x => x.id === it.recount_of);
        if (p) parentByChildId.set(it.id, p);
      }
    }
    // Group locations.
    const locsByItem = new Map();
    for (const l of locs) {
      let arr = locsByItem.get(l.item_id);
      if (!arr) { arr = []; locsByItem.set(l.item_id, arr); }
      arr.push(l);
    }
    for (const arr of locsByItem.values()) {
      arr.sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
    }

    S.items = items || [];
    S.locsByItem = locsByItem;
    S.parentByChildId = parentByChildId;
    rebuildVisibleQueue();
  }

  function rebuildVisibleQueue() {
    // Filter rules per the ticket:
    //   * Recount rows only shown to counters OTHER than the
    //     original counter. If we don't know the parent's counter,
    //     show it (server-side check will still reject if we try
    //     to submit).
    //   * "Later" pushes to the end of the visible queue for this
    //     session.
    //   * Anything already counted this session doesn't show up.
    const myName = (S.name || "").trim().toLowerCase();
    const visible = [];
    for (const it of S.items) {
      if (S.countedThisShift.has(it.id)) continue;
      if (it.recount_of) {
        const parent = S.parentByChildId.get(it.id);
        if (parent && parent.counted_by && String(parent.counted_by).trim().toLowerCase() === myName) {
          continue;   // same counter can't recount their own row
        }
      }
      visible.push(it);
    }
    // Later items go to the end.
    visible.sort((a, b) => {
      const al = S.laterIds.has(a.id) ? 1 : 0;
      const bl = S.laterIds.has(b.id) ? 1 : 0;
      if (al !== bl) return al - bl;
      // Then tier order: hot -> runway -> rotation -> flagged
      const order = { hot: 0, runway: 1, rotation: 2, flagged: 3 };
      const ao = order[a.tier] || 9;
      const bo = order[b.tier] || 9;
      if (ao !== bo) return ao - bo;
      return String(a.assigned_date || "").localeCompare(String(b.assigned_date || ""));
    });
    S.queue = visible;
    S.total = visible.length + S.countedThisShift.size;
    S.counted = S.countedThisShift.size;
    renderHome();
  }

  // ---------------------------------------------------------------
  // RETRY QUEUE
  // ---------------------------------------------------------------
  function loadRetryQueue() {
    try { S.retryQueue = JSON.parse(localStorage.getItem(LS_QUEUE) || "[]") || []; }
    catch (_) { S.retryQueue = []; }
    renderRetryPill();
  }
  function saveRetryQueue() {
    try { localStorage.setItem(LS_QUEUE, JSON.stringify(S.retryQueue)); }
    catch (_) {}
    renderRetryPill();
  }
  function renderRetryPill() {
    const p = $("retry-pill");
    if (!p) return;
    if (S.retryQueue.length === 0) { p.classList.remove("on"); return; }
    p.textContent = S.retryQueue.length + " saving...";
    p.classList.add("on");
  }
  async function drainRetryQueue() {
    if (S.retryQueue.length === 0) return;
    const batch = S.retryQueue.slice(0, 20);
    const ok = await postWrite(batch);
    if (ok && ok.ok) {
      S.retryQueue = S.retryQueue.slice(batch.length);
      saveRetryQueue();
      if (S.retryQueue.length > 0) setTimeout(drainRetryQueue, 500);
    } else {
      // Try again later.
      if (S.retryTimer) clearTimeout(S.retryTimer);
      S.retryTimer = setTimeout(drainRetryQueue, 10000);
    }
  }

  async function postWrite(writes) {
    try {
      const resp = await fetch("/.netlify/functions/cycle-count-write", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-fs-edit-token": CFG.FS_EDIT_TOKEN,
          "x-app-build": String(CFG.APP_BUILD || 0),
        },
        body: JSON.stringify({ writes }),
      });
      const text = await resp.text();
      let json = null; try { json = JSON.parse(text); } catch (_) {}
      if (!resp.ok) return { ok: false, status: resp.status, error: (json && json.error) || text.slice(0, 120) };
      return json || { ok: true };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  }

  function queueForRetry(op) {
    S.retryQueue.push(op);
    saveRetryQueue();
    if (S.retryTimer) clearTimeout(S.retryTimer);
    S.retryTimer = setTimeout(drainRetryQueue, 1000);
  }

  // ---------------------------------------------------------------
  // RENDER -- HOME
  // ---------------------------------------------------------------
  function renderHome() {
    show("screen-home");
    // Progress ring.
    const done = S.counted;
    const total = Math.max(S.total, done);
    const pct = total > 0 ? done / total : 0;
    const CIRC = 2 * Math.PI * 52; // 326.7
    $("ring-fg").style.strokeDasharray = String(CIRC);
    $("ring-fg").style.strokeDashoffset = String(CIRC * (1 - pct));
    $("ring-num").textContent = `${done} of ${total}`;

    const slot = $("next-card-slot");
    const next = S.queue[0];
    if (!next) {
      slot.innerHTML = `
        <div class="empty-state">
          <div class="big">🎉</div>
          <h2>Queue clear</h2>
          <p class="dim">Nothing pending for you right now. Pull to refresh or check back after the next assignment run.</p>
          <button class="btn-primary" style="max-width:280px;margin-top:16px" id="home-refresh">Refresh</button>
        </div>`;
      $("home-refresh").onclick = () => refresh().catch(err => showError(err.message));
      return;
    }
    const locs = S.locsByItem.get(next.id) || [];
    const binCount = locs.length;
    slot.innerHTML = `
      <div class="part-card">
        <div class="part-pn mono">${esc(next.pn)}</div>
        <div class="part-desc">${esc(next.desc || "(no description)")}</div>
        <div class="chip-row">
          ${tierChip(next)}
          ${partClsChip(next)}
          ${binCount > 0 ? `<span class="chip">${binCount} bin${binCount === 1 ? "" : "s"}</span>` : `<span class="chip">single total</span>`}
        </div>
        <div class="part-reason ${next.recount_of ? "recount" : ""}">${esc(humanReason(next))}</div>
      </div>
      <div style="height:12px"></div>
      <button class="btn-primary" id="btn-start">START COUNT</button>
      <div class="secondary-row">
        <button id="btn-skip">Skip</button>
        <button id="btn-later">Later</button>
      </div>
    `;
    $("btn-start").onclick = () => startCount(next.id);
    $("btn-skip").onclick  = () => openSkipModal(next.id);
    $("btn-later").onclick = () => laterItem(next.id);
  }

  function laterItem(itemId) {
    S.laterIds.add(itemId);
    try { localStorage.setItem(LS_LATER, JSON.stringify([...S.laterIds])); } catch (_) {}
    rebuildVisibleQueue();
  }

  // ---------------------------------------------------------------
  // COUNT SCREEN
  // ---------------------------------------------------------------
  function startCount(itemId) {
    const item = S.items.find(i => i.id === itemId);
    if (!item) return;
    S.activeItemId = itemId;
    S.binIdx = 0;
    S.extraBins = [];
    const locs = (S.locsByItem.get(itemId) || []).map(l => ({
      location: l.location,
      location_desc: l.location_desc || "",
      system: Number(l.system_qty_at_assign) || 0,
      entered: "",
    }));
    S.binValues = locs;
    renderCountScreen();
  }
  function renderCountScreen() {
    const item = S.items.find(i => i.id === S.activeItemId);
    if (!item) return;
    show("screen-count");
    $("count-pn").textContent = item.pn;
    $("count-desc").textContent = item.desc || "";
    const body = $("count-body");

    if (S.binValues.length === 0 && S.extraBins.length === 0) {
      // Single-total flow.
      $("bin-progress").textContent = item.recount_of ? "RECOUNT" : "";
      body.innerHTML = `
        <div class="system-say" ${item.recount_of ? 'style="visibility:hidden"' : ''}>
          <div class="label">System says</div>
          <div class="num" id="sys-say">${item.recount_of ? "?" : Math.round(item.system_qty_at_assign)}</div>
        </div>
        <div class="count-input-wrap">
          <input class="count-input" id="qty-input" type="number" inputmode="numeric" min="0" step="1" placeholder="0" value="" />
          <div class="quick-btns">
            <button class="quick-btn zero" data-set="0">0</button>
            <button class="quick-btn" data-inc="1">+1</button>
            <button class="quick-btn" data-inc="3">+3</button>
            <button class="quick-btn" data-inc="12">+12</button>
          </div>
        </div>
      `;
      const input = $("qty-input");
      const updateSubmit = () => { $("count-submit").disabled = input.value === ""; };
      input.oninput = updateSubmit;
      body.querySelectorAll(".quick-btn").forEach(b => b.onclick = () => {
        if (b.dataset.set != null) input.value = b.dataset.set;
        else {
          const cur = Number(input.value) || 0;
          input.value = String(cur + Number(b.dataset.inc || 0));
        }
        updateSubmit();
      });
      updateSubmit();
      $("count-submit").textContent = "SUBMIT";
      $("count-submit").onclick = () => submitSingle(item, Math.max(0, Math.round(Number(input.value) || 0)));
      setTimeout(() => input.focus(), 50);
      return;
    }

    // Multi-bin flow -- one bin at a time.
    const allBins = S.binValues.concat(S.extraBins.map(e => ({ ...e, isExtra: true })));
    const total = allBins.length;
    if (S.binIdx >= total) S.binIdx = total - 1;
    const cur = allBins[S.binIdx];
    $("bin-progress").textContent = `bin ${S.binIdx + 1} of ${total}${item.recount_of ? " (RECOUNT)" : ""}`;
    const runningTotal = allBins.reduce((s, b) => s + (Number(b.entered) || 0), 0);
    const allFilled = allBins.every(b => b.entered !== "");
    body.innerHTML = `
      <div class="bin-header">
        <div class="bin-label">Location</div>
        <div class="bin-code mono">${esc(cur.location || "(unnamed)")}</div>
        ${cur.location_desc ? `<div class="bin-desc">${esc(cur.location_desc)}</div>` : ""}
      </div>
      <div class="system-say" ${item.recount_of ? 'style="visibility:hidden"' : ''}>
        <div class="label">System says</div>
        <div class="num">${item.recount_of ? "?" : Math.round(cur.system)}</div>
      </div>
      <div class="count-input-wrap">
        <input class="count-input" id="qty-input" type="number" inputmode="numeric" min="0" step="1" placeholder="0" value="${esc(cur.entered)}" />
        <div class="quick-btns">
          <button class="quick-btn zero" data-set="0">0</button>
          <button class="quick-btn" data-inc="1">+1</button>
          <button class="quick-btn" data-inc="3">+3</button>
          <button class="quick-btn" data-inc="12">+12</button>
        </div>
      </div>
      <div class="running-total">running total <span class="num" id="run-total">${runningTotal}</span></div>
      <div class="bin-nav">
        <button id="bin-prev" ${S.binIdx === 0 ? "disabled" : ""}>&larr; Prev</button>
        <button id="bin-next" class="btn-primary" style="font-size:18px;min-height:56px">${S.binIdx === total - 1 ? "Last bin" : "Next &rarr;"}</button>
      </div>
      <button class="found-elsewhere-btn" id="btn-found">+ Found stock somewhere else</button>
    `;
    const input = $("qty-input");
    const setEntered = (v) => {
      cur.entered = v;
      const newTotal = allBins.reduce((s, b) => s + (Number(b.entered) || 0), 0);
      $("run-total").textContent = newTotal;
      const filled = allBins.every(b => b.entered !== "");
      $("count-submit").disabled = !filled;
    };
    input.oninput = () => setEntered(input.value);
    body.querySelectorAll(".quick-btn").forEach(b => b.onclick = () => {
      if (b.dataset.set != null) { input.value = b.dataset.set; setEntered("0"); }
      else {
        const nxt = (Number(input.value) || 0) + Number(b.dataset.inc || 0);
        input.value = String(nxt); setEntered(String(nxt));
      }
    });
    $("bin-prev").onclick = () => { S.binIdx = Math.max(0, S.binIdx - 1); renderCountScreen(); };
    $("bin-next").onclick = () => {
      if (S.binIdx < total - 1) { S.binIdx += 1; renderCountScreen(); }
    };
    $("btn-found").onclick = () => openFoundElsewhere();
    $("count-submit").textContent = allFilled ? "SUBMIT" : `Fill all ${total} bins to submit`;
    $("count-submit").disabled = !allFilled;
    $("count-submit").onclick = () => submitMulti(item);
    setTimeout(() => input.focus(), 50);
  }
  function openFoundElsewhere() {
    const locName = prompt("Location code for the extra stock (e.g. R12/A03):", "");
    if (locName === null) return;
    const clean = String(locName || "").trim();
    if (!clean) { flash("Location required"); return; }
    S.extraBins.push({ location: clean, location_desc: "", system: 0, entered: "" });
    S.binIdx = S.binValues.length + S.extraBins.length - 1;
    renderCountScreen();
  }

  // ---------------------------------------------------------------
  // SUBMIT
  // ---------------------------------------------------------------
  async function submitSingle(item, counted) {
    if (item.recount_of) {
      const parent = S.parentByChildId.get(item.id);
      if (parent && parent.counted_by && String(parent.counted_by).trim().toLowerCase() === S.name.trim().toLowerCase()) {
        flash("Recount needs a different counter than " + parent.counted_by);
        return;
      }
    }
    const op = {
      op: "submitCount",
      itemId: item.id,
      counted_qty: counted,
      counted_by: S.name,
    };
    const res = await postWrite([op]);
    handleSubmitResult(item, item.system_qty_at_assign, counted, res, op);
  }
  async function submitMulti(item) {
    const all = S.binValues.concat(S.extraBins.map(e => ({ ...e, isExtra: true })));
    const sum = all.reduce((s, b) => s + Math.max(0, Math.round(Number(b.entered) || 0)), 0);
    const locations = all.map(b => {
      const row = { location: b.location, counted_qty: Math.max(0, Math.round(Number(b.entered) || 0)) };
      if (b.isExtra) row.foundElsewhere = true;
      return row;
    });
    if (item.recount_of) {
      const parent = S.parentByChildId.get(item.id);
      if (parent && parent.counted_by && String(parent.counted_by).trim().toLowerCase() === S.name.trim().toLowerCase()) {
        flash("Recount needs a different counter than " + parent.counted_by);
        return;
      }
    }
    const op = {
      op: "submitCount",
      itemId: item.id,
      counted_qty: sum,
      counted_by: S.name,
      locations,
    };
    const res = await postWrite([op]);
    handleSubmitResult(item, item.system_qty_at_assign, sum, res, op);
  }
  function handleSubmitResult(item, sys, counted, res, op) {
    if (!res || !res.ok) {
      // Retry queue -- keep the entered values visible; user can
      // tap SUBMIT again once online. We ALSO queue the op so if
      // they close the tab it'll retry on the next load.
      queueForRetry(op);
      flash("Save failed -- queued for retry", 3500);
      return;
    }
    const r = (res.results && res.results[0]) || {};
    if (r.ok === false) {
      flash("Rejected: " + (r.error || "unknown"), 4500);
      return;
    }
    S.countedThisShift.add(item.id);
    // Result screen.
    const rs = $("result-screen");
    rs.classList.remove("match", "off", "recount");
    if (r.status === "recount") {
      rs.classList.add("recount");
      $("result-icon").textContent = "🔁";
      $("result-headline").textContent = "Recount needed";
      $("result-sub").textContent = `Off by ${Math.abs(counted - sys)}. Another counter will verify.`;
      $("result-hint").textContent = "logged. moving on...";
    } else if (inTol(sys, counted)) {
      rs.classList.add("match");
      $("result-icon").textContent = "✅";
      $("result-headline").textContent = "Matches";
      $("result-sub").textContent = `Counted ${counted}`;
      $("result-hint").textContent = "logged. next part loading...";
    } else {
      rs.classList.add("off");
      $("result-icon").textContent = "⚠";
      $("result-headline").textContent = `Off by ${counted - sys > 0 ? "+" : ""}${counted - sys}`;
      $("result-sub").textContent = `Counted ${counted} vs system ${sys}. Logged; if it stays off, someone else will recount.`;
      $("result-hint").textContent = "next part loading...";
    }
    rs.classList.add("on");
    setTimeout(() => {
      rs.classList.remove("on");
      rebuildVisibleQueue();
      // Ensure home shows next.
      renderHome();
      // Fetch again in the background so recount rows / new
      // assignments land without a manual refresh.
      refresh().catch(() => {});
    }, RESULT_ADVANCE_MS);
  }

  // ---------------------------------------------------------------
  // SKIP
  // ---------------------------------------------------------------
  function openSkipModal(itemId) {
    S.activeItemId = itemId;
    S.skipReason = null;
    $("skip-note").value = "";
    $("skip-confirm").disabled = true;
    document.querySelectorAll(".reason-grid button").forEach(b => b.classList.remove("on"));
    $("skip-modal").classList.add("on");
  }
  function closeSkipModal() { $("skip-modal").classList.remove("on"); }
  async function confirmSkip() {
    if (!S.skipReason || !S.activeItemId) return;
    const note = ($("skip-note").value || "").trim();
    const fullReason = note ? (S.skipReason + " -- " + note) : S.skipReason;
    const op = { op: "skip", itemId: S.activeItemId, reason: fullReason };
    const res = await postWrite([op]);
    if (!res || !res.ok) { queueForRetry(op); flash("Skip queued for retry"); }
    else if (res.results && res.results[0] && res.results[0].ok === false) {
      flash("Rejected: " + res.results[0].error, 4500);
      return;
    }
    S.countedThisShift.add(S.activeItemId);
    closeSkipModal();
    rebuildVisibleQueue();
  }

  // ---------------------------------------------------------------
  // BOOT + POLL
  // ---------------------------------------------------------------
  async function refresh() { await fetchQueue(); }
  function startPoll() {
    if (S.pollTimer) clearInterval(S.pollTimer);
    S.pollTimer = setInterval(() => refresh().catch(() => {}), POLL_MS);
  }

  function showError(msg) {
    show("screen-error");
    $("error-msg").textContent = msg || "";
  }

  async function boot() {
    // Load per-session "later" set.
    try { const later = JSON.parse(localStorage.getItem(LS_LATER) || "[]"); S.laterIds = new Set(later); } catch (_) {}
    loadRetryQueue();
    if (S.retryQueue.length > 0) drainRetryQueue();
    try { initSupabase(); }
    catch (err) { showError(err.message); return; }
    const nameOk = resolveName();
    // Wire chip + modals + count-screen back button + skip modal.
    $("name-chip").onclick = openNameModal;
    $("name-input").oninput = () => { $("name-save").disabled = !$("name-input").value.trim(); };
    $("name-save").onclick = () => {
      const v = $("name-input").value.trim(); if (!v) return;
      S.name = v; try { localStorage.setItem(LS_NAME, v); } catch (_) {}
      $("name-chip").textContent = v;
      closeNameModal();
      if (!S.items.length) refresh().catch(err => showError(err.message));
      else rebuildVisibleQueue();
    };
    document.querySelectorAll(".reason-grid button").forEach(b => b.onclick = () => {
      document.querySelectorAll(".reason-grid button").forEach(x => x.classList.remove("on"));
      b.classList.add("on"); S.skipReason = b.dataset.reason; $("skip-confirm").disabled = false;
    });
    $("skip-cancel").onclick = closeSkipModal;
    $("skip-confirm").onclick = confirmSkip;
    $("count-back").onclick = () => { S.activeItemId = null; renderHome(); };
    $("count-skip").onclick = () => openSkipModal(S.activeItemId);

    if (!nameOk) {
      // Wait for name input; queue will render after save.
      return;
    }
    try { await refresh(); }
    catch (err) { showError(err.message); return; }
    startPoll();
    // Re-drain retry queue on visibility change (came back from lock).
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        drainRetryQueue();
        refresh().catch(() => {});
      }
    });
  }
  document.addEventListener("DOMContentLoaded", boot);
})();
