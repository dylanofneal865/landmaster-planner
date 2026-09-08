// Frame Schedule -- supplier snapshot VIEW.
//
// GET /.netlify/functions/frame-schedule-view?token=<string>
// -> serves the stored HTML from public.frame_schedule_published.
//
// TOKEN-ALIAS SEMANTICS (v7.13):
//   The URL's token is looked up against the CURRENT
//   __settings__.publishToken value:
//     * If they match, we serve that token's row directly.
//     * If they differ but the URL's token EVER existed in
//       frame_schedule_published (any historical publish), we
//       treat the URL token as an ALIAS for the current page --
//       we serve the CURRENT token's row. This fixes stale
//       supplier bookmarks after a __settings__ corruption
//       forced a fresh mint: the old link keeps working and
//       shows today's plan instead of a frozen orphan snapshot.
//     * If the URL's token never existed in
//       frame_schedule_published, we 404 -- someone typed junk.
//   404 also fires for shape-invalid tokens (before any DB hit),
//   and for the case where the URL token IS current but its row
//   was somehow lost.
//
// Auth: TOKEN IS THE CREDENTIAL. Row-level security on
// frame_schedule_published denies anon; only this function reads it
// via the service key. Aliasing is safe under this model -- to
// reach an alias you still need a URL-shaped token that WAS at
// some point granted to a supplier, so we're not turning random
// bytes into a valid page.
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

  // v5 supplier-site redirect: once the standalone supplier site
  // is live, every planner-domain view URL becomes a 302 to the
  // supplier origin's root. This keeps any old bookmarks working
  // while making sure the supplier ends up on the isolated
  // domain -- the planner's origin has no login and we do NOT
  // want a supplier trimming the URL back to reach the app.
  // ?token= is passed through when present so a specific
  // published snapshot can still be reached by URL if needed.
  const supplierSiteUrl = process.env.FS_SUPPLIER_SITE_URL;
  if (typeof supplierSiteUrl === "string" && supplierSiteUrl.length > 0) {
    const raw = event && event.queryStringParameters && event.queryStringParameters.token;
    const base = supplierSiteUrl.replace(/\/+$/, "") + "/";
    const location = (typeof raw === "string" && raw.length > 0)
      ? `${base}?token=${encodeURIComponent(raw)}`
      : base;
    return {
      statusCode: 302,
      headers: { Location: location, "Cache-Control": "no-store" },
      body: "",
    };
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    return { statusCode: 500, body: "Server not configured" };
  }

  const urlToken = event && event.queryStringParameters && event.queryStringParameters.token;
  if (typeof urlToken !== "string" || !TOKEN_RE.test(urlToken)) return NOT_FOUND;

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Resolve the CURRENT token from __settings__ so we can decide
  // whether the URL token points at today's page or an orphaned
  // old row (see TOKEN-ALIAS SEMANTICS in the header).
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

  // Serve token = whichever one currently owns the live page.
  // For URL === current: obvious. For URL !== current but URL was
  // historically published: alias to current. For URL never
  // published: 404. When currentToken is null (no page has been
  // published at all), only exact-URL still works so a bookmark
  // to the very first snapshot before this migration lands is
  // not silently broken.
  let serveToken;
  if (currentToken && urlToken === currentToken) {
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
    if (!existsRow) return NOT_FOUND;   // token never seen -- someone typed junk
    // URL token WAS published sometime. Alias to current if we
    // have one; otherwise fall back to serving the URL token's
    // own row (may itself be an old snapshot -- best we can do
    // without a current pointer).
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
      // Static snapshot -- no reason for anyone to embed it or
      // pull scripts from it. Belt-and-suspenders.
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
    body: data.html,
  };
};
