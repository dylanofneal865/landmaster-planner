// Netlify Scheduled Function — pulls production-order rows from the
// Acumatica OData generic inquiry "LM Planner Production Orders" and
// reconciles the Supabase `production_orders` table.
//
// Schedule: weekly, Monday 11:00 UTC (~ 6 AM EST / 7 AM EDT). Production
// orders are slow-moving reference data for a read-only reporting tab —
// they don't need the 2-minute on-hand cadence.
//
// ISOLATION CONTRACT — read-only reporting feature:
//   - Writes ONLY to public.production_orders (and one row to public.audit
//     for the per-run summary — same pattern as every other sync).
//   - NEVER writes to: parts, pos, usage, bom_links, kit_boms, settings,
//     follow_marks, deleted_parts, draft_order.
//   - The client mirror DB.productionOrders is READ ONLY on the browser
//     side. No push helper, no _dirtyProductionOrders set, no realtime
//     publication. The daily downstream weekly-BOM-demand view is the
//     only consumer.
//
// Required environment variables:
//   ACUMATICA_BASE_URL                     e.g. https://mdcarts.acumatica.com
//   ACUMATICA_COMPANY                      e.g. LIVE
//   ACUMATICA_PRODUCTION_ORDERS_GI_NAME    e.g. LM Planner Production Orders
//                                          (default: "LM Planner Production Orders")
//   ACUMATICA_USERNAME                     Acumatica login username
//   ACUMATICA_PASSWORD                     Acumatica login password
//   SUPABASE_URL                           e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY                   service-role key from Supabase API settings
//
// Field-name resolution: user-added GI columns arrive in the OData XML
// with a leading underscore (confirmed elsewhere in this codebase for
// `_BlanketExpires`, `_BlanketPONbr`). This function tries a candidate
// list per logical field — both prefixed and non-prefixed spellings —
// and dumps the raw tag names of the first entry on every run so a
// mis-guessed candidate can be corrected in one follow-up pass. Any
// logical field where NO candidate matched is logged loudly (WARNING),
// so a silent null doesn't slip through as a missing date or zero qty.

const { createClient } = require("@supabase/supabase-js");

// Decode the five XML entities Acumatica emits in OData text fields
// (plus numeric char refs). Verbatim from acumatica-bom-sync.js — kept
// inline so this function stays self-contained for esbuild bundling.
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
// entry. The regex tolerates an optional attribute list (m:type, etc.)
// but NOT trailing numbered siblings like <d:CreatedBy_2>. Matches on
// literal field name — so calling get("_ReleasedDate") pulls only the
// underscore-prefixed variant, not the bare form.
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

// Normalize an Acumatica Edm.DateTime string ("2026-06-14T00:00:00" etc.)
// to a plain YYYY-MM-DD. Returns null for null/empty/unparseable input.
// Time-of-day is discarded: production-order dates are calendar-anchored
// and any time component drifts across DST boundaries would create
// off-by-one weekly bucketing.
function toDateStr(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

// Numeric coerce with default 0. Handles Acumatica's decimal-string
// emission ("12.0000") and null/empty gracefully.
function toNum(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}

// Try each candidate field name in order; return the first non-empty
// hit as { field, value }. Matches the pattern in acumatica-sync.js
// for BLANKET_EXPIRES_CANDIDATES etc.
function getFirstHit(getFn, candidates) {
  for (const f of candidates) {
    const v = getFn(f);
    if (v != null && String(v).trim() !== "") return { field: f, value: String(v).trim() };
  }
  return { field: null, value: "" };
}

// Canonicalize an object for fingerprint comparison. Recursively sorts
// keys at every depth so two objects with identical content but
// different key insertion order produce identical JSON. Arrays are
// preserved (their order MAY be semantic; we don't have any arrays in
// production_order rows today but the helper stays honest for future
// evolution).
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

// Fingerprint a production-order row for delta comparison. Any real
// change to any field flips this; incidental object-identity or key-
// order differences do not. Simpler than _poFingerprint in acumatica-
// sync.js because production_orders have no sub-array to pre-sort.
function _prodOrderFingerprint(data) {
  if (!data || typeof data !== "object") return "";
  return JSON.stringify(_canonicalize(data));
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[acumatica-production-orders-sync] ${msg}`, data || "");

  const {
    ACUMATICA_BASE_URL,
    ACUMATICA_COMPANY,
    ACUMATICA_PRODUCTION_ORDERS_GI_NAME,
    ACUMATICA_USERNAME,
    ACUMATICA_PASSWORD,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
  } = process.env;

  if (!ACUMATICA_BASE_URL || !ACUMATICA_USERNAME || !ACUMATICA_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing required environment variables");
    return { statusCode: 500, body: JSON.stringify({ error: "Missing env vars" }) };
  }

  const giEncoded = encodeURIComponent(ACUMATICA_PRODUCTION_ORDERS_GI_NAME || "LM Planner Production Orders");
  const company = ACUMATICA_COMPANY || "LIVE";
  const baseUrl = `${ACUMATICA_BASE_URL}/OData/${company}/${giEncoded}`;
  log("Fetching (paginated)", baseUrl);

  // ── Paginated fetch ─────────────────────────────────────────────────
  // Acumatica OData caps a single response at ~1000 rows. Walk pages
  // via $top/$skip until a short page reports the feed is drained.
  // MAX_PAGES caps a runaway loop; a WARNING at the ceiling flags the
  // case where every page came back full and there might still be more.
  // Pattern cloned from runPOSync in acumatica-sync.js.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 20;
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

  // ── Field-name discovery: dump the first entry's raw tag names once ──
  // Same aid as acumatica-bom-sync.js. Reveals the real OData column
  // names on a manual run so any candidate miss below can be corrected
  // in a single follow-up. Bounded to 80 tags so a bloated first entry
  // can't flood the log.
  if (entries.length > 0) {
    const tagNames = Array.from(new Set(
      (entries[0].match(/<d:([A-Za-z0-9_]+)[\s>]/g) || []).map(s => s.replace(/^<d:/, "").replace(/[\s>]$/, ""))
    ));
    log(`Sample entry[0] tag names (${tagNames.length}):`, tagNames.slice(0, 80).join(", "));
  }

  // ── Candidate lists per logical field ──────────────────────────────
  // User-added GI columns arrive with a leading underscore; base-entity
  // columns don't. We list both. First hit wins per row; the "detected"
  // field name is remembered so we can emit a WARNING if any logical
  // field never resolved a candidate (silent-null guard).
  const FIELD_CANDIDATES = {
    orderType:       ["OrderType",             "_OrderType"],
    productionOrder: ["ProdOrdID", "ProductionOrderNbr", "OrderNbr", "ProductionOrder", "_ProductionOrder"],
    fgSku:           ["InventoryID", "FGInventoryID", "FinishedGoodSKU", "_FinishedGoodSKU"],
    fgDesc:          ["Descr", "Description", "FGDescription", "FinishedGoodDescription", "_FinishedGoodDescription"],
    releasedDate:    ["RelDate", "ReleasedDate", "_ReleasedDate"],
    startDate:       ["StartDate", "PlanStartDate", "_StartDate"],
    endDate:         ["EndDate", "PlanEndDate", "_EndDate"],
    qtyToProduce:    ["QtyToProd", "QtyToProduce", "_QtyToProduce"],
    qtyRemaining:    ["QtyRemaining", "QtyToProdRemaining", "_QtyRemaining"],
    qtyComplete:     ["QtyComplete", "QtyCompleted", "_QtyComplete"],
    warehouse:       ["SiteID", "Warehouse", "_Warehouse"],
    status:          ["Status", "ProdOrdStatus", "_Status", "_ProdOrdStatus"],
  };
  const detectedField = {};   // logical → OData tag that hit at least once
  const missingField = new Set(Object.keys(FIELD_CANDIDATES));   // never hit → WARN

  // ── Parse each entry into a normalized row ─────────────────────────
  // Dedupe by production-order number; if a duplicate arrives (feed
  // quirk), first-wins matches the bom-sync pattern.
  const feedById = new Map();
  let rowsMissingOrderNbr = 0;
  for (const raw of entries) {
    const { get } = makeFieldGetters(raw);

    // Resolve every logical field via getFirstHit; remember which tag
    // actually returned a value so we can log field-mapping status.
    const resolved = {};
    for (const [logical, candidates] of Object.entries(FIELD_CANDIDATES)) {
      const { field, value } = getFirstHit(get, candidates);
      resolved[logical] = value;
      if (field) {
        if (!detectedField[logical]) detectedField[logical] = field;
        missingField.delete(logical);
      }
    }

    const orderNbr = String(resolved.productionOrder || "").trim();
    if (!orderNbr) {
      rowsMissingOrderNbr++;
      continue;
    }

    const data = {
      id:              `po_prod_${orderNbr}`,
      order_type:      resolved.orderType || null,
      production_order: orderNbr,
      fg_sku:          resolved.fgSku || null,
      fg_description:  resolved.fgDesc || null,
      released_date:   toDateStr(resolved.releasedDate),
      start_date:      toDateStr(resolved.startDate),
      end_date:        toDateStr(resolved.endDate),
      qty_to_produce:  toNum(resolved.qtyToProduce),
      qty_remaining:   toNum(resolved.qtyRemaining),
      qty_complete:    toNum(resolved.qtyComplete),
      warehouse:       resolved.warehouse || null,
      status:          resolved.status || null,
    };

    if (!feedById.has(data.id)) {
      feedById.set(data.id, data);
    }
  }

  // Field-mapping status report — logged after parse so counts reflect
  // real coverage. Missing-fields WARNING is the silent-null guard: if
  // NO candidate for a field ever hit, downstream code sees null for
  // that field on every row and would silently under-report.
  log(`Field mapping detected:`, detectedField);
  if (missingField.size > 0) {
    log(`WARNING: no candidate matched for ${missingField.size} logical field(s) — these will be null on every row. Add the correct OData tag name(s) to FIELD_CANDIDATES:`, [...missingField]);
  }
  if (rowsMissingOrderNbr > 0) {
    log(`Skipped ${rowsMissingOrderNbr} row(s) with no production-order number`);
  }
  log(`Parsed ${feedById.size} unique production order(s) (raw entries: ${entries.length})`);

  // Zero-row bailout — matches acumatica-bom-sync.js. A schema/auth
  // glitch that returns zero rows must NOT wipe the table.
  if (feedById.size === 0) {
    log("No production orders parsed from feed — possible schema change or empty GI; bailing without touching the table");
    return { statusCode: 200, body: JSON.stringify({ upserted: 0, removed: 0, note: "No rows parsed" }) };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Load existing rows for diff + reconcile ───────────────────────
  // Same paged select pattern as bom-sync. We select `data` (jsonb) so
  // the fingerprint compares canonically against the exact object we
  // WOULD write, not against N top-level columns that might drift.
  const existing = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa.from("production_orders").select("id, data").range(from, from + PAGE - 1);
    if (error) {
      log("production_orders select error", error);
      return { statusCode: 500, body: JSON.stringify({ error: "production_orders select failed", detail: error.message }) };
    }
    if (!data || data.length === 0) break;
    existing.push(...data);
    if (data.length < PAGE) break;
  }
  const existingById = new Map(existing.map((r) => [r.id, r.data || {}]));
  log(`Loaded ${existing.length} existing production_orders rows`);

  // ── Diff ──────────────────────────────────────────────────────────
  // Upsert rows that are new OR whose canonical fingerprint changed.
  // Delete rows in Supabase but absent from the feed (reconciling
  // deletions — a closed production order eventually drops off the GI;
  // reference-data table must not accumulate ghosts). The zero-row
  // bailout above stops a bad feed from triggering a table-wide wipe.
  const rowsToUpsert = [];
  let unchanged = 0;
  for (const [id, data] of feedById.entries()) {
    const prev = existingById.get(id);
    if (prev && _prodOrderFingerprint(data) === _prodOrderFingerprint(prev)) {
      unchanged++;
      continue;
    }
    // Row shape written to Supabase: top-level indexed columns + full
    // canonical `data` blob for the next run's fingerprint compare.
    // Top-level columns are read-only mirrors for future SQL-side
    // querying; the client only reads `id, data`.
    rowsToUpsert.push({
      id:               data.id,
      order_type:       data.order_type,
      fg_sku:           data.fg_sku,
      fg_description:   data.fg_description,
      released_date:    data.released_date,
      start_date:       data.start_date,
      end_date:         data.end_date,
      qty_to_produce:   data.qty_to_produce,
      qty_remaining:    data.qty_remaining,
      qty_complete:     data.qty_complete,
      warehouse:        data.warehouse,
      status:           data.status,
      data,
    });
  }

  const idsToDelete = [];
  for (const r of existing) {
    if (!feedById.has(r.id)) idsToDelete.push(r.id);
  }

  log(`Will upsert ${rowsToUpsert.length} (${unchanged} unchanged) and delete ${idsToDelete.length} stale rows`);

  // ── Batched upsert (500 rows/req) ─────────────────────────────────
  // Same batch size, same retry-once-then-skip pattern as bom-sync. A
  // chunk that fails twice is logged with its ids and the reconcile
  // continues so a bad row can't block the rest.
  const UPSERT_BATCH = 500;
  let totalUpserted = 0;
  const failedUpsertIds = [];
  for (let i = 0; i < rowsToUpsert.length; i += UPSERT_BATCH) {
    const batch = rowsToUpsert.slice(i, i + UPSERT_BATCH);
    let { error } = await supa.from("production_orders").upsert(batch);
    if (error) {
      log(`upsert chunk ${i}-${i + batch.length - 1} failed, retrying once`, error.message);
      ({ error } = await supa.from("production_orders").upsert(batch));
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

  // ── Batched delete (200 ids/req) ──────────────────────────────────
  // Same URL-length guard as bom-sync: the PostgREST `id=in.(…)` filter
  // caps around 16 KB; 200 keeps us safe with room to spare.
  const DELETE_BATCH = 200;
  let totalDeleted = 0;
  const failedDeleteIds = [];
  for (let i = 0; i < idsToDelete.length; i += DELETE_BATCH) {
    const batch = idsToDelete.slice(i, i + DELETE_BATCH);
    let { error } = await supa.from("production_orders").delete().in("id", batch);
    if (error) {
      log(`delete chunk ${i}-${i + batch.length - 1} failed, retrying once`, error.message);
      ({ error } = await supa.from("production_orders").delete().in("id", batch));
    }
    if (error) {
      log(`delete chunk ${i}-${i + batch.length - 1} failed after retry — skipping`, {
        detail: error.message,
        count: batch.length,
        ids: batch,
      });
      failedDeleteIds.push(...batch);
      continue;
    }
    totalDeleted += batch.length;
  }

  const upsertFailed = failedUpsertIds.length;
  const deleteFailed = failedDeleteIds.length;
  const anyChunkFailed = upsertFailed > 0 || deleteFailed > 0;

  // ── Audit row ─────────────────────────────────────────────────────
  // Same shape and conventions as the on-hand / BOM passes.
  const auditId = `audit_acumatica_production_orders_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await supa.from("audit").upsert([
    {
      id: auditId,
      data: {
        id: auditId,
        ts: new Date().toISOString(),
        type: "acumatica-production-orders-sync",
        msg:
          `Acumatica production-orders sync: ${totalUpserted} upserted (${unchanged} unchanged), ${totalDeleted} removed ` +
          `across ${feedById.size} orders in feed` +
          (anyChunkFailed ? ` — ${upsertFailed} upsert / ${deleteFailed} delete ids failed after retry` : "") +
          (missingField.size > 0 ? ` — WARNING: ${missingField.size} field(s) unmapped: ${[...missingField].join(",")}` : ""),
        detail: {
          source: "netlify-scheduled-function",
          fetched: entries.length,
          pages: pageCount,
          rowsInFeed: feedById.size,
          rowsExisting: existing.length,
          upserted: totalUpserted,
          unchanged,
          removed: totalDeleted,
          upsertFailed,
          deleteFailed,
          skippedNoOrderNbr: rowsMissingOrderNbr,
          detectedFieldMapping: detectedField,
          unmappedFields: [...missingField],
          durationMs: Date.now() - t0,
        },
      },
    },
  ]);

  log(
    `Done. ${totalUpserted} upserted, ${totalDeleted} removed across ${feedById.size} orders in ${Date.now() - t0}ms` +
      (anyChunkFailed ? ` (skipped ${upsertFailed} upsert / ${deleteFailed} delete ids)` : "") +
      (missingField.size > 0 ? ` — WARNING: unmapped fields: ${[...missingField].join(",")}` : "")
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      durationMs: Date.now() - t0,
      fetched: entries.length,
      pages: pageCount,
      rowsInFeed: feedById.size,
      upserted: totalUpserted,
      unchanged,
      removed: totalDeleted,
      upsertFailed,
      deleteFailed,
      skippedNoOrderNbr: rowsMissingOrderNbr,
      detectedFieldMapping: detectedField,
      unmappedFields: [...missingField],
    }),
  };
};
