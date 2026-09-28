// SYNC HEARTBEAT -- one row per scheduled function in sync_heartbeats.
//   beat()  upserted on SUCCESSFUL completion only (last_ok + note).
//   fail()  on ANY failed run: note = "ERROR <ts>: <reason>" and NOTHING
//           else -- last_ok is never touched, so the card still reads
//           the true last success and turns stale on schedule, but the
//           reason for the stall is on the page instead of in a log
//           nobody opens. The next beat() overwrites the note.
//   guard() wraps a handler so a thrown exception or a 5xx return
//           lands in fail() before it is reported -- the one place a
//           silent death becomes a visible sentence.
//
// WHY. The Settings page derived "Last sync" from DB.audit, the browser's
// mirror of a 31,000-row table it pages unordered 1,000 at a time. That
// label could not tell a dead sync from a healthy one: the audit rows
// were being written fine, the browser just never saw the new ones. A
// heartbeat is a single row per sync that the page can fetch in one
// tiny query, and its age against the sync's cadence is an honest
// dead-sync alarm. The Sep 28 PO-sync stall (invocation killed mid-run
// for hours with no audit, no beat, no error anywhere the page could
// see) is why failures now write their reason too.
//
// CONTRACT.
//   * beat() is called at real completions only -- never on early
//     bail-outs (no rows parsed, disabled, weekend, dry run). Those are
//     not "the sync worked"; letting them beat would hide a dead feed.
//   * fail() never inserts a fresh last_ok. If the row does not exist
//     yet it is created BACKDATED (epoch) so the card reads stale + the
//     reason, never a fake OK.
//   * Every upsert/update error is CHECKED and logged loudly, and none
//     of these ever throw -- a heartbeat failure must not fail the sync
//     it reports on.
//   * Returns true on success, false on failure, so a caller that wants
//     to surface it in its response can.
//
// SQL (run once in the Supabase SQL editor):
//   create table if not exists public.sync_heartbeats (
//     name    text primary key,
//     last_ok timestamptz not null default now(),
//     note    text
//   );
//   alter table public.sync_heartbeats enable row level security;
//   drop policy if exists sync_heartbeats_anon_select on public.sync_heartbeats;
//   create policy sync_heartbeats_anon_select on public.sync_heartbeats
//     for select to anon using (true);
//   -- service role bypasses RLS; no write policy needed for the functions.

const NOTE_MAX = 500;
const BACKDATED = "1970-01-01T00:00:00.000Z";

function _say(log) {
  return typeof log === "function" ? log : (...a) => console.log(...a);
}

async function beat(supa, name, note, log) {
  const say = _say(log);
  if (!supa || !name) {
    say(`[heartbeat] ${name || "?"}: not sent (no client or name)`);
    return false;
  }
  try {
    const { error } = await supa
      .from("sync_heartbeats")
      .upsert({ name, last_ok: new Date().toISOString(), note: note == null ? null : String(note).slice(0, NOTE_MAX) }, { onConflict: "name" });
    if (error) {
      say(`[heartbeat] ${name}: UPSERT FAILED — ${error.message}${error.code ? " (" + error.code + ")" : ""}. The Settings card will read this sync as stale until this is fixed.`);
      return false;
    }
    return true;
  } catch (err) {
    say(`[heartbeat] ${name}: threw — ${(err && err.message) || err}`);
    return false;
  }
}

// Format the note exactly as the Settings card parses it.
function failNote(reason, when) {
  const ts = (when instanceof Date ? when : new Date()).toISOString();
  const r = String(reason == null ? "unknown" : reason).replace(/\s+/g, " ").trim();
  return `ERROR ${ts}: ${r}`.slice(0, NOTE_MAX);
}

async function fail(supa, name, reason, log) {
  const say = _say(log);
  if (!supa || !name) {
    say(`[heartbeat] ${name || "?"}: failure note not sent (no client or name) — ${reason}`);
    return false;
  }
  const note = failNote(reason);
  try {
    // UPDATE, never upsert: last_ok must not move on a failure.
    const { data, error } = await supa
      .from("sync_heartbeats")
      .update({ note })
      .eq("name", name)
      .select("name");
    if (error) {
      say(`[heartbeat] ${name}: failure-note UPDATE FAILED — ${error.message}${error.code ? " (" + error.code + ")" : ""}. Reason was: ${note}`);
      return false;
    }
    if (Array.isArray(data) && data.length > 0) {
      say(`[heartbeat] ${name}: ${note}`);
      return true;
    }
    // No row yet (table seeded without this name): create it BACKDATED
    // so the card shows stale + reason, never a fresh last_ok.
    const { error: insErr } = await supa
      .from("sync_heartbeats")
      .insert({ name, last_ok: BACKDATED, note });
    if (insErr) {
      say(`[heartbeat] ${name}: failure-note INSERT FAILED — ${insErr.message}${insErr.code ? " (" + insErr.code + ")" : ""}. Reason was: ${note}`);
      return false;
    }
    say(`[heartbeat] ${name}: ${note} (row created, backdated)`);
    return true;
  } catch (err) {
    say(`[heartbeat] ${name}: failure-note threw — ${(err && err.message) || err}. Reason was: ${note}`);
    return false;
  }
}

// Service-role client from the function's env, or null. Kept here so
// guard() can write a note for handlers that died before building
// their own client.
function clientFromEnv() {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const { createClient } = require("@supabase/supabase-js");
    return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  } catch (_) {
    return null;
  }
}

// Milliseconds this invocation may still run. Netlify hands the Lambda
// context through as the handler's second argument; when it is there,
// its clock is the platform's own. Otherwise fall back to a wall-clock
// budget from `t0` (default 100 s -- every completed acumatica-sync run
// on record finished inside 108 s, so the platform allows at least that).
function remainingMs(context, t0, budgetMs) {
  if (context && typeof context.getRemainingTimeInMillis === "function") {
    const n = Number(context.getRemainingTimeInMillis());
    if (Number.isFinite(n)) return n;
  }
  const budget = Number.isFinite(budgetMs) ? budgetMs : 100000;
  const start = Number.isFinite(t0) ? t0 : Date.now();
  return budget - (Date.now() - start);
}

// Wrap a scheduled handler: a thrown exception or a >= 500 response
// writes the failure note under `name` before the result is returned /
// rethrown. `getClient` (optional) supplies the Supabase client; default
// builds one from env. Never swallows the error.
function guard(name, handler, getClient) {
  return async function guarded(event, context) {
    let res;
    try {
      res = await handler(event, context);
    } catch (err) {
      const supa = (typeof getClient === "function" ? getClient() : null) || clientFromEnv();
      await fail(supa, name, `threw: ${(err && err.message) || String(err)}`);
      throw err;
    }
    const code = res && Number(res.statusCode);
    if (Number.isFinite(code) && code >= 500) {
      let why = "";
      try {
        const b = typeof res.body === "string" ? JSON.parse(res.body) : res.body;
        why = (b && (b.detail || b.error)) ? `${b.error || ""}${b.detail ? " — " + b.detail : ""}${b.status ? " (status " + b.status + ")" : ""}` : String(res.body || "").slice(0, 200);
      } catch (_) {
        why = String(res.body || "").slice(0, 200);
      }
      const supa = (typeof getClient === "function" ? getClient() : null) || clientFromEnv();
      await fail(supa, name, `HTTP ${code}: ${why}`);
    }
    return res;
  };
}

module.exports = { beat, fail, failNote, guard, remainingMs, clientFromEnv, NOTE_MAX, BACKDATED };
