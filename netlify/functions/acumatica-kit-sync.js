// Netlify Scheduled Function — pulls kit-component links from the
// Acumatica OData generic inquiry "LM Planner Kit Components" and
// reconciles the Supabase `kit_boms` table.
//
// Schedule: once daily at 06:00 UTC (configured in netlify.toml).
// Modeled on acumatica-bom-sync.js — same auth, OData Atom-XML
// fetch/parse, chunked deletes, retry-then-skip logic, env-var
// contract. Two deliberate divergences:
//   1. The kit GI is server-paginated (~20 rows/page × ~66 pages
//      for 1,379 rows), so this fetch loops via $top/$skip. bom-sync
//      gets its ~16k rows in a single call because the BOM GI has no
//      server-side cap; single-call would silently truncate here.
//   2. `kit_boms` is one row per KIT (not per link), keyed on kit_pn.
//      A GI row is one (kit, component) pair, so we AGGREGATE rows
//      into kit objects before upserting — byte-compatible with
//      importKitBomsFromExcel's in-memory shape (js/41-kit-boms.js)
//      so the client can't tell whether a kit came from Excel or
//      from this sync.
//
// Required environment variables:
//   ACUMATICA_BASE_URL        e.g. https://mdcarts.acumatica.com
//   ACUMATICA_COMPANY         e.g. LIVE
//   ACUMATICA_KIT_GI_NAME     e.g. LM Planner Kit Components
//                             (default: "LM Planner Kit Components")
//   ACUMATICA_USERNAME        the Acumatica login username
//   ACUMATICA_PASSWORD        the Acumatica login password
//   SUPABASE_URL              e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY      the service-role key from Supabase API settings

const { createClient } = require("@supabase/supabase-js");

// Decode the five XML entities Acumatica emits in OData text fields
// (plus numeric char refs). WITHOUT this, a kit desc containing "&"
// arrives as "&amp;", gets stored that way in Supabase, and every UI
// renderer that HTML-escapes on output produces "&amp;amp;".
//
// ORDER MATTERS: &amp; MUST be replaced LAST. Decoding it first would
// turn a literal "&amp;lt;" into "&lt;", and a later rule would then
// decode that AGAIN into "<" — a double-decode. Running &amp; last
// preserves the intent: "&amp;lt;" survives as literal "&lt;".
//
// Numeric char refs use String.fromCodePoint (not fromCharCode) so
// astral-plane codepoints (>= 0x10000) are handled correctly instead
// of producing lone surrogates. Hex refs are matched BEFORE decimal
// so patterns like &#xFF; aren't misinterpreted by the decimal rule.
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

// Shared field extractors for an Acumatica OData Atom-XML <entry>.
// Mirrors makeFieldGetters() in acumatica-bom-sync.js — kept inline so
// this function stays self-contained for esbuild bundling.
function makeFieldGetters(raw) {
  const get = (field) => {
    // Exact field-name match: allow attributes (m:type, etc.) but NOT
    // numbered siblings like <d:CreatedBy_2> — the optional group
    // requires whitespace after the name, so "_2"/"_3" suffixes can't
    // slip through.
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

// Try a small list of candidate OData tag names for one logical field
// and return the first hit. Handles Acumatica's whitespace-stripping /
// hyphen-quirks in GI column names — the "Non-Stock ..." columns can
// arrive as NonStock..., Non_Stock..., or Nonstock... depending on how
// the GI designer stored the display name. If none of the candidates
// match, the returned .field is null and the caller logs it.
function firstHit(getFn, candidates) {
  for (const f of candidates) {
    const v = getFn(f);
    if (v != null && String(v).trim() !== "") return { field: f, value: String(v).trim() };
  }
  return { field: null, value: "" };
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[acumatica-kit-sync] ${msg}`, data || "");

  const {
    ACUMATICA_BASE_URL,
    ACUMATICA_COMPANY,
    ACUMATICA_KIT_GI_NAME,
    ACUMATICA_USERNAME,
    ACUMATICA_PASSWORD,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
  } = process.env;

  if (!ACUMATICA_BASE_URL || !ACUMATICA_USERNAME || !ACUMATICA_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing required environment variables");
    return { statusCode: 500, body: JSON.stringify({ error: "Missing env vars" }) };
  }

  const giEncoded = encodeURIComponent(ACUMATICA_KIT_GI_NAME || "LM Planner Kit Components");
  const company = ACUMATICA_COMPANY || "LIVE";
  const baseUrl = `${ACUMATICA_BASE_URL}/OData/${company}/${giEncoded}`;
  const auth = Buffer.from(`${ACUMATICA_USERNAME}:${ACUMATICA_PASSWORD}`).toString("base64");

  // ── Paginated Acumatica fetch ─────────────────────────────────────
  // Kit GI is server-paginated (~20 rows/page → ~66 pages for the
  // current 1,379-row feed). A single-call fetch would silently
  // truncate, so we loop $top/$skip and advance by the ACTUAL row
  // count each round (not the requested $top) — this stays correct
  // whether the server honors $top=1000 or clamps it to its own cap.
  // Safety cap at MAX_PAGES prevents a runaway loop on a misbehaving GI.
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 500;
  const entries = [];
  let skip = 0;
  let pageNum = 0;
  try {
    for (; pageNum < MAX_PAGES; pageNum++) {
      const url = `${baseUrl}?$top=${PAGE_SIZE}&$skip=${skip}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Basic ${auth}`, Accept: "application/atom+xml" },
      });
      if (!resp.ok) {
        const body = await resp.text();
        log("Acumatica returned non-OK status", { page: pageNum + 1, status: resp.status, body: body.slice(0, 200) });
        return { statusCode: 502, body: JSON.stringify({ error: "Acumatica auth/fetch failed", status: resp.status, page: pageNum + 1 }) };
      }
      const xml = await resp.text();
      const pageEntries = xml.split(/<entry[^>]*>/i).slice(1);
      if (pageEntries.length === 0) {
        log(`Page ${pageNum + 1}: 0 entries — end of feed`);
        break;
      }
      entries.push(...pageEntries);
      skip += pageEntries.length;   // advance by actual, not by $top
      log(`Page ${pageNum + 1}: ${pageEntries.length} entries (cumulative ${entries.length})`);
    }
    if (pageNum >= MAX_PAGES) {
      log(`Bailing at ${MAX_PAGES} pages to prevent runaway loop`);
    }
  } catch (err) {
    log("Fetch threw", err.message);
    return { statusCode: 502, body: JSON.stringify({ error: "Acumatica fetch error", detail: err.message }) };
  }

  log(`Total ${entries.length} <entry> elements across ${pageNum} page(s)`);

  // Discovery aid: dump the first entry's <d:...> tag names once, so a
  // manual run reveals the actual column-name spellings if any of the
  // expected candidates below don't hit. Bounded so a large first entry
  // doesn't flood the log.
  if (entries.length > 0) {
    const tagNames = Array.from(new Set(
      (entries[0].match(/<d:([A-Za-z0-9_]+)[\s>]/g) || []).map(s => s.replace(/^<d:/, "").replace(/[\s>]$/, ""))
    ));
    log(`Sample entry[0] tag names (${tagNames.length}):`, tagNames.slice(0, 80).join(", "));
  }

  // ── Field-name candidates ─────────────────────────────────────────
  // Acumatica typically strips whitespace from GI result-column display
  // names to form the OData tag name. Hyphens in "Non-Stock ..." can
  // survive as _ or vanish — candidates cover all three. First run's
  // tag-sample log surfaces any spelling we missed; add it here in a
  // follow-up if needed.
  const CANDIDATES = {
    kitPn:       ["KitPartNumber", "KitPartNbr"],
    kitDesc:     ["KitDescription", "KitDesc"],
    revision:    ["Revision"],
    stockPn:     ["StockComponentPartNumber", "StockComponentPart"],
    stockDesc:   ["StockComponentDescription", "StockComponentDesc"],
    stockQty:    ["StockQtyPerKit", "StockQty"],
    nonStockPn:  ["NonStockComponentPartNumber", "Non_StockComponentPartNumber", "NonstockComponentPartNumber"],
    nonStockQty: ["NonStockQtyPerKit", "Non_StockQtyPerKit", "NonstockQtyPerKit"],
  };

  // ── Parse rows and AGGREGATE into kits ────────────────────────────
  // Shape target — byte-compatible with importKitBomsFromExcel
  // (js/41-kit-boms.js), so the app reads sync-populated and Excel-
  // imported kits identically:
  //   data.kit_desc: string
  //   data.components: [{ pn, qty (number), desc (string), isStock (boolean) }]
  //
  // Row rules per feature spec:
  //   - Kit Part Number is used verbatim — no stripping of a "-R"
  //     revision suffix. The GI can (and does) report base ("15744")
  //     and revision-suffixed ("15744-R") as distinct kit rows; both
  //     get their own kit_boms entry because the resolver's fallback
  //     path (js/41-kit-boms.js:97) looks up kit_boms by ORIGINAL PN.
  //     Its earlier bom_links attempts (with and without suffix
  //     stripping) are independent of what's in kit_boms.
  //   - A row is skipped ONLY when both Stock and Non-Stock component
  //     PNs are empty. Non-stock rows are NEVER dropped as a class.
  //   - Within a row, a stock or non-stock branch is added only if
  //     its PN is present AND its qty > 0 — matches the importer's
  //     `qty > 0` guard so a zero-qty ghost line never becomes a
  //     component.
  //   - Dedup keyed on (pn, isStock) so the same PN can appear once
  //     as stock and once as non-stock but not twice as the same
  //     type — matches the importer's find() guards line-for-line.
  const kits = new Map();          // kit_pn → { kit_desc, components: [] }
  const detectedFields = {};
  let rawRows = 0;
  let kitPnEmpty = 0;
  let bothPnsEmpty = 0;
  let stockLinksAdded = 0;
  let nonStockLinksAdded = 0;

  for (const raw of entries) {
    rawRows++;
    const { get } = makeFieldGetters(raw);

    const kitPnHit       = firstHit(get, CANDIDATES.kitPn);
    const kitDescHit     = firstHit(get, CANDIDATES.kitDesc);
    const stockPnHit     = firstHit(get, CANDIDATES.stockPn);
    const stockQtyHit    = firstHit(get, CANDIDATES.stockQty);
    const stockDescHit   = firstHit(get, CANDIDATES.stockDesc);
    const nonStockPnHit  = firstHit(get, CANDIDATES.nonStockPn);
    const nonStockQtyHit = firstHit(get, CANDIDATES.nonStockQty);

    // Remember which candidate spelling actually hit (first winner
    // stays) — surfaced in the summary log so we can spot drift.
    if (kitPnHit.field       && !detectedFields.kitPn)       detectedFields.kitPn       = kitPnHit.field;
    if (kitDescHit.field     && !detectedFields.kitDesc)     detectedFields.kitDesc     = kitDescHit.field;
    if (stockPnHit.field     && !detectedFields.stockPn)     detectedFields.stockPn     = stockPnHit.field;
    if (stockQtyHit.field    && !detectedFields.stockQty)    detectedFields.stockQty    = stockQtyHit.field;
    if (stockDescHit.field   && !detectedFields.stockDesc)   detectedFields.stockDesc   = stockDescHit.field;
    if (nonStockPnHit.field  && !detectedFields.nonStockPn)  detectedFields.nonStockPn  = nonStockPnHit.field;
    if (nonStockQtyHit.field && !detectedFields.nonStockQty) detectedFields.nonStockQty = nonStockQtyHit.field;

    const kitPn = kitPnHit.value;
    if (!kitPn) { kitPnEmpty++; continue; }

    if (!stockPnHit.value && !nonStockPnHit.value) { bothPnsEmpty++; continue; }

    // Get-or-create the kit aggregate. First non-empty kit_desc for
    // this kit wins — later rows for the same kit may leave kit_desc
    // blank, which we don't want to overwrite what we already have.
    let kit = kits.get(kitPn);
    if (!kit) {
      kit = { kit_desc: kitDescHit.value || "", components: [] };
      kits.set(kitPn, kit);
    } else if (!kit.kit_desc && kitDescHit.value) {
      kit.kit_desc = kitDescHit.value;
    }

    // Stock branch — importer's guard: PN present AND qty > 0.
    if (stockPnHit.value) {
      const qty = parseFloat(String(stockQtyHit.value || "0").replace(/[^0-9.\-]/g, ""));
      if (isFinite(qty) && qty > 0) {
        const already = kit.components.find(c => c.pn === stockPnHit.value && c.isStock);
        if (!already) {
          kit.components.push({
            pn: stockPnHit.value,
            qty,
            desc: stockDescHit.value || "",
            isStock: true,
          });
          stockLinksAdded++;
        }
      }
    }

    // Non-stock branch — same guard. Non-stock components have no
    // description column in the GI, so desc is always "" — matches
    // the importer (js/41-kit-boms.js:43).
    if (nonStockPnHit.value) {
      const qty = parseFloat(String(nonStockQtyHit.value || "0").replace(/[^0-9.\-]/g, ""));
      if (isFinite(qty) && qty > 0) {
        const already = kit.components.find(c => c.pn === nonStockPnHit.value && !c.isStock);
        if (!already) {
          kit.components.push({
            pn: nonStockPnHit.value,
            qty,
            desc: "",
            isStock: false,
          });
          nonStockLinksAdded++;
        }
      }
    }
  }

  log(`Parsed ${rawRows} raw rows → ${kits.size} kits (${stockLinksAdded} stock + ${nonStockLinksAdded} non-stock links). Skipped: ${kitPnEmpty} kit-pn-empty, ${bothPnsEmpty} both-pns-empty.`);
  log("Detected field names:", detectedFields);

  // Warn if any of the critical field names never resolved. kitPn is
  // the only hard-fail (a run with no kits parses to 0 → we bail).
  const criticalMissing = [];
  if (!detectedFields.kitPn) criticalMissing.push("kitPn");
  if (!detectedFields.stockPn && !detectedFields.nonStockPn) criticalMissing.push("stockPn/nonStockPn");
  if (criticalMissing.length) {
    log(`WARNING: critical field(s) never resolved: ${criticalMissing.join(", ")}. Check the tag-sample log above and add the correct spelling to CANDIDATES.`);
  }

  // Guard against a zero-row feed — never wipe the table on a
  // transient schema/auth glitch. Same shape as bom-sync's bail-out.
  if (kits.size === 0) {
    log("No kits parsed from feed — possible schema change or empty GI; bailing without touching the table");
    return { statusCode: 200, body: JSON.stringify({ upserted: 0, removed: 0, note: "No kits parsed" }) };
  }

  // ── Supabase reconcile ────────────────────────────────────────────
  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ── Superseded-variant dedup ──────────────────────────────────────
  // The kit GI occasionally lists both a bare PN ("19568") and its
  // "-2" replacement ("19568-2") on the same kit. When the bare one
  // no longer exists in the inventory catalog and the "-2" variant
  // does, treat the "-2" as the replacement and drop the bare one.
  //
  // NARROWLY SCOPED: this only fires when bare is NOT-in-catalog AND
  // "-2" IS in-catalog. Two in-catalog siblings are NEVER merged —
  // an intentional dual-listing (rare but legal) survives untouched.
  const catalogPns = new Set();
  {
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supa.from("parts").select("pn").range(from, from + PAGE - 1);
      if (error) {
        log("parts catalog select error", error);
        return { statusCode: 500, body: JSON.stringify({ error: "parts catalog select failed", detail: error.message }) };
      }
      if (!data || data.length === 0) break;
      for (const r of data) catalogPns.add(r.pn);
      if (data.length < PAGE) break;
    }
  }
  log(`Loaded ${catalogPns.size} in-catalog PNs for superseded-variant check`);

  let supersededDropped = 0;
  for (const [kit_pn, kit] of kits.entries()) {
    const pnSet = new Set(kit.components.map(c => c.pn));
    const kept = [];
    for (const c of kit.components) {
      const suffixed = `${c.pn}-2`;
      if (pnSet.has(suffixed) && !catalogPns.has(c.pn) && catalogPns.has(suffixed)) {
        log(`${kit_pn}: dropped superseded ${c.pn} (kept ${suffixed})`);
        supersededDropped++;
        continue;
      }
      kept.push(c);
    }
    if (kept.length !== kit.components.length) {
      kit.components = kept;
    }
  }
  if (supersededDropped > 0) {
    log(`Superseded-variant dedup: dropped ${supersededDropped} component(s) across all kits`);
  }

  // Page through every existing row. Same paged pattern as bom-sync;
  // note the PK column here is kit_pn, not id (see js/30-supabase.js:855).
  const existing = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa.from("kit_boms").select("kit_pn, data").range(from, from + PAGE - 1);
    if (error) {
      log("kit_boms select error", error);
      return { statusCode: 500, body: JSON.stringify({ error: "kit_boms select failed", detail: error.message }) };
    }
    if (!data || data.length === 0) break;
    existing.push(...data);
    if (data.length < PAGE) break;
  }
  const existingByPn = new Map(existing.map(r => [r.kit_pn, r.data || {}]));
  log(`Loaded ${existing.length} existing kit_boms rows`);

  // Diff — upsert kits that are new OR whose content changed; delete
  // kits present in Supabase but absent from the feed. Order-independent
  // content comparison keyed on (pn, isStock) so a benign component
  // reorder doesn't trigger a full-row rewrite.
  function _kitContentEqual(a, b) {
    if (!a || !b) return false;
    if ((a.kit_desc || "") !== (b.kit_desc || "")) return false;
    const ac = Array.isArray(a.components) ? a.components : [];
    const bc = Array.isArray(b.components) ? b.components : [];
    if (ac.length !== bc.length) return false;
    const bMap = new Map(bc.map(c => [`${c.pn}::${!!c.isStock}`, c]));
    for (const c of ac) {
      const match = bMap.get(`${c.pn}::${!!c.isStock}`);
      if (!match) return false;
      if (Number(match.qty) !== Number(c.qty)) return false;
      if ((match.desc || "") !== (c.desc || "")) return false;
    }
    return true;
  }

  const rowsToUpsert = [];
  let unchanged = 0;
  for (const [kit_pn, kit] of kits.entries()) {
    const prev = existingByPn.get(kit_pn);
    if (prev && _kitContentEqual(prev, kit)) {
      unchanged++;
      continue;
    }
    rowsToUpsert.push({ kit_pn, data: kit });
  }

  const pnsToDelete = [];
  for (const r of existing) {
    if (!kits.has(r.kit_pn)) pnsToDelete.push(r.kit_pn);
  }

  log(`Will upsert ${rowsToUpsert.length} (${unchanged} unchanged) and delete ${pnsToDelete.length} stale kits`);

  // Chunked upsert — 500 rows per request. Same size and retry-once-
  // then-skip policy as bom-sync.
  const UPSERT_BATCH = 500;
  let totalUpserted = 0;
  const failedUpsertPns = [];
  for (let i = 0; i < rowsToUpsert.length; i += UPSERT_BATCH) {
    const batch = rowsToUpsert.slice(i, i + UPSERT_BATCH);
    let { error } = await supa.from("kit_boms").upsert(batch);
    if (error) {
      log(`upsert chunk ${i}-${i + batch.length - 1} failed, retrying once`, error.message);
      ({ error } = await supa.from("kit_boms").upsert(batch));
    }
    if (error) {
      log(`upsert chunk ${i}-${i + batch.length - 1} failed after retry — skipping`, {
        detail: error.message,
        count: batch.length,
        pns: batch.map(r => r.kit_pn),
      });
      failedUpsertPns.push(...batch.map(r => r.kit_pn));
      continue;
    }
    totalUpserted += batch.length;
  }

  // Chunked delete — 200 kit_pns per request. Delete filter travels in
  // the URL as `kit_pn=in.(pn1,pn2,...)`, so we keep the batch small
  // for the same PostgREST/nginx ~16 KB request-line ceiling that
  // bom-sync accounts for.
  const DELETE_BATCH = 200;
  let totalDeleted = 0;
  const failedDeletePns = [];
  for (let i = 0; i < pnsToDelete.length; i += DELETE_BATCH) {
    const batch = pnsToDelete.slice(i, i + DELETE_BATCH);
    let { error } = await supa.from("kit_boms").delete().in("kit_pn", batch);
    if (error) {
      log(`delete chunk ${i}-${i + batch.length - 1} failed, retrying once`, error.message);
      ({ error } = await supa.from("kit_boms").delete().in("kit_pn", batch));
    }
    if (error) {
      log(`delete chunk ${i}-${i + batch.length - 1} failed after retry — skipping`, {
        detail: error.message,
        count: batch.length,
        pns: batch,
      });
      failedDeletePns.push(...batch);
      continue;
    }
    totalDeleted += batch.length;
  }

  const upsertFailed = failedUpsertPns.length;
  const deleteFailed = failedDeletePns.length;
  const anyChunkFailed = upsertFailed > 0 || deleteFailed > 0;

  // Audit row — same shape and conventions as bom-sync's audit.
  const auditId = `audit_acumatica_kit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await supa.from("audit").upsert([
    {
      id: auditId,
      data: {
        id: auditId,
        ts: new Date().toISOString(),
        type: "acumatica-kit-sync",
        msg:
          `Acumatica Kit sync: ${totalUpserted} kits upserted (${unchanged} unchanged), ` +
          `${totalDeleted} removed` +
          (anyChunkFailed ? ` — ${upsertFailed} upsert / ${deleteFailed} delete pns failed after retry` : ""),
        detail: {
          source: "netlify-scheduled-function",
          rawRows,
          rawEntries: entries.length,
          pagesFetched: pageNum,
          kitsInFeed: kits.size,
          kitsExisting: existing.length,
          upserted: totalUpserted,
          unchanged,
          removed: totalDeleted,
          upsertFailed,
          deleteFailed,
          stockLinksAdded,
          nonStockLinksAdded,
          supersededDropped,
          rowsSkipped: { kitPnEmpty, bothPnsEmpty },
          detectedFields,
          durationMs: Date.now() - t0,
        },
      },
    },
  ]);

  log(
    `Done. ${totalUpserted} kits upserted, ${totalDeleted} removed in ${Date.now() - t0}ms` +
      (anyChunkFailed ? ` (skipped ${upsertFailed} upsert / ${deleteFailed} delete pns)` : "")
  );

  return {
    statusCode: 200,
    body: JSON.stringify({
      durationMs: Date.now() - t0,
      rawEntries: entries.length,
      pagesFetched: pageNum,
      kitsInFeed: kits.size,
      upserted: totalUpserted,
      unchanged,
      removed: totalDeleted,
      upsertFailed,
      deleteFailed,
      stockLinksAdded,
      nonStockLinksAdded,
      supersededDropped,
      rowsSkipped: { kitPnEmpty, bothPnsEmpty },
      detectedFields,
    }),
  };
};
