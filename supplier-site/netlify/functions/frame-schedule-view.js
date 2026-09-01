// Frame Schedule -- supplier-site VIEW.
//
// This is the copy that lives on the SEPARATE supplier-facing
// Netlify site (Base directory = supplier-site). The whole site
// is rewritten to this function at the root, so the supplier's
// bookmarked URL has no visible path or token -- just the bare
// site origin.
//
// Behavior:
//   - If ?token=<string> is on the URL, use it directly (same
//     shape gate as the planner-side function).
//   - If ?token is missing, look up the default token from
//     public.frame_schedule where fg_sku = '__settings__' and
//     take data.publishToken. This is the operator's stable
//     token minted client-side on first publish; it makes the
//     bare "/" URL work without the supplier ever handling one.
//   - Fetch the corresponding row from
//     public.frame_schedule_published and return its stored HTML.
//   - 404 (text/html "Not found") when the token is missing,
//     malformed, or has no matching published row.
//
// Auth: TOKEN IS THE CREDENTIAL. Row-level security on both
// tables denies anon; only this function reads them via the
// service key.
//
// Required env:
//   SUPABASE_URL          e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY  service-role key from Supabase API settings

const { createClient } = require("@supabase/supabase-js");

// Same loose token gate as the planner-side function and the
// client mint. MUST stay identical across all three so a token
// accepted anywhere is accepted everywhere.
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
  const log = (msg, data) => console.log(`[supplier-site view] ${msg}`, data || "");

  if (event && event.httpMethod !== "GET") {
    return { statusCode: 405, body: "GET only" };
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    return { statusCode: 500, body: "Server not configured" };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Prefer the query-string token; fall back to the default
  // stashed in the __settings__ row.
  let token = event && event.queryStringParameters && event.queryStringParameters.token;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    // No usable token on the URL -- look up the default.
    const { data: settingsRow, error: settingsErr } = await supa
      .from("frame_schedule")
      .select("data")
      .eq("fg_sku", "__settings__")
      .maybeSingle();
    if (settingsErr) {
      log("settings select failed", { code: settingsErr.code, message: settingsErr.message });
      return { statusCode: 500, body: "Read failed" };
    }
    const rawTok = settingsRow && settingsRow.data && settingsRow.data.publishToken;
    if (typeof rawTok !== "string" || !TOKEN_RE.test(rawTok)) return NOT_FOUND;
    token = rawTok;
  }

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
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
    body: data.html,
  };
};
