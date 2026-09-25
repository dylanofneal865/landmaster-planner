// SYNC HEARTBEAT -- one row per scheduled function in sync_heartbeats,
// upserted on SUCCESSFUL completion only.
//
// WHY. The Settings page derived "Last sync" from DB.audit, the browser's
// mirror of a 31,000-row table it pages unordered 1,000 at a time. That
// label could not tell a dead sync from a healthy one: the audit rows
// were being written fine, the browser just never saw the new ones. A
// heartbeat is a single row per sync that the page can fetch in one
// tiny query, and its age against the sync's cadence is an honest
// dead-sync alarm.
//
// CONTRACT.
//   * Called at real completions only -- never on early bail-outs
//     (no rows parsed, disabled, weekend, dry run). Those are not
//     "the sync worked"; letting them beat would hide a dead feed.
//   * The upsert error is CHECKED and logged loudly. Every audit upsert
//     in this codebase discarded { error } for months; this one does
//     not, and it never throws -- a heartbeat failure must not fail the
//     sync it reports on.
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

async function beat(supa, name, note, log) {
  const say = typeof log === "function" ? log : (...a) => console.log(...a);
  if (!supa || !name) {
    say(`[heartbeat] ${name || "?"}: not sent (no client or name)`);
    return false;
  }
  try {
    const { error } = await supa
      .from("sync_heartbeats")
      .upsert({ name, last_ok: new Date().toISOString(), note: note == null ? null : String(note).slice(0, 500) }, { onConflict: "name" });
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

module.exports = { beat };
