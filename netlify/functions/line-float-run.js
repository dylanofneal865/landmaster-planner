// LINE FLOAT — manual / browser entry point.
//
// WHY THIS FILE EXISTS
// Netlify does not route HTTP requests to a function that carries a
// `schedule` in netlify.toml; it answers 403 "Access denied". So
// line-float-compute.js (scheduled 06:30 UTC) can never be opened in a
// browser, no matter what its handler does. This wrapper carries NO
// schedule, so it is publicly routable, and delegates to the exact same
// runner — one implementation, two doors.
//
// Same shape the repo already uses for PO receipts:
// acumatica-po-receipts-sync.js is an unscheduled shared runner and
// acumatica-po-receipts-{full,incremental}.js are thin scheduled
// wrappers around it.
//
// ACCESS MODEL
//   Read-only by DEFAULT. With no edit token this endpoint forces
//   dry-run: it computes, reports, and writes nothing. That is the
//   diagnostic path and it is deliberately open, because it mutates
//   nothing and exposes only BOM structure the planner already renders.
//
//   Writing requires the same x-fs-edit-token header every other
//   mutating function uses (cycle-count-write, frame-schedule-write).
//   A browser GET cannot set headers, so ?write=1 is also accepted
//   alongside ?token=<FS_EDIT_TOKEN> for a manual "recompute now".
//   Token-in-URL lands in access logs, so prefer the header where you
//   can; the cron path needs neither and is how writes normally happen.
//
// USAGE
//   /.netlify/functions/line-float-run                  dry run, full report
//   /.netlify/functions/line-float-run?explain=PN1,PN2  + explosion paths
//   /.netlify/functions/line-float-run?write=1&token=…  recompute + persist
//
// NEVER writes to Acumatica. See line-float-compute.js for the math,
// the band definition, and the CREATE TABLE SQL.

const { runLineFloat } = require("./line-float-compute.js");

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const headers = (event && event.headers) || {};

  const wantsWrite = q.write === "1" || q.write === "true";
  const tokenIn = headers["x-fs-edit-token"] || headers["X-Fs-Edit-Token"] || q.token || "";
  const expected = process.env.FS_EDIT_TOKEN || "";
  const authed = !!expected && String(tokenIn) === String(expected);

  if (wantsWrite && !authed) {
    return {
      statusCode: 401,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        error: "write requires a valid edit token",
        how: "send x-fs-edit-token as a header, or ?token=<FS_EDIT_TOKEN> in the URL. Drop ?write=1 for the open read-only dry run.",
      }, null, 2),
    };
  }

  // Force dry-run unless an authenticated write was explicitly asked
  // for. Passing ?dry=0 without a token must NOT silently persist.
  const forcedDry = !(wantsWrite && authed);
  const inner = {
    ...event,
    queryStringParameters: { ...q, dry: forcedDry ? "1" : "0" },
  };

  const res = await runLineFloat(inner);
  // Render JSON in the browser rather than downloading it.
  return {
    ...res,
    headers: { ...(res.headers || {}), "content-type": "application/json; charset=utf-8" },
  };
};
