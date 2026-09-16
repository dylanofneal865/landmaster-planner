// PRODUCTION-ORDERS SYNC — manual / browser entry point.
//
// WHY THIS FILE EXISTS
// acumatica-production-orders-sync.js carries a `schedule` in
// netlify.toml, and Netlify does not route HTTP to a scheduled function
// — it answers 403 "Access denied" no matter what the handler does. So
// there was no way to force a sync, and no way to see WHY the hourly
// cron was not moving production_orders. This wrapper carries no
// schedule, so it is routable, and delegates to the same runner: one
// implementation, two doors.
//
// Same shape the repo already uses for PO receipts
// (acumatica-po-receipts-sync.js + two scheduled wrappers) and for the
// line-float band (line-float-compute.js + line-float-run.js).
//
// ACCESS MODEL
//   A sync WRITES (production_orders, one audit row, and the chained
//   line-float recompute), so unlike line-float-run there is no open
//   read-only mode. Every path requires the same x-fs-edit-token every
//   other mutating function uses. A browser GET cannot set headers, so
//   ?token=<FS_EDIT_TOKEN> is accepted too; token-in-URL lands in access
//   logs, so prefer the header where you can.
//
//   ?diag=1 runs NOTHING. It reports which environment variables are
//   present (booleans only — never values), the exact OData URL the sync
//   would call, and the newest success/failure audit stamps. That is the
//   "was it ever invoked, and is it configured" question answered
//   without touching Acumatica. Still token-gated: the GI name and
//   tenant URL are not secret, but they are not for the open internet
//   either.
//
// USAGE
//   /.netlify/functions/acumatica-production-orders-run?diag=1&token=…
//       configuration + last-run stamps, no side effects
//   /.netlify/functions/acumatica-production-orders-run?token=…
//       force a sync now; response carries the full run trace
//
// The response body includes `trace` — the same lines the function logs
// — so a failure is diagnosable from the HTTP response alone.
//
// NEVER writes to Acumatica.

const { createClient } = require("@supabase/supabase-js");
const { runProductionOrdersSync } = require("./acumatica-production-orders-sync.js");

// Newest audit row of a given type, without jsonb operators. Filtering
// on data->>type is unindexed and unreliable at size; pulling a bounded
// page by primary key and filtering in JS is both faster and honest
// about its own limit.
async function newestAudit(supa, type, scanLimit) {
  const { data, error } = await supa.from("audit")
    .select("id, data").order("id", { ascending: false }).limit(scanLimit || 750);
  if (error) return { error: error.message };
  let best = null;
  for (const r of (data || [])) {
    const d = r && r.data;
    if (!d || d.type !== type) continue;
    if (!best || String(d.ts) > String(best.ts)) best = d;
  }
  return { row: best, scanned: (data || []).length };
}

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const headers = (event && event.headers) || {};
  const json = (statusCode, body) => ({
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body, null, 2),
  });

  const tokenIn = headers["x-fs-edit-token"] || headers["X-Fs-Edit-Token"] || q.token || "";
  const expected = process.env.FS_EDIT_TOKEN || "";
  if (!expected || String(tokenIn) !== String(expected)) {
    return json(401, {
      error: "this endpoint requires a valid edit token",
      how: "send x-fs-edit-token as a header, or ?token=<FS_EDIT_TOKEN> in the URL",
    });
  }

  if (q.diag === "1" || q.diag === "true") {
    const env = {
      ACUMATICA_BASE_URL: !!process.env.ACUMATICA_BASE_URL,
      ACUMATICA_COMPANY: !!process.env.ACUMATICA_COMPANY,
      ACUMATICA_PRODUCTION_ORDERS_GI_NAME: !!process.env.ACUMATICA_PRODUCTION_ORDERS_GI_NAME,
      ACUMATICA_USERNAME: !!process.env.ACUMATICA_USERNAME,
      ACUMATICA_PASSWORD: !!process.env.ACUMATICA_PASSWORD,
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
    };
    const giName = process.env.ACUMATICA_PRODUCTION_ORDERS_GI_NAME || "LM Planner Production Orders";
    const company = process.env.ACUMATICA_COMPANY || "LIVE";
    const url = process.env.ACUMATICA_BASE_URL
      ? `${process.env.ACUMATICA_BASE_URL}/OData/${company}/${encodeURIComponent(giName)}?$top=1000&$skip=0`
      : "(ACUMATICA_BASE_URL not set)";

    let stamps = { note: "SUPABASE_URL / SUPABASE_SERVICE_KEY missing — cannot read audit stamps" };
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
      const supa = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
      const okRow = await newestAudit(supa, "acumatica-production-orders-sync");
      const badRow = await newestAudit(supa, "acumatica-production-orders-sync-failed");
      let rowCount = null;
      try {
        const { count } = await supa.from("production_orders").select("id", { count: "exact", head: true });
        rowCount = count;
      } catch (_) {}
      stamps = {
        // The unconditional audit row makes this a LIVENESS signal: a run
        // that changed nothing still stamps, so a stamp that has not moved
        // means no run reached the end of the function.
        lastSuccessfulRun: okRow.row ? { ts: okRow.row.ts, msg: okRow.row.msg } : null,
        lastFailedRun: badRow.row ? { ts: badRow.row.ts, msg: badRow.row.msg, stage: badRow.row.detail && badRow.row.detail.stage } : null,
        productionOrderRows: rowCount,
        interpretation: !okRow.row
          ? "no successful run has EVER been recorded"
          : (badRow.row && String(badRow.row.ts) > String(okRow.row.ts)
              ? "the most recent attempt FAILED — see lastFailedRun.stage"
              : "the most recent recorded attempt succeeded; if that timestamp is old, the cron is not firing"),
      };
    }
    return json(200, { mode: "diag", ranSync: false, env, company, giName, odataUrl: url, stamps });
  }

  const res = await runProductionOrdersSync(event);
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch (_) {}
  return json(res.statusCode, { mode: "sync", forced: true, statusCode: res.statusCode, result: parsed || res.body });
};
