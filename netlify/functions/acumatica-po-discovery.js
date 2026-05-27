// Netlify Function — one-time READ-ONLY discovery for the "LM Planner PO Line"
// Acumatica Generic Inquiry. Fetches the OData feed, parses out the first
// <entry>, and returns the raw XML plus the list of <d:FieldName> tags found
// so we can see every field Acumatica is exposing.
//
// Does NOT write to Supabase. Does NOT mutate any state. Safe to call repeatedly.
//
// Trigger:
//   curl -i https://<your-site>.netlify.app/.netlify/functions/acumatica-po-discovery
// or hit that URL in a browser. Output is the JSON response body; the same
// info is also printed to the Netlify function logs.
//
// Reuses the same env vars as acumatica-sync.js:
//   ACUMATICA_BASE_URL, ACUMATICA_COMPANY, ACUMATICA_USERNAME, ACUMATICA_PASSWORD

const GI_NAME = "LMInventoryPlannerPOLines";

exports.handler = async () => {
  const log = (msg, data) => console.log(`[acumatica-po-discovery] ${msg}`, data || "");

  const {
    ACUMATICA_BASE_URL,
    ACUMATICA_COMPANY,
    ACUMATICA_USERNAME,
    ACUMATICA_PASSWORD,
  } = process.env;

  if (!ACUMATICA_BASE_URL || !ACUMATICA_USERNAME || !ACUMATICA_PASSWORD) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing Acumatica env vars" }) };
  }

  const company = ACUMATICA_COMPANY || "LIVE";
  const giEncoded = encodeURIComponent(GI_NAME);
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
      log("Acumatica non-OK", { status: resp.status, body: body.slice(0, 300) });
      return {
        statusCode: resp.status,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          error: "Acumatica fetch failed",
          status: resp.status,
          url,
          bodyPreview: body.slice(0, 500),
        }, null, 2),
      };
    }
    xml = await resp.text();
  } catch (err) {
    log("Fetch threw", err.message);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: "Acumatica fetch threw", detail: err.message, url }),
    };
  }

  const entries = xml.split(/<entry[^>]*>/i).slice(1);
  log(`Found ${entries.length} <entry> elements`);

  if (entries.length === 0) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        entryCount: 0,
        note: "No <entry> elements parsed — GI name may be wrong, or feed format unexpected.",
        rawFeedHead: xml.slice(0, 1500),
      }, null, 2),
    };
  }

  const firstEntry = entries[0];
  const fieldNames = Array.from(new Set(
    Array.from(firstEntry.matchAll(/<d:([A-Za-z0-9_]+)[\s>/]/g)).map(m => m[1])
  )).sort();

  log("FIELD_NAMES", fieldNames);
  log("RAW_FIRST_ENTRY", firstEntry);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      entryCount: entries.length,
      fieldNames,
      firstEntryXml: firstEntry,
    }, null, 2),
  };
};
