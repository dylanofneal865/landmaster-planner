// v7.11 Frame Schedule -- SERVER-SIDE WRITE ENFORCEMENT.
//
// All frame_schedule row writes go through this function so the
// authoritative "is this row a manual pin?" / "is my build too
// old?" checks happen against the current DATABASE row, not the
// client's local mirror. A stale-mirror session that thinks a
// row is weekly-auto but the DB has it as manual is now stopped
// here -- not at the client.
//
// The client (js/30-supabase.js writers) POSTs here with a
// service-independent edit token; this function forwards to
// Supabase with the SERVICE key.
//
// Request shape (JSON body):
//   { writes:   [ { iso, payload }, ... ] }
// OR
//   { settings: { crewhd, std, bufferWeeks?, publishToken?,
//                 lastPublishedAt?, scheduleMode? } }
//
// Required headers on EVERY request:
//   x-fs-edit-token   -- must equal env FS_EDIT_TOKEN. Missing /
//                        mismatch -> 401.
//   x-app-build       -- integer APP_BUILD from js/01-config.js.
//                        Missing / non-numeric -> 400. Value <
//                        __settings__.data.minWriteBuild -> 409.
//
// Per-write payload semantics (mirror of _fsCommitWeek's outbound
// payload shape):
//   payload.qty              -- {pn: units} to persist
//   payload.slot             -- slot descriptor or null (clears)
//   payload.onHandAtClose    -- {pn: units} snapshot
//   payload.qtyOverride      -- {pn: units} manual overrides
//   payload.allowManualSlotChange -- true to override the DB-side
//                                    manual-pin immutability guard
//
// The DB-side manual-pin guard (v7.10 semantics, now enforced HERE
// instead of only at the client): if the CURRENT DB row has
// slot.source === "manual" AND payload.slot is present AND differs
// AND allowManualSlotChange !== true -> the write is SKIPPED and
// the per-iso result carries { ok: true, skipped: true,
// reason: "manual-pin" }. Every other write in the same batch
// still lands.
//
// Response shape:
//   200 { ok: true, results: [{ iso, ok, skipped?, reason?, error? }] }
//        OR (settings) { ok: true, kind: "settings" }
//   400 { error }        -- bad request shape / missing headers
//   401 { error }        -- token mismatch
//   409 { error, minWriteBuild } -- build stale
//   500 { error, detail } -- DB failure
//
// ISOLATION:
//   * Writes ONLY to public.frame_schedule.
//   * Never touches parts, pos, usage, po_receipts, etc.
//   * frame_schedule_published stays with its own function
//     (netlify/functions/frame-schedule-publish.js) but shares
//     the SAME edit token.
//
// Required env:
//   SUPABASE_URL          e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY  service-role key from Supabase API settings
//   FS_EDIT_TOKEN         shared secret; set on Netlify site env.
//                         Operator prompts once per browser session
//                         and enters this value. Rotate as needed.

const { createClient } = require("@supabase/supabase-js");

// v7.10 slot equality helper, mirrored from js/25 + js/30.
function _slotsEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return String(a.pn || "")     === String(b.pn || "")
      && String(a.pn2 || "")    === String(b.pn2 || "")
      && (Number(a.qty)  || 0)  === (Number(b.qty)  || 0)
      && (Number(a.qty2) || 0)  === (Number(b.qty2) || 0)
      && String(a.mode || "")   === String(b.mode || "")
      && !!a.locked             === !!b.locked
      && String(a.source || "") === String(b.source || "");
}

// Sanitize a single week's payload the same way js/30's writer
// used to. Duplicated here so this function is self-contained
// (no shared module).
function _sanitizeWeekPayload(payload, prevData) {
  const qty = {};
  if (payload && payload.qty && typeof payload.qty === "object") {
    for (const [k, v] of Object.entries(payload.qty)) {
      const n = Math.max(0, Number(v) || 0);
      if (n > 0) qty[k] = n;
    }
  }
  let slot = null;
  if (payload && payload.slot && typeof payload.slot === "object" && payload.slot.pn) {
    slot = {
      pn: String(payload.slot.pn),
      locked: !!payload.slot.locked,
      source: (payload.slot.source === "manual"
              || payload.slot.source === "seed"
              || payload.slot.source === "weekly-auto")
                ? payload.slot.source
                : "auto",
    };
    if (typeof payload.slot.pn2 === "string" && payload.slot.pn2 && payload.slot.pn2 !== slot.pn) {
      slot.pn2 = payload.slot.pn2;
    }
    if (payload.slot.mode === "weekly") slot.mode = "weekly";
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
  // Preserve onHandAtClose / qtyOverride from the prior row when
  // the payload doesn't mention them (same semantics js/30 had).
  let onHandAtClose = null;
  if (payload && payload.onHandAtClose && typeof payload.onHandAtClose === "object") {
    onHandAtClose = {};
    for (const [k, v] of Object.entries(payload.onHandAtClose)) {
      const n = Number(v);
      if (Number.isFinite(n)) onHandAtClose[k] = n;
    }
    if (Object.keys(onHandAtClose).length === 0) onHandAtClose = null;
  } else if (prevData && prevData.onHandAtClose && typeof prevData.onHandAtClose === "object") {
    onHandAtClose = prevData.onHandAtClose;
  }
  let qtyOverride;
  if (payload && Object.prototype.hasOwnProperty.call(payload, "qtyOverride")) {
    if (payload.qtyOverride && typeof payload.qtyOverride === "object") {
      const sanitized = {};
      for (const [k, v] of Object.entries(payload.qtyOverride)) {
        const n = Math.floor(Number(v));
        if (Number.isFinite(n) && n >= 0) sanitized[k] = n;
      }
      qtyOverride = Object.keys(sanitized).length > 0 ? sanitized : null;
    } else {
      qtyOverride = null;
    }
  } else if (prevData && prevData.qtyOverride) {
    qtyOverride = prevData.qtyOverride;
  } else {
    qtyOverride = null;
  }
  const dataOut = { qty };
  if (slot) dataOut.slot = slot;
  if (onHandAtClose) dataOut.onHandAtClose = onHandAtClose;
  if (qtyOverride) dataOut.qtyOverride = qtyOverride;
  return { dataOut, slot };
}

function _sanitizeSettingsPayload(payload, prevData) {
  const crewhd = Math.max(0, Number(payload && payload.crewhd) || 0);
  const std    = Math.max(0, Number(payload && payload.std)    || 0);
  const bwArg = Number(payload && payload.bufferWeeks);
  const bufferWeeks = (Number.isFinite(bwArg) && bwArg >= 0)
    ? bwArg
    : (prevData && Number.isFinite(prevData.bufferWeeks) ? prevData.bufferWeeks : null);
  const ptArg = payload && payload.publishToken;
  const publishToken = (typeof ptArg === "string" && /^[A-Za-z0-9._-]{24,128}$/.test(ptArg))
    ? ptArg
    : (prevData && typeof prevData.publishToken === "string" && prevData.publishToken ? prevData.publishToken : null);
  const lpArg = payload && payload.lastPublishedAt;
  const lastPublishedAt = (typeof lpArg === "string" && lpArg.length > 0)
    ? lpArg
    : (prevData && typeof prevData.lastPublishedAt === "string" && prevData.lastPublishedAt ? prevData.lastPublishedAt : null);
  const smArg = payload && payload.scheduleMode;
  let scheduleMode;
  if (smArg === "weekly" || smArg === "slots") scheduleMode = smArg;
  else if (prevData && (prevData.scheduleMode === "weekly" || prevData.scheduleMode === "slots")) scheduleMode = prevData.scheduleMode;
  else scheduleMode = "weekly";
  const clientBuild = payload && Number.isFinite(Number(payload.appBuild)) ? Math.floor(Number(payload.appBuild)) : 0;
  const prevBuild = (prevData && Number.isFinite(Number(prevData.minWriteBuild))) ? Math.floor(Number(prevData.minWriteBuild)) : 0;
  const minWriteBuild = Math.max(prevBuild, clientBuild);
  const dataOut = { caps: { crewhd, std } };
  if (bufferWeeks !== null) dataOut.bufferWeeks = bufferWeeks;
  if (publishToken !== null) dataOut.publishToken = publishToken;
  if (lastPublishedAt !== null) dataOut.lastPublishedAt = lastPublishedAt;
  dataOut.scheduleMode = scheduleMode;
  if (minWriteBuild > 0) dataOut.minWriteBuild = minWriteBuild;
  return { dataOut };
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[frame-schedule-write] ${msg}`, data || "");

  if (!event || event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "POST required" }) };
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, FS_EDIT_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    return { statusCode: 500, body: JSON.stringify({ error: "server not configured (supabase)" }) };
  }
  if (!FS_EDIT_TOKEN) {
    log("Missing FS_EDIT_TOKEN env");
    return { statusCode: 500, body: JSON.stringify({ error: "server not configured (edit token)" }) };
  }

  // ---- Header checks ---------------------------------------------
  const headers = event.headers || {};
  const tokenIn = headers["x-fs-edit-token"] || headers["X-Fs-Edit-Token"] || "";
  if (String(tokenIn) !== String(FS_EDIT_TOKEN)) {
    return { statusCode: 401, body: JSON.stringify({ error: "invalid or missing x-fs-edit-token" }) };
  }
  const clientBuildRaw = headers["x-app-build"] || headers["X-App-Build"] || "";
  const clientBuild = Number(clientBuildRaw);
  if (!Number.isFinite(clientBuild) || clientBuild <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid or missing x-app-build" }) };
  }

  // ---- Parse body ------------------------------------------------
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "invalid JSON body" }) };
  }
  const isSettings = !!(body && body.settings);
  const isWrites = Array.isArray(body && body.writes);
  if (!isSettings && !isWrites) {
    return { statusCode: 400, body: JSON.stringify({ error: "body must be { writes: [...] } or { settings: {...} }" }) };
  }
  if (isSettings && isWrites) {
    return { statusCode: 400, body: JSON.stringify({ error: "body cannot mix writes and settings" }) };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- Load current __settings__ for the build guard ------------
  // Every write in this call is subject to the same
  // minWriteBuild -- one read serves the whole batch.
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

  // ---- SETTINGS path --------------------------------------------
  if (isSettings) {
    const { dataOut } = _sanitizeSettingsPayload(body.settings, settingsData);
    const nowIso = new Date().toISOString();
    const { error: upErr } = await supa
      .from("frame_schedule")
      .upsert(
        { fg_sku: "__settings__", weekly_qty: 0, data: dataOut, updated_at: nowIso },
        { onConflict: "fg_sku" }
      );
    if (upErr) {
      log("settings upsert failed", upErr);
      return { statusCode: 500, body: JSON.stringify({ error: "settings upsert failed", detail: upErr.message }) };
    }
    log(`settings write OK in ${Date.now() - t0}ms`);
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, kind: "settings" }),
    };
  }

  // ---- WRITES path (batch) --------------------------------------
  const writes = body.writes;
  if (writes.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, results: [] }) };
  }
  if (writes.length > 200) {
    return { statusCode: 400, body: JSON.stringify({ error: "batch too large (max 200)" }) };
  }

  // Load every touched row's current state IN ONE ROUND-TRIP so the
  // manual-pin guard can compare against DB truth.
  const touchIsos = [];
  for (const w of writes) {
    if (w && typeof w.iso === "string" && /^\d{4}-\d{2}-\d{2}$/.test(w.iso)) {
      touchIsos.push(w.iso);
    }
  }
  const priorByIso = new Map();
  if (touchIsos.length > 0) {
    const { data: priors, error: priorErr } = await supa
      .from("frame_schedule")
      .select("fg_sku, data")
      .in("fg_sku", touchIsos);
    if (priorErr) {
      log("prior read failed", priorErr);
      return { statusCode: 500, body: JSON.stringify({ error: "prior read failed", detail: priorErr.message }) };
    }
    for (const r of (priors || [])) priorByIso.set(r.fg_sku, r.data || {});
  }

  const results = [];
  const rowsToUpsert = [];
  const nowIso = new Date().toISOString();

  for (const w of writes) {
    if (!w || typeof w.iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(w.iso)) {
      results.push({ iso: (w && w.iso) || null, ok: false, error: "invalid iso" });
      continue;
    }
    if (w.iso === "__settings__") {
      results.push({ iso: w.iso, ok: false, error: "reserved key -- use { settings: {...} }" });
      continue;
    }
    const payload = w.payload || {};
    const prior = priorByIso.get(w.iso) || {};
    // Manual-pin immutability against DB truth.
    const payloadHasSlot = Object.prototype.hasOwnProperty.call(payload, "slot");
    const priorSlot = prior && prior.slot;
    if (payloadHasSlot
        && priorSlot && priorSlot.source === "manual"
        && !_slotsEqual(payload.slot, priorSlot)
        && payload.allowManualSlotChange !== true) {
      results.push({
        iso: w.iso,
        ok: true,
        skipped: true,
        reason: "manual-pin",
        prevPn: priorSlot.pn || null,
        prevPn2: priorSlot.pn2 || null,
      });
      continue;
    }
    const { dataOut } = _sanitizeWeekPayload(payload, prior);
    rowsToUpsert.push({
      fg_sku: w.iso,
      weekly_qty: 0,
      data: dataOut,
      updated_at: nowIso,
    });
    results.push({ iso: w.iso, ok: true });
  }

  if (rowsToUpsert.length > 0) {
    const { error: batchErr } = await supa
      .from("frame_schedule")
      .upsert(rowsToUpsert, { onConflict: "fg_sku" });
    if (batchErr) {
      log("batch upsert failed", batchErr);
      // Mark every non-skipped result as failed with the batch
      // error's message; the client sees per-iso results and
      // can decide what to do.
      for (const r of results) {
        if (!r.skipped && r.ok) { r.ok = false; r.error = batchErr.message; }
      }
      return {
        statusCode: 500,
        body: JSON.stringify({ ok: false, error: "batch upsert failed", detail: batchErr.message, results }),
      };
    }
  }

  const skipped = results.filter(r => r.skipped).length;
  const wrote = results.filter(r => r.ok && !r.skipped).length;
  log(`batch write OK: ${wrote} wrote, ${skipped} skipped(manual-pin) in ${Date.now() - t0}ms`);
  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, results }),
  };
};
