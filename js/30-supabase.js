/* =====================================================
   30-supabase.js
   Slice 1: Cloud-sync the parts table to Supabase
   ===================================================== */

const SUPABASE_URL = "https://rqvswdxfebhlyouozltk.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJxdnN3ZHhmZWJobHlvdW96bHRrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1Mzk2MTQsImV4cCI6MjA5NDExNTYxNH0.VU1Ciuez8Dh4W4uGA8cgLSZuOPCGPwQXLc5J4y9-h04";

let _supa = null;
let _cloudReady = false;
let _lastCloudDraftHash = null;
// LWW baseline for the draft — the newest updatedAt we've seen (from
// boot, our own push, or a realtime event we accepted). Every draft
// realtime event and every draft push compares against this to reject
// strictly-older writes. A cloud row with no updatedAt (legacy row or
// a foreign write) is treated as the OLDEST possible value so it can
// never beat a fresh timestamped write. Null on boot until cloudInit
// adopts the cloud row's timestamp.
let _lastDraftUpdatedAt = null;
let _lastCloudSettingsHash = null;
let _lastCloudKitBomsHash = null;

// Delta tracking — only push records that actually changed
const _dirtyParts = new Set();    // PNs of parts that changed locally
const _dirtyPos = new Set();      // PO IDs that changed
const _dirtyAudit = new Set();    // audit IDs (new entries only — audit is append-only)
const _dirtyUsage = new Set();    // usage IDs that changed
const _dirtyKitBoms = new Set();  // kit_pns that changed
let _settingsDirty = false;

// Queue-entry stamp tracking. Populated at boot from the sidecar
// queue_entries table + updated in-session on every successful stamp.
// The detector diffs queueParts() against THIS Set — never against a
// nullable field on the part — so once a PN is stamped locally, no
// further INSERT attempts fire from this session. Steady-state cost:
// zero writes, zero broadcasts. See _detectQueueEntries.
const _stampedPns = new Set();

// Last-local-save timestamps (side channel). Complements the _dirty* sets:
// _dirtyParts covers the window [set at mutate] → [cleared when push commits].
// The poll's Promise.all fetch can be in flight during that ENTIRE window
// AND still be resolving after the dirty flag has been cleared — that's the
// clobber race (cause #1). This side channel remembers "the last time this
// key had a local save," so the poll can compare against the moment its
// fetch started and reject an apply for any row saved after that moment,
// even if the dirty flag has since been cleared. Same channel is consulted
// by the realtime handlers to reject a stale echo for a row we just saved
// (own-echo + cross-user variants of the race). NEVER cleared — a stale
// timestamp is harmless (guards fail-open once the fetch/echo is newer
// than the recorded save). Memory footprint tracks part/PO count only.
const _lastLocalSaveAt = { parts: new Map(), pos: new Map(), settings: 0 };

// Realtime echo of my own recent write can arrive after the push clears the
// dirty flag. Any inbound realtime event for a row I saved within this
// window is dropped — my local state is fresher than any echo could carry.
// 5s covers push RTT (~300ms) + Supabase realtime broadcast latency
// (~200-1000ms) with a wide margin. Too short = race reopens; too long =
// legitimate cross-user edits get delayed after I stop typing.
const RECENT_SAVE_MS = 5000;

// Interim double-redraw suppression for Phase 2 Step 3-4. Both propagation
// paths (postgres_changes + broadcast+delta-fetch) are live and deliver
// the same change per row. On the receiving client, postgres_changes
// applies first (~200-400ms after write) and stamps _lastRemoteApplyAt.
// The broadcast flush arrives second (~700-1100ms after write, incl.
// debounce + fetch) and would apply the SAME row and trigger a second
// redraw. Guard: broadcast flush checks this map and skips any row with
// a recent postgres_changes apply — no re-apply, no re-redraw. Under
// Step 5 postgres_changes is removed → nothing stamps → guard never
// fires → broadcast becomes the sole path with a normal single redraw.
// Self-cleaning.
//
// 3s is long enough to cover the typical 400-900ms gap between the two
// paths delivering the same change (plus jitter), short enough that a
// row genuinely changed twice within 3s still gets its second apply
// through — matches the intent of the local-save recency guard.
const RECENT_REMOTE_APPLY_MS = 3000;
const _lastRemoteApplyAt = {
  parts:          new Map(),
  pos:            new Map(),
  settings:       0,                 // single-row table, scalar mirror of _lastLocalSaveAt.settings
  kit_boms:       new Map(),
  follow_marks:   new Map(),
  deleted_parts:  new Map(),
  audit:          new Map(),
  usage:          new Map(),
};

// ── Broadcast listener state (Phase 2 broadcast migration, Step 2) ────
// Parallel to postgres_changes: a lightweight broadcast channel where a
// server- or client-side sync will (in Step 3+) send { tables: [...] }
// pings. On receipt, each named table gets a delta fetch since its
// _lastSeenAt cursor, and the resulting rows are applied through the
// SAME per-table apply logic the postgres_changes handlers use today —
// same guards, same tombstone check, same recency guard, same echo
// skip. Nothing sends broadcasts yet; this listener stays INERT until
// Step 3 wires the senders. The postgres_changes channel remains fully
// functional in parallel.
let _broadcastChannel = null;
// Pending table set is unioned across debounce window. A sync writing
// parts then pos as two separate pings collapses to one fetch pass.
const _broadcastPendingTables = new Set();
let _broadcastTimer = null;
// Set true for the DURATION of a broadcast flush pass. _applyAndRefresh
// short-circuits when set, so the N per-table applies inside the pass
// don't each schedule a debounced redraw — the pass ends with ONE
// _applyAndRefresh() call. Wrapped in try/finally in the flush so a
// throw can never leave the flag stuck.
let _broadcastInProgress = false;
const BROADCAST_DEBOUNCE_MS = 500;
const _partsSnapshot = new Map(); // last-pushed snapshot per PN (also stores audit_<id> markers and __settings__ blob)
const _posSnapshot = new Map();
const _usageSnapshot = new Map(); // separate to avoid overloading _partsSnapshot
const _kitBomsSnapshot = new Map();

// ── Delta-fetch cursors (Phase 2 broadcast migration, Step 1) ─────────
// Per-table high-water marks (ISO strings). Seeded at boot from the max
// updated_at / created_at present after the initial full-scan fetches
// adopt cloud state; advanced by each successful delta fetch that
// consumes it. NEVER reset — a stale cursor just yields a slightly
// larger delta next call, and every apply path is idempotent so a
// re-processed boundary row is a no-op.
//
// Tables using updated_at: parts, pos, settings, kit_boms, follow_marks,
// deleted_parts (BEFORE UPDATE triggers stamp these server-side, so
// Acumatica sync writes advance them too).
//
// Tables using created_at: audit, usage (append-only, never mutated).
//
// draft_order is EXCLUDED: it already has its own LWW envelope
// (data.updatedAt) with `_lastDraftUpdatedAt` gating; broadcasts won't
// touch it.
//
// Nothing consumes _lastSeenAt yet — Step 1 is add-only. The poll and
// realtime handlers still run their existing paths.
const _lastSeenAt = {
  parts:          null,
  pos:            null,
  settings:       null,
  kit_boms:       null,
  follow_marks:   null,
  deleted_parts:  null,
  audit:          null,   // uses created_at (append-only)
  usage:          null,   // uses created_at (append-only)
};

// Wait for the main app to finish booting (DB must exist with parts)
async function _waitForDB() {
  let tries = 0;
  while ((typeof DB === "undefined" || !DB || !Array.isArray(DB.parts)) && tries < 100) {
    await new Promise(r => setTimeout(r, 50));
    tries++;
  }
  return typeof DB !== "undefined" && !!DB;
}

// Fetch ALL parts from Supabase, paging past the default 1000-row limit
async function _fetchAllParts() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("parts")
      .select("pn, data, updated_at")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Fetch ALL POs from Supabase, paginated
async function _fetchAllPos() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("pos")
      .select("id, data")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] pos page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ── Generic delta fetcher (Phase 2, Step 1) ─────────────────────────
// Filters `table` where `tsCol > sinceIso`, orders ASC by tsCol,
// paginates 1000/page. Returns { rows, maxSeenAt }:
//   - rows      : the fetched rows (never null on success; [] if none new)
//   - maxSeenAt : the newest timestamp actually seen in `rows`, or null
//                 when no rows were returned. The caller uses this to
//                 advance _lastSeenAt[table] — a no-op assignment when
//                 null so nothing regresses on an empty tick.
//
// Cursor semantics: strict `>` (not `>=`). A stray sub-microsecond tie
// at the exact cursor boundary would be missed, but Postgres timestamptz
// has µs precision and every apply path is idempotent — worst case is
// one skipped apply that a later heart-beat catch-up re-picks up when
// something else in that row changes.
//
// Failure returns { rows: null, maxSeenAt: null } so the caller can
// distinguish "empty delta" (rows: []) from "fetch failed" (rows: null)
// and refuse to advance the cursor on failure.
async function _fetchSince(table, keyCols, tsCol, sinceIso) {
  if (!_supa) return { rows: [], maxSeenAt: null };
  if (!sinceIso) {
    console.warn(`[cloud] _fetchSince(${table}) called without a cursor — returning empty; seed _lastSeenAt.${table} first`);
    return { rows: [], maxSeenAt: null };
  }
  const rows = [];
  const PAGE = 1000;
  let from = 0;
  let maxSeen = sinceIso;
  while (true) {
    const { data, error } = await _supa
      .from(table)
      .select(`${keyCols}, ${tsCol}`)
      .gt(tsCol, sinceIso)
      .order(tsCol, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error(`[cloud] delta fetch failed for ${table}:`, error);
      return { rows: null, maxSeenAt: null };
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    for (const r of data) {
      const ts = r && r[tsCol];
      if (ts && ts > maxSeen) maxSeen = ts;
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { rows, maxSeenAt: maxSeen === sinceIso ? null : maxSeen };
}

async function _fetchPartsSince(sinceIso)        { return _fetchSince("parts",         "pn, data, updated_at", "updated_at", sinceIso); }
async function _fetchPosSince(sinceIso)          { return _fetchSince("pos",           "id, data",     "updated_at", sinceIso); }
async function _fetchSettingsSince(sinceIso)     { return _fetchSince("settings",      "id, data",     "updated_at", sinceIso); }
async function _fetchKitBomsSince(sinceIso)      { return _fetchSince("kit_boms",      "kit_pn, data", "updated_at", sinceIso); }
async function _fetchFollowMarksSince(sinceIso)  { return _fetchSince("follow_marks",  "id, data",     "updated_at", sinceIso); }
async function _fetchDeletedPartsSince(sinceIso) { return _fetchSince("deleted_parts", "id, data",     "updated_at", sinceIso); }
async function _fetchAuditSince(sinceIso)        { return _fetchSince("audit",         "id, data",     "created_at", sinceIso); }
async function _fetchUsageSince(sinceIso)        { return _fetchSince("usage",         "id, data",     "created_at", sinceIso); }

// ── Boot cursor seeder (Phase 2, Step 1) ────────────────────────────
// One-shot: 8 parallel top-1-desc queries to capture the current max
// timestamp per table. Called from cloudInit AFTER the boot full-scan
// fetches complete, so cursors reflect exactly what boot adopted.
//
// Empty-table cursor: an empty-at-boot table has no max timestamp to
// use, so we bootstrap its cursor to the DATABASE clock (via the
// public.db_now() rpc), NOT the browser clock. The cursor is compared
// against DB-stamped updated_at / created_at values by _fetchSince;
// using the browser clock would open a skew window during which rows
// inserted by another client could carry updated_at < our cursor and
// be permanently missed by the delta path. That matters most for
// tombstones and follow_marks, which have no realtime replay and
// (after Step 5) lose their fast-path propagation entirely — the
// delta fetch is their only in-session catch-up mechanism.
//
// Fallback: if the db_now rpc fails (permission, function missing,
// network), we DO fall back to new Date().toISOString() so boot never
// hard-fails, but log a clear warning so the misconfig is visible.
//
// Not exported and not called anywhere except cloudInit.
//
// Failure-mode notes for this function:
//   1. cloudInit has no top-level try/catch and is invoked via
//      setTimeout(cloudInit, 200), which discards its Promise. Any
//      uncaught throw in this seeder becomes an unhandled rejection
//      that halts the rest of cloudInit (subscription setup, poll
//      start, etc). We therefore wrap the WHOLE body in try/catch
//      so the seeder can never fail cloudInit.
//   2. supabase-js awaits do not have a built-in timeout. A hung
//      network request (captive portal, cold-start edge, dropped
//      keep-alive) makes Promise.all() never resolve, and the
//      summary log never fires. We wrap every awaited network call
//      in _withTimeout so a stall becomes a rejection we can log
//      and fall back from.
//   3. The final summary log runs in a `finally` block so it fires
//      regardless of what went wrong — critical for diagnosability
//      on future boots.
async function _seedLastSeenCursors() {
  console.log("[cloud] seeding delta cursors…");
  try {
    if (!_supa) {
      console.warn("[cloud] delta cursor seed: _supa is not initialized — skipping");
      return;
    }

    // Per-call timeout wrapper. supabase-js has no native timeout; a
    // hung fetch would stall Promise.all forever otherwise. 5s is
    // long enough to survive a slow round-trip and short enough that
    // boot doesn't feel frozen if Supabase is unreachable.
    const TIMEOUT_MS = 5000;
    const _withTimeout = (p, label) => Promise.race([
      p,
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`${label} timeout after ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS
      )),
    ]);

    // Get the DB clock ONCE up front. All empty-table branches share
    // it, so all their cursors sit at the same instant (any inter-
    // table insert ordering is preserved by the per-row updated_at).
    let serverNow;
    try {
      const { data: serverNowRaw, error } = await _withTimeout(_supa.rpc("db_now"), "db_now rpc");
      if (error || !serverNowRaw) {
        console.warn(
          "[cloud] db_now rpc failed — falling back to browser clock for empty-table cursors; " +
          "check that public.db_now() exists and is granted to anon/authenticated. " +
          "Error:", error ? error.message : "empty result"
        );
        serverNow = new Date().toISOString();
      } else {
        // PostgREST returns timestamptz as an ISO-8601 string. Normalize
        // through Date so the cursor has the same shape (ms precision,
        // 'Z' suffix) as timestamps returned in row payloads by
        // updated_at / created_at selects.
        serverNow = new Date(serverNowRaw).toISOString();
      }
    } catch (e) {
      console.warn(
        "[cloud] db_now rpc threw or timed out — falling back to browser clock for empty-table cursors:",
        (e && e.message) || e
      );
      serverNow = new Date().toISOString();
    }

    const tables = [
      ["parts",         "updated_at"],
      ["pos",           "updated_at"],
      ["settings",      "updated_at"],
      ["kit_boms",      "updated_at"],
      ["follow_marks",  "updated_at"],
      ["deleted_parts", "updated_at"],
      ["audit",         "created_at"],
      ["usage",         "created_at"],
    ];
    // allSettled instead of all — even if a per-table callback
    // somehow rejects (it shouldn't, since each has its own try/
    // catch, but belt-and-suspenders), the summary still runs.
    await Promise.allSettled(tables.map(async ([table, tsCol]) => {
      try {
        const query = _supa
          .from(table)
          .select(tsCol)
          .order(tsCol, { ascending: false })
          .limit(1);
        const { data, error } = await _withTimeout(query, `${table} max-ts`);
        if (error) {
          // Table-level failure — seed with serverNow so the delta
          // path still functions once the transient error clears.
          // Better than leaving null (which would refuse forever).
          console.warn(`[cloud] cursor seed for ${table} failed — using serverNow as fallback:`, error.message);
          _lastSeenAt[table] = serverNow;
          return;
        }
        const val = data && data[0] ? data[0][tsCol] : null;
        // Empty-table branch: fall back to the DB clock, never null.
        // Non-empty tables use their real max timestamp.
        _lastSeenAt[table] = val || serverNow;
      } catch (e) {
        console.warn(`[cloud] cursor seed for ${table} threw or timed out — using serverNow as fallback:`, (e && e.message) || e);
        _lastSeenAt[table] = serverNow;
      }
    }));
  } catch (e) {
    // Belt-and-suspenders: catch any unexpected throw so the seeder
    // never propagates a rejection into cloudInit.
    console.error("[cloud] delta cursor seed: unexpected throw — cursors may be incomplete:", (e && e.stack) || e);
  } finally {
    // ALWAYS log the resulting cursor state, even after failure — so
    // the console tells us which keys landed as null vs seeded.
    console.log("[cloud] delta cursors seeded:", { ..._lastSeenAt });
  }
}

// BOM links — read-only from the browser's perspective. Server-side
// netlify/functions/acumatica-bom-sync.js owns writes (daily). One paged
// fetch on boot is enough; no realtime subscription, no push hooks.
// Paginated fetch of all production_orders rows. Sidecar table populated
// weekly by netlify/functions/acumatica-production-orders-sync.js —
// server-owned writes, NEVER pushed from the browser. One paged fetch
// on boot AND on reconnect (matches queue_entries; production orders
// change weekly and a reconnect after the Monday sync should pick them
// up). NOT included in the realtime subscription set — poll-only.
// Client mirror DB.productionOrders is READ ONLY: no push helper, no
// dirty tracking, no realtime handler. Only consumer is the "BOM Usage
// Weekly" reporting tab (added in a later phase).
async function _fetchAllProductionOrders() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("production_orders")
      .select("id, data")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] production_orders page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Paginated fetch of po_receipts rows — FULL ARCHIVE for FRAME_PNS.
// Sidecar table populated daily by
// netlify/functions/acumatica-po-receipts-sync.js — server-owned
// writes, NEVER pushed from the browser. One paged fetch on boot
// AND on reconnect. NOT included in the realtime subscription set —
// poll-only. Client mirror DB.poReceipts is READ ONLY: no push
// helper, no dirty tracking, no realtime handler. Only consumer is
// the Frame Schedule tab's Receipt History panel.
//
// SERVER-SIDE PN FILTER — the archive table holds every released
// receipt line ever synced (retention policy: forever). The Frame
// Schedule tab only cares about six frame PNs, so we filter via
// `.in("data->>pn", [...])` before pagination. Keeps the client
// working set small even after years of history. The PN list is
// intentionally duplicated here rather than imported from js/25 —
// this file loads first and has no dependency on the page module.
const _FRAME_PNS_FOR_RECEIPTS = ["UT101001", "UT101002", "UT101003", "UT101004", "UT101005", "UT101006"];
async function _fetchAllPoReceipts() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("po_receipts")
      .select("id, data")
      .in("data->>pn", _FRAME_PNS_FOR_RECEIPTS)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] po_receipts page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function _fetchAllBomLinks() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("bom_links")
      .select("id, data")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] bom_links page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function _fetchAllAudit() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("audit")
      .select("id, data")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] audit page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// ------------------------------------------------------------------
// follow_marks — shared "Sent" / "Chased" dated checkmarks for the
// Follow-Ups page. Table is {id text PK, data jsonb}; data = { type,
// poId, lineId, pn, markedAt } (no user, no name — dated flag only).
// Active = within 3 business days of markedAt (computed at READ time
// by js/22-page-followups.js — never deleted on load to keep the
// realtime path inert).
//
// LOOP-PROOFING — strict rules for callers and the realtime handler:
//   - cloudInit fetches ONCE and populates window.followMarks. No
//     prune-on-load. No deletes during boot. (Earlier prune-on-load
//     fired DELETE events that re-entered the realtime handler.)
//   - The realtime handler may ONLY: update window.followMarks via
//     .set/.delete (with content-equality echo skip), and request a
//     debounced re-render IFF the Follow-Ups page is the active route.
//     It must NEVER call cloudInit, re-subscribe, fetch, write, or
//     call saveDB.
//   - Optimistic writes from the UI (upsert/delete) are echoed back
//     by realtime; the content-equality check (.markedAt match) makes
//     the echo a no-op, so writer + echo can never ping-pong.
// ------------------------------------------------------------------
async function _fetchAllFollowMarks() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("follow_marks")
      .select("id, data")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] follow_marks page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Write helpers — called optimistically from 22-page-followups.js after
// the in-memory map is already updated. The realtime echo for the same
// content is detected and ignored by _handleRealtimeFollowMark.
async function upsertFollowMarkCloud(id, data) {
  if (!_supa) return { ok: false, error: new Error("not ready") };
  const { error } = await _supa.from("follow_marks").upsert({ id, data });
  if (error) {
    console.error("[cloud] follow_marks upsert failed:", error);
    return { ok: false, error };
  }
  _sendDataChanged(["follow_marks"]);
  return { ok: true };
}

async function deleteFollowMarkCloud(id) {
  if (!_supa) return { ok: false, error: new Error("not ready") };
  const { error } = await _supa.from("follow_marks").delete().eq("id", id);
  if (error) {
    console.error("[cloud] follow_marks delete failed:", error);
    return { ok: false, error };
  }
  // No broadcast send — DELETE-only postgres_changes listener on
  // landmaster-broadcast (Step 2) fans the row-DELETE out to every
  // subscribed client.
  return { ok: true };
}

window.upsertFollowMarkCloud = upsertFollowMarkCloud;
window.deleteFollowMarkCloud = deleteFollowMarkCloud;

// ── deleted_parts tombstone helpers ─────────────────────────────────
// Table schema: { id text PK, data jsonb } — matches follow_marks and
// bom_links. The pn goes in the `id` column; meta + snapshot in `data`.
async function upsertDeletedPartCloud(id, data) {
  if (!_supa) return { ok: false, error: new Error("not ready") };
  const { error } = await _supa.from("deleted_parts").upsert({ id, data });
  if (error) {
    console.error("[cloud] deleted_parts upsert failed:", error);
    return { ok: false, error };
  }
  _sendDataChanged(["deleted_parts"]);
  return { ok: true };
}

async function deleteDeletedPartCloud(id) {
  if (!_supa) return { ok: false, error: new Error("not ready") };
  const { error } = await _supa.from("deleted_parts").delete().eq("id", id);
  if (error) {
    console.error("[cloud] deleted_parts delete failed:", error);
    return { ok: false, error };
  }
  // No broadcast send — DELETE-only postgres_changes listener carries
  // the tombstone-clear (un-delete) to every subscribed client.
  return { ok: true };
}

// Delete a single parts row by pn — used at delete-time so no future
// load resurrects the pn. Returns { ok, error } like the other helpers.
async function deletePartRowCloud(pn) {
  if (!_supa) return { ok: false, error: new Error("not ready") };
  const { error } = await _supa.from("parts").delete().eq("pn", pn);
  if (error) {
    console.error("[cloud] parts row delete failed:", error);
    return { ok: false, error };
  }
  // No broadcast send — DELETE-only postgres_changes listener carries
  // the parts row DELETE. (The tombstone row INSERT paired with this
  // delete is handled by upsertDeletedPartCloud, which does broadcast.)
  return { ok: true };
}

// Upsert a single parts row — used by undeletePart to restore the row
// so other clients pick it up via realtime.
async function upsertPartCloud(pn, part) {
  if (!_supa) return { ok: false, error: new Error("not ready") };
  const { pn: _, ...rest } = part;
  const { error } = await _supa.from("parts").upsert({ pn, data: rest });
  if (error) {
    console.error("[cloud] parts row upsert failed:", error);
    return { ok: false, error };
  }
  _sendDataChanged(["parts"]);
  return { ok: true };
}

window.upsertDeletedPartCloud = upsertDeletedPartCloud;
window.deleteDeletedPartCloud = deleteDeletedPartCloud;
window.deletePartRowCloud = deletePartRowCloud;
window.upsertPartCloud = upsertPartCloud;

// Paginated fetch of all build_plan_targets rows. Sidecar table (NOT
// on the realtime publication — poll-only) that stores the Build Plan
// tab's shared state:
//   - A sentinel row with fg_sku='__settings__' whose `data` jsonb holds
//     {targetPerWeek, windowWeeks} — the tab-wide input + mix window.
//   - Zero or more regular rows (fg_sku ≠ '__settings__') whose
//     weekly_qty is that FG's manual override (pin) in units-per-week.
// Populated by cloudInit + _catchupFetch. Client mirror shape:
//   DB.buildPlanTargets = {
//     settings: {targetPerWeek, windowWeeks, updatedAt} | null,
//     overrides: Map<fg_sku, {weeklyQty, updatedAt, updatedBy}>,
//   }
async function _fetchAllBuildPlanTargets() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("build_plan_targets")
      .select("fg_sku, weekly_qty, data, updated_at, updated_by")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] build_plan_targets page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Populate DB.buildPlanTargets from a fetched-row array. Splits the
// sentinel settings row from regular per-FG override rows. Mutates
// the mirror in place — the outer object is only assigned once (on
// first call); the overrides Map is cleared+refilled per app
// convention so any UI holding a reference stays valid.
//
// Reading a v1 row (no `data` column populated, plain per-FG weekly_qty
// interpreted as "the plan for that FG") lands here as an override —
// which is the correct semantic under v2. Existing rows silently
// become pinned overrides; no data migration needed.
function _populateBuildPlanTargetsFromRows(rows) {
  if (!DB.buildPlanTargets || !(DB.buildPlanTargets.overrides instanceof Map)) {
    DB.buildPlanTargets = { settings: null, overrides: new Map() };
  }
  DB.buildPlanTargets.settings = null;
  DB.buildPlanTargets.overrides.clear();
  if (!Array.isArray(rows)) return;
  for (const row of rows) {
    if (!row || !row.fg_sku) continue;
    const key = String(row.fg_sku);
    if (key === "__settings__") {
      const d = row.data || {};
      DB.buildPlanTargets.settings = {
        targetPerWeek: Number(d.targetPerWeek) || 0,
        windowWeeks:   Number(d.windowWeeks)   || 8,
        startDate:     (typeof d.startDate === "string" && d.startDate) ? d.startDate : null,
        updatedAt:     row.updated_at || null,
      };
      continue;
    }
    DB.buildPlanTargets.overrides.set(key, {
      weeklyQty: Number(row.weekly_qty) || 0,
      updatedAt: row.updated_at || null,
      updatedBy: row.updated_by || null,
    });
  }
}

// Upsert the tab-wide settings sentinel row. Last-write-wins per the
// primary key ('__settings__') — Build Plan is shared state, so a
// concurrent session writing a different target is a genuine conflict
// and the later write is the intent to accept. Optimistic mirror
// update BEFORE the RPC so the UI reflects the change immediately;
// reverts on failure.
async function setBuildPlanSettingsCloud({ targetPerWeek, windowWeeks, startDate = null }) {
  if (!_supa) return { ok: false, error: new Error("cloud not ready") };
  if (!DB.buildPlanTargets) DB.buildPlanTargets = { settings: null, overrides: new Map() };
  const t = Number(targetPerWeek);
  const w = Number(windowWeeks);
  if (!Number.isFinite(t) || t < 0) return { ok: false, error: new Error("invalid targetPerWeek") };
  if (!Number.isFinite(w) || w <= 0) return { ok: false, error: new Error("invalid windowWeeks") };
  const sd = (typeof startDate === "string" && startDate) ? startDate : null;
  const nowIso = new Date().toISOString();
  const prev = DB.buildPlanTargets.settings;
  const nextSettings = { targetPerWeek: t, windowWeeks: w, startDate: sd, updatedAt: nowIso };
  DB.buildPlanTargets.settings = nextSettings;
  const { error } = await _supa
    .from("build_plan_targets")
    .upsert(
      {
        fg_sku:     "__settings__",
        weekly_qty: 0,          // sentinel — not read; column is NOT NULL
        data:       { targetPerWeek: t, windowWeeks: w, startDate: sd },
        updated_at: nowIso,
      },
      { onConflict: "fg_sku" }
    );
  if (error) {
    DB.buildPlanTargets.settings = prev;
    console.error("[cloud] build_plan_targets settings upsert failed:", error);
    if (typeof showToast === "function") {
      showToast("Build-plan settings save failed: " + error.message, "crit");
    }
    return { ok: false, error };
  }
  return { ok: true };
}

// Upsert a per-FG override (pin). Regular per-FG row — the `data`
// column is left null so a plain SELECT can distinguish overrides
// from the sentinel row by the presence/absence of `data`.
async function setBuildPlanOverrideCloud(fgSku, weeklyQty) {
  if (!_supa) return { ok: false, error: new Error("cloud not ready") };
  if (!DB.buildPlanTargets) DB.buildPlanTargets = { settings: null, overrides: new Map() };
  const key = String(fgSku);
  if (key === "__settings__") return { ok: false, error: new Error("reserved key") };
  const q = Number(weeklyQty);
  if (!Number.isFinite(q) || q < 0) return { ok: false, error: new Error("invalid qty") };
  const nowIso = new Date().toISOString();
  const prev = DB.buildPlanTargets.overrides.get(key);
  DB.buildPlanTargets.overrides.set(key, {
    weeklyQty: q,
    updatedAt: nowIso,
    updatedBy: prev ? prev.updatedBy : null,
  });
  const { error } = await _supa
    .from("build_plan_targets")
    .upsert(
      { fg_sku: key, weekly_qty: q, data: null, updated_at: nowIso },
      { onConflict: "fg_sku" }
    );
  if (error) {
    if (prev) DB.buildPlanTargets.overrides.set(key, prev);
    else DB.buildPlanTargets.overrides.delete(key);
    console.error("[cloud] build_plan_targets override upsert failed:", error);
    if (typeof showToast === "function") {
      showToast("Build-plan override save failed: " + error.message, "crit");
    }
    return { ok: false, error };
  }
  return { ok: true };
}

// Delete a single override row. Optimistic-then-revert. Never
// touches the settings sentinel — the caller shouldn't ever pass
// '__settings__' here, but the guard makes it safe.
async function clearBuildPlanOverrideCloud(fgSku) {
  if (!_supa) return { ok: false, error: new Error("cloud not ready") };
  if (!DB.buildPlanTargets) DB.buildPlanTargets = { settings: null, overrides: new Map() };
  const key = String(fgSku);
  if (key === "__settings__") return { ok: false, error: new Error("reserved key") };
  const prev = DB.buildPlanTargets.overrides.get(key);
  DB.buildPlanTargets.overrides.delete(key);
  const { error } = await _supa
    .from("build_plan_targets")
    .delete()
    .eq("fg_sku", key);
  if (error) {
    if (prev) DB.buildPlanTargets.overrides.set(key, prev);
    console.error("[cloud] build_plan_targets override delete failed:", error);
    if (typeof showToast === "function") {
      showToast("Build-plan override clear failed: " + error.message, "crit");
    }
    return { ok: false, error };
  }
  return { ok: true };
}

// Delete every override in one call. Sentinel settings row is
// preserved by the .neq filter — settings and overrides are
// independent lifecycles. Optimistic-then-revert on the whole batch.
async function clearAllBuildPlanOverridesCloud() {
  if (!_supa) return { ok: false, error: new Error("cloud not ready") };
  if (!DB.buildPlanTargets) DB.buildPlanTargets = { settings: null, overrides: new Map() };
  if (DB.buildPlanTargets.overrides.size === 0) return { ok: true };
  const prev = new Map(DB.buildPlanTargets.overrides);
  DB.buildPlanTargets.overrides.clear();
  const { error } = await _supa
    .from("build_plan_targets")
    .delete()
    .neq("fg_sku", "__settings__");
  if (error) {
    for (const [k, v] of prev) DB.buildPlanTargets.overrides.set(k, v);
    console.error("[cloud] build_plan_targets clear-all overrides failed:", error);
    if (typeof showToast === "function") {
      showToast("Clear overrides failed: " + error.message, "crit");
    }
    return { ok: false, error };
  }
  return { ok: true };
}

window.setBuildPlanSettingsCloud       = setBuildPlanSettingsCloud;
window.setBuildPlanOverrideCloud       = setBuildPlanOverrideCloud;
window.clearBuildPlanOverrideCloud     = clearBuildPlanOverrideCloud;
window.clearAllBuildPlanOverridesCloud = clearAllBuildPlanOverridesCloud;

// ------------------------------------------------------------------
// Frame Schedule (MOR-RYDE weekly qty grid + global caps).
// Sidecar table (NOT on the realtime publication — poll-only) that
// stores the Frame Schedule tab's shared state. Same column shape as
// build_plan_targets so the schema template transfers: fg_sku PRIMARY
// KEY, weekly_qty NOT NULL, data jsonb, updated_at, updated_by.
//
// TWO ROW ROLES (split by fg_sku, mirrors the build_plan_targets
// __settings__ sentinel convention):
//   - fg_sku='__settings__' — global caps in `data.caps = {crewhd,
//     std}`. Single row; upserted via setFrameScheduleSettingsCloud.
//   - fg_sku=<ISO Monday, "YYYY-MM-DD"> — one per week; `data`
//     carries {qty:{pn:n}, slot?:{pn,locked,source}}. slot is
//     present only on the slot-START week. weekly_qty is unused
//     (column is NOT NULL for schema compat).
//
// v2.0 rows written before the global-caps migration may still
// carry a `caps` field on per-week rows — the populate reader
// tolerates and ignores it (see comment inside).
//
// Client mirror shape:
//   DB.frameSchedule = {
//     settings: {caps:{crewhd,std}, updatedAt} | null,
//     weeks:    Map<isoMonday, {qty:{pn:n}, slot|null, updatedAt}>,
//     loaded:   bool,
//   }
// ------------------------------------------------------------------
async function _fetchAllFrameSchedule() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("frame_schedule")
      .select("fg_sku, weekly_qty, data, updated_at, updated_by")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] frame_schedule page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Populate DB.frameSchedule from a fetched-row array. Clear-and-refill
// the weeks Map in place per app convention — the outer object is
// only reassigned on shape mismatch. Mirrors
// _populateBuildPlanTargetsFromRows exactly so any UI consumer holding
// a reference to DB.frameSchedule stays valid across reloads.
function _populateFrameScheduleFromRows(rows) {
  if (!DB.frameSchedule || !(DB.frameSchedule.weeks instanceof Map)) {
    DB.frameSchedule = { settings: null, weeks: new Map(), loaded: false };
  }
  DB.frameSchedule.settings = null;
  DB.frameSchedule.weeks.clear();
  if (!Array.isArray(rows)) { DB.frameSchedule.loaded = true; return; }
  for (const row of rows) {
    if (!row || !row.fg_sku) continue;
    const key = String(row.fg_sku);
    const d = row.data || {};
    if (key === "__settings__") {
      // v2.1 global caps sentinel. Row's `data.caps` carries the
      // whole-tab CREW/HD and STD per-week caps.
      // v4.1: `data.bufferWeeks` (float, min-cover-in-weeks
      // safety buffer) lifted alongside the caps. Legacy
      // `data.buffer` (integer units) is intentionally IGNORED —
      // the units-based term was superseded by the weeks-based
      // formulation before it saw production use.
      const bw = Number(d.bufferWeeks);
      // v5 publishToken: lifted so the supplier-snapshot Publish
      // button reuses the same URL across republishes. Shape:
      // 24..128 URL-safe chars ("fs-<uuid>" from the client mint).
      // Absent on legacy rows → null → client mints on first click.
      const rawTok = d && d.publishToken;
      const publishToken = (typeof rawTok === "string" && /^[A-Za-z0-9._-]{24,128}$/.test(rawTok))
        ? rawTok : null;
      // v5 lastPublishedAt: ISO timestamp of the most recent
      // successful publish. Rendered next to the URL in the
      // client's status area so the operator always knows how
      // fresh the supplier's copy is. Null on legacy rows /
      // before the first publish.
      const rawLp = d && d.lastPublishedAt;
      const lastPublishedAt = (typeof rawLp === "string" && rawLp.length > 0) ? rawLp : null;
      // v7 scheduleMode: "weekly" or "slots". Default "weekly"
      // per the v7 cover-driven scheduler ticket; legacy rows
      // without the field also land on "weekly".
      const rawSm = d && d.scheduleMode;
      const scheduleMode = (rawSm === "slots") ? "slots" : "weekly";
      DB.frameSchedule.settings = {
        caps: {
          crewhd: Number(d.caps && d.caps.crewhd) || 0,
          std:    Number(d.caps && d.caps.std)    || 0,
        },
        bufferWeeks: (Number.isFinite(bw) && bw >= 0) ? bw : null,
        publishToken,
        lastPublishedAt,
        scheduleMode,
        updatedAt: row.updated_at || null,
      };
      continue;
    }
    // Regular per-week row. v2 added `slot: {pn, locked, source}`
    // on the slot-START week. v2.0 rows still had per-week `caps`
    // on `data` — we IGNORE that field now that caps are global
    // (the settings sentinel above owns them). Old rows continue
    // to be readable; their stale caps are silently dropped.
    const slot = (d.slot && typeof d.slot === "object" && d.slot.pn)
      ? {
          pn: String(d.slot.pn),
          // v3.3: optional pn2 for 1-week split runs. Absent =
          // whole-run slot (both weeks are pn). Old rows without
          // pn2 continue to read as whole runs.
          pn2: (typeof d.slot.pn2 === "string" && d.slot.pn2) ? d.slot.pn2 : null,
          locked: !!d.slot.locked,
          // v7.1 source accepts "weekly-auto" alongside the
          // legacy set. Anything else falls back to "auto"
          // so unknown values from a future writer read safely.
          source: (d.slot.source === "manual" || d.slot.source === "seed" || d.slot.source === "weekly-auto")
                    ? d.slot.source : "auto",
          // v7.1 mode: "weekly" marks a single-week pin from the
          // weekly-cover scheduler (persisted per-week, not
          // spread across a 2-week slot). Absent / anything else
          // reads as the legacy 2-week slot mode.
          mode: d.slot.mode === "weekly" ? "weekly" : null,
          // v7.2 qty / qty2: optional explicit build quantities
          // for the weekly-mode scheduler's mix candidates.
          // Non-negative integers only; drop anything else.
          // Absent on legacy rows (and on legacy slot mode)
          // signals the sim should compute qty via its own
          // demand + catchup math (v7.0 pin behavior).
          qty:  (typeof d.slot.qty  === "number" && d.slot.qty  >= 0 && Number.isFinite(d.slot.qty))  ? Math.floor(d.slot.qty)  : null,
          qty2: (typeof d.slot.qty2 === "number" && d.slot.qty2 >= 0 && Number.isFinite(d.slot.qty2)) ? Math.floor(d.slot.qty2) : null,
        }
      : null;
    // v4.1: onHandAtClose = {pn: units, ...} snapshot of each
    // frame's on-hand at week close. Lifted here so the client
    // can compute "actual /wk" burn = prevOnHand + received −
    // thisOnHand across consecutive snapshots. Missing = no
    // snapshot yet for that week.
    let onHandAtClose = null;
    if (d.onHandAtClose && typeof d.onHandAtClose === "object") {
      onHandAtClose = {};
      for (const [k, v] of Object.entries(d.onHandAtClose)) {
        const n = Number(v);
        if (Number.isFinite(n)) onHandAtClose[k] = n;
      }
    }
    // v5.5 qtyOverride = {pn: units} manual per-cell qty
    // constraints. Non-negative integers only; empties dropped.
    // Read here so the sim (which honors overrides as hard
    // constraints) sees them on the next render. Absent /
    // legacy rows read as null.
    let qtyOverride = null;
    if (d.qtyOverride && typeof d.qtyOverride === "object") {
      qtyOverride = {};
      for (const [k, v] of Object.entries(d.qtyOverride)) {
        const n = Math.floor(Number(v));
        if (Number.isFinite(n) && n >= 0) qtyOverride[k] = n;
      }
      if (Object.keys(qtyOverride).length === 0) qtyOverride = null;
    }
    DB.frameSchedule.weeks.set(key, {
      qty: (d.qty && typeof d.qty === "object") ? d.qty : {},
      slot,
      onHandAtClose,
      qtyOverride,
      updatedAt: row.updated_at || null,
    });
  }
  DB.frameSchedule.loaded = true;
}

// Upsert one week (isoMonday key). Optimistic mirror + revert-on-error.
// Last-write-wins on the (fg_sku) primary key — Frame Schedule is
// shared state and a concurrent editor in another session writing a
// different qty is a genuine conflict; the later write is the intent
// to accept. The full week payload replaces the row so a qty that
// drops to 0 disappears from the qty map (see caller filtering).
async function setFrameScheduleWeekCloud(isoMonday, payload) {
  if (!_supa) return { ok: false, error: new Error("cloud not ready") };
  if (!DB.frameSchedule || !(DB.frameSchedule.weeks instanceof Map)) {
    DB.frameSchedule = { settings: null, weeks: new Map(), loaded: false };
  }
  const key = String(isoMonday || "");
  // Guard: the settings sentinel belongs to setFrameScheduleSettingsCloud.
  // A stray call here would clobber the caps blob.
  if (key === "__settings__") {
    return { ok: false, error: new Error("reserved key — use setFrameScheduleSettingsCloud") };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    return { ok: false, error: new Error("invalid iso Monday key") };
  }
  // v2.1: no per-week caps. Payload carries {qty, slot?, onHandAtClose?}.
  const qty = {};
  if (payload && payload.qty && typeof payload.qty === "object") {
    for (const [k, v] of Object.entries(payload.qty)) {
      const n = Math.max(0, Number(v) || 0);
      if (n > 0) qty[k] = n;
    }
  }
  // slot descriptor: present ONLY on the slot-START week. Non-start
  // weeks omit the field; the read path treats missing slot as null.
  let slot = null;
  if (payload && payload.slot && typeof payload.slot === "object" && payload.slot.pn) {
    slot = {
      pn: String(payload.slot.pn),
      locked: !!payload.slot.locked,
      // v7.1 source accepts "weekly-auto" from the weekly
      // scheduler's per-week auto-persist, alongside the legacy
      // "manual"/"seed" set. Unknown values default to "auto".
      source: (payload.slot.source === "manual" || payload.slot.source === "seed" || payload.slot.source === "weekly-auto")
                ? payload.slot.source : "auto",
    };
    // v3.3: attach pn2 ONLY when it's a real split (present and
    // different from pn). Whole runs omit the field so old
    // readers that don't know about pn2 are unaffected.
    if (typeof payload.slot.pn2 === "string" && payload.slot.pn2 && payload.slot.pn2 !== slot.pn) {
      slot.pn2 = payload.slot.pn2;
    }
    // v7.1 mode: "weekly" marks a single-week pin from the
    // weekly-cover scheduler (v7 ticket item 5). Omitted for
    // legacy 2-week slot rows so their readers stay byte-
    // identical to pre-v7.1 output.
    if (payload.slot.mode === "weekly") slot.mode = "weekly";
    // v7.2 qty / qty2: explicit build quantities for the
    // weekly-mode mix candidates. Non-negative integers only;
    // qty2 only attached when there's a real secondary
    // placement (slot.pn2 present). Omitted for legacy slot
    // rows / v7.0 weekly pins that carry just pn -- readers
    // treat missing qty as "compute via demand + catchup".
    if (typeof payload.slot.qty === "number" && payload.slot.qty >= 0 && Number.isFinite(payload.slot.qty)) {
      slot.qty = Math.floor(payload.slot.qty);
    }
    if (slot.pn2
        && typeof payload.slot.qty2 === "number"
        && payload.slot.qty2 >= 0
        && Number.isFinite(payload.slot.qty2)) {
      slot.qty2 = Math.floor(payload.slot.qty2);
    }
  }
  // v4.1: onHandAtClose = {pn: units} snapshot. Coerced to
  // numbers; non-numeric entries dropped. Present or absent
  // independently of slot/qty — pn writers omit slot, snapshot
  // writers may omit qty (though callers today send both).
  let onHandAtClose = null;
  if (payload && payload.onHandAtClose && typeof payload.onHandAtClose === "object") {
    onHandAtClose = {};
    for (const [k, v] of Object.entries(payload.onHandAtClose)) {
      const n = Number(v);
      if (Number.isFinite(n)) onHandAtClose[k] = n;
    }
    if (Object.keys(onHandAtClose).length === 0) onHandAtClose = null;
  }
  // v5.5 qtyOverride = {pn: units} manual constraints. Written
  // when the payload names the field; preserved on omission
  // (same shape as onHandAtClose). A payload with an empty
  // object or explicit null CLEARS the override map -- distinct
  // from omitting the field entirely, which preserves prior.
  const prev = DB.frameSchedule.weeks.get(key);
  let qtyOverride;   // undefined = preserve prior
  if (payload && Object.prototype.hasOwnProperty.call(payload, "qtyOverride")) {
    if (payload.qtyOverride && typeof payload.qtyOverride === "object") {
      const sanitized = {};
      for (const [k, v] of Object.entries(payload.qtyOverride)) {
        const n = Math.floor(Number(v));
        if (Number.isFinite(n) && n >= 0) sanitized[k] = n;
      }
      qtyOverride = Object.keys(sanitized).length > 0 ? sanitized : null;
    } else {
      qtyOverride = null;   // explicit clear
    }
  } else {
    qtyOverride = (prev && prev.qtyOverride) || null;
  }
  const nowIso = new Date().toISOString();
  DB.frameSchedule.weeks.set(key, {
    qty,
    slot,
    onHandAtClose: onHandAtClose || (prev && prev.onHandAtClose) || null,
    qtyOverride,
    updatedAt: nowIso,
  });
  const dataPayload = { qty };
  if (slot) dataPayload.slot = slot;
  if (onHandAtClose) dataPayload.onHandAtClose = onHandAtClose;
  else if (prev && prev.onHandAtClose) dataPayload.onHandAtClose = prev.onHandAtClose;
  if (qtyOverride) dataPayload.qtyOverride = qtyOverride;
  const { error } = await _supa
    .from("frame_schedule")
    .upsert(
      {
        fg_sku:     key,
        weekly_qty: 0,          // unused for frame_schedule; column NOT NULL
        data:       dataPayload,
        updated_at: nowIso,
      },
      { onConflict: "fg_sku" }
    );
  if (error) {
    if (prev) DB.frameSchedule.weeks.set(key, prev);
    else DB.frameSchedule.weeks.delete(key);
    console.error("[cloud] frame_schedule upsert failed:", error);
    if (typeof showToast === "function") {
      showToast("Frame schedule save failed: " + error.message, "crit");
    }
    return { ok: false, error };
  }
  return { ok: true };
}

// Upsert the global CREW/HD + STD caps into the __settings__
// sentinel row. Optimistic mirror + revert-on-error. Last-write-
// wins per primary key — global caps are shared state so a
// concurrent editor is a genuine conflict; the later timestamp
// prevails. Mirrors setBuildPlanSettingsCloud (js/30 build_plan
// targets) end to end.
async function setFrameScheduleSettingsCloud(caps) {
  if (!_supa) return { ok: false, error: new Error("cloud not ready") };
  if (!DB.frameSchedule || !(DB.frameSchedule.weeks instanceof Map)) {
    DB.frameSchedule = { settings: null, weeks: new Map(), loaded: false };
  }
  const crewhd = Math.max(0, Number(caps && caps.crewhd) || 0);
  const std    = Math.max(0, Number(caps && caps.std)    || 0);
  // v4.1 accept an optional `bufferWeeks` field (float, min cover
  // in weeks). When present + finite, persist it; when omitted,
  // preserve the prior mirror's value so a caps-only edit doesn't
  // wipe the buffer. Legacy `caps.buffer` (integer units) is
  // intentionally ignored — never round-tripped through here.
  const prev = DB.frameSchedule.settings;
  const bwArg = Number(caps && caps.bufferWeeks);
  const bufferWeeks = Number.isFinite(bwArg) && bwArg >= 0
    ? bwArg
    : (prev && Number.isFinite(prev.bufferWeeks) ? prev.bufferWeeks : null);
  // v5 publishToken: same preservation shape as bufferWeeks. When
  // caller passes a valid token (client mints "fs-<uuid>" via
  // crypto.randomUUID), persist it. When caller omits, keep
  // whatever the prior mirror had so a caps-only or buffer-only
  // edit doesn't wipe the supplier URL.
  const ptArg = caps && caps.publishToken;
  const publishToken = (typeof ptArg === "string" && /^[A-Za-z0-9._-]{24,128}$/.test(ptArg))
    ? ptArg
    : (prev && typeof prev.publishToken === "string" && prev.publishToken ? prev.publishToken : null);
  // v5 lastPublishedAt: ISO timestamp captured by the Publish
  // button after a successful upsert. Preserved-on-omit like the
  // other v5 fields so a caps edit doesn't blank the stamp.
  const lpArg = caps && caps.lastPublishedAt;
  const lastPublishedAt = (typeof lpArg === "string" && lpArg.length > 0)
    ? lpArg
    : (prev && typeof prev.lastPublishedAt === "string" && prev.lastPublishedAt ? prev.lastPublishedAt : null);
  // v7 scheduleMode: "weekly" | "slots" -- preserve-on-omit like
  // the other v5+ fields. Only two values are accepted; anything
  // else (including undefined from a caps-only edit) falls back
  // to the prior mirror value, then to the "weekly" default.
  const smArg = caps && caps.scheduleMode;
  let scheduleMode;
  if (smArg === "weekly" || smArg === "slots") {
    scheduleMode = smArg;
  } else if (prev && (prev.scheduleMode === "weekly" || prev.scheduleMode === "slots")) {
    scheduleMode = prev.scheduleMode;
  } else {
    scheduleMode = "weekly";
  }
  const nowIso = new Date().toISOString();
  const dataOut = { caps: { crewhd, std } };
  if (bufferWeeks !== null) dataOut.bufferWeeks = bufferWeeks;
  if (publishToken !== null) dataOut.publishToken = publishToken;
  if (lastPublishedAt !== null) dataOut.lastPublishedAt = lastPublishedAt;
  // Persist scheduleMode unconditionally so a legacy row upgrades
  // on the first save. The default is "weekly", so an empty-caps
  // installation still lands on the new scheduler.
  dataOut.scheduleMode = scheduleMode;
  DB.frameSchedule.settings = { caps: { crewhd, std }, bufferWeeks, publishToken, lastPublishedAt, scheduleMode, updatedAt: nowIso };
  const { error } = await _supa
    .from("frame_schedule")
    .upsert(
      {
        fg_sku:     "__settings__",
        weekly_qty: 0,          // sentinel — not read; column NOT NULL
        data:       dataOut,
        updated_at: nowIso,
      },
      { onConflict: "fg_sku" }
    );
  if (error) {
    DB.frameSchedule.settings = prev;
    console.error("[cloud] frame_schedule settings upsert failed:", error);
    if (typeof showToast === "function") {
      showToast("Frame schedule caps save failed: " + error.message, "crit");
    }
    return { ok: false, error };
  }
  return { ok: true };
}

// v5 Publish a frame-schedule supplier snapshot. Sends the pre-
// rendered supplier HTML + a stable token to the publish Netlify
// function; returns the resulting public URL. Token round-trip
// happens through setFrameScheduleSettingsCloud (the caller is
// responsible for persisting the freshly-minted token before /
// after this call so republishes reuse the same URL). Pure HTTP;
// no direct Supabase call here.
async function publishFrameScheduleSnapshot(token, html) {
  if (typeof token !== "string" || !/^[A-Za-z0-9._-]{24,128}$/.test(token)) {
    return { ok: false, error: new Error("invalid token") };
  }
  if (typeof html !== "string" || html.length === 0) {
    return { ok: false, error: new Error("missing html") };
  }
  // v5.1 Mirror the server-side 3 MB cap so a runaway payload
  // fails fast without a round-trip. The supplier snapshot now
  // embeds the full Frame Schedule tab + inlined stylesheet, so
  // the payload is meaningfully larger than the old grid-only
  // page -- but 3 MB is still comfortably above the expected
  // size.
  if (html.length > 3000000) {
    return { ok: false, error: new Error("html too large (>3MB)") };
  }
  try {
    const resp = await fetch("/.netlify/functions/frame-schedule-publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, html }),
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not json */ }
    if (!resp.ok) {
      const detail = (json && (json.error || json.detail)) || text.slice(0, 200);
      return { ok: false, error: new Error(`publish returned ${resp.status}: ${detail}`) };
    }
    if (!json || !json.url) {
      return { ok: false, error: new Error("publish returned no url") };
    }
    return { ok: true, url: json.url, updatedAt: json.updated_at || null, bytes: json.bytes || 0 };
  } catch (err) {
    return { ok: false, error: err };
  }
}

window.setFrameScheduleWeekCloud     = setFrameScheduleWeekCloud;
window.setFrameScheduleSettingsCloud = setFrameScheduleSettingsCloud;
window.publishFrameScheduleSnapshot  = publishFrameScheduleSnapshot;

// Paginated fetch of all queue_entries rows. Sidecar table (not on the
// realtime publication — poll-only) that stores the first-ever-in-queue
// timestamp per pn. Runs during cloudInit AFTER parts are hydrated so
// the mirror is ready when the first refresh() calls the detector.
// Returned rows are [{pn, first_entered_at}]; last_left_at intentionally
// absent (v1 has no exit tracking / no re-stamp).
async function _fetchAllQueueEntries() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("queue_entries")
      .select("pn, first_entered_at")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] queue_entries page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

// Insert new queue-entry stamps for the given PNs. First-write-wins
// via onConflict:"pn", ignoreDuplicates:true — a concurrent session
// that already stamped a PN wins, and this call is a no-op for that
// row (Postgres serializes at the PK constraint, and the "ignore-
// duplicates" prefer header stops PostgREST from returning a conflict
// error). On success, the caller MUST mirror the stamp into
// DB.queueEntries and _stampedPns so subsequent refreshes don't
// re-attempt the write.
async function _stampQueueEntriesCloud(pns) {
  if (!_supa || !pns.length) return { ok: false, stamped: [] };
  const now = new Date().toISOString();
  const rows = pns.map(pn => ({ pn, first_entered_at: now }));
  const { error } = await _supa
    .from("queue_entries")
    .upsert(rows, { onConflict: "pn", ignoreDuplicates: true });
  if (error) {
    console.warn("[cloud] queue_entries upsert failed:", error);
    return { ok: false, stamped: [] };
  }
  return { ok: true, stamped: pns, stampedAt: now };
}

// Detector — one pass per refresh cycle. Called from js/05-ui-shell.js
// refresh() right after bumpStatusCache(), so partsWithStatus() (and
// therefore queueParts()) is fresh AND cached for downstream reads.
// Only INSERTs for PNs not already in _stampedPns → steady-state cost
// is a Set difference over ~40-100 pns per cycle, zero writes.
// Fire-and-forget: the sort surface reads whatever's in DB.queueEntries
// right now; a stamp that hasn't landed yet just misses the current
// render and shows on the next refresh.
async function _detectQueueEntries() {
  if (!_supa) return;
  if (typeof queueParts !== "function") return;
  if (!(DB.queueEntries instanceof Map)) DB.queueEntries = new Map();
  const currentPns = new Set(queueParts().map(p => p.pn));
  const toStamp = [];
  for (const pn of currentPns) if (!_stampedPns.has(pn)) toStamp.push(pn);
  if (!toStamp.length) return;
  const { ok, stamped, stampedAt } = await _stampQueueEntriesCloud(toStamp);
  if (!ok) return;
  for (const pn of stamped) {
    _stampedPns.add(pn);
    // ignoreDuplicates means "someone else may have won" — but we
    // don't know which pns won vs no-op'd. Mirror OUR stampedAt for
    // any pn we don't already have a stamp for; next boot's fetch
    // corrects any pn where another session's earlier stamp is
    // authoritative. Never overwrite an existing entry — first-write-
    // wins on the client mirror too.
    if (!DB.queueEntries.has(pn)) {
      DB.queueEntries.set(pn, { firstEnteredAt: stampedAt });
    }
  }
}
window._detectQueueEntries = _detectQueueEntries;

// Paginated fetch of all deleted_parts rows. Runs during cloudInit
// BEFORE the parts fetch so the tombstone Set is ready when the
// parts filter runs.
async function _fetchAllDeletedParts() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa
      .from("deleted_parts")
      .select("id, data")
      .range(from, from + PAGE - 1);
    if (error) {
      console.error("[cloud] deleted_parts page fetch failed:", error);
      return null;
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function cloudInit() {
  const ok = await _waitForDB();
  if (!ok) {
    console.error("[cloud] DB never became ready");
    return;
  }

  if (!window.supabase || !window.supabase.createClient) {
    console.error("[cloud] Supabase SDK not loaded");
    showToast("Cloud sync unavailable: SDK not loaded", "crit");
    return;
  }

  _supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // Tombstones FIRST — populated before the parts fetch so the
  // filter below can drop any tombstoned pn coming back from cloud.
  // The Map is initialized as a shape-guard in js/17-welcome-init.js
  // but we defensively re-guard here in case cloudInit is called
  // before that init (e.g. tests, hot-reload).
  if (!(DB.deletedParts instanceof Map)) DB.deletedParts = new Map();
  else DB.deletedParts.clear();
  const cloudTombstones = await _fetchAllDeletedParts();
  if (cloudTombstones !== null) {
    for (const row of cloudTombstones) {
      DB.deletedParts.set(String(row.id), row.data || {});
    }
    console.log(`[cloud] loaded ${DB.deletedParts.size} deleted-part tombstone(s)`);
  } else {
    console.warn("[cloud] deleted_parts fetch failed — tombstone filter INACTIVE this session");
  }

  // Pull current cloud parts (paginated to handle >1000 rows)
  const data = await _fetchAllParts();
  if (data === null) {
    showToast("Cloud sync failed during initial fetch", "crit");
    return;
  }

  console.log(`[cloud] cloud has ${data.length} parts, local has ${DB.parts.length}`);

  if (data.length === 0 && DB.parts.length > 0) {
    // First-time migration: push local up
    showToast(`Pushing ${DB.parts.length} parts to cloud (one-time)…`, "info", "Cloud sync");
    const success = await _pushAllParts();
    if (success) {
      showToast(`Migration complete: ${DB.parts.length} parts now in cloud`, "ok", "Cloud sync");
    }
  } else if (data.length > 0) {
    // Cloud has data → replace local. In-place mutation (length=0 +
    // push) so any pre-existing reference to DB.parts stays valid —
    // matches the invariant realtime handlers rely on. Filter drops
    // any pn present in DB.deletedParts so tombstoned parts never
    // enter DB.parts.
    const cloudParts = data.map(r => ({ pn: r.pn, ...r.data, updatedAt: r.updated_at || null }));
    const filtered = cloudParts.filter(p => !DB.deletedParts.has(String(p.pn)));
    const droppedCount = cloudParts.length - filtered.length;
    DB.parts.length = 0;
    for (const p of filtered) DB.parts.push(p);
    _origSaveDB ? _origSaveDB.call(window) : saveDB();
    if (typeof bumpStatusCache === "function") bumpStatusCache();
    if (typeof refresh === "function") refresh();
    showToast(
      `Synced ${filtered.length} parts from cloud${droppedCount > 0 ? ` (${droppedCount} tombstoned)` : ""}`,
      "ok", "Cloud connected"
    );
  }

  // ---- queue_entries (sidecar for "Newest in queue" sort) ----
  // Poll-only — this table is NOT in the realtime publication.
  // Populated by _detectQueueEntries() firing from refresh(). Fetched
  // AFTER parts so a hypothetical FK on parts is satisfied and the
  // mirror aligns with the parts set the detector will diff against.
  if (!(DB.queueEntries instanceof Map)) DB.queueEntries = new Map();
  else DB.queueEntries.clear();
  _stampedPns.clear();
  const cloudQE = await _fetchAllQueueEntries();
  if (cloudQE !== null) {
    for (const row of cloudQE) {
      if (!row || !row.pn) continue;
      DB.queueEntries.set(String(row.pn), { firstEnteredAt: row.first_entered_at || null });
      _stampedPns.add(String(row.pn));
    }
    console.log(`[cloud] loaded ${DB.queueEntries.size} queue_entries stamp(s)`);
  } else {
    console.warn("[cloud] queue_entries fetch failed — 'Newest in queue' sort will show unstamped this session; detector will re-attempt stamps");
  }

  // ---- POs ----
  const cloudPos = await _fetchAllPos();
  if (cloudPos !== null) {
    if (cloudPos.length === 0 && DB.pos && DB.pos.length > 0) {
      showToast(`Pushing ${DB.pos.length} POs to cloud (one-time)…`, "info", "Cloud sync");
      await _pushAllPos();
      showToast(`Migrated ${DB.pos.length} POs to cloud`, "ok", "Cloud sync");
    } else if (cloudPos.length > 0) {
      DB.pos = cloudPos.map(r => ({ id: r.id, ...r.data }));
      _origSaveDB ? _origSaveDB.call(window) : saveDB();
      if (typeof bumpStatusCache === "function") bumpStatusCache();
      if (typeof refresh === "function") refresh();
      showToast(`Synced ${cloudPos.length} POs from cloud`, "ok");
    }
  }

  // ---- Draft Order ----
  const cloudDraft = await _fetchCloudDraft();
  if (cloudDraft !== null) {
    if (typeof DRAFT_ORDER !== "undefined") {
      if (cloudDraft.items.length === 0 && DRAFT_ORDER.length > 0) {
        // Local content, cloud is empty — push local as the first authoritative
        // write. _pushDraft stamps updatedAt and adopts it into
        // _lastDraftUpdatedAt on success, so the boot baseline is correct
        // either way (cloud row or freshly-migrated local).
        await _pushDraft();
      } else if (cloudDraft.items.length > 0) {
        DRAFT_ORDER.length = 0;
        DRAFT_ORDER.push(...cloudDraft.items);
        if (typeof draftOrderSave === "function") draftOrderSave();
        if (typeof updateDraftOrderPill === "function") updateDraftOrderPill();
      }
    }
    _lastCloudDraftHash = _hashDraft(typeof DRAFT_ORDER !== "undefined" ? DRAFT_ORDER : []);
    // Adopt the cloud row's updatedAt as this session's LWW baseline. If
    // the cloud row was written pre-fix (no updatedAt) or _pushDraft
    // already stamped one during the migration branch above, prefer the
    // stamped value; otherwise fall through to cloudDraft.updatedAt.
    if (!_lastDraftUpdatedAt) _lastDraftUpdatedAt = cloudDraft.updatedAt || null;
  }

  // ---- Audit Log ----
  // Cloud-wins strategy (NOT merge): cloud is source of truth.
  // Local rows missing from cloud are treated as "deleted in cloud" and removed.
  const cloudAudit = await _fetchAllAudit();
  if (cloudAudit !== null) {
    if (cloudAudit.length === 0 && DB.audit && DB.audit.length > 0) {
      // Cloud is empty for the first time — push local up
      showToast(`Pushing ${DB.audit.length} audit entries to cloud (one-time)…`, "info", "Cloud sync");
      await _pushAllAudit();
    } else {
      // Cloud has data — replace local entirely with cloud
      DB.audit = cloudAudit.map(r => ({ id: r.id, ...r.data })).sort((a, b) => {
        const ta = a.ts || a.time || "";
        const tb = b.ts || b.time || "";
        return tb.localeCompare(ta); // newest first
      });
      _origSaveDB ? _origSaveDB.call(window) : saveDB();
    }
  }

  // ---- Settings ----
  const cloudSettings = await _fetchCloudSettings();
  if (cloudSettings !== null) {
    DB.settings = { ...DB.settings, ...cloudSettings };
    _origSaveDB ? _origSaveDB.call(window) : saveDB();
  } else if (DB.settings) {
    await _pushSettings();
  }
  _lastCloudSettingsHash = _hashSettings(DB.settings);

  // ---- Usage ----
  // Cloud-wins strategy (NOT merge): cloud is source of truth.
  // Local rows missing from cloud are treated as "deleted in cloud" and removed.
  const cloudUsage = await _fetchAllUsage();
  if (cloudUsage !== null) {
    if (cloudUsage.length === 0 && DB.usage && DB.usage.length > 0) {
      // Cloud is empty for the first time — push local up
      showToast(`Pushing ${DB.usage.length} usage entries to cloud (one-time)…`, "info", "Cloud sync");
      await _pushAllUsage();
    } else {
      // Cloud has data — replace local entirely with cloud
      DB.usage = cloudUsage.map(r => ({ id: r.id, ...r.data })).sort((a, b) => {
        const ta = a.ts || ""; const tb = b.ts || "";
        return tb.localeCompare(ta);
      });
      _origSaveDB ? _origSaveDB.call(window) : saveDB();
      if (cloudUsage.length > 0) {
        showToast(`Synced ${cloudUsage.length} usage entries from cloud`, "ok");
      }
    }
  }

  // ---- Kit BOMs ----
  // Cloud-wins strategy. In-place mutation of DB.kitBoms.
  const cloudKitBoms = await _fetchAllKitBoms();
  if (cloudKitBoms !== null) {
    if (!DB.kitBoms || typeof DB.kitBoms !== "object") DB.kitBoms = {};
    if (cloudKitBoms.length === 0 && Object.keys(DB.kitBoms).length > 0) {
      // Cloud is empty for the first time — push local up
      showToast(`Pushing ${Object.keys(DB.kitBoms).length} kit BOMs to cloud (one-time)…`, "info", "Cloud sync");
      await _pushAllKitBoms();
    } else {
      // Replace local entirely with cloud (in place)
      for (const k of Object.keys(DB.kitBoms)) delete DB.kitBoms[k];
      for (const r of cloudKitBoms) DB.kitBoms[r.kit_pn] = { kit_pn: r.kit_pn, ...r.data };
      _origSaveDB ? _origSaveDB.call(window) : saveDB();
      if (cloudKitBoms.length > 0) {
        showToast(`Synced ${cloudKitBoms.length} kit BOMs from cloud`, "ok");
      }
    }
    _lastCloudKitBomsHash = _hashKitBoms(DB.kitBoms);
  }

  // ---- BOM Links (read-only) ----
  // Slow-moving reference data; we pull once on boot and never push from the
  // browser. Stored as a flat array of { bomId, parent, child, qty, uom }.
  // NOT persisted via saveDB — re-fetched from cloud each session — and NOT
  // included in the realtime subscription set below.
  const cloudBomLinks = await _fetchAllBomLinks();
  if (cloudBomLinks !== null) {
    DB.bomLinks = cloudBomLinks.map(r => ({ id: r.id, ...r.data }));
    console.log(`[cloud] loaded ${DB.bomLinks.length} bom_links rows`);
    if (DB.bomLinks.length === 0) {
      console.warn("[cloud] bom_links is EMPTY — multi-level BOM explosion will return no leaves. Check Supabase table or daily Acumatica BOM sync.");
    }
    if (typeof refresh === "function") refresh();
  } else {
    // Fetch failed entirely — keep whatever's already on DB (likely undefined)
    // and warn so the page can surface it.
    console.warn("[cloud] bom_links fetch failed; DB.bomLinks may be unset");
    if (!Array.isArray(DB.bomLinks)) DB.bomLinks = [];
  }

  // ---- Production Orders (read-only reporting) ----
  // Populated weekly by acumatica-production-orders-sync. Client mirror
  // DB.productionOrders is read-only — never pushed, never mutated by
  // any user action. Feeds the "BOM Usage Weekly" reporting tab and
  // NOTHING else (no partStatus/queueParts/daily-rate coupling). Not
  // in the realtime publication — poll-only via this fetch + reconnect
  // catchup. Isolation contract: nothing else in the app reads or
  // writes DB.productionOrders.
  const cloudProductionOrders = await _fetchAllProductionOrders();
  if (cloudProductionOrders !== null) {
    DB.productionOrders = cloudProductionOrders.map(r => ({ id: r.id, ...r.data }));
    console.log(`[cloud] loaded ${DB.productionOrders.length} production_orders rows`);
  } else {
    console.warn("[cloud] production_orders fetch failed; DB.productionOrders may be unset");
    if (!Array.isArray(DB.productionOrders)) DB.productionOrders = [];
  }

  // ---- Build Plan (shared what-if input) ----
  // Sidecar table split into two roles by _populateBuildPlanTargetsFromRows:
  //   - '__settings__' sentinel row → DB.buildPlanTargets.settings
  //   - all other rows → DB.buildPlanTargets.overrides (Map<fg_sku, ...>)
  // Poll-only. NOT in the realtime publication; a reconnect catchup
  // re-fetches so a concurrent edit from another session lands on the
  // next reconnect.
  const cloudBuildPlanTargets = await _fetchAllBuildPlanTargets();
  if (cloudBuildPlanTargets !== null) {
    _populateBuildPlanTargetsFromRows(cloudBuildPlanTargets);
    const s = DB.buildPlanTargets.settings;
    console.log(`[cloud] loaded build_plan_targets: ${DB.buildPlanTargets.overrides.size} override(s), settings=${s ? `target ${s.targetPerWeek}/wk, window ${s.windowWeeks}wk` : "unset"}`);
  } else {
    console.warn("[cloud] build_plan_targets fetch failed; DB.buildPlanTargets may be empty this session");
    if (!DB.buildPlanTargets || !(DB.buildPlanTargets.overrides instanceof Map)) {
      DB.buildPlanTargets = { settings: null, overrides: new Map() };
    }
  }

  // ---- Frame Schedule (MOR-RYDE weekly cap + qty grid) ----
  // Sidecar table, poll-only like build_plan_targets. Rows keyed by
  // ISO Monday date in fg_sku; data jsonb carries {caps, qty}.
  const cloudFrameSchedule = await _fetchAllFrameSchedule();
  if (cloudFrameSchedule !== null) {
    _populateFrameScheduleFromRows(cloudFrameSchedule);
    console.log(`[cloud] loaded frame_schedule: ${DB.frameSchedule.weeks.size} week(s)`);
  } else {
    console.warn("[cloud] frame_schedule fetch failed; DB.frameSchedule may be empty this session");
    if (!DB.frameSchedule || !(DB.frameSchedule.weeks instanceof Map)) {
      DB.frameSchedule = { settings: null, weeks: new Map(), loaded: false };
    }
  }

  // ---- PO Receipts (last 26 weeks, read-only overlay) ----
  // Populated daily by acumatica-po-receipts-sync. Client mirror
  // DB.poReceipts is READ ONLY — never pushed, never mutated by any
  // user action. Feeds the Frame Schedule tab's "got N" received-vs-
  // scheduled overlay and NOTHING else. Not in the realtime
  // publication — poll-only via this fetch + reconnect catchup.
  const cloudPoReceipts = await _fetchAllPoReceipts();
  if (cloudPoReceipts !== null) {
    if (!Array.isArray(DB.poReceipts)) DB.poReceipts = [];
    DB.poReceipts.length = 0;
    for (const r of cloudPoReceipts) DB.poReceipts.push({ id: r.id, ...r.data });
    console.log(`[cloud] loaded ${DB.poReceipts.length} po_receipts rows (full archive for FRAME_PNS)`);
  } else {
    console.warn("[cloud] po_receipts fetch failed; DB.poReceipts may be unset");
    if (!Array.isArray(DB.poReceipts)) DB.poReceipts = [];
  }

  _cloudReady = true;
  // Prime snapshots so future _detectChanges() only flags real edits
  for (const p of DB.parts) _partsSnapshot.set(p.pn, JSON.stringify(p));
  for (const po of (DB.pos || [])) _posSnapshot.set(po.id, JSON.stringify(po));
  for (const a of (DB.audit || [])) if (a.id) _partsSnapshot.set("audit_" + a.id, "1");
  for (const u of (DB.usage || [])) if (u.id) _usageSnapshot.set(u.id, JSON.stringify(u));
  for (const [kit_pn, kit] of Object.entries(DB.kitBoms || {})) _kitBomsSnapshot.set(kit_pn, JSON.stringify(kit));
  _partsSnapshot.set("__settings__", JSON.stringify(DB.settings || {}));
  // follow_marks — ONE fetch, populate window.followMarks, NEVER prune
  // on load. Expiry (3 business days) is decided at READ time by the
  // UI consumer; deleting on boot would fire DELETE events into the
  // realtime handler and could re-enter the load path. Stale rows just
  // render as inactive — table cleanliness is a non-goal here.
  // Mutate IN PLACE so any earlier consumer holding the map ref stays
  // valid (the page may have rendered an empty list before this fetch).
  if (!window.followMarks) window.followMarks = new Map();
  const fmRows = await _fetchAllFollowMarks();
  if (Array.isArray(fmRows)) {
    window.followMarks.clear();
    for (const r of fmRows) {
      if (r && r.id && r.data) window.followMarks.set(r.id, r.data);
    }
    console.log(`[cloud] loaded ${window.followMarks.size} follow_marks`);
  }

  // Phase 2 broadcast migration, Step 1 — seed the delta cursors after
  // every boot full-scan has adopted its cloud state. Nothing consumes
  // these yet; the delta fetchers exist but are unwired.
  await _seedLastSeenCursors();

  _hookSaveDB();
  _hookDraftSave();
  _showCloudIndicator(true);
  _setupRealtimeSubscriptions();
  // Phase 2 broadcast migration, Step 2 — parallel broadcast channel.
  // Listener is INERT until Step 3 wires senders; the postgres_changes
  // channel above remains authoritative for now.
  _setupBroadcastChannel();
  // Watchdog for the realtime socket. visibilitychange/online/focus catch
  // laptop-wake and network-blip transitions; the interval catches silent
  // zombie sockets that never fire CLOSED. Both are idempotent one-shots.
  _installConnectionListeners();
  _startHeartbeat();
  // Polling fallback: re-fetches parts + pos every POLL_INTERVAL_MS
  // when the tab is visible AND realtime hasn't delivered recently.
  // Read-only; does not count against realtime quota. See the block
  // near _cloudPollTick for the full change-detection + dirty-skip
  // logic.
  _startCloudPoll();
  // Initial-fetch confirmation for the header sync indicator. Every
  // subsequent freshness update (realtime accept, poll success,
  // catch-up) bumps this the same way.
  window._lastCloudSyncAt = Date.now();
  if (typeof updateSyncIndicator === "function") updateSyncIndicator();
  // Live tick-down for "SYNCED · N min ago" — updates ONLY the indicator
  // element's text, no page re-render. 15 s cadence is fine: "just now"
  // rolls to "1 min ago" within a minute of the last cloud touch.
  _startSyncIndicatorTicker();

  // First-class kit migration: tag parts present in kit_boms as itemType="kit".
  // Runs AFTER snapshot priming + _hookSaveDB so the tagged parts are detected
  // as dirty by _detectChanges and pushed to cloud (persisted), not just
  // mutated locally. Idempotent — a no-op once everything is already tagged.
  if (typeof tagKitsFromKitBoms === "function") {
    try { tagKitsFromKitBoms(); } catch (e) { console.warn("[kits] tag migration failed", e); }
  }
}

let _realtimeChannel = null;
let _suppressNextLocalChange = false; // prevents echo: don't re-push what we just received

// ── Realtime watchdog state ─────────────────────────────────────────
// Supabase's WebSocket-based realtime channel can die silently on: laptop
// sleep, mobile background, network blip, server-side idle timeout, or
// captive-portal hijack. The subscribe() status callback below detects
// CHANNEL_ERROR / TIMED_OUT / CLOSED and reconnects with exponential
// backoff. On every accepted realtime event we bump _lastRealtimeAt so
// the heartbeat + visibility listeners can distinguish "healthy but
// quiet" from "zombie socket that stopped delivering".
let _lastRealtimeAt = 0;                  // wall-clock ms of most recent accepted event
// Separate from _lastRealtimeAt (which is socket-specific): tracks when
// THIS CLIENT last successfully confirmed data is current. Bumped by:
//   - every accepted realtime event
//   - every successful poll tick (even a no-change tick — the check succeeded)
//   - the initial cloudInit fetch
//   - _catchupFetch on reconnect
// The header sync indicator (updateSyncIndicator in 18-excel-sync.js)
// reads THIS, not the audit table, so a disconnected tab correctly
// ages out of "SYNCED" instead of showing another client's sync time.
// Exposed on window so cross-file readers don't rely on classic-script
// scope sharing.
window._lastCloudSyncAt = 0;
let _realtimeBackoffMs = 0;               // grows 1s → 2s → 4s → … → capped 30s
let _realtimeReconnectTimer = null;       // pending backoff timer, if any
let _realtimeReconnecting = false;        // reentrancy guard

// Reconnect generation. Incremented at the top of every _reconnectRealtime
// call. Each channel's subscribe() callback captures the generation at
// channel-creation time and self-ignores any status event where its
// captured gen != the current _reconnectGen. Effect: only the LATEST
// reconnect's channels can drive state — every prior channel's straggler
// events are silenced structurally, regardless of timing. This replaces
// the reverted _intentionalClose flag (which couldn't distinguish which
// teardown a CLOSED belonged to).
let _reconnectGen = 0;

// Coalesce concurrent reconnect requests. If _reconnectRealtime is called
// while one is already in flight, we don't stack; we mark this flag and
// the current run's finally re-schedules ONCE at the end.
let _reconnectAgain = false;

// Backoff-reset dwell timer. Backoff resets to 0 ONLY after the
// connection has been stably subscribed for BACKOFF_RESET_DWELL_MS.
// This kills the "stuck at 1000ms" loop where a brief SUBSCRIBED-then-
// CLOSED cycle would otherwise reset backoff every iteration. Genuine
// loops now see backoff CLIMB (1s→2s→4s…) until the intervals get
// long enough to stop hammering. Cancelled on any CLOSED.
let _backoffResetTimer = null;
const BACKOFF_RESET_DWELL_MS = 8000;
let _heartbeatTimer = null;               // 5-min interval that probes for zombies
let _connectionListenersInstalled = false; // visibility/online/focus one-shot
let _hasSubscribedOnce = false;            // guards the catch-up fetch — first
                                            // SUBSCRIBED is cloudInit's initial
                                            // fetch; subsequent SUBSCRIBEDs are
                                            // reconnects and need catch-up.

// Shared subscribe/close bookkeeping for both channels. Kept in helpers
// so the two channels' status-callback bodies stay identical.
function _onChannelSubscribed() {
  _lastRealtimeAt = Date.now();
  // Cancel any pending reconnect timer — we're currently healthy, so
  // the queued reconnect (originally scheduled while offline) would
  // now tear down a healthy channel. This is the direct fix for the
  // "stuck at 1000ms" loop: the stale queued reconnect no longer
  // fires against a now-subscribed channel.
  if (_realtimeReconnectTimer) {
    clearTimeout(_realtimeReconnectTimer);
    _realtimeReconnectTimer = null;
    console.log("[cloud] pending reconnect cancelled — channel is healthy");
  }
  // Start (or restart) the dwell timer. Backoff only resets after
  // BACKOFF_RESET_DWELL_MS of continuous subscription — a brief
  // SUBSCRIBED-then-CLOSED cycle cancels the timer BEFORE reset,
  // leaving backoff climbing.
  if (_backoffResetTimer) clearTimeout(_backoffResetTimer);
  _backoffResetTimer = setTimeout(() => {
    _backoffResetTimer = null;
    if (_realtimeBackoffMs > 0) {
      console.log(`[cloud] backoff reset to 0 after ${BACKOFF_RESET_DWELL_MS}ms stable subscription`);
      _realtimeBackoffMs = 0;
    }
  }, BACKOFF_RESET_DWELL_MS);
}

function _onChannelClosed() {
  // Cancel the dwell timer — we're no longer stably subscribed.
  // Backoff stays at its current climbed value.
  if (_backoffResetTimer) {
    clearTimeout(_backoffResetTimer);
    _backoffResetTimer = null;
  }
}

function _setupRealtimeSubscriptions() {
  if (_realtimeChannel) return; // already subscribed
  if (!_supa) return;

  // Every accepted event stamps _lastRealtimeAt. The heartbeat below
  // uses this to catch zombie sockets that report "joined" but silently
  // stopped delivering (Supabase's realtime layer occasionally does this
  // through captive portals and after prolonged idle).
  // wrap ALSO stamps _lastRemoteApplyAt for INSERT/UPDATE. Critical:
  // this stamp lives HERE, NOT inside the handlers. The handlers are
  // also called by _applyBroadcastRow (bypassing wrap). If the stamp
  // were in the handler, broadcast dispatches would self-stamp, and
  // under Step 5 (broadcast-only) two pings for the same row 2s apart
  // would self-suppress the second apply. Keeping the stamp in wrap
  // means only real postgres_changes events stamp; broadcast never
  // does. Under Step 5: no postgres_changes → no stamps → no self-
  // suppress → rapid successive changes both apply as intended.
  const wrap = (fn, table) => (payload) => {
    const now = Date.now();
    _lastRealtimeAt = now;
    window._lastCloudSyncAt = now;              // header indicator freshness
    if (table && payload && payload.eventType !== "DELETE" && payload.new) {
      _stampRemoteApplyAt(table, payload.new);
    }
    fn(payload);
  };

  // Only tables IN the supabase_realtime publication can be subscribed
  // via postgres_changes. Current publication: parts, pos, settings,
  // deleted_parts, follow_marks, draft_order (6 tables). Subscribing to
  // audit, usage, or kit_boms is REJECTED by the Realtime server with
  // "Unable to subscribe to changes with given parameters", which
  // closes the entire channel and triggers a self-feeding reconnect
  // loop. Those three tables were deliberately dropped from the
  // publication to save quota — they're written server-side (Netlify
  // syncs) or client-side without cross-tab-live urgency, and any
  // cross-tab propagation they need is handled by the broadcast delta
  // path (_BROADCAST_FETCHERS covers all three).
  // Capture gen at channel-creation. The subscribe callback compares
  // this against _reconnectGen on every status event; a mismatch means
  // a newer reconnect has superseded us, and we silently ignore.
  // Effect: only the LATEST reconnect's channel drives state.
  const capturedGen = _reconnectGen;
  const chan = _supa
    .channel("landmaster-sync")
    .on("postgres_changes", { event: "*", schema: "public", table: "parts" },         wrap(_handleRealtimePart,         "parts"))
    .on("postgres_changes", { event: "*", schema: "public", table: "pos" },           wrap(_handleRealtimePO,           "pos"))
    .on("postgres_changes", { event: "*", schema: "public", table: "draft_order" },   wrap(_handleRealtimeDraft,        null))    // not in _BROADCAST_FETCHERS — no stamp
    .on("postgres_changes", { event: "*", schema: "public", table: "settings" },      wrap(_handleRealtimeSettings,     "settings"))
    .on("postgres_changes", { event: "*", schema: "public", table: "follow_marks" },  wrap(_handleRealtimeFollowMark,   "follow_marks"))
    .on("postgres_changes", { event: "*", schema: "public", table: "deleted_parts" }, wrap(_handleRealtimeDeletedParts, "deleted_parts"));
  _realtimeChannel = chan;
  chan.subscribe((status, err) => {
    // Structural stale-channel guard — see _reconnectGen docstring.
    // Any status event from a channel whose captured gen no longer
    // matches the current gen is from a superseded reconnect; ignore.
    if (capturedGen !== _reconnectGen) {
      console.debug(`[cloud] stale status ${status} from gen-${capturedGen} landmaster-sync (current gen ${_reconnectGen}) — ignoring`);
      return;
    }
    console.log("[cloud] realtime status:", status, err || "");
    if (status === "SUBSCRIBED") {
      // Healthy — cancel pending reconnect timer and start dwell for
      // backoff reset. See _onChannelSubscribed for the rationale.
      _onChannelSubscribed();
      _showCloudIndicator(true);
      // On a RECONNECT (not initial boot subscribe), pull catch-up:
      // the socket doesn't replay missed events.
      if (_hasSubscribedOnce) {
        _catchupFetch().catch((e) => console.warn("[cloud] catch-up fetch failed", e));
      }
      _hasSubscribedOnce = true;
    } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      console.warn("[cloud] realtime unhealthy — will reconnect", { status, err });
      _showCloudIndicator(false, "reconnecting");
      _onChannelClosed();
      _scheduleRealtimeReconnect();
    }
  });
}

// ── Broadcast channel setup (Phase 2 broadcast migration, Step 2) ─────
// Separate channel from "landmaster-sync". This one only listens for
// broadcast events, not postgres_changes. INERT until Step 3 wires
// senders — no messages will arrive today. Reconnect logic is deferred
// to Step 5 (when postgres_changes is retired); until then the parallel
// postgres_changes channel is authoritative and this listener is
// additive.
function _setupBroadcastChannel() {
  if (_broadcastChannel) return;
  if (!_supa) return;

  // Same freshness stamping as landmaster-sync's wrap. Any accepted
  // broadcast payload OR DELETE event bumps _lastRealtimeAt so the
  // poll's skip-after-realtime gate and the header sync-indicator both
  // treat it as fresh activity. Kept LOCAL to this setup so the two
  // channels' setups stay self-contained and mirror each other.
  //
  // wrap accepts a `table` arg for symmetry with landmaster-sync, but
  // the _stampRemoteApplyAt call is DEAD CODE on this channel — the
  // DELETE-only filter means payload.eventType is always "DELETE" and
  // the stamp condition never fires. Kept identical to landmaster-
  // sync's wrap so future changes stay consistent across both.
  const wrap = (fn, table) => (payload) => {
    const now = Date.now();
    _lastRealtimeAt = now;
    window._lastCloudSyncAt = now;
    if (table && payload && payload.eventType !== "DELETE" && payload.new) {
      _stampRemoteApplyAt(table, payload.new);
    }
    fn(payload);
  };

  // Capture gen at channel-creation. See landmaster-sync setup for
  // rationale. Straggler status events from a superseded broadcast
  // channel are structurally silenced.
  const capturedGen = _reconnectGen;
  const chan = _supa
    .channel("landmaster-broadcast")
    .on("broadcast", { event: "data-changed" }, (msg) => _handleDataChanged(msg && msg.payload))
    // DELETE-only postgres_changes for tables where deletion propagation
    // matters after landmaster-sync is retired in Step 5. Reuses the
    // existing handlers' DELETE branches verbatim — each reads only
    // payload.old.<pk> which REPLICA IDENTITY DEFAULT provides.
    //
    // ONLY tables in the supabase_realtime publication are listed.
    // audit / usage / kit_boms are NOT in the publication and were
    // dropped from these DELETE listeners too (subscribing to an
    // unpublished table is rejected and closes the channel — same
    // failure mode as the event:"*" mismatch on landmaster-sync). If
    // any of those three ever needs cross-tab delete propagation, the
    // broadcast payload's reserved `deleted: {...}` field is the path,
    // not a postgres_changes subscription.
    //
    // Skipped: settings (single-row, no delete concept), draft_order
    // (LWW-managed, no delete concept), audit/usage/kit_boms (not
    // published). Recency guard NOT applied on this path — a delete
    // does not race with an in-flight local save for the same row.
    //
    // Billing: only DELIVERED messages count against the realtime quota.
    // Non-DELETE events on these tables (INSERT/UPDATE) are filtered at
    // the Realtime server before delivery — zero messages billed on
    // this channel for the update volume we're trying to eliminate in
    // Step 5. Deletes are rare, so this cost is bounded.
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "parts"         }, wrap(_handleRealtimePart,         "parts"))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "pos"           }, wrap(_handleRealtimePO,           "pos"))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "follow_marks"  }, wrap(_handleRealtimeFollowMark,   "follow_marks"))
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "deleted_parts" }, wrap(_handleRealtimeDeletedParts, "deleted_parts"));
  _broadcastChannel = chan;
  chan.subscribe((status, err) => {
    // Structural stale-channel guard — see landmaster-sync setup.
    if (capturedGen !== _reconnectGen) {
      console.debug(`[cloud] stale status ${status} from gen-${capturedGen} landmaster-broadcast (current gen ${_reconnectGen}) — ignoring`);
      return;
    }
    console.log("[cloud] broadcast channel:", status, err || "");
    if (status === "SUBSCRIBED") {
      _onChannelSubscribed();
      // No catch-up here. The broadcast channel doesn't replay
      // missed events either, but reconnect-time catch-up for the
      // delete stream is a Step 5 concern (when landmaster-sync's
      // whole-table re-pull is retired). For now the parallel
      // landmaster-sync catch-up covers everything this channel
      // would need.
      return;
    }
    if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
      console.warn("[cloud] broadcast channel unhealthy — will reconnect", { status, err });
      _onChannelClosed();
      _scheduleRealtimeReconnect();
    }
  });
}

// Stamp _lastRemoteApplyAt for a single postgres_changes-delivered
// row. Called from the wrap() middleware on BOTH channels — but
// gated by the caller to eventType !== "DELETE". Deliberately NOT
// called from _applyBroadcastRow: that dispatches handlers directly,
// bypassing wrap, so broadcast-driven applies do NOT stamp. That's
// the Step-5 correctness invariant — under broadcast-only, two pings
// 2s apart for the same row must both apply (nothing to compare
// against), not have the second suppressed by the first's stamp.
function _stampRemoteApplyAt(table, row) {
  if (!table || !row) return;
  const now = Date.now();
  if (table === "settings") {
    _lastRemoteApplyAt.settings = now;
    return;
  }
  const m = _lastRemoteApplyAt[table];
  if (!m) return;
  let pk;
  switch (table) {
    case "parts":         pk = row.pn; break;
    case "pos":           pk = row.id; break;
    case "kit_boms":      pk = row.kit_pn; break;
    case "follow_marks":  pk = row.id; break;
    case "deleted_parts": pk = row.id; break;
    case "audit":         pk = row.id; break;
    case "usage":         pk = row.id; break;
    default: return;
  }
  if (pk != null) m.set(pk, now);
}

// PK extractor per table — the delta fetch returns rows shaped
// { <pkCol>, data, updated_at | created_at }. Used by the flush guards
// to look up recency stamps for the row about to be dispatched.
function _broadcastRowPk(table, row) {
  if (!row) return null;
  switch (table) {
    case "parts":         return row.pn;
    case "pos":           return row.id;
    case "settings":      return row.id;         // always "current"
    case "kit_boms":      return row.kit_pn;
    case "follow_marks":  return row.id;
    case "deleted_parts": return row.id;
    case "audit":         return row.id;
    case "usage":         return row.id;
    default:              return null;
  }
}

// Was this row applied by a postgres_changes handler within the last
// RECENT_REMOTE_APPLY_MS? If yes, the broadcast flush skips it to
// suppress the redundant double-apply/double-redraw during Step 3-4.
// Handlers stamp _lastRemoteApplyAt only when they actually apply
// (after their own tombstone + recency guards allow it), so a stamp
// unambiguously means "the store already reflects this remote change".
function _recentlyRemoteApplied(table, pk) {
  if (pk == null) return false;
  if (table === "settings") {
    const t = _lastRemoteApplyAt.settings || 0;
    return t > 0 && (Date.now() - t) < RECENT_REMOTE_APPLY_MS;
  }
  const m = _lastRemoteApplyAt[table];
  if (!m) return false;
  const t = m.get(pk) || 0;
  return t > 0 && (Date.now() - t) < RECENT_REMOTE_APPLY_MS;
}

// Did THIS client just save this row locally? If yes, the broadcast
// flush skips it (self-echo — nothing to apply, our local state is
// already fresher). The handlers also carry this guard internally as
// defense-in-depth; short-circuiting at the flush level lets us keep
// totalApplied honest (don't count as "applied" what the handler is
// about to skip anyway).
function _recentlyLocallySaved(table, pk) {
  if (pk == null) return false;
  if (table === "settings") {
    const t = _lastLocalSaveAt.settings || 0;
    return t > 0 && (Date.now() - t) < RECENT_SAVE_MS;
  }
  const m = _lastLocalSaveAt[table];
  if (!m) return false;
  const t = m.get(pk) || 0;
  return t > 0 && (Date.now() - t) < RECENT_SAVE_MS;
}

// Dispatch table for the broadcast flush: table name → delta fetcher.
// Central map so a Step 3 sender emitting an unrecognized table is
// logged and skipped, not silently applied.
const _BROADCAST_FETCHERS = {
  parts:          _fetchPartsSince,
  pos:            _fetchPosSince,
  settings:       _fetchSettingsSince,
  kit_boms:       _fetchKitBomsSince,
  follow_marks:   _fetchFollowMarksSince,
  deleted_parts:  _fetchDeletedPartsSince,
  audit:          _fetchAuditSince,
  usage:          _fetchUsageSince,
};

// Dispatch a delta-fetched row through the SAME postgres_changes-handler
// path the row would take if it had arrived as a realtime event. This is
// the "reuse existing helpers" contract: every guard (tombstone, recency,
// dirty, echo-skip) executes identically. Broadcast never delivers a
// DELETE payload — the delta fetch surfaces updates only. Row deletions
// are represented as INSERTs in the tombstone table (deleted_parts),
// which _handleRealtimeDeletedParts already handles by splicing the
// matching pn out of DB.parts. Table-scoped table deletes (e.g. a
// deleted follow_mark) are inherently lossy on this path; Step 3 senders
// can carry an explicit deleted_ids list if that becomes a problem.
function _applyBroadcastRow(table, row) {
  switch (table) {
    case "parts":         _handleRealtimePart({ eventType: "UPDATE", new: row }); break;
    case "pos":           _handleRealtimePO({ eventType: "UPDATE", new: row }); break;
    case "settings":      _handleRealtimeSettings({ new: row }); break;
    case "kit_boms":      _handleRealtimeKitBoms({ eventType: "UPDATE", new: row }); break;
    case "follow_marks":  _handleRealtimeFollowMark({ eventType: "UPDATE", new: row }); break;
    case "deleted_parts": _handleRealtimeDeletedParts({ eventType: "UPDATE", new: row }); break;
    case "audit":         _handleRealtimeAudit({ eventType: "UPDATE", new: row }); break;
    case "usage":         _handleRealtimeUsage({ eventType: "UPDATE", new: row }); break;
    default:              console.warn(`[cloud] broadcast: unknown table "${table}" — ignored`);
  }
}

// Broadcast-out — called after every successful client-side push to
// notify OTHER browsers that a table changed, so they delta-fetch and
// apply. Own-echo behavior on THIS browser: the ping fans out to us
// too; our _handleDataChanged runs, delta-fetches the row we just
// wrote, dispatches to _handleRealtimePart etc., and the recency guard
// (_lastLocalSaveAt.<table>, RECENT_SAVE_MS) causes the handler to
// return without re-applying — no visible effect. Non-blocking: the
// caller shouldn't need to await this. Errors are logged but never
// thrown; a failed broadcast is not a user-visible failure because the
// data is already persisted (and postgres_changes remains a live
// safety net until Step 5).
//
// `deleted` is intentionally unused today. Every table we care about
// carries deletion via the Step 2 DELETE-only postgres_changes
// listener on this same channel, so hard-deletes need no help from
// the broadcast payload. The parameter is in the signature so a
// future gap (a deletion type the DELETE listener can't cover) can be
// added without changing every call-site.
async function _sendDataChanged(tables, deleted) {
  if (!Array.isArray(tables) || tables.length === 0) return;
  // Defensive: skip if the broadcast channel hasn't finished subscribing
  // yet. supabase-js v2 will queue or drop sends on a not-yet-joined
  // channel depending on internal state; skipping is safer than
  // guessing. postgres_changes covers propagation in this narrow
  // pre-subscribe window (also transient — happens only in the first
  // few hundred ms of boot).
  if (!_broadcastChannel) return;
  if (_broadcastChannel.state !== "joined") {
    console.debug(`[cloud] broadcast send skipped — channel state=${_broadcastChannel.state}`);
    return;
  }
  try {
    const payload = { tables };
    if (deleted && typeof deleted === "object" && Object.keys(deleted).length > 0) {
      payload.deleted = deleted;
    }
    await _broadcastChannel.send({
      type: "broadcast",
      event: "data-changed",
      payload,
    });
  } catch (e) {
    console.warn("[cloud] broadcast send failed:", (e && e.message) || e);
  }
}

// Broadcast-in from any sender (this browser, other browsers, or a
// Netlify sync function). Payload shape: { tables: [...] }.
// Coalesces bursts within BROADCAST_DEBOUNCE_MS by unioning the pending
// table set — a sync that emits parts then pos as two pings collapses
// to one fetch pass.
function _handleDataChanged(payload) {
  const tables = Array.isArray(payload && payload.tables) ? payload.tables : [];
  if (tables.length === 0) return;
  for (const t of tables) _broadcastPendingTables.add(String(t));
  clearTimeout(_broadcastTimer);
  _broadcastTimer = setTimeout(_flushBroadcastPass, BROADCAST_DEBOUNCE_MS);
}

// One flush pass. Runs after debounce quiet-period expires.
//
// Tombstone ordering: if the pass includes both "deleted_parts" and
// "parts", process deleted_parts FIRST. Otherwise the parts delta could
// re-insert a pn whose tombstone this same pass would then apply on
// the following iteration — visible flicker + a wasted _applyAndRefresh.
// Processing tombstones first means _handleRealtimePart's
// DB.deletedParts.has(pn) guard drops any tombstoned pn from the parts
// delta on the SAME pass.
async function _flushBroadcastPass() {
  _broadcastTimer = null;
  if (_broadcastPendingTables.size === 0) return;

  // Snapshot + clear so pings arriving DURING the fetch enter a new
  // pending set (next debounce cycle), not this one.
  const pending = new Set(_broadcastPendingTables);
  _broadcastPendingTables.clear();

  // Deterministic order: deleted_parts first, then everything else in
  // insertion order (parts, pos, settings, ...).
  const orderedTables = [];
  if (pending.has("deleted_parts")) orderedTables.push("deleted_parts");
  for (const t of pending) if (t !== "deleted_parts") orderedTables.push(t);

  let totalApplied = 0;
  _broadcastInProgress = true;
  try {
    for (const table of orderedTables) {
      const fetcher = _BROADCAST_FETCHERS[table];
      if (!fetcher) {
        console.warn(`[cloud] broadcast: no fetcher for table "${table}" — skipped`);
        continue;
      }
      const cursor = _lastSeenAt[table];
      const { rows, maxSeenAt } = await fetcher(cursor);
      // rows === null → fetch failed. Do NOT advance the cursor; next
      // ping (or next boot-time reseeding via _catchupFetch in Step 5)
      // will retry from the same point.
      if (rows === null) continue;
      for (const row of rows) {
        const pk = _broadcastRowPk(table, row);
        // Guard #1 — postgres_changes just applied this row. During
        // Step 3-4 dual-run, both paths deliver the same change per
        // remote save; skipping here suppresses the redundant
        // second apply and the second _applyAndRefresh redraw.
        if (_recentlyRemoteApplied(table, pk)) {
          console.debug(`[cloud] broadcast: skipped ${table} ${pk} — postgres_changes just applied it`);
          continue;
        }
        // Guard #2 — this fetch is our own self-echo. Handler would
        // skip via its own local-save guard; short-circuiting here
        // keeps totalApplied honest so we don't fire a redraw for
        // a save we made ourselves.
        if (_recentlyLocallySaved(table, pk)) {
          console.debug(`[cloud] broadcast: skipped ${table} ${pk} — self-echo (recent local save)`);
          continue;
        }
        _applyBroadcastRow(table, row);
        totalApplied++;
      }
      // Only advance the cursor if the fetch actually returned rows.
      // maxSeenAt is null when the fetcher saw zero new rows — leaving
      // the cursor exactly where it was, which is correct. Advancing
      // even when every row was guard-skipped is intentional: we DID
      // see those rows, we just didn't need to apply them because
      // postgres_changes or our own save already did.
      if (maxSeenAt) _lastSeenAt[table] = maxSeenAt;
    }
  } catch (e) {
    console.error("[cloud] broadcast flush threw — cursors up to failure point were advanced:", (e && e.stack) || e);
  } finally {
    // ALWAYS clear the flag — a stuck-true would suppress every
    // subsequent postgres_changes-driven redraw.
    _broadcastInProgress = false;
  }

  if (totalApplied > 0) {
    const now = Date.now();
    // Stamp the realtime freshness clocks so the poll's skip-after-
    // realtime gate and the header sync-indicator both treat the
    // broadcast delivery as fresh activity (same as an accepted
    // postgres_changes event does via wrap()).
    _lastRealtimeAt = now;
    window._lastCloudSyncAt = now;
    console.log(`[cloud] broadcast data-changed: [${orderedTables.join(", ")}] → applied ${totalApplied} rows`);
    // Single batched redraw + IDB write + statusCache bump for the
    // entire pass. All the per-table dispatches short-circuited on
    // _broadcastInProgress; this is the only real call.
    _applyAndRefresh();
  }
}

// Reconnect the realtime channels from scratch: kill BOTH existing
// channels (landmaster-sync postgres_changes + landmaster-broadcast
// broadcast/DELETE), then rebuild both. The sync channel's SUBSCRIBED
// status callback handles the catch-up fetch on the next SUBSCRIBED;
// the broadcast channel needs no catch-up under Step 2 (see comment
// in _setupBroadcastChannel's subscribe callback).
//
// Both channels teardown together because either one being unhealthy
// almost always means the underlying WebSocket is unhealthy —
// Supabase multiplexes multiple channels over one WS. Rebuilding both
// costs one extra subscribe per reconnect (cheap) and guarantees the
// two channels stay in lockstep, so DELETE events can never lag
// behind the postgres_changes stream (or vice versa) after a wake.
async function _reconnectRealtime() {
  // Single-flight mutex. If a reconnect is already in flight, mark the
  // "again" flag; the current run's finally will fire one more cycle at
  // the end. Prevents overlapping rebuilds.
  if (_realtimeReconnecting) {
    _reconnectAgain = true;
    return;
  }
  if (!_supa) return;
  _realtimeReconnecting = true;
  // Bump generation BEFORE teardown so status events fired by the OLD
  // channels' removeChannel (whose subscribe callbacks captured the
  // previous gen) see mismatched gen and self-ignore. This is the
  // structural replacement for the reverted _intentionalClose flag.
  const myGen = ++_reconnectGen;
  try {
    // Cancel dwell (we're rebuilding — no longer stably subscribed).
    if (_backoffResetTimer) {
      clearTimeout(_backoffResetTimer);
      _backoffResetTimer = null;
    }
    // Teardown OLD channels. Null the module refs BEFORE the await so
    // wake/heartbeat state checks see null (short-circuiting to
    // "trigger reconnect" which is a no-op via the reentrancy guard),
    // and so any straggler CLOSED fired after removeChannel resolves
    // sees module ref !== chan closure (also a mismatch, but the gen
    // check already covers this — the null is belt-and-suspenders).
    if (_realtimeChannel) {
      const oldRt = _realtimeChannel;
      _realtimeChannel = null;
      try { await _supa.removeChannel(oldRt); } catch (e) { /* best-effort */ }
    }
    if (_broadcastChannel) {
      const oldBc = _broadcastChannel;
      _broadcastChannel = null;
      try { await _supa.removeChannel(oldBc); } catch (e) { /* best-effort */ }
    }
    // Defensive: if another reconnect somehow ran between now and our
    // gen bump (shouldn't happen with the reentrancy guard, but structural),
    // abort — a newer rebuild has already run and we'd stomp it.
    if (myGen !== _reconnectGen) {
      console.log(`[cloud] reconnect gen ${myGen} superseded by ${_reconnectGen} — aborting stale rebuild`);
      return;
    }
    _setupRealtimeSubscriptions();
    _setupBroadcastChannel();
  } finally {
    _realtimeReconnecting = false;
    // If a concurrent reconnect request came in during our flight,
    // fire ONE more cycle now (respecting backoff via schedule).
    if (_reconnectAgain) {
      _reconnectAgain = false;
      _scheduleRealtimeReconnect();
    }
  }
}

// Exponential backoff scheduler — 1s → 2s → 4s → 8s → 16s → capped 30s.
// Backoff resets to 0 ONLY after the connection has been stably
// subscribed for BACKOFF_RESET_DWELL_MS (see _onChannelSubscribed) —
// a SUBSCRIBED that immediately re-closes does NOT reset backoff, so
// a real loop CLIMBS toward the cap instead of hammering at 1000ms.
//
// N callers within one debounce → ONE pending timer:
//   - If a reconnect is already running: mark _reconnectAgain; the
//     current run's finally will schedule ONE more cycle at the end.
//     Multiple concurrent callers collapse to at most one follow-up.
//   - If a timer is already pending: no-op (existing coalesce).
//   - Otherwise: schedule.
function _scheduleRealtimeReconnect() {
  if (_realtimeReconnecting) {
    _reconnectAgain = true;
    return;
  }
  if (_realtimeReconnectTimer) return;
  _realtimeBackoffMs = Math.min(_realtimeBackoffMs > 0 ? _realtimeBackoffMs * 2 : 1000, 30000);
  console.log(`[cloud] scheduling realtime reconnect in ${_realtimeBackoffMs}ms`);
  _realtimeReconnectTimer = setTimeout(() => {
    _realtimeReconnectTimer = null;
    _reconnectRealtime();
  }, _realtimeBackoffMs);
}

// Catch-up fetch on reconnect. Realtime doesn't replay missed events,
// so after a disconnect we re-pull every table we subscribe to. Mutate
// in place (splice/length=0/push, never reassign) so any UI holding a
// reference to DB.parts / DB.pos / DB.deletedParts / window.followMarks
// stays valid.
//
// Deliberately DOES NOT re-run: SDK init, saveDB hook, draftSave hook,
// snapshot priming for _detectChanges, kit-migration. Those are one-
// time setup in cloudInit and reruns would corrupt dirty tracking.
async function _catchupFetch() {
  if (!_supa || !_cloudReady) return;
  const t0 = Date.now();

  // Tombstones first — same order as cloudInit so the parts filter below
  // sees the current tombstone set.
  const cloudTombstones = await _fetchAllDeletedParts();
  if (cloudTombstones !== null) {
    if (!(DB.deletedParts instanceof Map)) DB.deletedParts = new Map();
    DB.deletedParts.clear();
    for (const row of cloudTombstones) {
      DB.deletedParts.set(String(row.id), row.data || {});
    }
  }

  // Parts. Filter tombstoned pns exactly like cloudInit does.
  const cloudParts = await _fetchAllParts();
  if (cloudParts !== null && Array.isArray(cloudParts)) {
    const tombs = DB.deletedParts instanceof Map ? DB.deletedParts : new Map();
    const merged = cloudParts
      .filter((r) => r && r.pn && !tombs.has(String(r.pn)))
      .map((r) => ({ pn: r.pn, ...r.data, updatedAt: r.updated_at || null }));
    DB.parts.length = 0;
    for (const p of merged) DB.parts.push(p);
    // Re-prime the dirty-tracking snapshot so subsequent LOCAL edits
    // still detect properly. Without this, the first local edit after
    // reconnect would trigger a phantom "changed" upsert on every part.
    _partsSnapshot.clear();
    for (const p of DB.parts) _partsSnapshot.set(p.pn, JSON.stringify(p));
  }

  // POs.
  const cloudPos = await _fetchAllPos();
  if (cloudPos !== null) {
    const merged = cloudPos.map((r) => ({ id: r.id, ...r.data }));
    DB.pos.length = 0;
    for (const po of merged) DB.pos.push(po);
    _posSnapshot.clear();
    for (const po of DB.pos) _posSnapshot.set(po.id, JSON.stringify(po));
  }

  // queue_entries — pull fresh stamps that other sessions wrote while
  // we were disconnected. Detector's steady-state guard relies on
  // _stampedPns being accurate; without this, a PN stamped by another
  // session during our downtime would be missing from our mirror and
  // the next detector pass would issue an ignoreDuplicates INSERT
  // (harmless no-op, but avoidable) and the sort would still show it
  // as unstamped locally until next boot. Cheap: one paginated fetch.
  const cloudQEcatchup = await _fetchAllQueueEntries();
  if (cloudQEcatchup !== null) {
    if (!(DB.queueEntries instanceof Map)) DB.queueEntries = new Map();
    DB.queueEntries.clear();
    _stampedPns.clear();
    for (const row of cloudQEcatchup) {
      if (!row || !row.pn) continue;
      DB.queueEntries.set(String(row.pn), { firstEnteredAt: row.first_entered_at || null });
      _stampedPns.add(String(row.pn));
    }
  }

  // production_orders — weekly-cadence reference data. A reconnect
  // after the Monday sync should pick up the fresh week; without this
  // catch-up, the reporting tab would show last week's numbers until
  // the next full reboot. Read-only mirror — no snapshot priming, no
  // dirty tracking.
  const cloudProdOrdersCatchup = await _fetchAllProductionOrders();
  if (cloudProdOrdersCatchup !== null) {
    if (!Array.isArray(DB.productionOrders)) DB.productionOrders = [];
    DB.productionOrders.length = 0;
    for (const r of cloudProdOrdersCatchup) DB.productionOrders.push({ id: r.id, ...r.data });
  }

  // build_plan_targets — shared what-if state. A concurrent editor
  // in another session may have set targets while we were offline,
  // and our local mirror would be stale otherwise. Cheap: at most
  // 91 rows (one per FG).
  const cloudBPTargetsCatchup = await _fetchAllBuildPlanTargets();
  if (cloudBPTargetsCatchup !== null) {
    _populateBuildPlanTargetsFromRows(cloudBPTargetsCatchup);
  }

  // frame_schedule — shared weekly grid. Same rationale as
  // build_plan_targets: cheap fetch (a few dozen rows at most).
  const cloudFrameScheduleCatchup = await _fetchAllFrameSchedule();
  if (cloudFrameScheduleCatchup !== null) {
    _populateFrameScheduleFromRows(cloudFrameScheduleCatchup);
  }

  // po_receipts — daily-cadence history feed, 26-week window. A
  // reconnect after the 06:15 UTC sync should pick up the fresh
  // day; without this, the "got N" overlay on Frame Schedule would
  // show yesterday's receipt totals until the next full reboot.
  // Read-only mirror — no snapshot priming, no dirty tracking.
  const cloudPoReceiptsCatchup = await _fetchAllPoReceipts();
  if (cloudPoReceiptsCatchup !== null) {
    if (!Array.isArray(DB.poReceipts)) DB.poReceipts = [];
    DB.poReceipts.length = 0;
    for (const r of cloudPoReceiptsCatchup) DB.poReceipts.push({ id: r.id, ...r.data });
  }

  // Draft — LWW-safe adoption. Only accept cloud if strictly newer than
  // our baseline, so a stale-writer's clobber doesn't sneak in via
  // catch-up. Mirrors _isDraftBaselineCurrent semantics.
  const cloudDraft = await _fetchCloudDraft();
  if (cloudDraft && typeof DRAFT_ORDER !== "undefined") {
    const cloudTs = cloudDraft.updatedAt || "";
    const mineTs = _lastDraftUpdatedAt || "";
    if (!mineTs || (cloudTs && cloudTs > mineTs)) {
      DRAFT_ORDER.length = 0;
      for (const item of cloudDraft.items) DRAFT_ORDER.push(item);
      if (typeof draftOrderSave === "function") {
        _suppressNextLocalChange = true;
        draftOrderSave();
        _suppressNextLocalChange = false;
      }
      if (typeof updateDraftOrderPill === "function") updateDraftOrderPill();
      _lastCloudDraftHash = _hashDraft(cloudDraft.items);
      if (cloudDraft.updatedAt) _lastDraftUpdatedAt = cloudDraft.updatedAt;
    }
  }

  // Follow marks — in-place mutation so any consumer holding the Map ref
  // stays valid.
  const fmRows = await _fetchAllFollowMarks();
  if (Array.isArray(fmRows)) {
    if (!window.followMarks) window.followMarks = new Map();
    window.followMarks.clear();
    for (const r of fmRows) if (r && r.id && r.data) window.followMarks.set(r.id, r.data);
  }

  // Settings — merge (don't replace) so a client-local setting the
  // client already tweaked isn't clobbered by an older cloud snapshot.
  const cloudSettings = await _fetchCloudSettings();
  if (cloudSettings) DB.settings = { ...DB.settings, ...cloudSettings };

  _applyAndRefresh();
  // Freshness — same plausibility guard as _cloudPollTick. Only bump
  // when the key fetches (parts + pos) actually returned non-null AND,
  // if we already had local rows, cloud also had rows. A catchup where
  // every fetch returned null or 0 rows into a populated local means
  // reconnect saw no data — not a legitimate "everything is fresh"
  // state. Let the indicator age so the failure is visible.
  const catchupPosOk   = Array.isArray(cloudPos)   && (cloudPos.length > 0   || DB.pos.length === 0);
  const catchupPartsOk = Array.isArray(cloudParts) && (cloudParts.length > 0 || DB.parts.length === 0);
  if (catchupPosOk && catchupPartsOk) {
    window._lastCloudSyncAt = Date.now();
    if (typeof updateSyncIndicator === "function") updateSyncIndicator();
  } else {
    console.warn(
      `[cloud] catch-up: fetch returned implausibly empty result — freshness NOT bumped ` +
      `(cloudPos=${Array.isArray(cloudPos) ? cloudPos.length : "null"}, ` +
      `cloudParts=${Array.isArray(cloudParts) ? cloudParts.length : "null"}, ` +
      `DB.pos.length=${DB.pos.length}, DB.parts.length=${DB.parts.length}).`
    );
  }
  console.log(`[cloud] catch-up fetch complete in ${Date.now() - t0}ms`);
}

// Visibility / focus / online listeners — installed once. Triggered on
// tab wake-up, network resume, or window refocus. Kicks a reconnect
// unless the channel is already known-healthy (state === "joined").
function _installConnectionListeners() {
  if (_connectionListenersInstalled) return;
  _connectionListenersInstalled = true;

  const checkAndReconnect = (why) => {
    if (!_cloudReady) return;
    const rtState = _realtimeChannel && _realtimeChannel.state;
    const bcState = _broadcastChannel && _broadcastChannel.state;
    const staleness = Date.now() - (_lastRealtimeAt || 0);
    // "joined" is the healthy state string on Supabase's RealtimeChannel.
    // Any other state (closed, errored, joining, leaving) means we
    // shouldn't trust the socket. Both channels are checked because
    // _reconnectRealtime rebuilds both together — if the broadcast
    // channel is dead but sync is fine, we still want the broadcast
    // channel restored so DELETE propagation resumes. Also reconnect
    // if we haven't seen ANY realtime activity in >10 min — user just
    // woke the tab, get fresh data regardless of the socket's self-
    // report.
    if (rtState !== "joined" || bcState !== "joined" || staleness > 10 * 60 * 1000) {
      console.log(`[cloud] wake check (${why}): rt=${rtState}, bc=${bcState}, staleness=${staleness}ms — reconnecting`);
      _realtimeBackoffMs = 0;  // user-initiated wake — no throttling
      _reconnectRealtime();
    }
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkAndReconnect("visibility");
  });
  window.addEventListener("online", () => checkAndReconnect("online"));
  window.addEventListener("focus", () => checkAndReconnect("focus"));
}

// Heartbeat — every 5 minutes, verify the channel is joined. If not,
// reconnect. Also probes for zombie sockets: if the channel reports
// joined but hasn't delivered an event in >10 min AND the tab is
// visible, fetch a small row (draft_order) to sanity-check. If the
// probe fails, force a reconnect. Cheap: ~288 wake-cycles/day, at most
// 1 tiny fetch per zombie-suspicion event.
function _startHeartbeat() {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(() => {
    if (!_cloudReady) return;
    if (document.visibilityState !== "visible") return;   // don't probe from background
    // Both channels must be joined. If either dropped, rebuild both —
    // Step 5 makes the broadcast/delete channel the sole propagation
    // path for updates AND deletes, so any silent drop there would
    // stop all cross-user propagation until reload.
    const rtState = _realtimeChannel && _realtimeChannel.state;
    const bcState = _broadcastChannel && _broadcastChannel.state;
    if (rtState !== "joined" || bcState !== "joined") {
      console.log(`[cloud] heartbeat: rt=${rtState}, bc=${bcState} — reconnecting`);
      _reconnectRealtime();
      return;
    }
    const staleness = Date.now() - (_lastRealtimeAt || 0);
    if (staleness > 10 * 60 * 1000) {
      // Silent socket. Poke via draft_order (tiny, LWW-guarded).
      _fetchCloudDraft().then((res) => {
        if (res !== null) {
          // Fetch worked — connection is fine even though realtime is
          // quiet. Treat the successful probe as fresh activity so
          // we don't re-probe every minute.
          _lastRealtimeAt = Date.now();
        } else {
          console.log("[cloud] heartbeat probe failed — reconnecting");
          _reconnectRealtime();
        }
      });
    }
  }, 5 * 60 * 1000);
}

// ── Polling fallback ────────────────────────────────────────────────
// Belt-and-suspenders for the case where the realtime subscription is
// technically live (state === "joined") but the server is not actually
// delivering events. Every POLL_INTERVAL_MS the poll re-fetches parts
// and pos, diffs against the local snapshots, and merges in place if
// anything changed. Cost model:
//   - Reads via _fetchAllParts / _fetchAllPos (paginated). READS DO NOT
//     COUNT against the Supabase realtime message quota.
//   - Skips when the tab is hidden.
//   - Skips when the last realtime event arrived within
//     POLL_SKIP_AFTER_REALTIME_MS — realtime is working, poll idle.
//   - Skips a specific row if the local client has a dirty edit pending
//     push for it (avoids clobbering a mid-flight local change with the
//     old server value).
//   - Emits a log line ONLY when something actually changed.
// Zero writes anywhere in this loop; grep the block for `.upsert` /
// `.insert` / `.delete` — none.
const POLL_INTERVAL_MS = 30000;                  // 30 s — tune here
// If realtime delivered anything in the last 20s, skip this tick (poll
// stays subordinate to realtime whenever the WS is healthy). Value must
// be < POLL_INTERVAL_MS or every tick short-circuits.
const POLL_SKIP_AFTER_REALTIME_MS = 20000;
let _pollTimer = null;
let _pollInFlight = false;

// Deterministic row-content fingerprint for change detection. Naive
// JSON.stringify is KEY-ORDER SENSITIVE and Postgres JSONB does not
// preserve insertion order — a fetched row will typically come back
// with keys in a different order than what the client wrote. Comparing
// raw JSON.stringify(cloud) vs JSON.stringify(local) then reports a
// false "changed" on every poll tick, forever. Same class of bug we
// fixed server-side in acumatica-sync's PO fingerprint.
//
// _canonicalize recursively sorts object keys at every depth so two
// objects with identical content but different key insertion order
// produce identical JSON. Arrays are preserved (their order IS
// semantic for our data — e.g., PO lines by lineNbr).
function _canonicalize(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(_canonicalize);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = _canonicalize(v[k]);
    return out;
  }
  return v;
}
function _rowFingerprint(row) { return JSON.stringify(_canonicalize(row)); }

// Phantom-change storm guard. If the same row keeps getting reported
// as "changed" with the same fingerprint on consecutive ticks —
// meaning our diff logic is spuriously flagging a stable row — we
// stop counting it toward the re-render trigger. The data write
// still happens (harmless: same bytes overwriting the same bytes),
// but no full navigate() rebuild fires. Prevents unbounded DOM churn
// even if a future subtle diff bug re-emerges.
const PHANTOM_STREAK_THRESHOLD = 3;
const _lastAppliedPartFp = new Map();   // pn → most recent applied fingerprint
const _lastAppliedPosFp = new Map();    // id → most recent applied fingerprint
const _phantomPartStreak = new Map();
const _phantomPosStreak = new Map();

function _startCloudPoll() {
  if (_pollTimer) return;
  _pollTimer = setInterval(_cloudPollTick, POLL_INTERVAL_MS);
}

// Lightweight tick-down for the "SYNCED · N min ago" header pill. The
// indicator's text is derived from window._lastCloudSyncAt; every 15s
// we re-run updateSyncIndicator() to re-derive the relative-time string
// and (if the age has crossed a threshold) flip the pill class between
// ok / warn / crit. This touches ONE DOM node — not a full page render.
// No effect when the tab is hidden.
let _syncIndicatorTicker = null;
function _startSyncIndicatorTicker() {
  if (_syncIndicatorTicker) return;
  _syncIndicatorTicker = setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (typeof updateSyncIndicator === "function") updateSyncIndicator();
  }, 15000);
}

async function _cloudPollTick() {
  if (!_cloudReady || !_supa) return;
  if (document.visibilityState !== "visible") return;
  if (_pollInFlight) return;
  const sinceRealtime = _lastRealtimeAt > 0 ? (Date.now() - _lastRealtimeAt) : Infinity;
  if (sinceRealtime < POLL_SKIP_AFTER_REALTIME_MS) return;

  _pollInFlight = true;
  // Race-guard timestamp — captured BEFORE the fetch begins. Any local
  // save whose _lastLocalSaveAt is >= this value happened during (or
  // after) our now-stale fetch. The per-row apply loops below reject
  // such rows even if _dirtyParts.clear() already ran. Closes the poll
  // half of the save-clobber race (cause #1 in the diagnosis).
  const fetchStartAt = Date.now();
  try {
    // Parallel fetch — READ-ONLY, paginated helpers.
    const [cloudPosRows, cloudPartsRows] = await Promise.all([
      _fetchAllPos(),
      _fetchAllParts(),
    ]);

    let posChanged = 0;
    let partsChanged = 0;

    // ── POs — canonical-fingerprint diff + phantom-storm guard ──────
    const posChangedSamples = [];
    let posPhantomSuppressed = 0;
    if (Array.isArray(cloudPosRows)) {
      const cloudById = new Map();
      for (const r of cloudPosRows) if (r && r.id) cloudById.set(r.id, r);

      for (const [id, r] of cloudById.entries()) {
        if (_dirtyPos.has(id)) continue;
        // Second guard: race window between dirty-clear (push commit) and
        // this stale fetch resolving. If a local save landed at-or-after
        // fetchStartAt, our in-flight fetch predates it — do NOT apply.
        if ((_lastLocalSaveAt.pos.get(id) || 0) >= fetchStartAt) {
          console.debug(`[cloud] skipped stale apply for PO ${id} (local save newer than fetch)`);
          continue;
        }
        const merged = { id, ...r.data };
        const i = DB.pos.findIndex(p => p.id === id);
        const localPo = i >= 0 ? DB.pos[i] : null;
        const nextFp = _rowFingerprint(merged);
        const localFp = localPo ? _rowFingerprint(localPo) : null;
        if (localFp === nextFp) {
          _phantomPosStreak.delete(id);
          continue;
        }
        const prevAppliedFp = _lastAppliedPosFp.get(id);
        const isRepeatFp = prevAppliedFp === nextFp;
        if (isRepeatFp) {
          const streak = (_phantomPosStreak.get(id) || 0) + 1;
          _phantomPosStreak.set(id, streak);
          if (streak >= PHANTOM_STREAK_THRESHOLD) {
            if (streak === PHANTOM_STREAK_THRESHOLD) {
              console.warn(
                `[cloud] phantom-change loop for PO id=${id} — ` +
                `same fingerprint reported changed ${streak} consecutive ticks. ` +
                `Suppressing re-render for this row.`,
                { cloudRow: merged, localRow: localPo, cloudFp: nextFp.slice(0, 400), localFp: (localFp || "").slice(0, 400) }
              );
            }
            if (i >= 0) DB.pos[i] = merged;
            else DB.pos.push(merged);
            _posSnapshot.set(id, JSON.stringify(merged));
            _lastAppliedPosFp.set(id, nextFp);
            posPhantomSuppressed++;
            continue;
          }
        } else {
          _phantomPosStreak.delete(id);
        }
        if (i >= 0) DB.pos[i] = merged;
        else DB.pos.push(merged);
        _posSnapshot.set(id, JSON.stringify(merged));
        _lastAppliedPosFp.set(id, nextFp);
        posChanged++;
        if (posChangedSamples.length < 3) {
          posChangedSamples.push({
            id,
            poNum: merged && merged.num,
            cloudKeys: Object.keys(merged).sort(),
            localKeys: localPo ? Object.keys(localPo).sort() : null,
            cloudFpHead: nextFp.slice(0, 200),
            localFpHead: (localFp || "").slice(0, 200),
            cloudRow: merged,
            localRow: localPo,
          });
        }
      }
      // Server-side deletes.
      const idsToDelete = [];
      for (const po of DB.pos) {
        if (!cloudById.has(po.id) && !_dirtyPos.has(po.id)) idsToDelete.push(po.id);
      }
      for (const id of idsToDelete) {
        const i = DB.pos.findIndex(p => p.id === id);
        if (i >= 0) DB.pos.splice(i, 1);
        _posSnapshot.delete(id);
        _lastAppliedPosFp.delete(id);
        _phantomPosStreak.delete(id);
        posChanged++;
      }
    }

    // ── Parts — canonical-fingerprint diff + phantom-storm guard ────
    const partsChangedSamples = [];  // first 3 changed rows for diagnostics
    let partsPhantomSuppressed = 0;
    if (Array.isArray(cloudPartsRows)) {
      const tombs = DB.deletedParts instanceof Map ? DB.deletedParts : new Map();
      const cloudByPn = new Map();
      for (const r of cloudPartsRows) {
        if (r && r.pn && !tombs.has(String(r.pn))) cloudByPn.set(r.pn, r);
      }
      for (const [pn, r] of cloudByPn.entries()) {
        if (_dirtyParts.has(pn)) continue;
        // Second guard: race window between dirty-clear (push commit) and
        // this stale fetch resolving. If a local save landed at-or-after
        // fetchStartAt, our in-flight fetch predates it — do NOT apply.
        if ((_lastLocalSaveAt.parts.get(pn) || 0) >= fetchStartAt) {
          console.debug(`[cloud] skipped stale apply for part ${pn} (local save newer than fetch)`);
          continue;
        }
        const merged = { pn, ...r.data, updatedAt: r.updated_at || null };
        const i = DB.parts.findIndex(p => p.pn === pn);
        const localPart = i >= 0 ? DB.parts[i] : null;
        // Canonical fingerprint on BOTH sides. Key-order-insensitive.
        const nextFp = _rowFingerprint(merged);
        const localFp = localPart ? _rowFingerprint(localPart) : null;
        if (localFp === nextFp) {
          // Genuinely identical content — reset any phantom streak.
          _phantomPartStreak.delete(pn);
          continue;
        }
        // Phantom detection: if we're being asked to apply the SAME
        // fingerprint we already applied last tick (or many ticks in
        // a row), that's a spurious "change" — the row isn't actually
        // moving. Log at threshold and stop counting toward re-render.
        const prevAppliedFp = _lastAppliedPartFp.get(pn);
        const isRepeatFp = prevAppliedFp === nextFp;
        if (isRepeatFp) {
          const streak = (_phantomPartStreak.get(pn) || 0) + 1;
          _phantomPartStreak.set(pn, streak);
          if (streak >= PHANTOM_STREAK_THRESHOLD) {
            // Apply-in-place so DB stays byte-consistent, but don't
            // trigger a full page re-render. Log once at threshold-
            // cross so the offender is visible without console spam.
            if (streak === PHANTOM_STREAK_THRESHOLD) {
              console.warn(
                `[cloud] phantom-change loop for pn=${pn} — ` +
                `same fingerprint reported changed ${streak} consecutive ticks. ` +
                `Suppressing re-render for this row.`,
                { cloudRow: merged, localRow: localPart, cloudFp: nextFp.slice(0, 400), localFp: (localFp || "").slice(0, 400) }
              );
            }
            if (i >= 0) DB.parts[i] = merged;
            else DB.parts.push(merged);
            _partsSnapshot.set(pn, JSON.stringify(merged));
            _lastAppliedPartFp.set(pn, nextFp);
            partsPhantomSuppressed++;
            continue;   // suppressed — no partsChanged bump
          }
        } else {
          _phantomPartStreak.delete(pn);
        }
        // Real change (or streak below threshold). Apply, remember fp,
        // and record a sample for diagnostic logging.
        if (i >= 0) DB.parts[i] = merged;
        else DB.parts.push(merged);
        _partsSnapshot.set(pn, JSON.stringify(merged));
        _lastAppliedPartFp.set(pn, nextFp);
        partsChanged++;
        if (partsChangedSamples.length < 3) {
          // Keep the sample minimal to avoid flooding the console:
          // report the differing fields' keys and a short fingerprint
          // preview. Full objects on demand via cloudRow / localRow.
          partsChangedSamples.push({
            pn,
            cloudKeys: Object.keys(merged).sort(),
            localKeys: localPart ? Object.keys(localPart).sort() : null,
            cloudFpHead: nextFp.slice(0, 200),
            localFpHead: (localFp || "").slice(0, 200),
            cloudRow: merged,
            localRow: localPart,
          });
        }
      }
      // Server-side deletes (also covers newly-tombstoned pns since
      // tombs were filtered out of cloudByPn above).
      const pnsToDelete = [];
      for (const p of DB.parts) {
        if (!cloudByPn.has(p.pn) && !_dirtyParts.has(p.pn)) pnsToDelete.push(p.pn);
      }
      for (const pn of pnsToDelete) {
        const i = DB.parts.findIndex(p => p.pn === pn);
        if (i >= 0) DB.parts.splice(i, 1);       // in-place delete
        _partsSnapshot.delete(pn);
        _lastAppliedPartFp.delete(pn);
        _phantomPartStreak.delete(pn);
        partsChanged++;
      }
    }

    // Freshness: bump ONLY when both fetches returned plausible data.
    // Array.isArray([]) is truthy for empty arrays, so the old guard
    // was flashing SYNCED even when Supabase silently returned zero
    // rows (auth expired, RLS misconfig, table wiped) — the indicator
    // lied about freshness and hid real problems.
    //
    // New rule: fetch must be non-null AND, if this client's local
    // table currently has data, the cloud fetch must also have data.
    // A cloud that returns 0 rows while local has hundreds is almost
    // always a failure, not a legitimate empty state. Legitimate
    // empty states (fresh install, brand-new DB) still bump because
    // local is also empty.
    const posFetchOk   = Array.isArray(cloudPosRows)   && (cloudPosRows.length > 0   || DB.pos.length === 0);
    const partsFetchOk = Array.isArray(cloudPartsRows) && (cloudPartsRows.length > 0 || DB.parts.length === 0);
    if (posFetchOk && partsFetchOk) {
      window._lastCloudSyncAt = Date.now();
      if (typeof updateSyncIndicator === "function") updateSyncIndicator();
    } else {
      console.warn(
        `[cloud] poll: fetch returned implausibly empty result — freshness NOT bumped ` +
        `(cloudPos.length=${Array.isArray(cloudPosRows) ? cloudPosRows.length : "null"}, ` +
        `cloudParts.length=${Array.isArray(cloudPartsRows) ? cloudPartsRows.length : "null"}, ` +
        `DB.pos.length=${DB.pos.length}, DB.parts.length=${DB.parts.length}). ` +
        `Indicator will age into STALE. Check Supabase auth / RLS / connection.`
      );
    }
    if (posChanged > 0 || partsChanged > 0 || posPhantomSuppressed > 0 || partsPhantomSuppressed > 0) {
      // Extended log: how many real changes, how many phantom-suppressed,
      // plus first 3 samples of each so any lingering phantom or real
      // data-shape issue is inspectable straight from the console.
      const suffix = (posPhantomSuppressed > 0 || partsPhantomSuppressed > 0)
        ? ` (phantom-suppressed: ${posPhantomSuppressed} pos, ${partsPhantomSuppressed} parts)`
        : "";
      console.log(
        `[cloud] poll: ${posChanged} pos changed, ${partsChanged} parts changed${suffix}`,
        (partsChangedSamples.length || posChangedSamples.length)
          ? { partsSamples: partsChangedSamples, posSamples: posChangedSamples }
          : ""
      );
      if (posChanged > 0 || partsChanged > 0) _applyAndRefresh();
    }
  } catch (e) {
    // Non-fatal. Log and let the next tick retry. Deliberately don't
    // bump _lastCloudSyncAt — the indicator continues to age, which
    // is exactly the "stale tab" signal we want the user to see.
    console.warn("[cloud] poll tick failed:", (e && e.message) || e);
  } finally {
    _pollInFlight = false;
  }
}

let _redrawTimer = null;
let _scrollRestoreRAF = null;
// Interaction-defer state. When the user is mid-typing we hold the
// redraw and retry every DEFER_RETRY_MS until they blur. The pending
// redraw is NEVER dropped — data mutations already landed in DB, we're
// only delaying the DOM rebuild. _wasDeferring gates the log so we
// announce a deferral ONCE per idle-to-active transition instead of
// every retry tick. _deferStartAt + _deferCount enforce the hard cap
// (see MAX_DEFER_TICKS below) so a stuck focus can never hang the
// tab forever.
const DEFER_RETRY_MS = 1000;
// Force a render after this many consecutive deferrals (~30 s at 1 s
// retries). Belt-and-suspenders: even if a future defer trigger gets
// stuck, the tab CANNOT go silent for more than 30 seconds. When the
// cap fires we log the blocking reason so the underlying cause is
// diagnosable.
const MAX_DEFER_TICKS = 30;
// If a defer persists this long, log an escalated warning naming the
// stuck reason. Separate from MAX_DEFER_TICKS so the user sees the
// diagnostic BEFORE the force-render kicks in.
const STUCK_DEFER_LOG_MS = 10000;
let _wasDeferring = false;
let _deferCount = 0;
let _deferStartAt = 0;
let _stuckLoggedAt = 0;

// Returns the "why" of an active interaction, or null when idle. Only
// data-entry contexts trigger a defer:
//   - "input-focus" : any focused INPUT / TEXTAREA / SELECT in the page
//
// DELIBERATELY NO drawer-open / modal-open trigger. Rationale:
//   navigate() rebuilds #main only. Drawer (#drawer-bd) and modal
//   (#modal-bd) are separate DOM subtrees — they survive #main
//   rebuilds untouched. A drawer being merely OPEN (with no focused
//   input) shouldn't block a redraw of the underlying page. And
//   because navigate() doesn't clear .open on drawers/modals, an
//   orphaned .open class would defer the redraw INDEFINITELY —
//   which is exactly the stall bug this fix is closing.
//
// Typing INSIDE a drawer or modal still defers correctly because
// the input-focus check now looks at any focused input anywhere in
// the document, not just inside #main.
function _isUserInteracting() {
  const ae = document.activeElement;
  if (ae && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT")) {
    // Any focused text/select input across the whole page — main, drawer,
    // modal, anywhere. Blurred / no focus → activeElement falls back to
    // document.body which fails the tag check.
    return "input-focus";
  }
  return null;
}

// The debounced body, hoisted so it can retry-schedule itself when the
// user is interacting. Runs the actual render inside try/catch so a
// bad row can't silently kill the redraw path (see the try/catch
// commentary that used to live inline).
function _doDebouncedRedraw() {
  const reason = _isUserInteracting();
  if (reason) {
    const now = Date.now();
    if (!_wasDeferring) {
      _wasDeferring = true;
      _deferCount = 0;
      _deferStartAt = now;
      _stuckLoggedAt = 0;
      console.log(`[cloud] redraw deferred — ${reason}`);
    }
    _deferCount++;

    // Stuck-defer escalation. Once the defer state has persisted past
    // STUCK_DEFER_LOG_MS, log a warning with the specific blocking
    // reason so the underlying cause (usually a stuck focus that some
    // upstream code forgot to blur) is diagnosable rather than silent.
    // Repeats every 10 s while stuck so the console shows the ongoing
    // condition, not just the initial one.
    if (now - _deferStartAt >= STUCK_DEFER_LOG_MS && now - _stuckLoggedAt >= STUCK_DEFER_LOG_MS) {
      console.warn(
        `[cloud] redraw STILL deferred after ${Math.round((now - _deferStartAt) / 1000)}s ` +
        `— blocked by: ${reason}. ` +
        `activeElement: <${(document.activeElement && document.activeElement.tagName) || "?"}>` +
        `${document.activeElement && document.activeElement.id ? ("#" + document.activeElement.id) : ""}. ` +
        `If this persists, a focus target may be stuck.`
      );
      _stuckLoggedAt = now;
    }

    // Hard cap. If defer has persisted past MAX_DEFER_TICKS retries,
    // FORCE the render anyway. The user MUST get fresh data eventually
    // — no interaction state can hang the tab forever. This is the
    // last-line-of-defense against any future defer trigger that
    // silently sticks.
    if (_deferCount >= MAX_DEFER_TICKS) {
      console.warn(
        `[cloud] redraw force-rendered after ${_deferCount}s of deferral ` +
        `(was blocked by: ${reason}) — possible stuck .open class or focus target.`
      );
      _wasDeferring = false;
      _deferCount = 0;
      _deferStartAt = 0;
      _stuckLoggedAt = 0;
      // Fall through to the render body below.
    } else {
      // Reschedule; each new event that arrives while deferred resets
      // this timer too (via _applyAndRefresh's clearTimeout above), so
      // the interval never stacks.
      clearTimeout(_redrawTimer);
      _redrawTimer = setTimeout(_doDebouncedRedraw, DEFER_RETRY_MS);
      return;
    }
  }
  if (_wasDeferring) {
    console.log("[cloud] redraw resumed — user idle, rendering now");
    _wasDeferring = false;
    _deferCount = 0;
    _deferStartAt = 0;
    _stuckLoggedAt = 0;
  }

  // Realtime re-renders shouldn't snap the page back to the top.
  // navigate() intentionally resets main.scrollTop for user-initiated
  // route changes, so we capture the position around the call and
  // restore it once the new DOM is laid out. Cancel any prior pending
  // restore so a stale snapshot from an earlier burst can't clobber
  // the user's current scroll position.
  if (_scrollRestoreRAF !== null) cancelAnimationFrame(_scrollRestoreRAF);
  const main = document.getElementById("main");
  const savedScrollTop = main ? main.scrollTop : 0;
  const currentRoute = document.querySelector(".nav-item.active")?.dataset?.route;
  const target = currentRoute
    || (typeof CURRENT_ROUTE !== "undefined" ? CURRENT_ROUTE : null)
    || "dashboard";
  console.log(`[cloud] realtime redraw: ${target}`);
  // try/catch around the actual render call. Any throw from a route's
  // render body (a malformed row, a missing field on a partial write,
  // etc.) would otherwise be swallowed by the setTimeout runtime and
  // leave the DOM silently stale.
  try {
    if (currentRoute && typeof navigate === "function") {
      navigate(currentRoute);
    } else if (typeof refresh === "function") {
      refresh();
    }
  } catch (e) {
    console.error(
      `[cloud] realtime redraw failed on route "${target}":`,
      (e && e.message) || e,
      e && e.stack
    );
  }
  if (main) {
    _scrollRestoreRAF = requestAnimationFrame(() => {
      main.scrollTop = savedScrollTop;
      _scrollRestoreRAF = null;
    });
  }
}

function _applyAndRefresh() {
  // Broadcast-flush batching: while a broadcast pass is applying N rows
  // through synthetic postgres_changes-handler dispatches, we defer the
  // redraw + IDB write + statusCache bump. The flush calls this ONCE at
  // the end of the pass. Guaranteed false outside a flush (the flush's
  // try/finally resets it), so postgres_changes-driven applies still
  // refresh immediately as before.
  if (_broadcastInProgress) return;
  _suppressNextLocalChange = true;
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  _suppressNextLocalChange = false;
  if (typeof bumpStatusCache === "function") bumpStatusCache();
  // Debounce redraws so a burst of realtime events causes one re-render, not many.
  // 150 ms is the coalescing window for realtime bursts; the interaction-defer
  // loop inside _doDebouncedRedraw can extend the effective wait further when
  // the user is typing / a drawer is open.
  clearTimeout(_redrawTimer);
  _redrawTimer = setTimeout(_doDebouncedRedraw, 150);
}

function _handleRealtimePart(payload) {
  const { eventType, new: row, old } = payload;
  if (eventType === "DELETE") {
    const i = DB.parts.findIndex(p => p.pn === old.pn);
    if (i >= 0) DB.parts.splice(i, 1);
  } else {
    // Tombstone guard: another user's edit to a tombstoned pn must NOT
    // resurrect it locally. If the incoming pn is in DB.deletedParts,
    // drop the event silently. The tombstone is the source of truth
    // for "this part is deleted" — a UPDATE event on parts for that
    // pn means the sync fn (or another client) still has a stale row.
    const rowPn = String(row.pn);
    if (DB.deletedParts instanceof Map && DB.deletedParts.has(rowPn)) {
      return;   // no _applyAndRefresh — nothing to redraw
    }
    // Recent-save guard — reject an echo that would overwrite a row we
    // just saved. Covers own-echo (double-save between dirty-clear and
    // echo arrival) and cross-user (another user's write echoes while
    // we're mid-edit). RECENT_SAVE_MS is generous enough to cover push
    // RTT + realtime broadcast latency for the echo of our own write.
    const lastSave = _lastLocalSaveAt.parts.get(rowPn) || 0;
    if (lastSave > 0 && (Date.now() - lastSave) < RECENT_SAVE_MS) {
      console.debug(`[cloud] skipped stale apply for part ${rowPn} (local save newer than realtime echo)`);
      return;
    }
    const merged = { pn: row.pn, ...row.data, updatedAt: row.updated_at || null };
    const i = DB.parts.findIndex(p => p.pn === row.pn);
    if (i >= 0) DB.parts[i] = merged;
    else DB.parts.push(merged);
  }
  _applyAndRefresh();
}

// Realtime handler for the deleted_parts table. UPSERT events add a
// tombstone and splice the matching pn out of DB.parts if it's still
// there (defense in depth — the parts-row DELETE event should have
// fired too, but ordering across two tables isn't guaranteed). DELETE
// events remove the tombstone locally; the un-delete flow's parts
// UPSERT re-inserts the part via _handleRealtimePart.
function _handleRealtimeDeletedParts(payload) {
  const { eventType, new: row, old } = payload;
  if (!(DB.deletedParts instanceof Map)) DB.deletedParts = new Map();
  if (eventType === "DELETE") {
    const pn = String(old && old.id);
    if (pn) DB.deletedParts.delete(pn);
  } else {
    const pn = String(row && row.id);
    if (!pn) return;
    DB.deletedParts.set(pn, (row && row.data) || {});
    // Purge any matching parts row that slipped in — splice keeps
    // DB.parts' identity intact so any reference held elsewhere stays
    // valid. Same in-place rule the app enforces everywhere.
    const i = DB.parts.findIndex(p => p.pn === pn);
    if (i >= 0) DB.parts.splice(i, 1);
  }
  _applyAndRefresh();
}

function _handleRealtimePO(payload) {
  const { eventType, new: row, old } = payload;
  if (eventType === "DELETE") {
    const i = DB.pos.findIndex(p => p.id === old.id);
    if (i >= 0) DB.pos.splice(i, 1);
  } else {
    // Recent-save guard — see _handleRealtimePart for rationale.
    const rowId = row && row.id;
    const lastSave = rowId ? (_lastLocalSaveAt.pos.get(rowId) || 0) : 0;
    if (lastSave > 0 && (Date.now() - lastSave) < RECENT_SAVE_MS) {
      console.debug(`[cloud] skipped stale apply for PO ${rowId} (local save newer than realtime echo)`);
      return;
    }
    const merged = { id: row.id, ...row.data };
    const i = DB.pos.findIndex(p => p.id === row.id);
    if (i >= 0) DB.pos[i] = merged;
    else DB.pos.push(merged);
  }
  _applyAndRefresh();
  // The full-page redraw above rebuilds #main but does NOT touch a PO
  // detail drawer overlay. patchOpenPODrawer refreshes the drawer's
  // sub-line + per-line cells IN PLACE when the drawer is showing the
  // just-updated PO. It self-guards on (drawer element exists, drawer
  // is .open, OPEN_PO_ID set, PO exists in DB.pos) — safe to call
  // unconditionally after every PO event, including DELETE (which
  // becomes a no-op since the PO is no longer in DB).
  if (typeof patchOpenPODrawer === "function") {
    try { patchOpenPODrawer(); }
    catch (e) { console.error("[cloud] patchOpenPODrawer threw:", e); }
  }
}

function _handleRealtimeDraft(payload) {
  const { new: row } = payload;
  const items = row?.data?.items || [];
  const incomingUpdatedAt = row?.data?.updatedAt || null;

  // LWW gate — REJECT strictly-older or equal writes. This is the
  // core protection against a stale writer resurrecting old state:
  // a long-idle tab that finally pushes will carry an updatedAt <=
  // whatever fresh writes have already occurred, so its realtime
  // event is dropped here on every listening tab.
  //
  // Rules:
  //   - both timestamps present: accept iff incoming > mine.
  //   - incoming has no updatedAt (legacy row / foreign write): can
  //     never beat a timestamped baseline; drop.
  //   - neither has a timestamp: fall through to the hash echo-skip
  //     below (nothing else we can compare on).
  if (incomingUpdatedAt && _lastDraftUpdatedAt && incomingUpdatedAt <= _lastDraftUpdatedAt) return;
  if (!incomingUpdatedAt && _lastDraftUpdatedAt) return;

  // Echo-skip: if the incoming content hash matches what we just pushed,
  // this event is our own write coming back around — don't re-apply it,
  // and don't stomp DRAFT_ORDER. Mirrors the content-equality skip in
  // _handleRealtimeFollowMark. Additive to the LWW gate above: content-
  // equality on our own push is normal; different content on a strictly-
  // newer timestamp means someone else wrote a real change.
  const incomingHash = _hashDraft(items);
  if (incomingHash === _lastCloudDraftHash) {
    // Still adopt the incoming updatedAt so future rejections work.
    if (incomingUpdatedAt) _lastDraftUpdatedAt = incomingUpdatedAt;
    return;
  }
  if (typeof DRAFT_ORDER !== "undefined") {
    DRAFT_ORDER.length = 0;
    DRAFT_ORDER.push(...items);
    if (typeof draftOrderSave === "function") {
      _suppressNextLocalChange = true;
      draftOrderSave();
      _suppressNextLocalChange = false;
    }
    if (typeof updateDraftOrderPill === "function") updateDraftOrderPill();
  }
  _lastCloudDraftHash = incomingHash;
  if (incomingUpdatedAt) _lastDraftUpdatedAt = incomingUpdatedAt;
}

function _handleRealtimeAudit(payload) {
  const { eventType, new: row, old } = payload;
  if (eventType === "DELETE") {
    const i = DB.audit.findIndex(a => a.id === old.id);
    if (i >= 0) DB.audit.splice(i, 1);
  } else {
    const merged = { id: row.id, ...row.data };
    const i = DB.audit.findIndex(a => a.id === row.id);
    if (i >= 0) DB.audit[i] = merged;
    else DB.audit.unshift(merged); // newest first
  }
  _applyAndRefresh();
}

function _handleRealtimeSettings(payload) {
  const { new: row } = payload;
  if (row?.data) {
    // Recent-save guard — same pattern as parts/POs. Settings is a
    // single-blob table, so one timestamp gates the whole row.
    // Reassignment of DB.settings on merge is preserved as-is — converting
    // to in-place mutation is a separate change; the guard just gates
    // whether the merge runs at all.
    if (Date.now() - (_lastLocalSaveAt.settings || 0) < RECENT_SAVE_MS) {
      console.debug("[cloud] skipped stale settings apply (local save newer)");
      return;
    }
    DB.settings = { ...DB.settings, ...row.data };
    _lastCloudSettingsHash = _hashSettings(DB.settings);
    _applyAndRefresh();
  }
}

function _handleRealtimeUsage(payload) {
  const { eventType, new: row, old } = payload;
  if (!DB.usage) DB.usage = [];
  if (eventType === "DELETE") {
    const i = DB.usage.findIndex(u => u.id === old.id);
    if (i >= 0) DB.usage.splice(i, 1);
  } else {
    const merged = { id: row.id, ...row.data };
    const i = DB.usage.findIndex(u => u.id === row.id);
    if (i >= 0) DB.usage[i] = merged;
    else DB.usage.push(merged);
  }
  _applyAndRefresh();
}

function _handleRealtimeKitBoms(payload) {
  const { eventType, new: row, old } = payload;
  if (!DB.kitBoms || typeof DB.kitBoms !== "object") DB.kitBoms = {};
  if (eventType === "DELETE") {
    delete DB.kitBoms[old.kit_pn];
  } else {
    DB.kitBoms[row.kit_pn] = { kit_pn: row.kit_pn, ...row.data };
  }
  _lastCloudKitBomsHash = _hashKitBoms(DB.kitBoms);
  _applyAndRefresh();
}

// follow_marks realtime — INERT by design (see top-of-file rules).
// Only does: update window.followMarks (.set/.delete) with content-
// equality echo skip, then request a debounced re-render IFF the
// Follow-Ups page is the active route. Never calls cloudInit, never
// re-subscribes, never writes to Supabase, never calls saveDB.
let _followMarksRedrawTimer = null;
let _followMarksRendering = false;
function _handleRealtimeFollowMark(payload) {
  if (!window.followMarks) window.followMarks = new Map();
  const { eventType, new: row, old } = payload;

  let changed = false;
  if (eventType === "DELETE") {
    const id = old && old.id;
    if (id && window.followMarks.has(id)) {
      window.followMarks.delete(id);
      changed = true;
    }
    // else: already absent (likely the echo of our own delete) — no-op
  } else if (row && row.id) {
    const next = row.data || {};
    const existing = window.followMarks.get(row.id);
    // Content-equality echo skip: identical markedAt + type means this
    // is the realtime echo of our own optimistic write. Skip both the
    // set (idempotent anyway) and the re-render.
    if (existing
        && existing.type === next.type
        && existing.markedAt === next.markedAt
        && (existing.pn || "") === (next.pn || "")) {
      return;
    }
    window.followMarks.set(row.id, next);
    changed = true;
  }
  if (!changed) return;

  // Route guard — silently update the map for users on other pages so
  // their next switch to Follow-Ups / Coverage Gaps already has fresh
  // data, but skip the heavy re-render here. Both pages consume
  // follow_marks (chased marks on Follow-Ups, sent marks on Coverage
  // Gaps), so either being current warrants a redraw.
  if (typeof CURRENT_ROUTE !== "undefined"
      && CURRENT_ROUTE !== "followups"
      && CURRENT_ROUTE !== "coverage-gaps") return;

  // Re-entrancy guard — refresh() is synchronous so this is mostly
  // defense-in-depth, but it prevents a future async refresh from
  // queueing another mid-flight.
  if (_followMarksRendering) return;
  clearTimeout(_followMarksRedrawTimer);
  _followMarksRedrawTimer = setTimeout(() => {
    _followMarksRendering = true;
    try {
      // Pure re-render. No writes, no fetches, no subscribes. Reads
      // window.followMarks via the renderer. Scroll position is left
      // alone — navigate() resets main.scrollTop, but a remote mark
      // landing while the user is mid-scroll on Follow-Ups is rare;
      // if it becomes annoying we can preserve scroll the way
      // _applyAndRefresh does for parts/pos.
      if (typeof refresh === "function") refresh();
    } finally {
      _followMarksRendering = false;
    }
  }, 150);
}

async function _pushAllParts() {
  if (!_supa) return false;
  if (DB.parts.length === 0) return true;

  const rows = DB.parts.map(p => {
    const { pn, ...rest } = p;
    return { pn, data: rest };
  });

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await _supa.from("parts").upsert(batch);
    if (error) {
      console.error("[cloud] batch upsert failed:", error);
      showToast("Cloud push failed: " + error.message, "crit");
      return false;
    }
  }
  return true;
}

async function _pushAllPos() {
  if (!_supa) return false;
  if (!DB.pos || DB.pos.length === 0) return true;

  const rows = DB.pos.map(p => {
    const { id, ...rest } = p;
    return { id, data: rest };
  });

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await _supa.from("pos").upsert(batch);
    if (error) {
      console.error("[cloud] pos batch upsert failed:", error);
      showToast("Cloud push failed: " + error.message, "crit");
      return false;
    }
  }
  return true;
}

async function _pushAllAudit() {
  if (!_supa) return false;
  if (!DB.audit || DB.audit.length === 0) return true;

  // Backfill missing IDs on legacy entries (created before id was added at creation time)
  for (const a of DB.audit) {
    if (!a.id) {
      a.id = "audit_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
    }
  }

  const rows = DB.audit.map(a => {
    const { id, ...rest } = a;
    return { id, data: rest };
  });

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await _supa.from("audit").upsert(batch);
    if (error) {
      console.error("[cloud] audit batch upsert failed:", error);
      showToast("Cloud push failed: " + error.message, "crit");
      return false;
    }
  }
  return true;
}

async function _fetchCloudSettings() {
  if (!_supa) return null;
  const { data, error } = await _supa.from("settings").select("data").eq("id", "current").maybeSingle();
  if (error) { console.error("[cloud] settings fetch failed:", error); return null; }
  return data?.data || null;
}

async function _pushSettings() {
  if (!_supa) return false;
  const { error } = await _supa.from("settings").upsert({ id: "current", data: DB.settings || {} });
  if (error) { console.error("[cloud] settings push failed:", error); return false; }
  _sendDataChanged(["settings"]);
  return true;
}

async function _fetchAllUsage() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa.from("usage").select("id, data").range(from, from + PAGE - 1);
    if (error) { console.error("[cloud] usage page fetch failed:", error); return null; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function _pushAllUsage() {
  if (!_supa) return false;
  if (!DB.usage || DB.usage.length === 0) return true;
  let backfilled = 0;
  for (const u of DB.usage) {
    if (!u.id) {
      u.id = "usage_" + (u.ts || Date.now()) + "_" + Math.random().toString(36).slice(2, 8);
      backfilled++;
    }
  }
  if (backfilled > 0) console.log("[cloud] backfilled " + backfilled + " usage IDs");
  const rows = DB.usage.map(u => {
    const { id, ...rest } = u;
    return { id, data: rest };
  });
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await _supa.from("usage").upsert(batch);
    if (error) { console.error("[cloud] usage batch upsert failed:", error); showToast("Cloud push failed: " + error.message, "crit"); return false; }
  }
  return true;
}

async function _pushDirtyParts() {
  if (_dirtyParts.size === 0) return true;
  const byPn = new Map(DB.parts.map(p => [p.pn, p]));
  const rows = [];
  for (const pn of _dirtyParts) {
    const p = byPn.get(pn);
    if (p) {
      const { pn: _, ...rest } = p;
      rows.push({ pn, data: rest });
    }
  }
  if (rows.length === 0) { _dirtyParts.clear(); return true; }
  const { error } = await _supa.from("parts").upsert(rows);
  if (error) { console.error("[cloud] dirty parts push failed:", error); return false; }
  _dirtyParts.clear();
  _sendDataChanged(["parts"]);
  return true;
}

async function _pushDirtyPos() {
  if (_dirtyPos.size === 0) return true;
  const byId = new Map((DB.pos || []).map(p => [p.id, p]));
  const rows = [];
  for (const id of _dirtyPos) {
    const po = byId.get(id);
    if (po) {
      const { id: _, ...rest } = po;
      rows.push({ id, data: rest });
    }
  }
  if (rows.length === 0) { _dirtyPos.clear(); return true; }
  const { error } = await _supa.from("pos").upsert(rows);
  if (error) { console.error("[cloud] dirty pos push failed:", error); return false; }
  _dirtyPos.clear();
  _sendDataChanged(["pos"]);
  return true;
}

async function _pushDirtyAudit() {
  if (_dirtyAudit.size === 0) return true;
  const byId = new Map((DB.audit || []).map(a => [a.id, a]));
  const rows = [];
  for (const id of _dirtyAudit) {
    const a = byId.get(id);
    if (a) {
      const { id: _, ...rest } = a;
      rows.push({ id, data: rest });
    }
  }
  if (rows.length === 0) { _dirtyAudit.clear(); return true; }
  const { error } = await _supa.from("audit").upsert(rows);
  if (error) { console.error("[cloud] dirty audit push failed:", error); return false; }
  _dirtyAudit.clear();
  _sendDataChanged(["audit"]);
  return true;
}

async function _pushDirtyUsage() {
  if (_dirtyUsage.size === 0) return true;
  const byId = new Map((DB.usage || []).map(u => [u.id, u]));
  const rows = [];
  for (const id of _dirtyUsage) {
    const u = byId.get(id);
    if (u) {
      const { id: _, ...rest } = u;
      rows.push({ id, data: rest });
    }
  }
  if (rows.length === 0) { _dirtyUsage.clear(); return true; }
  const { error } = await _supa.from("usage").upsert(rows);
  if (error) { console.error("[cloud] dirty usage push failed:", error); return false; }
  _dirtyUsage.clear();
  _sendDataChanged(["usage"]);
  return true;
}

function _hashSettings(s) {
  try { return JSON.stringify(s || {}).length; } catch (e) { return 0; }
}
function _hashKitBoms(k) {
  try { return Object.keys(k || {}).length + ":" + JSON.stringify(k || {}).length; } catch (e) { return "?"; }
}

async function _fetchAllKitBoms() {
  if (!_supa) return [];
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await _supa.from("kit_boms").select("kit_pn, data").range(from, from + PAGE - 1);
    if (error) { console.error("[cloud] kit_boms page fetch failed:", error); return null; }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

async function _pushAllKitBoms() {
  if (!_supa) return false;
  const kits = DB.kitBoms || {};
  const entries = Object.entries(kits);
  if (entries.length === 0) return true;

  const rows = entries.map(([kit_pn, kit]) => {
    const { kit_pn: _, ...rest } = kit;
    return { kit_pn, data: rest };
  });

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await _supa.from("kit_boms").upsert(batch);
    if (error) {
      console.error("[cloud] kit_boms batch upsert failed:", error);
      showToast("Cloud push failed: " + error.message, "crit");
      return false;
    }
  }
  return true;
}

async function _pushDirtyKitBoms() {
  if (_dirtyKitBoms.size === 0) return true;
  const rows = [];
  for (const kit_pn of _dirtyKitBoms) {
    const kit = DB.kitBoms?.[kit_pn];
    if (kit) {
      const { kit_pn: _, ...rest } = kit;
      rows.push({ kit_pn, data: rest });
    }
  }
  if (rows.length === 0) { _dirtyKitBoms.clear(); return true; }
  const { error } = await _supa.from("kit_boms").upsert(rows);
  if (error) { console.error("[cloud] dirty kit_boms push failed:", error); return false; }
  _dirtyKitBoms.clear();
  _sendDataChanged(["kit_boms"]);
  return true;
}

function _detectChanges() {
  // Parts: find pns whose JSON has changed since last push
  const _detectNow = Date.now();   // one timestamp per detect pass so a burst of edits shares it
  for (const p of DB.parts) {
    const json = JSON.stringify(p);
    if (_partsSnapshot.get(p.pn) !== json) {
      _dirtyParts.add(p.pn);
      _lastLocalSaveAt.parts.set(p.pn, _detectNow);
      _partsSnapshot.set(p.pn, json);
    }
  }
  // POs
  for (const po of (DB.pos || [])) {
    const json = JSON.stringify(po);
    if (_posSnapshot.get(po.id) !== json) {
      _dirtyPos.add(po.id);
      _lastLocalSaveAt.pos.set(po.id, _detectNow);
      _posSnapshot.set(po.id, json);
    }
  }
  // Audit: any new entries (append-only, compare by Set membership)
  for (const a of (DB.audit || [])) {
    if (a.id && !_partsSnapshot.has("audit_" + a.id)) {
      _dirtyAudit.add(a.id);
      _partsSnapshot.set("audit_" + a.id, "1");
    }
  }
  // Usage: per-id JSON comparison
  for (const u of (DB.usage || [])) {
    if (!u.id) continue;
    const json = JSON.stringify(u);
    if (_usageSnapshot.get(u.id) !== json) {
      _dirtyUsage.add(u.id);
      _usageSnapshot.set(u.id, json);
    }
  }
  // Settings: single blob comparison
  const settingsJson = JSON.stringify(DB.settings || {});
  if (_partsSnapshot.get("__settings__") !== settingsJson) {
    _settingsDirty = true;
    _lastLocalSaveAt.settings = _detectNow;
    _partsSnapshot.set("__settings__", settingsJson);
  }
  // Kit BOMs: per-kit JSON comparison
  for (const [kit_pn, kit] of Object.entries(DB.kitBoms || {})) {
    const json = JSON.stringify(kit);
    if (_kitBomsSnapshot.get(kit_pn) !== json) {
      _dirtyKitBoms.add(kit_pn);
      _kitBomsSnapshot.set(kit_pn, json);
    }
  }
}

function _hashDraft(arr) {
  try { return (arr?.length || 0) + ":" + JSON.stringify(arr || []).length; }
  catch (e) { return (arr?.length || 0) + ":?"; }
}

async function _fetchCloudDraft() {
  if (!_supa) return null;
  const { data, error } = await _supa
    .from("draft_order")
    .select("data")
    .eq("id", "current")
    .maybeSingle();
  if (error) {
    console.error("[cloud] draft fetch failed:", error);
    return null;
  }
  if (!data?.data) return null;
  // Return the LWW envelope. A row written before this fix will have no
  // updatedAt — callers treat null as "oldest possible" so the LWW gate
  // still functions (a fresh timestamped write always beats a null one).
  return {
    items: data.data.items || [],
    updatedAt: data.data.updatedAt || null,
  };
}

async function _pushDraft() {
  if (!_supa) return false;
  const items = (typeof DRAFT_ORDER !== "undefined" && Array.isArray(DRAFT_ORDER)) ? DRAFT_ORDER : [];
  // Stamp every write. ISO strings are lexicographically comparable at
  // millisecond precision so simple `>` comparisons on strings act as
  // chronological ordering for realtime rejection and stale-push guards.
  const updatedAt = new Date().toISOString();
  const { error } = await _supa.from("draft_order").upsert({
    id: "current",
    data: { items, updatedAt },
  });
  if (error) {
    console.error("[cloud] draft push failed:", error);
    return false;
  }
  // Adopt AFTER a successful write so a failed push leaves the baseline
  // untouched — the next attempt still races against whatever the cloud
  // actually contains, not against a phantom timestamp we never sent.
  _lastDraftUpdatedAt = updatedAt;
  // No broadcast send for draft_order. It's excluded from
  // _BROADCAST_FETCHERS (its LWW envelope in data.updatedAt gates
  // propagation via _handleRealtimeDraft on the postgres_changes
  // channel already). Sending a "draft_order" ping would cause the
  // Step 2 listener to log "no fetcher for table 'draft_order'" and
  // skip. draft_order stays on postgres_changes; Step 5 will decide
  // whether to fold it into the delta model or keep it on a
  // per-table LWW channel.
  return true;
}

// Pre-push staleness gate. Returns true when this client's baseline is
// current-or-newer than the cloud row (safe to push). Returns false and
// adopts cloud state into local when this client is stale — the caller
// SKIPS the push in that case so a long-idle tab can't clobber writes
// it missed while asleep.
//
// A cloud row with no updatedAt (legacy write) is treated as older than
// any timestamped baseline this client holds — we'll still push over it
// to migrate it to the new envelope.
async function _isDraftBaselineCurrent() {
  const cloud = await _fetchCloudDraft();
  if (!cloud) return true;             // no cloud row → nothing to be stale against
  const cloudTs = cloud.updatedAt || "";
  const mineTs  = _lastDraftUpdatedAt || "";
  // Strictly newer cloud beats us. Ties (same timestamp) count as current
  // — that shouldn't happen with sub-millisecond ISO strings unless it's
  // literally our own write bouncing back.
  if (!cloudTs) return true;           // untimestamped cloud row → we win
  if (cloudTs <= mineTs) return true;  // we're current or newer
  // Stale — adopt cloud state into local, do NOT push.
  if (typeof DRAFT_ORDER !== "undefined") {
    DRAFT_ORDER.length = 0;
    DRAFT_ORDER.push(...cloud.items);
    _suppressNextLocalChange = true;
    if (typeof draftOrderSave === "function") draftOrderSave();
    _suppressNextLocalChange = false;
    if (typeof updateDraftOrderPill === "function") updateDraftOrderPill();
  }
  _lastDraftUpdatedAt = cloud.updatedAt;
  _lastCloudDraftHash = _hashDraft(cloud.items);
  return false;
}

let _cloudPushTimer = null;
function _schedulePush() {
  if (!_cloudReady) return;
  if (_suppressNextLocalChange) return;
  _detectChanges();
  if (_dirtyParts.size === 0 && _dirtyPos.size === 0 && _dirtyAudit.size === 0 && _dirtyUsage.size === 0 && _dirtyKitBoms.size === 0 && !_settingsDirty) return;

  clearTimeout(_cloudPushTimer);
  _showCloudIndicator(false, "syncing");
  _cloudPushTimer = setTimeout(async () => {
    let allOk = true;
    const promises = [];
    if (_dirtyParts.size > 0)   promises.push(_pushDirtyParts().then(ok => !ok && (allOk = false)));
    if (_dirtyPos.size > 0)     promises.push(_pushDirtyPos().then(ok => !ok && (allOk = false)));
    if (_dirtyAudit.size > 0)   promises.push(_pushDirtyAudit().then(ok => !ok && (allOk = false)));
    if (_dirtyUsage.size > 0)   promises.push(_pushDirtyUsage().then(ok => !ok && (allOk = false)));
    if (_dirtyKitBoms.size > 0) promises.push(_pushDirtyKitBoms().then(ok => !ok && (allOk = false)));
    if (_settingsDirty) {
      promises.push(_pushSettings().then(ok => { if (ok) _settingsDirty = false; else allOk = false; }));
    }
    await Promise.all(promises);
    _showCloudIndicator(allOk, allOk ? undefined : "error");
  }, 250);  // FAST debounce: 250ms instead of 1200ms
}

let _origSaveDB = null;
function _hookSaveDB() {
  if (_origSaveDB) return;
  _origSaveDB = window.saveDB;
  window.saveDB = function () {
    _origSaveDB.apply(this, arguments);
    _schedulePush();
  };
}

let _origDraftOrderSave = null;
function _hookDraftSave() {
  if (_origDraftOrderSave) return;
  if (typeof draftOrderSave !== "function") return;
  _origDraftOrderSave = window.draftOrderSave;
  window.draftOrderSave = function () {
    _origDraftOrderSave.apply(this, arguments);
    _scheduleDraftPush();
  };
}

let _draftPushTimer = null;
function _scheduleDraftPush() {
  if (!_cloudReady) return;
  if (_suppressNextLocalChange) return;
  const h = _hashDraft(typeof DRAFT_ORDER !== "undefined" ? DRAFT_ORDER : []);
  if (h === _lastCloudDraftHash) return;
  clearTimeout(_draftPushTimer);
  _showCloudIndicator(false, "syncing");
  _draftPushTimer = setTimeout(async () => {
    // LWW gate: if cloud has a newer updatedAt than our baseline, we're
    // stale. _isDraftBaselineCurrent() adopts cloud state locally and
    // returns false — we skip the push so we don't clobber writes we
    // missed while dozing. The user's in-flight local edit is lost;
    // that's the LWW trade-off (an idle tab that wakes up and pushes
    // stale would be worse). A fresh subsequent edit from this tab
    // will push cleanly.
    if (!(await _isDraftBaselineCurrent())) {
      _showCloudIndicator(true);   // successfully re-synced from cloud
      return;
    }
    const ok = await _pushDraft();
    if (ok) {
      _lastCloudDraftHash = _hashDraft(typeof DRAFT_ORDER !== "undefined" ? DRAFT_ORDER : []);
      _showCloudIndicator(true);
    } else {
      _showCloudIndicator(false, "error");
    }
  }, 250);

}

// Force-push the current DRAFT_ORDER to Supabase immediately, bypassing the
// 250ms debounce AND the hash gate. Called by draftOrderClear() so a cleared
// draft can't be resurrected by a stale realtime UPDATE echoing the
// pre-clear state. Updates _lastCloudDraftHash BEFORE the write so the
// realtime event echoing our own push is content-equal and skipped by
// _handleRealtimeDraft.
//
// STILL SUBJECT TO THE LWW GATE. Rationale: a stale tab where the user
// clicks Clear also shouldn't clobber writes it missed. If cloud is
// strictly newer we adopt cloud state locally — the clear appears to
// have "no effect" from the user's view, but the correct fix is to
// click Clear again on the now-current state. Uniform semantics beat
// per-path exceptions.
async function _forcePushDraftNow() {
  if (!_cloudReady) return;
  clearTimeout(_draftPushTimer);
  if (!(await _isDraftBaselineCurrent())) return;
  _lastCloudDraftHash = _hashDraft(
    typeof DRAFT_ORDER !== "undefined" ? DRAFT_ORDER : []
  );
  await _pushDraft();
}
window._forcePushDraftNow = _forcePushDraftNow;

function _showCloudIndicator(ready, state) {
  let el = document.getElementById("cloud-indicator");
  if (!el) {
    el = document.createElement("div");
    el.id = "cloud-indicator";
    el.style.cssText = "position:fixed;bottom:10px;left:12px;z-index:9999;width:10px;height:10px;border-radius:50%;transition:background .2s,box-shadow .2s;cursor:default";
    document.body.appendChild(el);
  }
  let color, label;
  if (state === "syncing")           { color = "#e6c84f"; label = "Cloud: syncing…"; }
  else if (state === "error")        { color = "#e25555"; label = "Cloud: sync error"; }
  else if (state === "reconnecting") { color = "#e6a04f"; label = "Cloud: realtime reconnecting — data may be stale"; }
  else if (state === "disconnected") { color = "#e25555"; label = "Cloud: realtime disconnected — data may be stale"; }
  else if (ready)                    { color = "var(--accent)"; label = "Cloud: connected"; }
  else                               { color = "#777"; label = "Cloud: connecting…"; }
  el.style.background = color;
  el.style.boxShadow = "0 0 6px " + color;
  el.title = label;
}

window.cloudForcePush = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  _showCloudIndicator(false, "syncing");
  const ok = await _pushAllParts();
  if (ok) {
    _showCloudIndicator(true);
    console.log("Force-pushed " + DB.parts.length + " parts");
  }
};

window.cloudForcePull = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const data = await _fetchAllParts();
  if (data === null) { console.error("Force pull failed"); return; }
  DB.parts = data.map(r => ({ pn: r.pn, ...r.data, updatedAt: r.updated_at || null }));
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  if (typeof bumpStatusCache === "function") bumpStatusCache();
  if (typeof refresh === "function") refresh();
  console.log("Pulled " + DB.parts.length + " parts from cloud");
};

window.cloudForcePushPos = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  _showCloudIndicator(false, "syncing");
  const ok = await _pushAllPos();
  if (ok) {
    _showCloudIndicator(true);
    console.log("Force-pushed " + (DB.pos?.length || 0) + " POs");
  }
};

window.cloudForcePullPos = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const data = await _fetchAllPos();
  if (data === null) { console.error("Force pull failed"); return; }
  DB.pos = data.map(r => ({ id: r.id, ...r.data }));
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  if (typeof bumpStatusCache === "function") bumpStatusCache();
  if (typeof refresh === "function") refresh();
  console.log("Pulled " + DB.pos.length + " POs from cloud");
};

window.cloudForcePullAudit = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const data = await _fetchAllAudit();
  if (data === null) { console.error("Force pull failed"); return; }
  DB.audit = data.map(r => ({ id: r.id, ...r.data })).sort((a, b) => {
    const ta = a.ts || a.time || "";
    const tb = b.ts || b.time || "";
    return tb.localeCompare(ta);
  });
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  console.log("Pulled " + DB.audit.length + " audit entries from cloud");
};

window.cloudForcePullDraft = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const cloud = await _fetchCloudDraft();
  if (cloud === null) { console.log("Pull failed"); return; }
  if (typeof DRAFT_ORDER !== "undefined") {
    DRAFT_ORDER.length = 0;
    DRAFT_ORDER.push(...cloud.items);
    if (typeof draftOrderSave === "function") draftOrderSave();
    if (typeof updateDraftOrderPill === "function") updateDraftOrderPill();
    _lastCloudDraftHash = _hashDraft(DRAFT_ORDER);
    // Adopt cloud's updatedAt so future stale-writer checks work
    // correctly after a manual pull.
    _lastDraftUpdatedAt = cloud.updatedAt || _lastDraftUpdatedAt;
    console.log("Pulled " + cloud.items.length + " draft items from cloud");
  }
};

window.cloudForcePullBomLinks = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const data = await _fetchAllBomLinks();
  if (data === null) { console.error("Force pull failed"); return; }
  DB.bomLinks = data.map(r => ({ id: r.id, ...r.data }));
  if (typeof refresh === "function") refresh();
  console.log("Pulled " + DB.bomLinks.length + " bom_links from cloud");
};

window.cloudForcePullKitBoms = async function () {
  if (!_supa) { console.log("Not connected"); return; }
  const data = await _fetchAllKitBoms();
  if (data === null) { console.error("Force pull failed"); return; }
  if (!DB.kitBoms || typeof DB.kitBoms !== "object") DB.kitBoms = {};
  for (const k of Object.keys(DB.kitBoms)) delete DB.kitBoms[k];
  for (const r of data) DB.kitBoms[r.kit_pn] = { kit_pn: r.kit_pn, ...r.data };
  _origSaveDB ? _origSaveDB.call(window) : saveDB();
  _lastCloudKitBomsHash = _hashKitBoms(DB.kitBoms);
  console.log("Pulled " + data.length + " kit BOMs from cloud");
};

// cloudInit is async and returns a Promise. setTimeout discards its
// return value, so any awaited step that rejects becomes an UNHANDLED
// promise rejection — the browser logs "Uncaught (in promise)…" but
// execution of cloudInit stops at the throw point, and every step
// after it (subscription setup, poll start, indicator wiring) never
// runs. That's exactly the failure mode where boot silently freezes
// with no visible cause. Catching the rejection here surfaces the
// error with a stable prefix so the actual throw point is visible in
// the console filter next time it happens.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setTimeout(
    () => cloudInit().catch(err => console.error("[cloud] cloudInit fatal:", err)),
    200,
  ));
} else {
  setTimeout(
    () => cloudInit().catch(err => console.error("[cloud] cloudInit fatal:", err)),
    200,
  );
}
