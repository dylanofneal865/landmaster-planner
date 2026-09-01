// Frame Schedule -- supplier snapshot PUBLISH.
//
// POST { token: <string>, html: <string> } -> upserts one row into
// public.frame_schedule_published keyed by token, with the rendered
// supplier-view HTML (schedule grid ONLY -- frames, weeks, qtys).
// Returns { ok: true, url: "/.netlify/functions/frame-schedule-view?token=<token>" }
// -- a RELATIVE path; the client prepends window.location.origin so
// the same function works across production / deploy-preview URLs
// without the server having to know its own hostname.
//
// Auth model: the TOKEN itself is the credential -- a "fs-<uuid>"
// string minted client-side via crypto.randomUUID on first publish
// and stored in the __settings__ row of frame_schedule so republish
// reuses the same URL. Row-level security on frame_schedule_published
// denies anon; only this function and the view function read/write
// it via the service key. The browser can NEVER reach the table
// directly.
//
// Env + Supabase client mirror acumatica-po-receipts-sync.js exactly
// (same require, same createClient options).
//
// Required env:
//   SUPABASE_URL          e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY  service-role key from Supabase API settings

const { createClient } = require("@supabase/supabase-js");

// Loose token gate -- 24..128 chars of URL-safe punctuation-free
// characters. Wide enough to accept the client's "fs-<uuid>"
// mint shape (39 chars) plus any future format tweaks. The token
// carries the entropy; length + charset just keep the URL clean.
// MUST stay identical to the client (_FS_TOKEN_RE in
// js/25-page-frame-schedule.js) and the view function.
const TOKEN_RE = /^[A-Za-z0-9._-]{24,128}$/;

// Build the CORS headers for one request. Same-origin calls don't
// strictly need CORS but the browser preflight fires on POSTs with
// content-type: application/json, so we echo the Origin header and
// list the methods + headers we accept.
function corsHeaders(event) {
  const origin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[frame-schedule-publish] ${msg}`, data || "");
  const cors = corsHeaders(event);

  // Preflight -- no body, just headers.
  if (event && event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (!event || event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ error: "POST required" }),
    };
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    return {
      statusCode: 500,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ error: "Missing env vars" }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return {
      statusCode: 400,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const token = payload && payload.token;
  const html  = payload && payload.html;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    return {
      statusCode: 400,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ error: "Invalid token" }),
    };
  }
  if (typeof html !== "string" || html.length === 0) {
    return {
      statusCode: 400,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ error: "Missing html body" }),
    };
  }
  // Belt-and-suspenders 3 MB cap. v5.1 the supplier snapshot
  // now embeds the full Frame Schedule tab (including an
  // inlined copy of css/styles.css), so the payload is larger
  // than the old grid-only page but still comfortably under a
  // few MB. Anything past 3 MB is a client bug.
  if (html.length > 3000000) {
    return {
      statusCode: 413,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ error: "html too large (>3MB)" }),
    };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const nowIso = new Date().toISOString();
  const { error } = await supa
    .from("frame_schedule_published")
    .upsert({ token, html, updated_at: nowIso }, { onConflict: "token" });

  if (error) {
    log("upsert failed", { code: error.code, message: error.message });
    return {
      statusCode: 500,
      headers: { ...cors, "content-type": "application/json" },
      body: JSON.stringify({ error: "publish failed", detail: error.message }),
    };
  }

  const url = `/.netlify/functions/frame-schedule-view?token=${token}`;
  log(`published ${html.length} bytes for token ...${token.slice(-6)} in ${Date.now() - t0}ms`);

  return {
    statusCode: 200,
    headers: { ...cors, "content-type": "application/json" },
    body: JSON.stringify({ ok: true, url, updated_at: nowIso, bytes: html.length }),
  };
};
