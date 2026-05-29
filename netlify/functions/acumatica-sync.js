// Netlify Scheduled Function — pulls on-hand inventory from Acumatica OData
// and updates the Supabase `parts` table.
//
// Schedule: every 2 minutes (configured in netlify.toml)
//
// Required environment variables:
//   ACUMATICA_BASE_URL        e.g. https://mdcarts.acumatica.com
//   ACUMATICA_COMPANY         e.g. LIVE
//   ACUMATICA_GI_NAME         e.g. LM Planner Inventory
//   ACUMATICA_USERNAME        the Acumatica login username
//   ACUMATICA_PASSWORD        the Acumatica login password
//   SUPABASE_URL              e.g. https://rqvswdxfebhlyouozltk.supabase.co
//   SUPABASE_SERVICE_KEY      the service-role key from Supabase API settings

const { createClient } = require("@supabase/supabase-js");

// Shared field extractors for an Acumatica OData Atom-XML <entry>.
function makeFieldGetters(raw) {
  const get = (field) => {
    const re = new RegExp(`<d:${field}[^>]*>([\\s\\S]*?)<\\/d:${field}>`, "i");
    const m = raw.match(re);
    return m ? m[1].trim() : null;
  };
  const isNull = (field) => {
    const re = new RegExp(`<d:${field}[^>]*m:null="true"`, "i");
    return re.test(raw);
  };
  return { get, isNull };
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[acumatica-sync] ${msg}`, data || "");

  const {
    ACUMATICA_BASE_URL,
    ACUMATICA_COMPANY,
    ACUMATICA_GI_NAME,
    ACUMATICA_USERNAME,
    ACUMATICA_PASSWORD,
    SUPABASE_URL,
    SUPABASE_SERVICE_KEY,
  } = process.env;

  if (!ACUMATICA_BASE_URL || !ACUMATICA_USERNAME || !ACUMATICA_PASSWORD || !SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    log("Missing required environment variables");
    return { statusCode: 500, body: JSON.stringify({ error: "Missing env vars" }) };
  }

  const giEncoded = encodeURIComponent(ACUMATICA_GI_NAME || "LM Planner Inventory");
  const company = ACUMATICA_COMPANY || "LIVE";
  const url = `${ACUMATICA_BASE_URL}/OData/${company}/${giEncoded}`;
  log("Fetching", url);

  let xml;
  try {
    const auth = Buffer.from(`${ACUMATICA_USERNAME}:${ACUMATICA_PASSWORD}`).toString("base64");
    const resp = await fetch(url, {
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/atom+xml",
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      log("Acumatica returned non-OK status", { status: resp.status, body: body.slice(0, 200) });
      return { statusCode: 502, body: JSON.stringify({ error: "Acumatica auth/fetch failed", status: resp.status }) };
    }
    xml = await resp.text();
  } catch (err) {
    log("Fetch threw", err.message);
    return { statusCode: 502, body: JSON.stringify({ error: "Acumatica fetch error", detail: err.message }) };
  }

  const entries = xml.split(/<entry[^>]*>/i).slice(1);
  log(`Found ${entries.length} <entry> elements`);

  const dedupe = new Map();
  for (const raw of entries) {
    const { get, isNull } = makeFieldGetters(raw);

    const pn = get("InventoryID");
    if (!pn) continue;

    const qtyAvailStr = isNull("QtyAvailableinWarehouse") ? null : get("QtyAvailableinWarehouse");
    if (qtyAvailStr === null) continue;

    const qtyAvail = parseFloat(qtyAvailStr);
    if (!isFinite(qtyAvail)) continue;

    if (!dedupe.has(pn)) {
      dedupe.set(pn, qtyAvail);
    }
  }

  log(`Deduped to ${dedupe.size} distinct parts`);

  if (dedupe.size === 0) {
    log("No parts parsed from feed — possible schema change");
    return { statusCode: 200, body: JSON.stringify({ updated: 0, note: "No parts parsed" }) };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  log("Fetching existing parts from Supabase");
  const existingPns = Array.from(dedupe.keys());
  const PAGE = 1000;
  const existingMap = new Map();
  for (let offset = 0; offset < existingPns.length; offset += PAGE) {
    const slice = existingPns.slice(offset, offset + PAGE);
    const { data, error } = await supa
      .from("parts")
      .select("pn, data")
      .in("pn", slice);
    if (error) {
      log("Supabase select error", error);
      return { statusCode: 500, body: JSON.stringify({ error: "Supabase select failed", detail: error.message }) };
    }
    for (const row of data || []) {
      existingMap.set(row.pn, row.data || {});
    }
  }
  log(`Loaded ${existingMap.size} existing parts; ${dedupe.size - existingMap.size} parts in feed are not in DB.parts (skipped)`);

  const rows = [];
  let unchanged = 0;
  for (const [pn, qtyAvail] of dedupe.entries()) {
    const existing = existingMap.get(pn);
    if (!existing) continue;
    if (Number(existing.onHand) === qtyAvail) {
      unchanged++;
      continue;
    }
    const merged = { ...existing, onHand: qtyAvail };
    rows.push({ pn, data: merged });
  }
  log(`Will update ${rows.length} parts (${unchanged} unchanged, skipped)`);

  const BATCH = 500;
  let totalUpserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supa.from("parts").upsert(batch);
    if (error) {
      log("Supabase upsert error", error);
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Supabase upsert failed",
          detail: error.message,
          partial: totalUpserted,
        }),
      };
    }
    totalUpserted += batch.length;
  }

  if (rows.length > 0) {
    const auditId = `audit_acumatica_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await supa.from("audit").upsert([
      {
        id: auditId,
        data: {
          id: auditId,
          ts: new Date().toISOString(),
          type: "acumatica-sync",
          msg: `Acumatica sync: ${totalUpserted} parts updated (${unchanged} unchanged, ${dedupe.size - existingMap.size} not in catalog)`,
          detail: {
            source: "netlify-scheduled-function",
            partsInFeed: dedupe.size,
            partsInPlanner: existingMap.size,
            updated: totalUpserted,
            unchanged,
            durationMs: Date.now() - t0,
          },
        },
      },
    ]);
  }

  log(`Done. ${totalUpserted} parts updated in ${Date.now() - t0}ms`);

  const onHandSummary = {
    partsInFeed: dedupe.size,
    partsInPlanner: existingMap.size,
    updated: totalUpserted,
    unchanged,
  };

  // ===== PO SYNC PASS (LMInventoryPlannerPOLines) =====
  // Runs every cycle, after the on-hand pass, sharing auth + Supabase client.
  const poSummary = await runPOSync({
    supa,
    log,
    baseUrl: ACUMATICA_BASE_URL,
    company,
    username: ACUMATICA_USERNAME,
    password: ACUMATICA_PASSWORD,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      durationMs: Date.now() - t0,
      onHand: onHandSummary,
      pos: poSummary,
    }),
  };
};

// ---- PO status derivation (ported verbatim from the app's Excel PO parser) ----
function normalizeAcumaticaStatus(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  const map = [
    [/^on\s*hold$/i, "On Hold"],
    [/^pending\s*approval$/i, "Pending Approval"],
    [/^pending\s*print(ing)?$/i, "Pending Printing"],
    [/^pending\s*e?-?mail$/i, "Pending Email"],
    [/^awaiting\s*link$/i, "Awaiting Link"],
    [/^open$/i, "Open"],
    [/^completed$/i, "Completed"],
    [/^rejected$/i, "Rejected"],
    [/^cancell?ed$/i, "Canceled"],
  ];
  for (const [re, canon] of map) if (re.test(s)) return canon;
  return s;
}

const ACUMATICA_STATUS_PRIORITY = ["On Hold", "Pending Approval", "Pending Printing", "Pending Email", "Awaiting Link", "Open", "Completed", "Rejected", "Canceled"];

function rollupAcumaticaStatus(lines) {
  let bestPri = Infinity, best = "", fallback = "";
  for (const l of (lines || [])) {
    const s = l.acumStatus || "";
    if (!s) continue;
    const pri = ACUMATICA_STATUS_PRIORITY.indexOf(s);
    if (pri >= 0) { if (pri < bestPri) { bestPri = pri; best = s; } }
    else if (!fallback) fallback = s;
  }
  return best || fallback;
}

// Fetches the LMInventoryPlannerPOLines GI, groups flat lines into nested PO
// objects (the shape the app already consumes), preserves local buyer/notes,
// upserts to the `pos` table, and reconciles POs that dropped out of the feed.
async function runPOSync(ctx) {
  const { supa, log, baseUrl, company, username, password } = ctx;
  const PO_GI = "LMInventoryPlannerPOLines";
  const url = `${baseUrl}/OData/${company}/${encodeURIComponent(PO_GI)}`;
  log("PO sync: fetching", url);

  let xml;
  try {
    const auth = Buffer.from(`${username}:${password}`).toString("base64");
    const resp = await fetch(url, {
      headers: { Authorization: `Basic ${auth}`, Accept: "application/atom+xml" },
    });
    if (!resp.ok) {
      const body = await resp.text();
      log("PO GI non-OK status", { status: resp.status, body: body.slice(0, 200) });
      return { error: "PO fetch failed", status: resp.status };
    }
    xml = await resp.text();
  } catch (err) {
    log("PO fetch threw", err.message);
    return { error: "PO fetch error", detail: err.message };
  }

  const entries = xml.split(/<entry[^>]*>/i).slice(1);
  log(`PO sync: found ${entries.length} <entry> elements`);

  const toNum = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const toIso = (v) => { if (!v) return null; const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); };

  // Parse each line and group by OrderNbr.
  const byOrder = new Map();
  const headerExpectedByOrder = new Map();
  const headerBuyerByOrder = new Map();
  const headerCreatedDateByOrder = new Map();
  for (const raw of entries) {
    const { get } = makeFieldGetters(raw);
    const num = (get("OrderNbr") || "").trim();
    if (!num) continue;

    // PO header fields — same value on every line of a PO; first-wins.
    if (!headerExpectedByOrder.has(num)) {
      headerExpectedByOrder.set(num, toIso(get("ExpectedDate")));
    }
    if (!headerBuyerByOrder.has(num)) {
      headerBuyerByOrder.set(num, (get("CreatedBy") || "").trim());
    }
    if (!headerCreatedDateByOrder.has(num)) {
      headerCreatedDateByOrder.set(num, toIso(get("Date")));
    }

    const lineNbrRaw = get("LineNbr");
    const lineNbr = lineNbrRaw == null ? null
      : (Number.isFinite(parseInt(lineNbrRaw, 10)) ? parseInt(lineNbrRaw, 10) : lineNbrRaw);
    const qty = toNum(get("OrderQty"));
    const qtyReceived = toNum(get("QtyOnReceipts"));
    const acumStatus = normalizeAcumaticaStatus(get("Status"));

    let status;
    if (qty > 0 && qtyReceived >= qty) status = "received";
    else if (qtyReceived > 0) status = "partial";
    else if (acumStatus === "Rejected" || acumStatus === "Canceled") status = "cancelled";
    else if (acumStatus === "Completed") status = "received";
    else status = "open";

    const line = {
      id: `${num}::${lineNbr}`,            // stable across syncs (dedupe key)
      pn: (get("InventoryID") || "").trim(),
      desc: get("Description") || "",
      qty,                                  // = OrderQty (app reads `qty`)
      qtyReceived,                          // = QtyOnReceipts (app reads `qtyReceived`)
      openQty: toNum(get("OpenQty")),
      cost: toNum(get("UnitCost")),         // = UnitCost (app reads `cost`)
      extCost: toNum(get("ExtCost")),
      uom: (get("UOM") || "").trim(),
      expectedDate: toIso(get("Promised")), // = Promised (app reads `expectedDate`)
      requestedDate: toIso(get("Requested")),
      warehouse: (get("Warehouse") || "").trim(),
      vendor: (get("Vendor") || "").trim(),
      vendorName: get("VendorName") || "",
      status,
      acumStatus,
      lineNbr,
      notes: "",
    };

    if (!byOrder.has(num)) byOrder.set(num, []);
    byOrder.get(num).push(line);
  }

  log(`PO sync: grouped into ${byOrder.size} POs`);
  if (byOrder.size === 0) {
    return { posInFeed: 0, linesInFeed: entries.length, upserted: 0, reconciled: 0, note: "No PO entries parsed" };
  }

  // Load existing pos rows (to preserve local buyer/notes and to reconcile drop-outs).
  const existing = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supa.from("pos").select("id, data").range(from, from + PAGE - 1);
    if (error) { log("pos select error", error); return { error: "pos select failed", detail: error.message }; }
    if (!data || data.length === 0) break;
    existing.push(...data);
    if (data.length < PAGE) break;
  }
  const existingById = new Map(existing.map((r) => [r.id, r.data || {}]));
  log(`PO sync: loaded ${existing.length} existing pos rows`);

  // Build nested PO rows.
  const rows = [];
  for (const [num, lines] of byOrder.entries()) {
    const id = "po_" + num;
    const prev = existingById.get(id) || {};

    // Preserve local annotations (PO-level buyer/notes, per-line notes).
    const prevLineNotes = new Map((prev.lines || []).map((l) => [l.id, l.notes]));
    for (const ln of lines) {
      const n = prevLineNotes.get(ln.id);
      if (n) ln.notes = n;
    }

    const first = lines[0];
    const allTerm = lines.length > 0 && lines.every((l) => l.status === "received" || l.status === "cancelled");
    const anyReceived = lines.some((l) => l.status === "received");
    const anyProgress = lines.some((l) => l.status === "partial" || l.status === "received");
    let poStatus;
    if (allTerm && anyReceived) poStatus = "received";
    else if (anyProgress) poStatus = "in_transit";
    else poStatus = "submitted";

    const data = {
      id,
      num,
      supplier: first.vendorName || "",
      vendor: first.vendor || "",
      source: "acumatica",
      buyer: prev.buyer || headerBuyerByOrder.get(num) || "",
      createdBy: prev.createdBy || "",
      notes: prev.notes || "",
      createdDate: headerCreatedDateByOrder.get(num) || null,
      expectedDate: headerExpectedByOrder.get(num) || first.expectedDate || null,
      status: poStatus,
      acumStatus: rollupAcumaticaStatus(lines),
      lines,
    };
    rows.push({ id, data });
  }

  // Reconciliation (additive, never delete): a PO previously synced from
  // Acumatica that is no longer in the feed and isn't already received is
  // marked received/Completed.
  const feedIds = new Set(rows.map((r) => r.id));
  let reconciled = 0;
  for (const r of existing) {
    const d = r.data || {};
    if (d.source === "acumatica" && !feedIds.has(r.id) && d.status !== "received") {
      rows.push({ id: r.id, data: { ...d, status: "received", acumStatus: "Completed" } });
      reconciled++;
    }
  }

  // Upsert.
  const BATCH = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supa.from("pos").upsert(batch);
    if (error) { log("pos upsert error", error); return { error: "pos upsert failed", detail: error.message, partial: upserted }; }
    upserted += batch.length;
  }

  // Audit.
  const auditId = `audit_acumatica_pos_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await supa.from("audit").upsert([
    {
      id: auditId,
      data: {
        id: auditId,
        ts: new Date().toISOString(),
        type: "acumatica-po-sync",
        msg: `Acumatica PO sync: ${byOrder.size} POs (${entries.length} lines) upserted, ${reconciled} reconciled closed`,
        detail: {
          source: "netlify-scheduled-function",
          posInFeed: byOrder.size,
          linesInFeed: entries.length,
          upserted,
          reconciled,
        },
      },
    },
  ]);

  log(`PO sync done: ${byOrder.size} POs upserted, ${reconciled} reconciled`);
  return { posInFeed: byOrder.size, linesInFeed: entries.length, upserted, reconciled };
}
