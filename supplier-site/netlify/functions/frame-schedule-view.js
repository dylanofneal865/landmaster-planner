// Frame Schedule -- supplier-site VIEW.
//
// This is the copy that lives on the SEPARATE supplier-facing
// Netlify site (Base directory = supplier-site). The whole site
// is rewritten to this function at the root, so the supplier's
// bookmarked URL has no visible path or token -- just the bare
// site origin.
//
// Behavior:
//   - If ?token=<string> is on the URL:
//       * If it matches the CURRENT __settings__.publishToken,
//         serve that token's row (bookmark lands on today's page).
//       * If it differs but the URL token EVER existed in
//         frame_schedule_published (any historical publish),
//         serve the CURRENT token's row instead -- the URL token
//         is treated as an ALIAS for the current page. Fixes
//         stale supplier bookmarks after a __settings__
//         corruption forced a fresh mint; old links keep working
//         and show today's plan rather than a frozen orphan.
//       * If it never existed in frame_schedule_published, 404 --
//         someone typed junk.
//   - If ?token is missing, look up the default token from
//     public.frame_schedule where fg_sku = '__settings__' and
//     take data.publishToken. This is the operator's stable
//     token minted client-side on first publish; it makes the
//     bare "/" URL work without the supplier ever handling one.
//   - Fetch the resolved token's HTML from
//     public.frame_schedule_published and return it.
//   - 404 (text/html "Not found") when the resolved token has
//     no matching row.
//
// Auth: TOKEN IS THE CREDENTIAL. Row-level security on both
// tables denies anon; only this function reads them via the
// service key. Aliasing is safe under this model -- reaching an
// alias still requires a URL-shaped token that was at some point
// granted to a supplier, so this is not turning random bytes
// into a valid page.
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

  // Resolve the current publishToken from __settings__ once.
  // Used for both the token-missing default AND the alias check
  // (see header for TOKEN-ALIAS semantics).
  const { data: settingsRow, error: settingsErr } = await supa
    .from("frame_schedule")
    .select("data")
    .eq("fg_sku", "__settings__")
    .maybeSingle();
  if (settingsErr) {
    log("settings select failed", { code: settingsErr.code, message: settingsErr.message });
    return { statusCode: 500, body: "Read failed" };
  }
  const rawCur = settingsRow && settingsRow.data && settingsRow.data.publishToken;
  const currentToken = (typeof rawCur === "string" && TOKEN_RE.test(rawCur)) ? rawCur : null;

  const urlToken = event && event.queryStringParameters && event.queryStringParameters.token;
  const hasUrlToken = (typeof urlToken === "string" && TOKEN_RE.test(urlToken));

  // Decide what token to serve.
  //   * No URL token -> serve current (the bare "/" default).
  //   * URL === current -> serve current.
  //   * URL differs but exists in frame_schedule_published ->
  //     alias, serve current's row.
  //   * URL never existed -> 404.
  let serveToken;
  if (!hasUrlToken) {
    if (!currentToken) return NOT_FOUND;
    serveToken = currentToken;
  } else if (currentToken && urlToken === currentToken) {
    serveToken = currentToken;
  } else {
    const { data: existsRow, error: existsErr } = await supa
      .from("frame_schedule_published")
      .select("token")
      .eq("token", urlToken)
      .maybeSingle();
    if (existsErr) {
      log("alias existence check failed", { code: existsErr.code, message: existsErr.message });
      return { statusCode: 500, body: "Read failed" };
    }
    if (!existsRow) return NOT_FOUND;
    // Alias to current if we have one; otherwise fall back to the
    // URL token itself (may itself be an old snapshot -- best we
    // can do without a current pointer).
    serveToken = currentToken || urlToken;
    if (currentToken && serveToken !== urlToken) {
      log(`aliasing orphaned token ...${urlToken.slice(-6)} -> current ...${currentToken.slice(-6)}`);
    }
  }

  const { data, error } = await supa
    .from("frame_schedule_published")
    .select("html, updated_at")
    .eq("token", serveToken)
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
