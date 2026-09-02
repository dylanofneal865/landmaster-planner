// Shared runner + HTTP handler for the PO-receipts sync.
//
// Two invocation modes:
//   - "full"        — no OData filter; walks the entire GI (180-day
//                     window Acumatica exposes). Daily 06:15 UTC via
//                     the thin wrapper acumatica-po-receipts-full.js.
//   - "incremental" — adds a `$filter=Date ge datetime'...'` clause
//                     (v7.4 -- Edm.DateTime literal, no timezone
//                     offset) with cutoff = today − 5 days. Every 30
//                     minutes via acumatica-po-receipts-incremental.js.
//                     Cheap: only the last few days of receipts come
//                     back on the wire, so pagination usually finishes
//                     in one page.
//
// v7.4 Filter literal cascade -- some tenants type the GI's Date
// column as Edm.DateTime (needs `datetime'...'`), others as
// Edm.DateTimeOffset (needs `datetimeoffset'...Z'`). The fetcher
// tries the datetime literal first, then datetimeoffset on non-OK,
// then falls back to a filter-less FULL sweep for that run so
// receipts still land even when both filter forms are rejected. The
// full URL of any failing request is logged so debugging doesn't
// need guesswork.
//
// runReceiptsSync(mode) is the exported entry point the wrappers call.
// exports.handler is still available for manual HTTP triggers — mode
// is read from ?mode=<full|incremental>, defaulting to "incremental".
//
// Reconciliation is history-preserving (no delete step) in every mode:
// the source GI is windowed to ~180 days and the incremental mode is
// windowed to ~5 days; older rows must survive on the client.
//
// ISOLATION CONTRACT — read-only reporting feature:
//   - Writes ONLY to public.po_receipts (and one row to public.audit
//     for the per-run summary — same pattern as every other sync).
//   - NEVER writes to: parts, pos, usage, bom_links, kit_boms, settings,
//     production_orders, follow_marks, deleted_parts, draft_order,
//     build_plan_targets, frame_schedule.
//   - HISTORY IS APPENDED, NEVER DELETED. The source GI is windowed to
//     the last ~180 days; older receipts drop out of the feed but must
//     survive in po_receipts so the received-vs-scheduled view on the
//     Frame Schedule tab can look back further than the feed window.
//     Reconciliation therefore upserts changed/new rows only — a row
//     absent from the feed is treated as "aged out", not "deleted".
//   - Client mirror DB.poReceipts is READ ONLY on the browser side.
//     No push helper, no dirty set, no realtime publication — poll-only.
//
// Required environment variables:
//   ACUMATICA_BASE_URL                  e.g. https://mdcarts.acumatica.com
//   ACUMATICA_COMPANY                   e.g. LIVE
//   ACUMATICA_PO_RECEIPTS_GI_NAME       default: "LM Planner - PO Receipt"
//   ACUMATICA_USERNAME                  Acumatica login username
//   ACUMATICA_PASSWORD                  Acumatica login password
//   SUPABASE_URL                        e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY                service-role key from Supabase API settings

const { createClient } = require("@supabase/supabase-js");

// Decode the five XML entities Acumatica emits in OData text fields
// (plus numeric char refs). Verbatim from acumatica-bom-sync.js.
// ORDER MATTERS: &amp; MUST be replaced LAST. See bom-sync for detail.
function decodeEntities(s) {
  if (typeof s !== "string") return s;
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, "&");   // MUST be last
}

// Extract <d:FieldName>value</d:FieldName> from an Acumatica OData Atom
// entry. Tolerates an optional attribute list (m:type, etc.) but not
// trailing numbered siblings like <d:CreatedBy_2>.
function makeFieldGetters(raw) {
  const get = (field) => {
    const re = new RegExp(`<d:${field}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/d:${field}>`, "i");
    const m = raw.match(re);
    return m ? decodeEntities(m[1].trim()) : null;
  };
  const isNull = (field) => {
    const re = new RegExp(`<d:${field}[^>]*m:null="true"`, "i");
    return re.test(raw);
  };
  return { get, isNull };
}

// Try each candidate field name in order; first non-empty hit wins.
function getFirstHit(getFn, candidates) {
  for (const f of candidates) {
    const v = getFn(f);
    if (v != null && String(v).trim() !== "") return { field: f, value: String(v).trim() };
  }
  return { field: null, value: "" };
}

// Normalize an Acumatica Edm.DateTime string to a plain YYYY-MM-DD.
// Only the DATE PART is used — never tz-shift. Acumatica emits dates
// as "2026-06-14T00:00:00" in the server's local calendar; parsing
// them into a Date object and reformatting via UTC getters can drift
// the day across a boundary. Regex-strip the date part directly.
function toDateStr(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

// Numeric coerce with default 0. Handles decimal strings ("12.0000")
// and null/empty gracefully.
function toNum(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// Compute the ISO Monday for a YYYY-MM-DD date using LOCAL calendar
// math — never through UTC getters, which drift by a day when the
// server timezone is west of UTC. new Date(y, m-1, d) is midnight in
// the LOCAL zone; setDate() operates on the LOCAL calendar day (DST
// safe). Returns YYYY-MM-DD of the Monday on or before the input.
function localMondayIso(ymd) {
  if (!ymd) return null;
  const m = String(ymd).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  const dt = new Date(y, mo, d);
  if (isNaN(dt.getTime())) return null;
  // JS getDay(): 0=Sunday..6=Saturday. Days back to Monday = (dow + 6) % 7.
  const back = (dt.getDay() + 6) % 7;
  dt.setDate(dt.getDate() - back);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// Sanitize a string for use as part of a composite row id. Match the
// bom-sync convention: strip the "::" separator so a field containing
// it can't collide with a different (ReceiptNbr, LineNbr) pair.
function sanitizeIdPart(s) {
  return String(s || "").replace(/::/g, "_").trim();
}

// Canonicalize for fingerprint diff — sort keys recursively so key-
// order noise doesn't count as a change. Mirrors _canonicalize in
// acumatica-production-orders-sync.js.
function _canonicalize(v) {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map(_canonicalize);
  if (typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = _canonicalize(v[k]);
    return out;
  }
  return v;
}
function _receiptFingerprint(data) {
  if (!data || typeof data !== "object") return "";
  return JSON.stringify(_canonicalize(data));
}

// v7.4 Compute the incremental $filter clause. OData v3 has two
// date-literal forms; which one Acumatica accepts depends on how
// the underlying column is typed in this tenant's GI:
//   * "datetime"       -> `datetime'YYYY-MM-DDTHH:MM:SS'`
//     (Edm.DateTime, no timezone offset, no Z). Preferred first
//     because most Acumatica GIs expose Date columns as
//     Edm.DateTime; comparing them against a datetimeoffset
//     literal returns a generic OData error.
//   * "datetimeoffset" -> `datetimeoffset'YYYY-MM-DDTHH:MM:SSZ'`
//     (Edm.DateTimeOffset). Kept as the fallback for tenants
//     that DO expose the column as offset-aware.
//
// The Date field name matches the GI's exposed "Date" column
// (candidate list also tries alt spellings; the filter always
// uses "Date" because that's the GI-facing column and the
// filter must reference the OData property name, not any
// decorated variant).
//
// Cutoff = midnight UTC N days ago. Deliberately generous by ~1
// day vs. the ticket's window so a receipt entered at any time
// on the boundary day is safely inside the filter (a strict
// `today−Nd 00:00 local` cutoff would drop entries stamped
// slightly before midnight due to server timezone drift).
function _computeIncrementalFilterClause(daysBack, literalForm) {
  const now = new Date();
  const cutoff = new Date(now.getTime() - daysBack * 86400000);
  cutoff.setUTCHours(0, 0, 0, 0);
  const isoWithZ = cutoff.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (literalForm === "datetimeoffset") {
    return `Date ge datetimeoffset'${isoWithZ}'`;
  }
  // Default -- datetime literal (Edm.DateTime), no offset, no Z.
  const isoNoTz = isoWithZ.replace(/Z$/, "");
  return `Date ge datetime'${isoNoTz}'`;
}

// Main runner — shared by both wrappers and the manual HTTP handler.
// mode: "full" | "incremental"
async function runReceiptsSync(mode) {
  const t0 = Date.now();
  const runMode = (mode === "full") ? "full" : "incremental";
  const log = (msg, data) => console.log(`[acumatica-po-receipts-sync:${runMode}] ${msg}`, data || "");

  const {
    ACUMATICA_BASE_URL,
    ACUMATICA_COMPANY,
    ACUMATICA_PO_RECEIPTS_GI_NAME,
    ACUMATICA_USERNAME,
    ACUMATICA_PASSWORD,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
  } = process.env;

  if (!ACUMATICA_BASE_URL || !ACUMATICA_USERNAME || !ACUMATICA_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing required environment variables");
    return { statusCode: 500, body: JSON.stringify({ mode: runMode, error: "Missing env vars" }) };
  }

  const giEncoded = encodeURIComponent(ACUMATICA_PO_RECEIPTS_GI_NAME || "LM Planner - PO Receipt");
  const company = ACUMATICA_COMPANY || "LIVE";
  const baseUrl = `${ACUMATICA_BASE_URL}/OData/${company}/${giEncoded}`;

  // v7.4 Incremental $filter form cascade.
  //   1. "datetime"       -- try first; most tenants type the GI
  //      Date column as Edm.DateTime.
  //   2. "datetimeoffset" -- retry once on non-OK, for tenants
  //      whose column is Edm.DateTimeOffset.
  //   3. "fallback-full"  -- both filter forms rejected; drop
  //      $filter entirely and walk the full 180-day GI window
  //      so receipts still land. Loud log naming the fallback
  //      so the operator sees the degraded run in the audit.
  // The successful probe request IS the first page -- no wasted
  // round trip. Full mode skips the cascade and walks unfiltered.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 30;
  const LOOKBACK_DAYS = 5;   // v7.4 bumped 4 -> 5 per operator ask
  let entries = [];
  let pageCount = 0;
  const auth = Buffer.from(`${ACUMATICA_USERNAME}:${ACUMATICA_PASSWORD}`).toString("base64");

  const attemptForms = runMode === "incremental"
    ? ["datetime", "datetimeoffset", "fallback-full"]
    : ["none"];

  let firstPageXml = null;
  let effectiveClause = "";
  let effectiveForm = "none";

  log("Fetching (paginated)", baseUrl);
  for (const form of attemptForms) {
    let clause = "";
    if (form === "datetime" || form === "datetimeoffset") {
      clause = _computeIncrementalFilterClause(LOOKBACK_DAYS, form);
    }
    const qs = [`$top=${PAGE_SIZE}`, `$skip=0`];
    if (clause) qs.push(`$filter=${encodeURIComponent(clause)}`);
    const pageUrl = `${baseUrl}?${qs.join("&")}`;
    try {
      const resp = await fetch(pageUrl, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/atom+xml",
        },
      });
      if (resp.ok) {
        firstPageXml = await resp.text();
        effectiveClause = clause;
        effectiveForm = form;
        if (form === "fallback-full" && runMode === "incremental") {
          log(`ALL INCREMENTAL FILTER FORMS FAILED -- FELL BACK to full 180-day sweep so receipts still land. Tenant/GI likely rejects both Edm.DateTime and Edm.DateTimeOffset literals against the Date column; investigate the GI schema.`);
        } else if (form === "datetime") {
          log(`incremental $filter form=datetime (Edm.DateTime): ${clause}`);
        } else if (form === "datetimeoffset") {
          log(`incremental $filter form=datetimeoffset (Edm.DateTimeOffset -- datetime literal was rejected): ${clause}`);
        } else if (form === "none") {
          log("full mode -- no $filter, walking the entire GI window");
        }
        break;
      }
      // Non-OK -- log the FULL URL + full-body slice so the next
      // debugging session doesn't need guesswork about what URL
      // we hit.
      const body = await resp.text();
      log(`Filter attempt FAILED (form=${form}, status=${resp.status})`, {
        url: pageUrl,
        body: body.slice(0, 800),
      });
    } catch (err) {
      log(`Filter attempt THREW (form=${form}): ${err.message}`);
    }
  }

  if (!firstPageXml) {
    log("Every fetch attempt failed (including the filter-less fallback). Bailing.");
    return {
      statusCode: 502,
      body: JSON.stringify({ mode: runMode, error: "Acumatica fetch failed for every filter form + fallback" }),
    };
  }

  // ── Paginated fetch (continuation) ─────────────────────────────
  // First page came in via the probe cascade above. Continue with
  // the effective filter clause (empty in fallback-full mode).
  // Acumatica OData caps a single response at ~1000 rows; walk
  // pages via $top/$skip until a short page reports drained.
  try {
    const firstPageEntries = firstPageXml.split(/<entry[^>]*>/i).slice(1);
    pageCount = 1;
    log(`page 1 (skip=0, form=${effectiveForm}) returned ${firstPageEntries.length} entries`);
    entries.push(...firstPageEntries);
    if (firstPageEntries.length >= PAGE_SIZE) {
      for (let page = 1, skip = PAGE_SIZE; page < MAX_PAGES; page++, skip += PAGE_SIZE) {
        const qs = [`$top=${PAGE_SIZE}`, `$skip=${skip}`];
        if (effectiveClause) qs.push(`$filter=${encodeURIComponent(effectiveClause)}`);
        const pageUrl = `${baseUrl}?${qs.join("&")}`;
        const resp = await fetch(pageUrl, {
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/atom+xml",
          },
        });
        if (!resp.ok) {
          const body = await resp.text();
          log(`Non-OK on continuation page (form=${effectiveForm}, page=${page}, status=${resp.status})`, {
            url: pageUrl,
            body: body.slice(0, 800),
          });
          return {
            statusCode: 502,
            body: JSON.stringify({ mode: runMode, error: "Acumatica auth/fetch failed", status: resp.status, page }),
          };
        }
        const pageXml = await resp.text();
        const pageEntries = pageXml.split(/<entry[^>]*>/i).slice(1);
        pageCount++;
        log(`page ${pageCount} (skip=${skip}) returned ${pageEntries.length} entries`);
        entries.push(...pageEntries);
        if (pageEntries.length < PAGE_SIZE) break;
      }
      if (pageCount === MAX_PAGES && entries.length && entries.length % PAGE_SIZE === 0) {
        log(`WARNING: hit MAX_PAGES=${MAX_PAGES} without a short page — the feed may have more rows. Raise MAX_PAGES.`);
      }
    }
  } catch (err) {
    log("Fetch threw", err.message);
    return { statusCode: 502, body: JSON.stringify({ mode: runMode, error: "Acumatica fetch error", detail: err.message }) };
  }

  log(`Fetched ${entries.length} <entry> element(s) across ${pageCount} page(s)`);

  // Discovery aid: dump the first entry's <d:...> tag names once, so a
  // manual run reveals the actual column names if a candidate misses.
  if (entries.length > 0) {
    const tagNames = Array.from(new Set(
      (entries[0].match(/<d:([A-Za-z0-9_]+)[\s>]/g) || []).map(s => s.replace(/^<d:/, "").replace(/[\s>]$/, ""))
    ));
    log(`Sample entry[0] tag names (${tagNames.length}):`, tagNames.slice(0, 80).join(", "));
  }

  // ── Candidate lists per logical field ──────────────────────────────
  const FIELD_CANDIDATES = {
    receiptNbr:  ["ReceiptNbr", "_ReceiptNbr"],
    date:        ["Date", "ReceiptDate", "_Date", "_ReceiptDate"],
    orderType:   ["OrderType", "_OrderType"],
    status:      ["Status", "_Status"],
    vendor:      ["Vendor", "VendorID", "_Vendor"],
    poNum:       ["POOrderNbr", "POOrder", "POOrderNumber", "OrderNbr", "_POOrderNbr"],
    inventoryId: ["InventoryID", "_InventoryID"],
    receiptQty:  ["ReceiptQty", "_ReceiptQty"],
    lineNbr:     ["LineNbr", "_LineNbr"],
  };
  const detectedField = {};
  const missingField = new Set(Object.keys(FIELD_CANDIDATES));

  // ── Parse each entry into a normalized receipt row ─────────────────
  // Filter IN CODE: Status === "Released" (GI conditions are unreliable
  // per project convention). Dedupe by composite id; first-wins.
  const feedById = new Map();
  let rowsDroppedNotReleased = 0;
  let rowsDroppedMissingKeys = 0;
  let rowsDroppedNoDate = 0;
  const statusCounts = Object.create(null);
  for (const raw of entries) {
    const { get } = makeFieldGetters(raw);
    const resolved = {};
    for (const [logical, candidates] of Object.entries(FIELD_CANDIDATES)) {
      const { field, value } = getFirstHit(get, candidates);
      resolved[logical] = value;
      if (field) {
        if (!detectedField[logical]) detectedField[logical] = field;
        missingField.delete(logical);
      }
    }

    const status = (resolved.status || "").trim();
    statusCounts[status || "<empty>"] = (statusCounts[status || "<empty>"] || 0) + 1;
    if (status !== "Released") { rowsDroppedNotReleased++; continue; }

    const receiptNbr = sanitizeIdPart(resolved.receiptNbr);
    const lineNbr = sanitizeIdPart(resolved.lineNbr);
    const pn = String(resolved.inventoryId || "").trim();
    if (!receiptNbr || !lineNbr || !pn) { rowsDroppedMissingKeys++; continue; }

    const receiptDate = toDateStr(resolved.date);
    if (!receiptDate) { rowsDroppedNoDate++; continue; }

    const weekIso = localMondayIso(receiptDate);
    const qty = toNum(resolved.receiptQty);

    const id = `${receiptNbr}::${lineNbr}`;
    const data = {
      receiptNbr,
      receiptDate,
      poNum: (resolved.poNum || "").trim() || null,
      pn,
      qty,
      vendor: (resolved.vendor || "").trim() || null,
      status,
      lineNbr,
      weekIso,
    };
    if (!feedById.has(id)) feedById.set(id, { id, data });
  }

  log(`Field mapping detected:`, detectedField);
  if (missingField.size > 0) {
    log(`WARNING: no candidate matched for ${missingField.size} logical field(s):`, [...missingField]);
  }
  log(`Status value counts (pre-filter):`, statusCounts);
  log(`Parsed ${feedById.size} released receipt lines (rawEntries: ${entries.length}, dropped: ${rowsDroppedNotReleased} not-released, ${rowsDroppedMissingKeys} missing-keys, ${rowsDroppedNoDate} no-date)`);

  // Zero-row bailout. For incremental mode a zero-row feed is normal
  // — nothing happened in the last 5 days. For full mode it usually
  // means an auth/schema glitch and we bail without touching the
  // table (matches every other sync's zero-row guard).
  if (feedById.size === 0) {
    if (runMode === "full") {
      log("No released receipts parsed from feed — possible schema change or empty GI; bailing without touching the table");
    } else {
      log("No released receipts in the last 5 days — nothing to reconcile (quiet, no audit row).");
    }
    return {
      statusCode: 200,
      body: JSON.stringify({ mode: runMode, upserted: 0, unchanged: 0, pages: pageCount, note: "No rows parsed" }),
    };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── SCOPED existing-row lookup ────────────────────────────────────
  // Full-table scans on po_receipts get expensive fast (archive
  // grows without bound). Load only the rows the feed's own ids
  // touch: `.in("id", chunk)` in chunks of 500 to stay under
  // PostgREST's URL length ceiling. Every incremental run's diff
  // now costs a handful of KB regardless of how big po_receipts is.
  const feedIds = [...feedById.keys()];
  const existingById = new Map();
  const LOOKUP_CHUNK = 500;
  for (let i = 0; i < feedIds.length; i += LOOKUP_CHUNK) {
    const chunk = feedIds.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await supa.from("po_receipts").select("id, data").in("id", chunk);
    if (error) {
      log("po_receipts scoped select error", error);
      return {
        statusCode: 500,
        body: JSON.stringify({ mode: runMode, error: "po_receipts select failed", detail: error.message }),
      };
    }
    for (const r of (data || [])) existingById.set(r.id, r.data || {});
  }
  log(`Scoped-lookup loaded ${existingById.size} existing rows against ${feedIds.length} feed ids`);

  // ── Diff (changed-only upsert). History preserved. ────────────────
  const rowsToUpsert = [];
  let unchanged = 0;
  for (const [id, row] of feedById.entries()) {
    const prev = existingById.get(id);
    if (prev && _receiptFingerprint(row.data) === _receiptFingerprint(prev)) {
      unchanged++;
      continue;
    }
    rowsToUpsert.push({ id, data: row.data });
  }
  log(`Will upsert ${rowsToUpsert.length} (${unchanged} unchanged); history preserved (no delete step)`);

  // ── Batched upsert (500 rows/req) — retry once then skip ──────────
  const UPSERT_BATCH = 500;
  let totalUpserted = 0;
  const failedUpsertIds = [];
  for (let i = 0; i < rowsToUpsert.length; i += UPSERT_BATCH) {
    const batch = rowsToUpsert.slice(i, i + UPSERT_BATCH);
    let { error } = await supa.from("po_receipts").upsert(batch);
    if (error) {
      log(`upsert chunk ${i}-${i + batch.length - 1} failed, retrying once`, error.message);
      ({ error } = await supa.from("po_receipts").upsert(batch));
    }
    if (error) {
      log(`upsert chunk ${i}-${i + batch.length - 1} failed after retry — skipping`, {
        detail: error.message,
        count: batch.length,
        ids: batch.map((r) => r.id),
      });
      failedUpsertIds.push(...batch.map((r) => r.id));
      continue;
    }
    totalUpserted += batch.length;
  }

  const upsertFailed = failedUpsertIds.length;

  // ── Audit row (conditional) ───────────────────────────────────────
  // Only emit audit when we actually changed data OR the run was a
  // full sweep. Prevents the 48×/day incremental cadence from
  // spamming the audit table with "0 upserted" no-ops. A full sweep
  // gets an audit row even at 0 upserted so ops can confirm the
  // daily reconcile ran.
  if (totalUpserted > 0 || runMode === "full") {
    const auditId = `audit_acumatica_po_receipts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await supa.from("audit").upsert([
      {
        id: auditId,
        data: {
          id: auditId,
          ts: new Date().toISOString(),
          type: "acumatica-po-receipts-sync",
          msg:
            `Acumatica PO-receipts sync (${runMode}): ${totalUpserted} upserted (${unchanged} unchanged) ` +
            `across ${feedById.size} released lines in feed` +
            (upsertFailed > 0 ? ` — ${upsertFailed} ids failed after retry` : "") +
            (missingField.size > 0 ? ` — WARNING: ${missingField.size} field(s) unmapped: ${[...missingField].join(",")}` : ""),
          detail: {
            source: "netlify-scheduled-function",
            mode: runMode,
            filter: effectiveClause || null,
            filterForm: effectiveForm,
            fetched: entries.length,
            pages: pageCount,
            rowsInFeed: feedById.size,
            rowsExistingLookedUp: existingById.size,
            upserted: totalUpserted,
            unchanged,
            upsertFailed,
            droppedNotReleased: rowsDroppedNotReleased,
            droppedMissingKeys: rowsDroppedMissingKeys,
            droppedNoDate: rowsDroppedNoDate,
            statusCounts,
            detectedFieldMapping: detectedField,
            unmappedFields: [...missingField],
            durationMs: Date.now() - t0,
          },
        },
      },
    ]);
  }

  // ── Broadcast hook ───────────────────────────────────────────────
  // The codebase has a landmaster-broadcast channel and a
  // sendBroadcast pattern (see acumatica-kit-sync.js), BUT the
  // client-side broadcast fetcher registry in js/30-supabase.js
  // (_BROADCAST_FETCHERS) does NOT include po_receipts — an
  // emitted ping for this table would be logged and skipped by
  // clients. Rather than wire in a fetcher on the client side
  // (out of scope for this ticket), we skip the broadcast here.
  // A polled refresh comes on the next cloudInit / reconnect.
  //
  // If po_receipts is later registered as a broadcast fetcher,
  // the hook here becomes: sendBroadcast({ tables: ["po_receipts"] })
  // whenever totalUpserted > 0.

  log(
    `Done (${runMode}). ${totalUpserted} upserted, ${unchanged} unchanged across ${feedById.size} lines in ${Date.now() - t0}ms` +
      (upsertFailed > 0 ? ` (skipped ${upsertFailed} upsert ids)` : "") +
      (missingField.size > 0 ? ` — WARNING: unmapped fields: ${[...missingField].join(",")}` : "")
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      mode: runMode,
      pages: pageCount,
      upserted: totalUpserted,
      unchanged,
      durationMs: Date.now() - t0,
      rowsInFeed: feedById.size,
      upsertFailed,
      droppedNotReleased: rowsDroppedNotReleased,
      droppedMissingKeys: rowsDroppedMissingKeys,
      droppedNoDate: rowsDroppedNoDate,
      detectedFieldMapping: detectedField,
      unmappedFields: [...missingField],
    }),
  };
}

exports.runReceiptsSync = runReceiptsSync;

// Manual HTTP trigger — mode from ?mode=full|incremental (default
// incremental, matching the higher-frequency schedule).
exports.handler = async (event) => {
  const qs = (event && event.queryStringParameters) || {};
  const mode = String(qs.mode || "").toLowerCase() === "full" ? "full" : "incremental";
  return runReceiptsSync(mode);
};
