/* =====================================================
   04-data.js
   Sections: SAMPLE DATA — realistic seed for first run, LANDMASTER LIVE BOOTSTRAP — decode embedded snapshot
   ===================================================== */

/* =====================================================
   SAMPLE DATA — removed in favor of embedded Landmaster snapshot
   The original generateSampleData() function lived here and produced
   ~80 mock UTV parts. It is no longer called; the planner boots
   directly from data/bootstrap.js (the real C9 Big Sheet snapshot).
   ===================================================== */

/* ============================================================
   LANDMASTER LIVE BOOTSTRAP — decode embedded snapshot
   Source: C9_Inventory_Transaction_History (Big Sheet) — 5/4/26
   ============================================================ */
async function decodeEmbeddedBootstrap() {
  // The snapshot is loaded by data/bootstrap.js, which sets
  // window.LM_BOOTSTRAP_DATA to a base64-encoded gzip blob.
  const b64 = window.LM_BOOTSTRAP_DATA;
  if (!b64) throw new Error("window.LM_BOOTSTRAP_DATA not set — is data/bootstrap.js loaded?");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes]);
  const ds = new DecompressionStream("gzip");
  const stream = blob.stream().pipeThrough(ds);
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

async function bootstrapSample() {
  let payload;
  try {
    payload = await decodeEmbeddedBootstrap();
  } catch (e) {
    console.error("Bootstrap failed:", e);
    showToast("Could not load embedded data: " + e.message, "crit", "Bootstrap Failed", 8000);
    DB = JSON.parse(JSON.stringify(DEFAULTS));
    DB.meta.dataSource = "empty";
    DB.meta.loaded = new Date().toISOString();
    saveDB();
    return;
  }
  DB = JSON.parse(JSON.stringify(DEFAULTS));
  DB.parts = payload.parts || [];
  DB.pos = payload.pos || [];
  DB.usage = payload.usage || [];
  // Snapshot POs use Acumatica numbers (POC0006006…) which we keep as-is.
  // New POs created in the app start from the configured poNumStart.
  DB.poNum = DB.settings.poNumStart || 47120;

  // Assign stable IDs to every PO and line — the embedded snapshot only has Acumatica
  // PO numbers (e.g. POC0006006), but the UI's Open / Edit / Receive buttons need an `id`.
  // Using the PO number as the id is stable across reloads.
  for (const po of DB.pos) {
    if (!po.id) po.id = "po_" + po.num;
    if (Array.isArray(po.lines)) {
      po.lines.forEach((ln, idx) => {
        if (!ln.id) ln.id = po.id + "_l" + idx;
      });
    }
  }
  // Assign IDs to usage txns too (defensive — they already have ids from the extractor)
  for (const u of DB.usage) {
    if (!u.id) u.id = uid("us");
  }

  DB.meta.dataSource = "Landmaster · C9 Big Sheet (5/4/26)";
  DB.meta.lastImport = new Date().toISOString();
  DB.meta.loaded = new Date().toISOString();
  DB.audit = DB.audit || [];
  DB.audit.unshift({
    id: uid("au"), ts: new Date().toISOString(), kind: "import",
    msg: `Bootstrapped Landmaster snapshot: ${DB.parts.length} parts, ${DB.pos.length} POs, ${DB.usage.length} usage txns`,
  });
  saveDB();
}
