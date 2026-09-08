// Frame Schedule -- nightly snapshot.
//
// Cron 05:45 UTC daily. Copies every row of public.frame_schedule
// (including the __settings__ sentinel) into
// public.frame_schedule_snapshots with a snapshot_date column so a
// clobber like the Sep 5-7 stale-tab incident is a one-query
// restore instead of a hand-typed rebuild. Retains 60 days;
// anything older is deleted the same tick.
//
// ENV:
//   SUPABASE_URL          e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY  service-role key from Supabase API settings
//
// TABLE SETUP (run in Supabase SQL editor, service-role only, RLS
// deny anon):
//
//   create table if not exists public.frame_schedule_snapshots (
//     snapshot_date date        not null,
//     fg_sku        text        not null,
//     weekly_qty    integer     not null default 0,
//     data          jsonb       not null default '{}'::jsonb,
//     src_updated_at timestamptz,
//     inserted_at   timestamptz not null default now(),
//     primary key (snapshot_date, fg_sku)
//   );
//   create index if not exists frame_schedule_snapshots_date_idx
//     on public.frame_schedule_snapshots (snapshot_date desc);
//   create index if not exists frame_schedule_snapshots_sku_idx
//     on public.frame_schedule_snapshots (fg_sku);
//   alter table public.frame_schedule_snapshots enable row level security;
//   -- No anon policies. Service key is the only writer/reader.
//
// RESTORE (from a snapshot):
//
//   -- inspect what a given day held:
//   select fg_sku, data->'slot' as slot, data->'qty' as qty
//     from public.frame_schedule_snapshots
//     where snapshot_date = '2026-09-05'
//     order by fg_sku;
//
//   -- one-week restore into frame_schedule:
//   update public.frame_schedule fs
//      set data = s.data, updated_at = now()
//     from public.frame_schedule_snapshots s
//    where s.snapshot_date = '2026-09-05'
//      and s.fg_sku = fs.fg_sku
//      and fs.fg_sku = '2026-09-07';
//
// ISOLATION:
//   * Writes ONLY to public.frame_schedule_snapshots.
//   * Reads public.frame_schedule (source of truth). Never
//     writes there.
//   * Never touches parts, pos, or any other table.

const { createClient } = require("@supabase/supabase-js");

const RETENTION_DAYS = 60;

exports.handler = async () => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[frame-schedule-snapshot] ${msg}`, data || "");

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY");
    return { statusCode: 500, body: JSON.stringify({ error: "Missing env vars" }) };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Cron 05:45 UTC daily -- use TODAY's UTC date so multiple runs
  // in the same UTC day upsert the same snapshot_date (idempotent).
  const now = new Date();
  const snapshotDate = now.toISOString().slice(0, 10);   // YYYY-MM-DD
  log(`snapshotting frame_schedule for date=${snapshotDate}`);

  // Read every row of frame_schedule -- including __settings__.
  // Table is small (fewer than a few hundred rows); one shot fine.
  const { data: rows, error: readErr } = await supa
    .from("frame_schedule")
    .select("fg_sku, weekly_qty, data, updated_at");
  if (readErr) {
    log("frame_schedule read failed", { code: readErr.code, message: readErr.message });
    return { statusCode: 500, body: JSON.stringify({ error: "read failed", detail: readErr.message }) };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    log("frame_schedule is empty -- nothing to snapshot; skipping write");
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, snapshotDate, rowsWritten: 0, note: "empty source table" }),
    };
  }
  log(`read ${rows.length} rows from frame_schedule`);

  // Build snapshot rows. Composite PK (snapshot_date, fg_sku) so
  // a retried cron run in the same UTC day upserts cleanly.
  const snapshotRows = rows.map(r => ({
    snapshot_date:   snapshotDate,
    fg_sku:          r.fg_sku,
    weekly_qty:      Number.isFinite(r.weekly_qty) ? r.weekly_qty : 0,
    data:            r.data || {},
    src_updated_at:  r.updated_at || null,
    // inserted_at defaults to now() server-side; don't send it.
  }));

  // Upsert in chunks of 500 to stay under any single-request size
  // ceiling. Small table so this is one page in practice.
  const CHUNK = 500;
  let written = 0;
  for (let i = 0; i < snapshotRows.length; i += CHUNK) {
    const chunk = snapshotRows.slice(i, i + CHUNK);
    const { error: writeErr } = await supa
      .from("frame_schedule_snapshots")
      .upsert(chunk, { onConflict: "snapshot_date,fg_sku" });
    if (writeErr) {
      log("frame_schedule_snapshots upsert failed", { code: writeErr.code, message: writeErr.message, chunkStart: i, chunkSize: chunk.length });
      return { statusCode: 500, body: JSON.stringify({ error: "snapshot write failed", detail: writeErr.message }) };
    }
    written += chunk.length;
  }
  log(`wrote ${written} snapshot rows for ${snapshotDate}`);

  // Retention trim: delete rows older than RETENTION_DAYS. Runs
  // regardless of whether today's write happened first
  // (idempotent -- a rerun deletes nothing new).
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 86400000)
    .toISOString().slice(0, 10);
  const { error: trimErr, count: trimmed } = await supa
    .from("frame_schedule_snapshots")
    .delete({ count: "estimated" })
    .lt("snapshot_date", cutoff);
  if (trimErr) {
    // Don't fail the run -- the snapshot landed. Log loudly and
    // move on; next run will retry the trim.
    log(`retention trim FAILED (snapshot succeeded, trim will retry tomorrow)`, {
      code: trimErr.code,
      message: trimErr.message,
      cutoff,
    });
  } else {
    log(`retention trim: deleted ${trimmed === null ? "?" : trimmed} rows older than ${cutoff}`);
  }

  const durMs = Date.now() - t0;
  log(`done in ${durMs}ms (snapshot_date=${snapshotDate}, rowsWritten=${written})`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      snapshotDate,
      rowsWritten: written,
      retentionCutoff: cutoff,
      trimmed: trimmed === null || trimErr ? null : trimmed,
      durationMs: durMs,
    }),
  };
};
