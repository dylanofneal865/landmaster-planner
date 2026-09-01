// Frame Schedule -- supplier snapshot VIEW.
//
// GET /.netlify/functions/frame-schedule-view?token=<string>
// -> serves the stored HTML from public.frame_schedule_published.
// 404 with a plain "Not found" body (still text/html so a browser
// renders it, not a raw string) when the token is missing,
// malformed, or has no matching row. Cache-Control: no-store so
// suppliers always see the latest publish.
//
// Auth: TOKEN IS THE CREDENTIAL. Row-level security on
// frame_schedule_published denies anon; only this function reads it
// via the service key. The URL is unguessable because the token is
// a "fs-<uuid>" string minted on first publish (via crypto.randomUUID)
// and stashed in the __settings__ row.
//
// Env + Supabase client mirror acumatica-po-receipts-sync.js exactly.
//
// Required env:
//   SUPABASE_URL          e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY  service-role key from Supabase API settings

const { createClient } = require("@supabase/supabase-js");

// Same loose token gate as the publish function so a bogus URL 404s
// immediately without a Supabase round-trip. MUST stay identical to
// the client (_FS_TOKEN_RE in js/25-page-frame-schedule.js) and the
// publish function.
const TOKEN_RE = /^[A-Za-z0-9._-]{24,128}$/;

const NOT_FOUND = {
  statusCode: 404,
  headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  },
  body: "Not found",
};

exports.handler = async (event) => {
  const log = (msg, data) => console.log(`[frame-schedule-view] ${msg}`, data || "");

  if (event && event.httpMethod !== "GET") {
    return { statusCode: 405, body: "GET only" };
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    return { statusCode: 500, body: "Server not configured" };
  }

  const token = event && event.queryStringParameters && event.queryStringParameters.token;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return NOT_FOUND;

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data, error } = await supa
    .from("frame_schedule_published")
    .select("html, updated_at")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    log("select failed", { code: error.code, message: error.message });
    return { statusCode: 500, body: "Read failed" };
  }
  if (!data || typeof data.html !== "string" || data.html.length === 0) {
    return NOT_FOUND;
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // Static snapshot -- no reason for anyone to embed it or
      // pull scripts from it. Belt-and-suspenders.
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
    body: data.html,
  };
};
