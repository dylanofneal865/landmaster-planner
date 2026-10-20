// Netlify BACKGROUND function -- the Acumatica PO pass.
//
// The "-background" suffix in the file name is what makes this a
// background function: Netlify answers the caller 202 at once and lets
// the run continue for up to 15 minutes. Do not rename the file.
//
// Why it exists (Oct 13 2026): the PO pass (LMInventoryPlannerPOLines,
// 8,535 lines / 9 pages, ~50 s) no longer fits the 30 s Netlify gives a
// scheduled function. See the "PO PASS HAND-OFF" note in
// acumatica-sync.js. That function still owns the schedule; on a PO
// tick it POSTs here and returns. This file adds no sync logic of its
// own -- it calls the same runPOSync with a longer deadline.
//
// Not scheduled (no netlify.toml stanza on purpose). Triggered by
// acumatica-sync every other 2-minute tick, so one run per 4 minutes.
// Manual run: POST /.netlify/functions/acumatica-po-sync-background
//
// Heartbeat: unchanged. runPOSync beats "acumatica-po-sync" on a real
// completion and writes its failure note on any failed run.
//
// Env: same as acumatica-sync.js (ACUMATICA_BASE_URL, ACUMATICA_COMPANY,
// ACUMATICA_USERNAME, ACUMATICA_PASSWORD, SUPABASE_URL,
// SUPABASE_SERVICE_KEY).

const { createClient } = require("@supabase/supabase-js");
const { fail: _fail, remainingMs: _remainingMs } = require("./_heartbeat.js");
const { _runPOSync } = require("./acumatica-sync.js");

const HB = "acumatica-po-sync";
// One run starts every 240 s. Stopping at 200 s means a slow run has
// always ended before the next one starts, so runs never overlap.
const RUN_BUDGET_MS = 200000;
const DEADLINE_MARGIN_MS = 8000;

exports.handler = async (event, context) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[acumatica-po-sync-background] ${msg}`, data || "");
  // Always answer 200. Netlify retries a background function that
  // returns an error (1 minute later, then 2 minutes after that), and a
  // retried PO pass would overlap the next scheduled one. Failures are
  // reported on the Settings card via the heartbeat note instead.
  const done = (extra) => ({ statusCode: 200, body: JSON.stringify(Object.assign({ durationMs: Date.now() - t0 }, extra || {})) });

  const {
    ACUMATICA_BASE_URL,
    ACUMATICA_COMPANY,
    ACUMATICA_USERNAME,
    ACUMATICA_PASSWORD,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
  } = process.env;

  let supa = null;
  try {
    if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
      supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    }
    if (!ACUMATICA_BASE_URL || !ACUMATICA_USERNAME || !ACUMATICA_PASSWORD || !supa) {
      log("Missing required environment variables");
      await _fail(supa, HB, "PO background run: missing required environment variables", log);
      return done({ error: "Missing env vars" });
    }

    const platformLeft = _remainingMs(context, t0, 900000) - DEADLINE_MARGIN_MS;
    const deadlineAt = t0 + Math.max(10000, Math.min(RUN_BUDGET_MS, platformLeft));
    log(`start, ${Math.round((deadlineAt - t0) / 1000)}s budget`);

    const pos = await _runPOSync({
      supa,
      log,
      baseUrl: ACUMATICA_BASE_URL,
      company: ACUMATICA_COMPANY || "LIVE",
      username: ACUMATICA_USERNAME,
      password: ACUMATICA_PASSWORD,
      supabaseUrl: SUPABASE_URL,
      serviceKey: SUPABASE_SERVICE_KEY,
      deadlineAt,
      mode: "background",
    });
    log(`done in ${Date.now() - t0}ms`, pos && pos.error ? { error: pos.error } : "");
    return done({ pos });
  } catch (err) {
    const why = (err && err.message) || String(err);
    log("threw", why);
    await _fail(supa, HB, `PO background run threw: ${why}`, log);
    return done({ error: why });
  }
};
