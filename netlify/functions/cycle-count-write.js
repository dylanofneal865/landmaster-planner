// Cycle Count -- SERVER-SIDE WRITER.
//
// All writes to cycle_count_items + cycle_count_log go through this
// function so the flow rules (variance threshold -> recount, blind
// recount by a different counter, auto-reconcile within 1 unit,
// append-only log, skip reasons) are enforced against DATABASE
// truth, not the client's local mirror.
//
// Auth mirror of frame-schedule-write.js exactly:
//   x-fs-edit-token   -- must equal env FS_EDIT_TOKEN. Missing /
//                        mismatch -> 401.
//   x-app-build       -- integer APP_BUILD from js/01-config.js.
//                        Missing / non-numeric -> 400.
// Build guard: reads frame_schedule.__settings__.data.minWriteBuild
// (same authority the frame-schedule flow uses -- a single stale-
// build gate) and 409s if the client is behind.
//
// Request shape (JSON body):
//   { writes: [ { op, ...opFields } ] }   -- max 100 writes/batch
//
// Ops (see per-op inline docs in _applyOp below):
//   { op: "flag",              pn, note?, systemQtyNow }
//   { op: "submitCount",       itemId, counted_qty, counted_by,
//                              client_key?, locations? }
//   { op: "recordAdhocCount",  pn, counted_qty, counted_by,
//                              systemQtyNow, client_key?, locations?,
//                              source? -- creates a "manual" tier
//                              cycle_count_items row for the pn then
//                              submits the count against it in one
//                              round-trip. Used by the Inventory
//                              Reconciliation workbench's "Record
//                              count" action so a supervisor can
//                              record a count without pre-seeding
//                              an assignment.
//   { op: "skip",              itemId, reason }
//   { op: "reconcileFromLive", itemId, currentOnHand }
//
// Response:
//   200 { ok: true, results: [{ index, ok, ... }] }
//   400 { error }  -- bad body / headers
//   401 { error }
//   409 { error, minWriteBuild }
//   500 { error }
//
// ISOLATION:
//   * Writes ONLY to cycle_count_items + cycle_count_log.
//   * NEVER touches parts, pos, po_receipts, frame_schedule, etc.
//   * Never writes parts.data.onHand -- Acumatica stays the SoR.

const { createClient } = require("@supabase/supabase-js");

// Recount threshold: variance beyond max(10%, 5 units) reassigns
// the row as "recount" and inserts a blind child item requiring a
// DIFFERENT counter to complete.
const VAR_TOLERANCE_PCT = 0.10;
const VAR_TOLERANCE_UNITS = 5;

// v-cc-idem: postgres duplicate-key error code. Both node-postgres
// and PostgREST bubble this up as { code: "23505" } (message
// contains "duplicate key value" too). We treat certain dup-keys
// (log.client_key retries, open-pn recount child collisions) as
// benign so a submitCount attempt never fails just because
// bookkeeping was already done.
function _isDupKey(err) {
  if (!err) return false;
  if (err.code === "23505") return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.indexOf("duplicate key") !== -1;
}

// Auto-reconcile threshold: when live parts.data.onHand converges
// within RECONCILE_UNITS of the counted qty, mark the item
// "reconciled" (Acumatica caught up).
const RECONCILE_UNITS = 1;

function _variancePct(sysQty, counted) {
  const s = Number(sysQty) || 0;
  const c = Number(counted) || 0;
  if (Math.abs(s) < 1e-9) return c === 0 ? 0 : 1;
  return (c - s) / Math.abs(s);
}

function _beyondTolerance(sysQty, counted) {
  const variance = (Number(counted) || 0) - (Number(sysQty) || 0);
  const absUnits = Math.abs(variance);
  if (absUnits <= VAR_TOLERANCE_UNITS) {
    // Small absolute swing -- also allow if pct is within tolerance.
    const pct = Math.abs(_variancePct(sysQty, counted));
    return pct > VAR_TOLERANCE_PCT && absUnits > VAR_TOLERANCE_UNITS;
  }
  const pct = Math.abs(_variancePct(sysQty, counted));
  return pct > VAR_TOLERANCE_PCT;
}

function _todayIsoUtc() {
  const d = new Date();
  return d.getFullYear() + "-"
    + String(d.getMonth() + 1).padStart(2, "0") + "-"
    + String(d.getDate()).padStart(2, "0");
}

async function _applyOp(supa, w, i, log) {
  const nowIso = new Date().toISOString();
  try {
    switch (w.op) {
      case "flag": {
        // Operator flag from the part drawer / row action. Adds a
        // HOT-tier pending item for today so the daily list picks
        // it up. Duplicate-guard: if the same pn already has a
        // pending HOT item for today, no-op (return that item's id).
        const pn = String(w.pn || "").trim();
        if (!pn) return { index: i, ok: false, error: "flag: pn required" };
        const noteRaw = typeof w.note === "string" ? w.note.trim() : "";
        const sysQty = Number(w.systemQtyNow);
        const today = _todayIsoUtc();
        // Dedupe against today's pending HOT items for this pn.
        const { data: existing, error: exErr } = await supa
          .from("cycle_count_items")
          .select("id")
          .eq("assigned_date", today)
          .eq("pn", pn)
          .eq("tier", "hot")
          .eq("status", "pending")
          .maybeSingle();
        if (exErr) return { index: i, ok: false, error: "flag: dedupe read failed: " + exErr.message };
        if (existing && existing.id) {
          return { index: i, ok: true, kind: "flag", itemId: existing.id, dedupe: true };
        }
        const reason = noteRaw ? ("operator flag: " + noteRaw) : "operator flag";
        const { data: inserted, error: insErr } = await supa
          .from("cycle_count_items")
          .insert({
            assigned_date: today,
            tier: "hot",
            reason,
            pn,
            system_qty_at_assign: Number.isFinite(sysQty) ? sysQty : 0,
            status: "pending",
            note: noteRaw || null,
          })
          .select("id")
          .single();
        if (insErr) return { index: i, ok: false, error: "flag: insert failed: " + insErr.message };
        return { index: i, ok: true, kind: "flag", itemId: inserted.id };
      }

      case "recordAdhocCount": {
        // v-ir-1: desktop replacement for the phone flow. Supervisor
        // records a count against a pn that doesn't have an open
        // cycle_count_items row -- we create one (tier "manual",
        // reason "supervisor recorded count [source]") and then
        // delegate the actual count logic to submitCount so the
        // tolerance / recount-child / locations rules stay in one
        // place.
        const pn = String(w.pn || "").trim();
        const counter = String(w.counted_by || "").trim();
        const countedRaw = Number(w.counted_qty);
        if (!pn) return { index: i, ok: false, error: "recordAdhocCount: pn required" };
        if (!counter) return { index: i, ok: false, error: "recordAdhocCount: counted_by required" };
        if (!Number.isFinite(countedRaw) || countedRaw < 0) {
          return { index: i, ok: false, error: "recordAdhocCount: counted_qty must be a non-negative number" };
        }
        const sysQty = Number.isFinite(Number(w.systemQtyNow)) ? Number(w.systemQtyNow) : 0;
        const today = _todayIsoUtc();
        const source = String(w.source || "").trim();
        const reason = source
          ? "supervisor recorded count (" + source + ")"
          : "supervisor recorded count";
        const { data: inserted, error: insErr } = await supa
          .from("cycle_count_items")
          .insert({
            assigned_date: today,
            tier: "manual",
            reason,
            pn,
            system_qty_at_assign: sysQty,
            status: "pending",
            note: null,
          })
          .select("id")
          .single();
        if (insErr) return { index: i, ok: false, error: "recordAdhocCount: item spawn failed: " + insErr.message };
        // Delegate to submitCount with the new item id, preserving
        // client_key so a retry short-circuits (via the log row's
        // unique index) BEFORE we'd double-spawn an adhoc item on
        // retry. NOTE: retries of recordAdhocCount that reach here
        // WILL create a second cycle_count_items row -- the log's
        // client_key idempotency protects against a double-log but
        // the item row is not client_key-scoped. We accept that cost:
        // an extra "pending" adhoc item that will be re-flipped to
        // "counted" by the delegated submitCount with no data loss.
        const sub = {
          op: "submitCount",
          itemId: inserted.id,
          counted_qty: countedRaw,
          counted_by: counter,
          client_key: w.client_key || w.clientKey || null,
          locations: Array.isArray(w.locations) ? w.locations : undefined,
        };
        return await _applyOp(supa, sub, i, log);
      }

      case "submitCount": {
        // Counter submits their result. Enforces:
        //   * item exists + is pending or recount
        //   * variance beyond tolerance -> promote to recount and
        //     spawn a blind child item (tier=flagged, recount_of=id)
        //   * if THIS item has recount_of set (a recount child),
        //     counted_by MUST NOT equal parent.counted_by (blind).
        //   * append a cycle_count_log row (append-only).
        //
        // v-cc-loc-1 phase 1 -- accepts optional `locations` array:
        //   locations: [{ location, counted_qty, foundElsewhere? }]
        // When present:
        //   * Every LISTED cycle_count_item_locations row for this
        //     item MUST be present in the payload (all bins filled).
        //   * `foundElsewhere: true` rows are new bins the counter
        //     discovered stock in -- inserted as new rows with
        //     system_qty_at_assign = 0.
        //   * item.counted_qty is REQUIRED to equal
        //     sum(locations.counted_qty). We enforce this here so
        //     a broken client can't submit a mismatched total.
        //   * log row carries `locations` jsonb breakdown so
        //     drift + per-bin history queries have real data.
        // Items with no cycle_count_item_locations rows keep the
        // single-total flow -- the payload's `locations` is ignored.
        const itemId = String(w.itemId || "").trim();
        const counter = String(w.counted_by || "").trim();
        const countedRaw = Number(w.counted_qty);
        const locationsIn = Array.isArray(w.locations) ? w.locations : null;
        // v-cc-idem: client-supplied idempotency key. When present,
        // a prior successful submit with the same key short-circuits
        // to that outcome so a retried POST can never double-log a
        // count (or spawn a duplicate recount child, or double-flip
        // an item's status). Nullable for backward compatibility --
        // an older client that doesn't send it keeps the old
        // at-most-once-per-fingers-crossed behavior.
        const clientKey = String(w.client_key || w.clientKey || "").trim() || null;
        if (!itemId) return { index: i, ok: false, error: "submitCount: itemId required" };
        if (!counter) return { index: i, ok: false, error: "submitCount: counted_by required" };
        if (!Number.isFinite(countedRaw) || countedRaw < 0) {
          return { index: i, ok: false, error: "submitCount: counted_qty must be a non-negative number" };
        }
        const counted = Math.round(countedRaw);
        // Idempotency short-circuit BEFORE any writes.
        if (clientKey) {
          const { data: prior, error: priorErr } = await supa
            .from("cycle_count_log")
            .select("id, item_id")
            .eq("client_key", clientKey)
            .maybeSingle();
          if (priorErr) return { index: i, ok: false, error: "submitCount: idempotency check failed: " + priorErr.message };
          if (prior && prior.id) {
            const { data: priorItem } = await supa
              .from("cycle_count_items")
              .select("status, variance")
              .eq("id", prior.item_id)
              .maybeSingle();
            return {
              index: i, ok: true, kind: "submitCount",
              itemId: prior.item_id,
              status: (priorItem && priorItem.status) || "counted",
              variance: (priorItem && Number(priorItem.variance)) || 0,
              childId: null,
              idempotent: true,
            };
          }
        }
        const { data: item, error: itemErr } = await supa
          .from("cycle_count_items")
          .select("id, pn, assigned_date, tier, reason, system_qty_at_assign, status, recount_of, note")
          .eq("id", itemId)
          .maybeSingle();
        if (itemErr) return { index: i, ok: false, error: "submitCount: read failed: " + itemErr.message };
        if (!item) return { index: i, ok: false, error: "submitCount: item not found" };
        if (item.status !== "pending" && item.status !== "recount") {
          return { index: i, ok: false, error: "submitCount: item status is " + item.status + " (not pending/recount)" };
        }
        // Blind-recount rule.
        if (item.recount_of) {
          const { data: parent, error: parentErr } = await supa
            .from("cycle_count_items")
            .select("counted_by")
            .eq("id", item.recount_of)
            .maybeSingle();
          if (parentErr) return { index: i, ok: false, error: "submitCount: parent read failed: " + parentErr.message };
          if (parent && parent.counted_by && String(parent.counted_by).trim().toLowerCase() === counter.toLowerCase()) {
            return { index: i, ok: false, error: "submitCount: recount must be performed by a different counter than the original" };
          }
        }
        const variance = counted - Number(item.system_qty_at_assign);
        const variancePct = _variancePct(item.system_qty_at_assign, counted);
        const beyond = _beyondTolerance(item.system_qty_at_assign, counted);
        // outcome + status. First-count beyond tolerance -> parent
        // flips to "recount" and we spawn a blind child. Recount
        // count itself completes as "counted" regardless (the third
        // count would be a manual flag).
        let newStatus = "counted";
        let childId = null;
        if (beyond && !item.recount_of) {
          newStatus = "recount";
          // Spawn blind child. Happens BEFORE the item + log writes
          // so the "the child was queued" invariant holds when the
          // parent flips to recount. A duplicate-key error here is
          // benign -- an open recount child already exists for this
          // pn / parent (either a prior successful submit whose
          // response was lost, or the open-pn unique index catching
          // a race). We adopt the existing child and continue -- a
          // count must never fail because bookkeeping was already
          // done.
          const { data: child, error: childErr } = await supa
            .from("cycle_count_items")
            .insert({
              assigned_date: item.assigned_date,
              tier: "flagged",
              reason: "recount of " + (item.reason || "count") + " (variance " + Math.round(variance) + ")",
              pn: item.pn,
              system_qty_at_assign: item.system_qty_at_assign,
              status: "pending",
              recount_of: item.id,
              note: item.note || null,
            })
            .select("id")
            .single();
          if (childErr) {
            if (_isDupKey(childErr)) {
              log("submitCount: recount child dup-key benign (" + (childErr.message || "23505") + ")");
              // Best-effort recovery of the existing child's id so
              // the client can hand it to a supervisor if needed.
              const { data: existingChild } = await supa
                .from("cycle_count_items")
                .select("id")
                .eq("recount_of", item.id)
                .in("status", ["pending", "recount"])
                .maybeSingle();
              childId = (existingChild && existingChild.id) || null;
            } else {
              return { index: i, ok: false, error: "submitCount: recount child spawn failed: " + childErr.message };
            }
          } else {
            childId = child.id;
          }
        }
        // v-cc-loc-1 phase 1 -- location persistence, must happen
        // BEFORE the item update so a failure here aborts the whole
        // op (no half-written item row).
        let locationsBreakdown = null;   // for log row
        if (locationsIn) {
          // Load existing snapshot rows for this item.
          const { data: existingLocs, error: locFetchErr } = await supa
            .from("cycle_count_item_locations")
            .select("id, location, system_qty_at_assign, counted_qty")
            .eq("item_id", itemId);
          if (locFetchErr) return { index: i, ok: false, error: "submitCount: locations fetch failed: " + locFetchErr.message };
          const existingByLoc = new Map();
          for (const r of (existingLocs || [])) existingByLoc.set(String(r.location), r);
          // Validate + partition payload rows.
          const seen = new Set();
          const updates = [];
          const inserts = [];
          for (const loc of locationsIn) {
            if (!loc || typeof loc.location !== "string" || !loc.location.trim()) {
              return { index: i, ok: false, error: "submitCount: locations[].location required" };
            }
            const locName = loc.location.trim();
            const locQtyRaw = Number(loc.counted_qty);
            if (!Number.isFinite(locQtyRaw) || locQtyRaw < 0) {
              return { index: i, ok: false, error: `submitCount: locations[${locName}].counted_qty must be a non-negative number` };
            }
            if (seen.has(locName)) {
              return { index: i, ok: false, error: `submitCount: duplicate location ${locName} in payload` };
            }
            seen.add(locName);
            const locQty = Math.round(locQtyRaw);
            const existing = existingByLoc.get(locName);
            if (existing) {
              updates.push({ id: existing.id, counted_qty: locQty, system: Number(existing.system_qty_at_assign) || 0 });
            } else if (loc.foundElsewhere) {
              // Counter discovered stock in an unlisted bin.
              inserts.push({
                item_id: itemId,
                pn: item.pn,
                location: locName,
                location_desc: (typeof loc.location_desc === "string") ? loc.location_desc.trim() || null : null,
                system_qty_at_assign: 0,
                counted_qty: locQty,
                counted_at: nowIso,
              });
            } else {
              return { index: i, ok: false, error: `submitCount: location ${locName} is not in this item's snapshot; pass foundElsewhere: true to add it` };
            }
          }
          // Every LISTED bin must be filled.
          for (const [locName] of existingByLoc.entries()) {
            if (!seen.has(locName)) {
              return { index: i, ok: false, error: `submitCount: location ${locName} missing from payload (all listed bins must be counted)` };
            }
          }
          // Sum-match against the item counted_qty.
          const payloadSum = locationsIn.reduce((s, l) => s + (Math.round(Number(l.counted_qty)) || 0), 0);
          if (payloadSum !== counted) {
            return { index: i, ok: false, error: `submitCount: counted_qty ${counted} != sum(locations) ${payloadSum}` };
          }
          // Persist updates + inserts.
          for (const u of updates) {
            const { error: uErr } = await supa
              .from("cycle_count_item_locations")
              .update({ counted_qty: u.counted_qty, counted_at: nowIso })
              .eq("id", u.id);
            if (uErr) return { index: i, ok: false, error: "submitCount: location update failed: " + uErr.message };
          }
          if (inserts.length > 0) {
            const { error: iErr } = await supa.from("cycle_count_item_locations").insert(inserts);
            if (iErr) return { index: i, ok: false, error: "submitCount: location inserts failed: " + iErr.message };
          }
          // Build the breakdown for the log row (post-write).
          locationsBreakdown = locationsIn.map(l => ({
            location: l.location.trim(),
            counted_qty: Math.round(Number(l.counted_qty) || 0),
            foundElsewhere: !!l.foundElsewhere,
          }));
        }

        const { error: upErr } = await supa
          .from("cycle_count_items")
          .update({
            counted_qty: counted,
            counted_by: counter,
            counted_at: nowIso,
            variance,
            status: newStatus,
            updated_at: nowIso,
          })
          .eq("id", itemId);
        if (upErr) return { index: i, ok: false, error: "submitCount: update failed: " + upErr.message };
        // Append log row.
        const outcomeLog = (newStatus === "recount") ? "recount" : "counted";
        const logRow = {
          item_id: itemId,
          pn: item.pn,
          assigned_date: item.assigned_date,
          counted_at: nowIso,
          counted_by: counter,
          tier: item.tier,
          reason: item.reason || null,
          system_qty_at_assign: item.system_qty_at_assign,
          counted_qty: counted,
          variance,
          variance_pct: variancePct,
          outcome: outcomeLog,
          note: item.note || null,
          recount_of: item.recount_of || null,
        };
        if (locationsBreakdown) logRow.locations = locationsBreakdown;
        if (clientKey) logRow.client_key = clientKey;
        const { error: logErr } = await supa
          .from("cycle_count_log")
          .insert(logRow);
        if (logErr) {
          // A dup-key on client_key means a concurrent retry beat us
          // to the log insert -- benign, the row is there.
          if (_isDupKey(logErr)) {
            log("submitCount: log client_key dup-key benign (" + (logErr.message || "23505") + ")");
          } else {
            // Non-fatal but surface it -- the count update landed.
            log("submitCount: log insert failed (non-fatal): " + logErr.message);
          }
        }
        return { index: i, ok: true, kind: "submitCount", itemId, status: newStatus, variance, childId };
      }

      case "skip": {
        // v-cc-loc-9 -- stamp the SKIPPER's name on both the item
        // and the log row so the supervisor tab can attribute the
        // skip (previously counted_by was null on skip rows,
        // rendering as "-" in the feed). `counted_by` is optional
        // in the payload only for backward compatibility with
        // callers that predate this change; new callers should
        // send it.
        const itemId = String(w.itemId || "").trim();
        const reason = String(w.reason || "").trim();
        const skipper = String(w.counted_by || "").trim();
        if (!itemId) return { index: i, ok: false, error: "skip: itemId required" };
        if (!reason) return { index: i, ok: false, error: "skip: reason required" };
        const { data: item, error: itemErr } = await supa
          .from("cycle_count_items")
          .select("id, pn, assigned_date, tier, reason, system_qty_at_assign, status, note, recount_of")
          .eq("id", itemId)
          .maybeSingle();
        if (itemErr) return { index: i, ok: false, error: "skip: read failed: " + itemErr.message };
        if (!item) return { index: i, ok: false, error: "skip: item not found" };
        const updates = {
          status: "skipped",
          note: reason,
          updated_at: nowIso,
        };
        if (skipper) { updates.counted_by = skipper; updates.counted_at = nowIso; }
        const { error: upErr } = await supa
          .from("cycle_count_items")
          .update(updates)
          .eq("id", itemId);
        if (upErr) return { index: i, ok: false, error: "skip: update failed: " + upErr.message };
        const { error: logErr } = await supa
          .from("cycle_count_log")
          .insert({
            item_id: itemId,
            pn: item.pn,
            assigned_date: item.assigned_date,
            counted_at: nowIso,
            counted_by: skipper || null,
            tier: item.tier,
            reason: item.reason || null,
            system_qty_at_assign: item.system_qty_at_assign,
            counted_qty: null,
            variance: null,
            variance_pct: null,
            outcome: "skipped",
            note: reason,
            recount_of: item.recount_of || null,
          });
        if (logErr) log("skip: log insert failed (non-fatal): " + logErr.message);
        return { index: i, ok: true, kind: "skip", itemId };
      }

      case "reassignFromSkip": {
        // v-cc-loc-9 -- supervisor sends a SKIPPED item back out.
        // Flips the item back to "pending", clears the counted_by /
        // counted_at fields left over from the skip, moves
        // assigned_date to today so it sorts to the front of the
        // queue, and (optionally) rewrites the reason to carry the
        // supervisor's note. NO log row is written for the
        // reassignment itself -- log rows represent completed
        // audit work; the eventual count that lands will log
        // normally.
        //
        // Rejects when the item is not currently skipped. Idempotent
        // per state: a second call after the item is already
        // pending / counted returns { skipped: true } instead of
        // clobbering the intermediate state.
        const itemId = String(w.itemId || "").trim();
        const requester = String(w.requested_by || "").trim();
        const noteRaw = String(w.note || "").trim();
        if (!itemId) return { index: i, ok: false, error: "reassignFromSkip: itemId required" };
        const { data: item, error: itemErr } = await supa
          .from("cycle_count_items")
          .select("id, pn, tier, reason, system_qty_at_assign, status, note, recount_of, assigned_date")
          .eq("id", itemId)
          .maybeSingle();
        if (itemErr) return { index: i, ok: false, error: "reassignFromSkip: read failed: " + itemErr.message };
        if (!item) return { index: i, ok: false, error: "reassignFromSkip: item not found" };
        if (item.status !== "skipped") {
          return { index: i, ok: true, kind: "reassignFromSkip", itemId, skipped: true, reason: "current status is " + item.status };
        }
        const today = nowIso.slice(0, 10);
        // Reason: "supervisor sent back out (via NAME)[: NOTE]".
        // Mirrors the requestRecount format so humanReason in
        // count-mobile.js can surface it uniformly.
        const reasonBase = requester
          ? "supervisor sent back out (via " + requester + ")"
          : "supervisor sent back out";
        const reasonText = noteRaw ? reasonBase + ": " + noteRaw : reasonBase;
        const { error: upErr } = await supa
          .from("cycle_count_items")
          .update({
            status: "pending",
            reason: reasonText,
            note: noteRaw || null,
            counted_by: null,
            counted_at: null,
            counted_qty: null,
            variance: null,
            assigned_date: today,   // to-queue-front behavior
            updated_at: nowIso,
          })
          .eq("id", itemId);
        if (upErr) return { index: i, ok: false, error: "reassignFromSkip: update failed: " + upErr.message };
        return { index: i, ok: true, kind: "reassignFromSkip", itemId };
      }

      case "reconcileFromLive": {
        // Client passes currentOnHand (raw parts.data.onHand from
        // its mirror). We treat "within 1 unit of counted_qty" as
        // converged -- Acumatica has caught up. Marks reconciled.
        const itemId = String(w.itemId || "").trim();
        const liveRaw = Number(w.currentOnHand);
        if (!itemId) return { index: i, ok: false, error: "reconcileFromLive: itemId required" };
        if (!Number.isFinite(liveRaw)) return { index: i, ok: false, error: "reconcileFromLive: currentOnHand required" };
        const { data: item, error: itemErr } = await supa
          .from("cycle_count_items")
          .select("id, pn, assigned_date, tier, reason, system_qty_at_assign, counted_qty, status, note, recount_of")
          .eq("id", itemId)
          .maybeSingle();
        if (itemErr) return { index: i, ok: false, error: "reconcileFromLive: read failed: " + itemErr.message };
        if (!item) return { index: i, ok: false, error: "reconcileFromLive: item not found" };
        if (item.status !== "counted") {
          return { index: i, ok: true, kind: "reconcileFromLive", itemId, skipped: true, reason: "status is " + item.status };
        }
        const counted = Number(item.counted_qty) || 0;
        const drift = Math.abs(liveRaw - counted);
        if (drift > RECONCILE_UNITS) {
          return { index: i, ok: true, kind: "reconcileFromLive", itemId, skipped: true, reason: "drift " + drift + " > " + RECONCILE_UNITS };
        }
        const { error: upErr } = await supa
          .from("cycle_count_items")
          .update({ status: "reconciled", updated_at: nowIso })
          .eq("id", itemId);
        if (upErr) return { index: i, ok: false, error: "reconcileFromLive: update failed: " + upErr.message };
        const { error: logErr } = await supa
          .from("cycle_count_log")
          .insert({
            item_id: itemId,
            pn: item.pn,
            assigned_date: item.assigned_date,
            counted_at: nowIso,
            counted_by: null,
            tier: item.tier,
            reason: item.reason || null,
            system_qty_at_assign: item.system_qty_at_assign,
            counted_qty: counted,
            variance: counted - Number(item.system_qty_at_assign),
            variance_pct: _variancePct(item.system_qty_at_assign, counted),
            outcome: "reconciled",
            note: item.note || null,
            recount_of: item.recount_of || null,
          });
        if (logErr) log("reconcileFromLive: log insert failed (non-fatal): " + logErr.message);
        return { index: i, ok: true, kind: "reconcileFromLive", itemId };
      }

      case "verifyLog": {
        // Supervisor attestation: stamp reviewed_by + reviewed_at on
        // a cycle_count_log row. NEVER writes on-hand -- this is
        // attestation only; Acumatica adjustment still happens
        // manually or via the SoR's usual channel. Idempotent when
        // called twice by the same reviewer (upserts fresh
        // timestamp; a different reviewer overwrites).
        const logId = String(w.logId || "").trim();
        const reviewer = String(w.reviewed_by || "").trim();
        if (!logId) return { index: i, ok: false, error: "verifyLog: logId required" };
        if (!reviewer) return { index: i, ok: false, error: "verifyLog: reviewed_by required" };
        const { error } = await supa
          .from("cycle_count_log")
          .update({ reviewed_by: reviewer, reviewed_at: nowIso })
          .eq("id", logId);
        if (error) return { index: i, ok: false, error: "verifyLog: update failed: " + error.message };
        return { index: i, ok: true, kind: "verifyLog", logId };
      }

      case "requestRecount": {
        // Supervisor manually spawns a recount child for a
        // parent item AND flips the parent's status to "recount"
        // so the UI marks it as recount-pending. Idempotent: if
        // a pending/recount child already exists for this parent
        // we return { skipped: true } with the existing child id
        // instead of stacking duplicates.
        //
        // v-cc-loc-8 -- optional `note`: a one-liner from the
        // supervisor ("recheck RMSTOR-LM bin") that lands on the
        // mobile count card as the reason line so the counter
        // knows exactly what to double-check.
        const parentId = String(w.itemId || "").trim();
        const requester = String(w.requested_by || "").trim();
        const noteRaw = String(w.note || "").trim();
        if (!parentId) return { index: i, ok: false, error: "requestRecount: itemId required" };
        const { data: parent, error: pErr } = await supa
          .from("cycle_count_items")
          .select("id, pn, assigned_date, tier, reason, system_qty_at_assign, note, status, counted_by")
          .eq("id", parentId)
          .maybeSingle();
        if (pErr) return { index: i, ok: false, error: "requestRecount: parent read failed: " + pErr.message };
        if (!parent) return { index: i, ok: false, error: "requestRecount: item not found" };
        const { data: existing, error: eErr } = await supa
          .from("cycle_count_items")
          .select("id, status")
          .eq("recount_of", parentId)
          .in("status", ["pending", "recount"])
          .maybeSingle();
        if (eErr) return { index: i, ok: false, error: "requestRecount: existing check failed: " + eErr.message };
        if (existing && existing.id) {
          return { index: i, ok: true, kind: "requestRecount", skipped: true, reason: "recount already pending", existingChildId: existing.id };
        }
        const today = nowIso.slice(0, 10);
        // v-cc-loc-8 -- reason format:
        //   "supervisor requested recount [(via NAME)][: NOTE]"
        // Mobile app's humanReason splits on the ": " to surface
        // the note as an explicit ask to the counter.
        const reasonBase = requester
          ? "supervisor requested recount (via " + requester + ")"
          : "supervisor requested recount";
        const reasonText = noteRaw ? reasonBase + ": " + noteRaw : reasonBase;
        const { data: child, error: cErr } = await supa
          .from("cycle_count_items")
          .insert({
            assigned_date: today,
            tier: "flagged",
            reason: reasonText,
            pn: parent.pn,
            system_qty_at_assign: parent.system_qty_at_assign,
            status: "pending",
            recount_of: parentId,
            // v-cc-loc-8 -- the supervisor note becomes the item
            // note too (in addition to the reason) so it shows in
            // any note-based UI.
            note: noteRaw || parent.note || null,
          })
          .select("id")
          .single();
        if (cErr) return { index: i, ok: false, error: "requestRecount: insert failed: " + cErr.message };
        // Bump parent's status to "recount" so the supervisor UI
        // renders it as recount-pending. Non-fatal on error --
        // the child was created, that's the important part.
        const { error: uErr } = await supa
          .from("cycle_count_items")
          .update({ status: "recount", updated_at: nowIso })
          .eq("id", parentId);
        if (uErr) log("requestRecount: parent status update failed (non-fatal): " + uErr.message);
        return { index: i, ok: true, kind: "requestRecount", childId: child.id };
      }

      default:
        return { index: i, ok: false, error: "unknown op: " + String(w.op) };
    }
  } catch (err) {
    return { index: i, ok: false, error: (err && err.message) || String(err) };
  }
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[cycle-count-write] ${msg}`, data === undefined ? "" : data);

  if (!event || event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST required" }) };
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, FS_EDIT_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "server not configured (supabase)" }) };
  }
  if (!FS_EDIT_TOKEN) {
    return { statusCode: 500, body: JSON.stringify({ error: "server not configured (edit token)" }) };
  }

  const headers = event.headers || {};
  const tokenIn = headers["x-fs-edit-token"] || headers["X-Fs-Edit-Token"] || "";
  if (String(tokenIn) !== String(FS_EDIT_TOKEN)) {
    return { statusCode: 401, body: JSON.stringify({ error: "invalid or missing x-fs-edit-token" }) };
  }
  const buildRaw = headers["x-app-build"] || headers["X-App-Build"] || "";
  const clientBuild = Number(buildRaw);
  if (!Number.isFinite(clientBuild) || clientBuild <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid or missing x-app-build" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: "invalid JSON body" }) }; }
  const writes = Array.isArray(body && body.writes) ? body.writes : null;
  if (!writes) return { statusCode: 400, body: JSON.stringify({ error: "body must be { writes: [...] }" }) };
  if (writes.length === 0) return { statusCode: 200, body: JSON.stringify({ ok: true, results: [] }) };
  if (writes.length > 100) return { statusCode: 400, body: JSON.stringify({ error: "batch too large (max 100)" }) };

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Reuse the frame-schedule minWriteBuild gate as the app-wide
  // stale-build signal. A tab that's already blocked from writing
  // frame_schedule is also blocked from writing cycle counts.
  const { data: settingsRow, error: settingsErr } = await supa
    .from("frame_schedule")
    .select("data")
    .eq("fg_sku", "__settings__")
    .maybeSingle();
  if (settingsErr) {
    log("settings read failed", settingsErr);
    return { statusCode: 500, body: JSON.stringify({ error: "settings read failed", detail: settingsErr.message }) };
  }
  const settingsData = (settingsRow && settingsRow.data) || {};
  const minWriteBuild = Number(settingsData.minWriteBuild) || 0;
  if (minWriteBuild > 0 && clientBuild < minWriteBuild) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: "app build is stale (newer version wrote this row)",
        minWriteBuild,
        clientBuild,
      }),
    };
  }

  const results = [];
  for (let i = 0; i < writes.length; i++) {
    results.push(await _applyOp(supa, writes[i], i, log));
  }

  const ok = results.every(r => r.ok);
  log(`batch ${ok ? "OK" : "PARTIAL"}: ${results.filter(r => r.ok).length}/${results.length} succeeded in ${Date.now() - t0}ms`);
  return {
    statusCode: 200,
    body: JSON.stringify({ ok, results }),
  };
};
