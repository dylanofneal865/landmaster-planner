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
    const get = (field) => {
      const re = new RegExp(`<d:${field}[^>]*>([\\s\\S]*?)<\\/d:${field}>`, "i");
      const m = raw.match(re);
      return m ? m[1].trim() : null;
    };
    const isNull = (field) => {
      const re = new RegExp(`<d:${field}[^>]*m:null="true"`, "i");
      return re.test(raw);
    };

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

  if (rows.length === 0) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        durationMs: Date.now() - t0,
        partsInFeed: dedupe.size,
        partsInPlanner: existingMap.size,
        updated: 0,
        unchanged,
      }),
    };
  }

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

  log(`Done. ${totalUpserted} parts updated in ${Date.now() - t0}ms`);

  return {
    statusCode: 200,
    body: JSON.stringify({
      durationMs: Date.now() - t0,
      partsInFeed: dedupe.size,
      partsInPlanner: existingMap.size,
      updated: totalUpserted,
      unchanged,
    }),
  };
};
