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

   Attribution (NOT auth):
     * Everyone uses the same /count URL. On first load the page
       prompts for a name; the answer is kept in localStorage and
       stamped on every counted_by field. Tap the name chip at
       the top of any screen to change it.
     * The name is REQUIRED before the first submit -- postWrite
       rejects a blank counted_by and the server-side blind-
       recount rule (recount must be a different counter than the
       original) depends on the value being real.
     * Anyone can type any name; this is stamping, not identity
       verification. Real identity belongs to whatever IdP wraps
       the Netlify site, not this page.
   ===================================================== */

(function () {
  "use strict";

  // ---------------------------------------------------------------
  // CONFIG
  // ---------------------------------------------------------------
  const CFG = window.CC_CONFIG || {};
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
  // v-cc-retry-honest: after this many APPLICATION-level failures
  // (server accepted the batch, returned ok:false on this op --
  // "not found", "recount by different counter", "counted_qty !=
  // sum(locations)", etc.), stop auto-retrying and demand a human
  // decision via the red pill / failure modal. Transport failures
  // (offline, HTTP 500, timeout) keep retrying silently forever.
  const APP_FAIL_CAP = 2;

  // ---------------------------------------------------------------
  // STATE
  // ---------------------------------------------------------------
  const S = {
    name: null,
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
    const raw = String(item.reason || "");
    const r = raw.toLowerCase();
    // v-cc-loc-8 / v-cc-loc-9 -- supervisor-driven reasons:
    //   "supervisor requested recount [(via NAME)][: NOTE]"
    //     -- fired by _ccRequestRecount (recount child; blind rule)
    //   "supervisor sent back out [(via NAME)][: NOTE]"
    //     -- fired by _ccReassignFromSkip (item flipped back to
    //     pending after a skip; NO blind rule -- any counter, incl
    //     the one who skipped it, may pick it up).
    // Both extract the NOTE (everything after the first ": ") so
    // the counter sees the exact ask.
    if (r.startsWith("supervisor requested recount") || r.startsWith("supervisor sent back out")) {
      const colon = raw.indexOf(": ");
      const note = colon >= 0 ? raw.slice(colon + 2).trim() : "";
      const isRecount = r.startsWith("supervisor requested recount");
      const base = isRecount
        ? (item.recount_of
            ? "Supervisor sent this back out. Recount -- don't peek at the prior count."
            : "Supervisor asked for a recount.")
        : "Supervisor sent this back out after a skip. Try again with fresh eyes.";
      return note ? base + " Note: " + note : base;
    }
    if (item.recount_of) return "Recount -- don't peek at the prior count. Fresh eyes only.";
    if (r.startsWith("operator flag")) return "Someone on the line flagged this. Check what they found.";
    if (r.startsWith("chain handoff at risk")) return "Chain handoff at risk -- count this AND its partner. Both ends matter.";
    if (r.startsWith("final part of its chain")) return "Final part of its chain -- no successor coming. This count is the only safety net.";
    if (r.startsWith("chain active member")) return "Active chain member -- verify what's on the shelf.";
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
  // NAME
  // Single flow: read from localStorage, else prompt. The chip in
  // the top bar taps back into the same modal so a shared tablet
  // can be handed off between counters without a reload.
  // ---------------------------------------------------------------
  function resolveName() {
    try {
      const v = localStorage.getItem(LS_NAME);
      if (v && v.trim()) { S.name = v.trim(); $("name-chip").textContent = S.name; return true; }
    } catch (_) {}
    openNameModal();
    return false;
  }
  function openNameModal() {
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
    // v-cc-mobile-perf: today's queue only + open recounts.
    // Prior: 30-day sweep + full location snapshot for every
    // item + parts desc fetch -- ~4 round-trips before first
    // paint even when the queue is short.
    // Now: single items fetch (today OR status=recount) + a
    // small parents/descs fetch keyed on what we actually got.
    // Location snapshots are fetched on-demand in startCount.
    const today = new Date().toISOString().slice(0, 10);
    const { data: items, error: e1 } = await S.supa
      .from("cycle_count_items")
      .select("id, pn, tier, reason, system_qty_at_assign, status, recount_of, note, assigned_date, counted_by")
      .in("status", ["pending", "recount"])
      .or(`assigned_date.eq.${today},status.eq.recount`)
      .order("tier", { ascending: true })
      .order("assigned_date", { ascending: true });
    if (e1) throw new Error("items fetch failed: " + e1.message);
    // Preserve any location snapshots we already cached for
    // items still in the queue -- so an opened card doesn't
    // re-fetch its bins on every 30s poll tick.
    const keepIds = new Set((items || []).map(r => r.id));
    const carriedLocs = new Map();
    for (const [id, arr] of S.locsByItem.entries()) {
      if (keepIds.has(id)) carriedLocs.set(id, arr);
    }
    // Parents + descs in parallel (both bounded to what we
    // actually have; both tolerate 0-length arrays).
    const parentIds = [...new Set((items || []).map(r => r.recount_of).filter(Boolean))];
    const partPns   = [...new Set((items || []).map(r => r.pn))];
    const [parents, descByPn] = await Promise.all([
      _fetchParentsMinimal(parentIds),
      _fetchPartMetaMinimal(partPns),
    ]);

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

    S.items = items || [];
    S.locsByItem = carriedLocs;   // lazy-populated on startCount
    S.parentByChildId = parentByChildId;
    rebuildVisibleQueue();
  }
  async function _fetchParentsMinimal(parentIds) {
    if (!parentIds || parentIds.length === 0) return [];
    const out = [];
    for (let i = 0; i < parentIds.length; i += 200) {
      const batch = parentIds.slice(i, i + 200);
      const { data } = await S.supa
        .from("cycle_count_items")
        .select("id, counted_by, counted_qty")
        .in("id", batch);
      if (data) out.push(...data);
    }
    return out;
  }
  async function _fetchPartMetaMinimal(partPns) {
    const m = new Map();
    if (!partPns || partPns.length === 0) return m;
    for (let i = 0; i < partPns.length; i += 200) {
      const batch = partPns.slice(i, i + 200);
      const { data } = await S.supa
        .from("parts")
        .select("pn, data")
        .in("pn", batch);
      if (data) {
        for (const p of data) m.set(p.pn, { desc: (p.data && p.data.desc) || "", cls: (p.data && p.data.partClass) || "" });
      }
    }
    return m;
  }
  async function _ensureLocationsFor(itemId) {
    if (S.locsByItem.has(itemId)) return S.locsByItem.get(itemId);
    const { data, error } = await S.supa
      .from("cycle_count_item_locations")
      .select("id, item_id, location, location_desc, system_qty_at_assign")
      .eq("item_id", itemId);
    if (error) { console.warn("[cc-mobile] locations fetch failed:", error.message); return []; }
    const arr = (data || []).slice().sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));
    S.locsByItem.set(itemId, arr);
    return arr;
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
  //
  // Entry shape: { op, attempts, appFailures, lastError }
  //   - attempts:    transport retries (fetch fell over, HTTP !ok)
  //   - appFailures: server accepted the batch but returned
  //                  ok:false on this op (rejected). We cap at
  //                  APP_FAIL_CAP so the pill can go red instead
  //                  of silently retrying forever.
  //   - lastError:   the server-provided text, shown in the
  //                  failure modal.
  //
  // v-cc-idem: every op carries client_key from _optimisticSubmit,
  // so the server short-circuits a retry to its prior outcome
  // instead of re-writing (would otherwise double-log, spawn a
  // second recount child, etc). Entries dedupe on client_key so a
  // retry-of-a-retry updates metadata rather than stacking.
  // ---------------------------------------------------------------
  function _newClientKey() {
    try {
      if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    } catch (_) {}
    return "ck-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
  }
  function _wrapEntry(op) {
    return { op, attempts: 0, appFailures: 0, lastError: null };
  }
  function loadRetryQueue() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_QUEUE) || "[]") || [];
      // Backfill: pre-v-cc-retry-honest entries were bare ops.
      S.retryQueue = raw.map(x => {
        if (x && typeof x === "object" && x.op && typeof x.op === "object") {
          return {
            op: x.op,
            attempts: Number(x.attempts) || 0,
            appFailures: Number(x.appFailures) || 0,
            lastError: x.lastError || null,
          };
        }
        // Assume x is a bare op.
        return _wrapEntry(x);
      });
    } catch (_) { S.retryQueue = []; }
    renderRetryPill();
  }
  function saveRetryQueue() {
    try { localStorage.setItem(LS_QUEUE, JSON.stringify(S.retryQueue)); }
    catch (_) {}
    renderRetryPill();
  }
  function _pillLabel() {
    const failed = S.retryQueue.filter(e => (e.appFailures || 0) >= APP_FAIL_CAP);
    const saving = S.retryQueue.length - failed.length;
    return { failed: failed.length, saving };
  }
  function renderRetryPill() {
    const p = $("retry-pill");
    if (!p) return;
    p.classList.remove("failed");
    p.onclick = null;
    if (S.retryQueue.length === 0) { p.classList.remove("on"); return; }
    const { failed, saving } = _pillLabel();
    if (failed > 0) {
      p.textContent = failed + " failed -- tap for details";
      p.classList.add("failed");
      p.onclick = openFailureModal;
      p.classList.add("on");
      return;
    }
    p.textContent = saving + " saving...";
    p.classList.add("on");
  }
  async function drainRetryQueue() {
    if (S.retryQueue.length === 0) return;
    // Only touch entries that haven't hit the app-failure cap;
    // capped ones sit there until a human retries via the modal.
    const draftable = S.retryQueue.filter(e => (e.appFailures || 0) < APP_FAIL_CAP);
    if (draftable.length === 0) { renderRetryPill(); return; }
    const batch = draftable.slice(0, 20);
    const resp = await postWrite(batch.map(e => e.op));
    if (!resp || resp.transportError) {
      // Network / HTTP failure -- keep retrying silently.
      for (const e of batch) e.attempts = (e.attempts || 0) + 1;
      if (resp && resp.error) for (const e of batch) e.lastError = resp.error;
      saveRetryQueue();
      if (S.retryTimer) clearTimeout(S.retryTimer);
      S.retryTimer = setTimeout(drainRetryQueue, 10000);
      return;
    }
    // Batch reached the server. Inspect per-op outcomes.
    const results = Array.isArray(resp.results) ? resp.results : [];
    const succeeded = new Set();   // entries to remove
    for (let idx = 0; idx < batch.length; idx++) {
      const r = results[idx];
      if (r && r.ok === true) {
        succeeded.add(batch[idx]);
      } else {
        batch[idx].appFailures = (batch[idx].appFailures || 0) + 1;
        batch[idx].lastError = String((r && r.error) || "server returned no result");
      }
    }
    if (succeeded.size > 0) {
      S.retryQueue = S.retryQueue.filter(e => !succeeded.has(e));
    }
    saveRetryQueue();
    // Continue draining if anything else is still draftable.
    const stillDraftable = S.retryQueue.some(e => (e.appFailures || 0) < APP_FAIL_CAP);
    if (stillDraftable) {
      if (S.retryTimer) clearTimeout(S.retryTimer);
      S.retryTimer = setTimeout(drainRetryQueue, 500);
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
      if (!resp.ok) {
        // 4xx / 5xx -- transport-ish, not an application decision.
        // Retry silently and don't count against APP_FAIL_CAP.
        return { ok: false, transportError: true, status: resp.status, error: (json && json.error) || text.slice(0, 200) };
      }
      // Batch reached us; per-op ok booleans decide the rest.
      return json || { ok: true, results: [] };
    } catch (err) {
      // fetch threw (offline, DNS, TLS, etc.)
      return { ok: false, transportError: true, error: err.message || String(err) };
    }
  }

  function queueForRetry(op, meta) {
    meta = meta || {};
    // Dedupe on client_key -- same submit fingerprint from two
    // paths shouldn't stack.
    const key = op && op.client_key;
    const existingIdx = key ? S.retryQueue.findIndex(e => e && e.op && e.op.client_key === key) : -1;
    if (existingIdx >= 0) {
      const cur = S.retryQueue[existingIdx];
      if (meta.appFail) {
        cur.appFailures = (cur.appFailures || 0) + 1;
        if (meta.error) cur.lastError = meta.error;
      } else {
        cur.attempts = (cur.attempts || 0) + 1;
        if (meta.error) cur.lastError = meta.error;
      }
    } else {
      const entry = _wrapEntry(op);
      if (meta.appFail) { entry.appFailures = 1; entry.lastError = meta.error || "unknown"; }
      else { entry.attempts = 1; entry.lastError = meta.error || null; }
      S.retryQueue.push(entry);
    }
    saveRetryQueue();
    if (S.retryTimer) clearTimeout(S.retryTimer);
    S.retryTimer = setTimeout(drainRetryQueue, 1000);
  }

  // ---------------------------------------------------------------
  // FAILURE MODAL
  // ---------------------------------------------------------------
  function openFailureModal() {
    const modal = $("fail-modal");
    if (!modal) return;
    const body = $("fail-list");
    const failed = S.retryQueue.filter(e => (e.appFailures || 0) >= APP_FAIL_CAP);
    if (failed.length === 0) { modal.classList.remove("on"); return; }
    body.innerHTML = failed.map((e, idx) => {
      const op = e.op || {};
      const pn = esc(op.pn || (op.itemId ? "item " + op.itemId.slice(0, 8) : "(unknown)"));
      const kind = op.op === "submitCount" ? ("count " + (op.counted_qty != null ? op.counted_qty : ""))
                 : op.op === "skip" ? ("skip: " + (op.reason || ""))
                 : (op.op || "op");
      return `
        <div class="fail-row" data-idx="${idx}">
          <div class="fail-hd"><span class="mono">${pn}</span> <span class="dim">${esc(kind)}</span></div>
          <div class="fail-err">${esc(e.lastError || "unknown error")}</div>
          <div class="fail-actions">
            <button class="btn-ghost" data-act="retry" data-idx="${idx}">Retry</button>
            <button class="btn-ghost" data-act="discard" data-idx="${idx}">Discard</button>
          </div>
        </div>`;
    }).join("");
    body.querySelectorAll("button[data-act]").forEach(btn => {
      btn.onclick = () => {
        const act = btn.getAttribute("data-act");
        const idx = Number(btn.getAttribute("data-idx"));
        const target = failed[idx];
        if (!target) return;
        if (act === "retry") {
          // Reset the app-failure count so drainRetryQueue picks
          // it up again -- attempts is preserved for diagnostics.
          target.appFailures = 0;
          saveRetryQueue();
          drainRetryQueue();
          openFailureModal();  // refresh list
        } else if (act === "discard") {
          if (!confirm("Discard this failed submit? It will NOT be sent.")) return;
          S.retryQueue = S.retryQueue.filter(x => x !== target);
          // Also let the counter re-count this item if they want.
          if (target.op && target.op.itemId) S.countedThisShift.delete(target.op.itemId);
          saveRetryQueue();
          openFailureModal();
          rebuildVisibleQueue();
        }
      };
    });
    modal.classList.add("on");
  }
  function closeFailureModal() {
    const modal = $("fail-modal");
    if (modal) modal.classList.remove("on");
  }
  if (typeof window !== "undefined") window._ccCloseFailureModal = closeFailureModal;

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
    // v-cc-loc-5 fix 1c -- compact bin list under the description so
    // the counter can plan their walk before tapping START. Up to
    // 4 bin codes, then "+N more"; "no bin on file" when the pn
    // has no location rows so the counter knows to hunt.
    let binsLine;
    if (binCount === 0) {
      binsLine = `<div class="dim" style="margin: 6px 0 12px; font-size: 15px">No bin on file &mdash; count all stock for this part wherever it lives.</div>`;
    } else {
      const shown = locs.slice(0, 4).map(l => esc(l.location)).join(", ");
      const rest = binCount > 4 ? ` <span class="dim">+${binCount - 4} more</span>` : "";
      binsLine = `<div style="margin: 6px 0 12px; font-size: 15px"><span class="dim">Bins:</span> <span class="mono">${shown}</span>${rest}</div>`;
    }
    // Chip: "1 BIN" when there's exactly one location (not "single
    // total" -- there IS a bin, it's just one); "N BINS" for
    // multi-bin; "NO BIN ON FILE" for aggregate-only.
    const binChip = binCount === 0
      ? `<span class="chip">no bin on file</span>`
      : `<span class="chip">${binCount} bin${binCount === 1 ? "" : "s"}</span>`;
    slot.innerHTML = `
      <div class="part-card">
        <div class="part-pn mono">${esc(next.pn)}</div>
        <div class="part-desc">${esc(next.desc || "(no description)")}</div>
        ${binsLine}
        <div class="chip-row">
          ${tierChip(next)}
          ${partClsChip(next)}
          ${binChip}
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
  async function startCount(itemId) {
    const item = S.items.find(i => i.id === itemId);
    if (!item) return;
    S.activeItemId = itemId;
    S.binIdx = 0;
    S.extraBins = [];
    // Lazy per-card fetch -- initial queue load skips bins so
    // Home paints instantly; we fetch this card's bins the
    // moment the counter taps in.
    const rows = await _ensureLocationsFor(itemId);
    if (S.activeItemId !== itemId) return;  // user backed out
    S.binValues = rows.map(l => ({
      location: l.location,
      location_desc: l.location_desc || "",
      system: Number(l.system_qty_at_assign) || 0,
      entered: "",
    }));
    renderCountScreen();
  }
  function renderCountScreen() {
    const item = S.items.find(i => i.id === S.activeItemId);
    if (!item) return;
    show("screen-count");
    $("count-pn").textContent = item.pn;
    $("count-desc").textContent = item.desc || "";
    const body = $("count-body");

    // v-cc-loc-5 fix 1a/1b -- three modes:
    //
    //   MODE 0 (no bin on file): S.binValues.length === 0 AND
    //     S.extraBins.length === 0. Show a "no bin on file"
    //     explainer where the bin header would be; single-total
    //     input; found-elsewhere still available so a counter who
    //     finds stock can still record the bin they found it in.
    //     Submit routes through submitSingle when no extras exist,
    //     submitMulti when the counter added a found-elsewhere row
    //     (the write function accepts locations[] against an item
    //     with zero snapshot rows -- all inserts go through the
    //     foundElsewhere:true path).
    //
    //   MODE 1 (exactly one bin, no extras): S.binValues.length
    //     === 1 AND S.extraBins.length === 0. Show the bin header
    //     prominently ("LOCATION A-14 (Rack 3)") the same way
    //     multi-bin does. No Prev/Next chrome, no bin-progress
    //     ("bin 1 of 1" would be noise), no running total (it's
    //     the input's value). Found-elsewhere still available.
    //     Submit routes through submitMulti so the count goes
    //     into cycle_count_item_locations with the bin name.
    //
    //   MODE 2 (multi-bin): >=2 bins in either binValues or
    //     extras. Unchanged from prior release -- Prev/Next,
    //     bin-progress indicator, running total.
    const allBins = S.binValues.concat(S.extraBins.map(e => ({ ...e, isExtra: true })));
    const totalBins = allBins.length;

    if (totalBins === 0) {
      // MODE 0: no bin on file.
      $("bin-progress").textContent = item.recount_of ? "RECOUNT" : "";
      body.innerHTML = `
        <div class="bin-header" style="border-color:var(--dim);background:var(--surf-2)">
          <div class="bin-label">Bin</div>
          <div class="bin-code" style="font-size:22px;color:var(--ink-2)">No bin on file</div>
          <div class="bin-desc">Count all stock for this part wherever it lives.</div>
        </div>
        <div class="system-say">
          <div class="label">System says</div>
          <div class="num">${Math.round(item.system_qty_at_assign)}</div>
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
        <button class="found-elsewhere-btn" id="btn-found">+ Found stock in a specific bin</button>
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
      $("btn-found").onclick = () => openFoundElsewhere();
      updateSubmit();
      $("count-submit").textContent = "SUBMIT";
      $("count-submit").onclick = () => submitSingle(item, Math.max(0, Math.round(Number(input.value) || 0)));
      setTimeout(() => input.focus(), 50);
      return;
    }

    if (totalBins === 1) {
      // MODE 1: single bin -- show location context without the
      // multi-bin chrome.
      const cur = allBins[0];
      S.binIdx = 0;
      $("bin-progress").textContent = item.recount_of ? "RECOUNT" : "";
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
        <button class="found-elsewhere-btn" id="btn-found">+ Found stock in another bin</button>
      `;
      const input = $("qty-input");
      const updateSubmit = () => {
        cur.entered = input.value;
        $("count-submit").disabled = input.value === "";
      };
      input.oninput = updateSubmit;
      body.querySelectorAll(".quick-btn").forEach(b => b.onclick = () => {
        if (b.dataset.set != null) input.value = b.dataset.set;
        else input.value = String((Number(input.value) || 0) + Number(b.dataset.inc || 0));
        updateSubmit();
      });
      $("btn-found").onclick = () => openFoundElsewhere();   // adds a bin -> switches to MODE 2 on next render
      $("count-submit").textContent = "SUBMIT";
      $("count-submit").disabled = cur.entered === "";
      $("count-submit").onclick = () => submitMulti(item);
      setTimeout(() => input.focus(), 50);
      return;
    }

    // MODE 2: multi-bin.
    if (S.binIdx >= totalBins) S.binIdx = totalBins - 1;
    const cur = allBins[S.binIdx];
    $("bin-progress").textContent = `bin ${S.binIdx + 1} of ${totalBins}${item.recount_of ? " (RECOUNT)" : ""}`;
    const runningTotal = allBins.reduce((s, b) => s + (Number(b.entered) || 0), 0);
    const allFilled = allBins.every(b => b.entered !== "");
    body.innerHTML = `
      <div class="bin-header">
        <div class="bin-label">Location</div>
        <div class="bin-code mono">${esc(cur.location || "(unnamed)")}</div>
        ${cur.location_desc ? `<div class="bin-desc">${esc(cur.location_desc)}</div>` : ""}
      </div>
      <div class="system-say">
        <div class="label">System says</div>
        <div class="num">${Math.round(cur.system)}</div>
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
        <button id="bin-next" class="btn-primary" style="font-size:18px;min-height:56px">${S.binIdx === totalBins - 1 ? "Last bin" : "Next &rarr;"}</button>
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
      if (S.binIdx < totalBins - 1) { S.binIdx += 1; renderCountScreen(); }
    };
    $("btn-found").onclick = () => openFoundElsewhere();
    $("count-submit").textContent = allFilled ? "SUBMIT" : `Fill all ${totalBins} bins to submit`;
    $("count-submit").disabled = !allFilled;
    $("count-submit").onclick = () => submitMulti(item);
    setTimeout(() => input.focus(), 50);
  }
  function openFoundElsewhere() {
    const locName = prompt("Location code for the extra stock (e.g. R12/A03):", "");
    if (locName === null) return;
    const clean = String(locName || "").trim();
    if (!clean) { flash("Location required"); return; }
    // v-cc-loc-5 -- if we're in MODE 0 (no bin on file) with a
    // typed total, promote it to an "(unspecified)" bin so the
    // switch into bin-mode doesn't lose the counter's work.
    // Server accepts arbitrary location strings under foundElsewhere.
    if (S.binValues.length === 0 && S.extraBins.length === 0) {
      const typedInput = document.getElementById("qty-input");
      const typed = typedInput ? String(typedInput.value || "").trim() : "";
      if (typed !== "") {
        S.extraBins.push({ location: "(unspecified)", location_desc: "counted before adding bin detail", system: 0, entered: typed });
      }
    }
    S.extraBins.push({ location: clean, location_desc: "", system: 0, entered: "" });
    S.binIdx = S.binValues.length + S.extraBins.length - 1;
    renderCountScreen();
  }

  // ---------------------------------------------------------------
  // SUBMIT
  // ---------------------------------------------------------------
  function submitSingle(item, counted) {
    if (item.recount_of) {
      const parent = S.parentByChildId.get(item.id);
      if (parent && parent.counted_by && String(parent.counted_by).trim().toLowerCase() === S.name.trim().toLowerCase()) {
        flash("Recount needs a different counter than " + parent.counted_by);
        return;
      }
    }
    const op = { op: "submitCount", itemId: item.id, counted_qty: counted, counted_by: S.name };
    _optimisticSubmit(item, item.system_qty_at_assign, counted, op);
  }
  function submitMulti(item) {
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
    const op = { op: "submitCount", itemId: item.id, counted_qty: sum, counted_by: S.name, locations };
    _optimisticSubmit(item, item.system_qty_at_assign, sum, op);
  }
  function _optimisticSubmit(item, sys, counted, op) {
    // v-cc-idem: stamp a per-attempt-set idempotency key BEFORE
    // any network call so a retry (from here OR from the drain
    // path after a transport failure) uses the SAME key and the
    // server short-circuits to the prior outcome instead of
    // re-writing.
    op.client_key = op.client_key || _newClientKey();
    // v-cc-mobile-perf: advance the queue immediately. Local
    // match/off inference is enough to render the result screen
    // (server uses the same tolerance rule); if the server later
    // decides RECOUNT, the recount item reappears in the next
    // fetch for a different counter.
    S.countedThisShift.add(item.id);
    _showResultScreen(item, sys, counted);
    postWrite([op]).then(res => {
      if (!res || res.transportError) {
        // Network / HTTP failure -- silent retry.
        queueForRetry(op, { error: res && res.error });
        return;
      }
      const r = (res.results && res.results[0]) || {};
      if (r.ok === false) {
        // Application rejection -- surface it, count against cap.
        flash("Rejected: " + (r.error || "unknown"), 4500);
        queueForRetry(op, { appFail: true, error: r.error });
      }
      // r.ok === true (including idempotent replay): nothing to do.
    }).catch(err => {
      queueForRetry(op, { error: err && err.message });
    });
  }
  function _showResultScreen(item, sys, counted) {
    const rs = $("result-screen");
    rs.classList.remove("match", "off", "recount");
    if (inTol(sys, counted)) {
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
      renderHome();
      // No inline refresh() here -- the 30s poll (and the
      // visibilitychange refetch on tab wake) keep the queue
      // fresh. One fetch per screen transition, not per tick.
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
    // v-cc-loc-9 -- stamp the skipper's name so the supervisor tab
    // shows WHO skipped in the live feed (was blank prior release).
    const op = { op: "skip", itemId: S.activeItemId, reason: fullReason, counted_by: S.name || "" };
    const res = await postWrite([op]);
    if (!res || res.transportError) {
      queueForRetry(op, { error: res && res.error });
      flash("Skip queued for retry");
    } else {
      const r = (res.results && res.results[0]) || {};
      if (r.ok === false) {
        flash("Rejected: " + (r.error || "unknown"), 4500);
        queueForRetry(op, { appFail: true, error: r.error });
        return;
      }
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
    try { console.time("cc-mobile-boot"); } catch (_) {}
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
    const failClose = $("fail-close");
    if (failClose) failClose.onclick = closeFailureModal;
    $("count-back").onclick = () => { S.activeItemId = null; renderHome(); };
    $("count-skip").onclick = () => openSkipModal(S.activeItemId);

    if (!nameOk) {
      // Wait for name input; queue will render after save.
      try { console.timeEnd("cc-mobile-boot"); } catch (_) {}
      return;
    }
    try { await refresh(); }
    catch (err) { showError(err.message); return; }
    startPoll();
    try { console.timeEnd("cc-mobile-boot"); } catch (_) {}
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
