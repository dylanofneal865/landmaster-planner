/* =====================================================
   41-kit-boms.js
   Kit BOM data — parses Acumatica "Kit Components" GI export
   into DB.kitBoms: map of kit_pn -> { kit_pn, kit_desc, components: [...] }

   Slice 1: ingest + query helpers only. Does not explode kit sales
   into component usage rows (that comes later).
   ===================================================== */

async function importKitBomsFromExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, {
    type: "array",
    cellDates: true,
    cellStyles: false,
    bookVBA: false,
    bookFiles: false,
    bookProps: false,
    bookSheets: false,
  });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const kits = {};   // kit_pn -> { kit_pn, kit_desc, components: [] }
  let totalComponents = 0;
  let skipped = 0;

  for (const r of rows) {
    const kit_pn = String(r["Kit Part Number"] || "").trim();
    if (!kit_pn) { skipped++; continue; }
    const kit_desc = String(r["Kit Description"] || "").trim();

    if (!kits[kit_pn]) {
      kits[kit_pn] = { kit_pn, kit_desc, components: [] };
    } else if (kit_desc && !kits[kit_pn].kit_desc) {
      kits[kit_pn].kit_desc = kit_desc;
    }

    const stockPn = String(r["Stock Component Part Number"] || "").trim();
    const stockQty = Number(r["Stock Qty Per Kit"]) || 0;
    const stockDesc = String(r["Stock Component Description"] || "").trim();

    const nonStockPn = String(r["Non-Stock Component Part Number"] || "").trim();
    const nonStockQty = Number(r["Non-Stock Qty Per Kit"]) || 0;

    if (stockPn && stockQty > 0) {
      kits[kit_pn].components.push({
        pn: stockPn,
        qty: stockQty,
        desc: stockDesc,
        isStock: true,
      });
      totalComponents++;
    } else if (nonStockPn && nonStockQty > 0) {
      kits[kit_pn].components.push({
        pn: nonStockPn,
        qty: nonStockQty,
        desc: "",
        isStock: false,
      });
      totalComponents++;
    } else {
      // Either zero qty or no component pn on this row — drill-template rows skip here.
      skipped++;
    }
  }

  // Replace DB.kitBoms in place so any reference (cloud-sync, UI) stays valid.
  if (!DB.kitBoms || typeof DB.kitBoms !== "object") DB.kitBoms = {};
  for (const k of Object.keys(DB.kitBoms)) delete DB.kitBoms[k];
  for (const [kit_pn, kit] of Object.entries(kits)) {
    DB.kitBoms[kit_pn] = kit;
  }

  saveDB();

  return {
    totalKits: Object.keys(kits).length,
    totalComponents,
    skipped,
  };
}

function getComponentsOfKit(kitPn) {
  const kit = DB.kitBoms?.[kitPn];
  return kit?.components || [];
}

function isKit(pn) {
  return !!(DB.kitBoms && DB.kitBoms[pn]);
}

function getKitsForComponent(componentPn) {
  if (!DB.kitBoms) return [];
  const out = [];
  for (const kit of Object.values(DB.kitBoms)) {
    if ((kit.components || []).some(c => c.pn === componentPn)) {
      out.push(kit);
    }
  }
  return out;
}

window.importKitBomsFromExcel = importKitBomsFromExcel;
window.getKitsForComponent = getKitsForComponent;
window.getComponentsOfKit = getComponentsOfKit;
window.isKit = isKit;
