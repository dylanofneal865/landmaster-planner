/* =====================================================
   41-kit-boms.js
   Kit BOM (Bill of Materials) data: kit -> components mapping.
   Imported from Acumatica's "LM Planner Kit Components" GI.
   Used by Slice 2 to explode kit sales into component usage.
   ===================================================== */

async function importKitBomsFromExcel(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: false });

  const kits = {};
  let skipped = 0, totalComponents = 0;

  for (const r of rows) {
    const kitPn = String(r["Kit Part Number"] || "").trim();
    if (!kitPn) { skipped++; continue; }

    const kitDesc = String(r["Kit Description"] || "").trim();
    const stockPn = String(r["Stock Component Part Number"] || "").trim();
    const stockQty = parseFloat(String(r["Stock Qty Per Kit"] || "0").replace(/[^0-9.\-]/g, ""));
    const stockDesc = String(r["Stock Component Description"] || "").trim();
    const nonStockPn = String(r["Non-Stock Component Part Number"] || "").trim();
    const nonStockQty = parseFloat(String(r["Non-Stock Qty Per Kit"] || "0").replace(/[^0-9.\-]/g, ""));

    if (!kits[kitPn]) {
      kits[kitPn] = { kit_pn: kitPn, kit_desc: kitDesc, components: [] };
    }

    if (stockPn && stockQty > 0) {
      const already = kits[kitPn].components.find(c => c.pn === stockPn && c.isStock);
      if (!already) {
        kits[kitPn].components.push({ pn: stockPn, qty: stockQty, desc: stockDesc, isStock: true });
        totalComponents++;
      }
    }

    if (nonStockPn && nonStockQty > 0) {
      const already = kits[kitPn].components.find(c => c.pn === nonStockPn && !c.isStock);
      if (!already) {
        kits[kitPn].components.push({ pn: nonStockPn, qty: nonStockQty, desc: "", isStock: false });
        totalComponents++;
      }
    }
  }

  // In-place replace (preserves any references the cloud-sync hook may hold)
  for (const k of Object.keys(DB.kitBoms)) delete DB.kitBoms[k];
  Object.assign(DB.kitBoms, kits);

  const totalKits = Object.keys(kits).length;
  logAudit("kit-boms-import", `Imported ${totalKits} kit BOMs with ${totalComponents} component links`);
  saveDB();

  return { totalKits, totalComponents, skipped };
}

function isKit(pn) {
  return !!(DB.kitBoms && DB.kitBoms[pn]);
}

function getComponentsOfKit(kitPn) {
  if (!DB.kitBoms || !DB.kitBoms[kitPn]) return [];
  return DB.kitBoms[kitPn].components || [];
}

function getKitsForComponent(componentPn) {
  const out = [];
  if (!DB.kitBoms) return out;
  for (const kitPn of Object.keys(DB.kitBoms)) {
    const kit = DB.kitBoms[kitPn];
    const found = kit.components?.find(c => c.pn === componentPn);
    if (found) out.push({ kit_pn: kitPn, kit_desc: kit.kit_desc, qty_per_kit: found.qty, isStock: found.isStock });
  }
  return out;
}

window.importKitBomsFromExcel = importKitBomsFromExcel;
window.isKit = isKit;
window.getComponentsOfKit = getComponentsOfKit;
window.getKitsForComponent = getKitsForComponent;
