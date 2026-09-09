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
//   { op: "flag",         pn, note?, systemQtyNow }
//   { op: "submitCount",  itemId, counted_qty, counted_by }
//   { op: "skip",         itemId, reason }
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

      case "submitCount": {
        // Counter submits their result. Enforces:
        //   * item exists + is pending or recount
        //   * variance beyond tolerance -> promote to recount and
        //     spawn a blind child item (tier=flagged, recount_of=id)
        //   * if THIS item has recount_of set (a recount child),
        //     counted_by MUST NOT equal parent.counted_by (blind).
        //   * append a cycle_count_log row (append-only).
        const itemId = String(w.itemId || "").trim();
        const counter = String(w.counted_by || "").trim();
        const countedRaw = Number(w.counted_qty);
        if (!itemId) return { index: i, ok: false, error: "submitCount: itemId required" };
        if (!counter) return { index: i, ok: false, error: "submitCount: counted_by required" };
        if (!Number.isFinite(countedRaw) || countedRaw < 0) {
          return { index: i, ok: false, error: "submitCount: counted_qty must be a non-negative number" };
        }
        const counted = Math.round(countedRaw);
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
          // Spawn blind child.
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
          if (childErr) return { index: i, ok: false, error: "submitCount: recount child spawn failed: " + childErr.message };
          childId = child.id;
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
        const { error: logErr } = await supa
          .from("cycle_count_log")
          .insert({
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
          });
        if (logErr) {
          // Non-fatal but surface it -- the count update landed.
          log("submitCount: log insert failed (non-fatal): " + logErr.message);
        }
        return { index: i, ok: true, kind: "submitCount", itemId, status: newStatus, variance, childId };
      }

      case "skip": {
        const itemId = String(w.itemId || "").trim();
        const reason = String(w.reason || "").trim();
        if (!itemId) return { index: i, ok: false, error: "skip: itemId required" };
        if (!reason) return { index: i, ok: false, error: "skip: reason required" };
        const { data: item, error: itemErr } = await supa
          .from("cycle_count_items")
          .select("id, pn, assigned_date, tier, reason, system_qty_at_assign, status, note, recount_of")
          .eq("id", itemId)
          .maybeSingle();
        if (itemErr) return { index: i, ok: false, error: "skip: read failed: " + itemErr.message };
        if (!item) return { index: i, ok: false, error: "skip: item not found" };
        const { error: upErr } = await supa
          .from("cycle_count_items")
          .update({
            status: "skipped",
            note: reason,
            updated_at: nowIso,
          })
          .eq("id", itemId);
        if (upErr) return { index: i, ok: false, error: "skip: update failed: " + upErr.message };
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
