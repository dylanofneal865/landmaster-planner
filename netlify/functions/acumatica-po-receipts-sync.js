// Netlify Scheduled Function — pulls PO receipts from the Acumatica
// OData generic inquiry "LM Planner - PO Receipt" and reconciles the
// Supabase `po_receipts` table.
//
// Schedule: once daily at 06:15 UTC (configured in netlify.toml). PO
// receipts are a slow-moving history feed — new rows land as receipts
// are entered in Acumatica; existing rows do not change.
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

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[acumatica-po-receipts-sync] ${msg}`, data || "");

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
    return { statusCode: 500, body: JSON.stringify({ error: "Missing env vars" }) };
  }

  const giEncoded = encodeURIComponent(ACUMATICA_PO_RECEIPTS_GI_NAME || "LM Planner - PO Receipt");
  const company = ACUMATICA_COMPANY || "LIVE";
  const baseUrl = `${ACUMATICA_BASE_URL}/OData/${company}/${giEncoded}`;
  log("Fetching (paginated)", baseUrl);

  // ── Paginated fetch ─────────────────────────────────────────────────
  // Acumatica OData caps a single response at ~1000 rows. Walk pages
  // via $top/$skip until a short page reports the feed is drained.
  // Pattern cloned from acumatica-production-orders-sync.js.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 30;
  let entries = [];
  let pageCount = 0;
  try {
    const auth = Buffer.from(`${ACUMATICA_USERNAME}:${ACUMATICA_PASSWORD}`).toString("base64");
    for (let page = 0, skip = 0; page < MAX_PAGES; page++, skip += PAGE_SIZE) {
      const pageUrl = `${baseUrl}?$top=${PAGE_SIZE}&$skip=${skip}`;
      const resp = await fetch(pageUrl, {
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: "application/atom+xml",
        },
      });
      if (!resp.ok) {
        const body = await resp.text();
        log("Acumatica returned non-OK status", { status: resp.status, page, skip, body: body.slice(0, 200) });
        return { statusCode: 502, body: JSON.stringify({ error: "Acumatica auth/fetch failed", status: resp.status, page }) };
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
  } catch (err) {
    log("Fetch threw", err.message);
    return { statusCode: 502, body: JSON.stringify({ error: "Acumatica fetch error", detail: err.message }) };
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
  // User-added GI columns arrive with a leading underscore; base-entity
  // columns don't. Try both spellings.
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
  // per project convention — every other sync applies its own predicate
  // here). Dedupe by composite id; first-wins matches bom-sync.
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
    if (status !== "Released") {
      rowsDroppedNotReleased++;
      continue;
    }

    const receiptNbr = sanitizeIdPart(resolved.receiptNbr);
    const lineNbr = sanitizeIdPart(resolved.lineNbr);
    const pn = String(resolved.inventoryId || "").trim();  // TRIM per spec
    if (!receiptNbr || !lineNbr || !pn) {
      rowsDroppedMissingKeys++;
      continue;
    }

    const receiptDate = toDateStr(resolved.date);
    if (!receiptDate) {
      rowsDroppedNoDate++;
      continue;
    }

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
      status,                                // always "Released" past the filter
      lineNbr,
      weekIso,
    };

    if (!feedById.has(id)) {
      feedById.set(id, { id, data });
    }
  }

  log(`Field mapping detected:`, detectedField);
  if (missingField.size > 0) {
    log(`WARNING: no candidate matched for ${missingField.size} logical field(s):`, [...missingField]);
  }
  log(`Status value counts (pre-filter):`, statusCounts);
  log(`Parsed ${feedById.size} released receipt lines (rawEntries: ${entries.length}, dropped: ${rowsDroppedNotReleased} not-released, ${rowsDroppedMissingKeys} missing-keys, ${rowsDroppedNoDate} no-date)`);

  // Zero-row bailout — a schema/auth glitch that returns zero rows must
  // not touch the table.
  if (feedById.size === 0) {
    log("No released receipts parsed from feed — possible schema change or empty GI; bailing without touching the table");
    return { statusCode: 200, body: JSON.stringify({ upserted: 0, unchanged: 0, pages: pageCount, note: "No rows parsed" }) };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Load existing rows for diff ───────────────────────────────────
  // HISTORY-PRESERVING: unlike bom-sync / production-orders, we do NOT
  // delete rows absent from the feed. The feed is a 180-day window;
  // older rows must persist so long-range receive-vs-scheduled math
  // stays valid. Only new/changed rows are upserted.
  const existing = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa.from("po_receipts").select("id, data").range(from, from + PAGE - 1);
    if (error) {
      log("po_receipts select error", error);
      return { statusCode: 500, body: JSON.stringify({ error: "po_receipts select failed", detail: error.message }) };
    }
    if (!data || data.length === 0) break;
    existing.push(...data);
    if (data.length < PAGE) break;
  }
  const existingById = new Map(existing.map((r) => [r.id, r.data || {}]));
  log(`Loaded ${existing.length} existing po_receipts rows`);

  // ── Diff ──────────────────────────────────────────────────────────
  // Upsert rows that are new OR whose canonical fingerprint changed.
  // NO delete step — see history-preserving note above.
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

  // ── Audit row ─────────────────────────────────────────────────────
  const auditId = `audit_acumatica_po_receipts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await supa.from("audit").upsert([
    {
      id: auditId,
      data: {
        id: auditId,
        ts: new Date().toISOString(),
        type: "acumatica-po-receipts-sync",
        msg:
          `Acumatica PO-receipts sync: ${totalUpserted} upserted (${unchanged} unchanged) ` +
          `across ${feedById.size} released lines in feed` +
          (upsertFailed > 0 ? ` — ${upsertFailed} ids failed after retry` : "") +
          (missingField.size > 0 ? ` — WARNING: ${missingField.size} field(s) unmapped: ${[...missingField].join(",")}` : ""),
        detail: {
          source: "netlify-scheduled-function",
          fetched: entries.length,
          pages: pageCount,
          rowsInFeed: feedById.size,
          rowsExisting: existing.length,
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

  log(
    `Done. ${totalUpserted} upserted, ${unchanged} unchanged across ${feedById.size} lines in ${Date.now() - t0}ms` +
      (upsertFailed > 0 ? ` (skipped ${upsertFailed} upsert ids)` : "") +
      (missingField.size > 0 ? ` — WARNING: unmapped fields: ${[...missingField].join(",")}` : "")
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      upserted: totalUpserted,
      unchanged,
      pages: pageCount,
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
};
