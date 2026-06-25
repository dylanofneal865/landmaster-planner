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

// Strip a trailing supersession suffix: a final "-<letters>" segment
// (e.g. 18931-R -> 18931, CA00057-R -> CA00057). Returns null when there's no
// such suffix — a trailing numeric segment like "18155-2" is NOT stripped.
function _stripKitSuffix(pn) {
  const m = String(pn || "").match(/^(.*)-[A-Za-z]+$/);
  return m ? m[1] : null;
}

// Shared kit-component resolver — the single source of truth for "what's in
// this kit". Order:
//   a. bom_links where parent === pn (the daily-synced LM Planner BOM data;
//      indexed via getBomChildrenIndex so this is O(1), not a 16k-row scan)
//   b. strip a trailing supersession suffix and retry bom_links — but ONLY if
//      the stripped PN actually exists as a bom_links parent
//   c. fall back to the hand-imported kit_boms[pn]
// Returns { components:[{pn, qty, …}], sourcePN, source } where source is
// "bom_links" | "bom_links_stripped" | "kit_boms" (or null when nothing
// resolves), so callers can show provenance and a wrong auto-strip is visible.
function resolveKitComponents(pn) {
  const empty = { components: [], sourcePN: null, source: null };
  if (!pn) return empty;
  const idx = (typeof getBomChildrenIndex === "function") ? getBomChildrenIndex() : null;

  // a. direct bom_links parent
  if (idx && idx.has(pn)) {
    const comps = idx.get(pn).map(c => ({ pn: c.child, qty: Number(c.qty) || 0, uom: c.uom || "" }));
    if (comps.length) return { components: comps, sourcePN: pn, source: "bom_links" };
  }

  // b. stripped supersession suffix → bom_links (only if the stripped PN is a real parent)
  const stripped = _stripKitSuffix(pn);
  if (idx && stripped && stripped !== pn && idx.has(stripped)) {
    const comps = idx.get(stripped).map(c => ({ pn: c.child, qty: Number(c.qty) || 0, uom: c.uom || "" }));
    if (comps.length) return { components: comps, sourcePN: stripped, source: "bom_links_stripped" };
  }

  // c. kit_boms fallback (preserve its desc/isStock so the drawer keeps its columns)
  const kb = (DB.kitBoms && DB.kitBoms[pn]) ? DB.kitBoms[pn] : null;
  if (kb && Array.isArray(kb.components) && kb.components.length) {
    const comps = kb.components.map(c => ({ pn: c.pn, qty: Number(c.qty) || 0, desc: c.desc || "", isStock: c.isStock }));
    return { components: comps, sourcePN: pn, source: "kit_boms" };
  }

  return empty;
}

// First-class kit test. A part is a kit when it's TAGGED itemType="kit" AND its
// components actually resolve (a tagged-but-unresolvable part must NOT render as
// a working kit). Accepts a part object (fast — used in the partsWithStatus
// hot loop) or a PN string. Parts without a DB.parts row fall back to legacy
// kit_boms membership so kit_boms-only kits (no catalog part) keep working.
function isKit(pnOrPart) {
  const part = (pnOrPart && typeof pnOrPart === "object")
    ? pnOrPart
    : (Array.isArray(DB.parts) ? DB.parts.find(p => p.pn === pnOrPart) : null);
  if (part) {
    if (part.itemType !== "kit") return false;
    return resolveKitComponents(part.pn).components.length > 0;
  }
  const kb = DB.kitBoms && DB.kitBoms[pnOrPart];
  return !!(kb && Array.isArray(kb.components) && kb.components.length > 0);
}

// Back-compat wrapper — now sources through the shared resolver (bom_links first,
// kit_boms fallback) so every kit-component reader stays in lock-step.
function getComponentsOfKit(kitPn) {
  return resolveKitComponents(kitPn).components;
}

// MIGRATION — tag every part that's present in kit_boms as itemType="kit", so
// the 143 hand-imported kits become first-class. Idempotent (skips parts already
// tagged) and only persists when something changed. kit_boms entries with no
// DB.parts row can't be tagged — they keep working via the legacy fallback in
// isKit / resolveKitComponents. Must run AFTER the cloud save-hook is installed
// so the changes are detected as dirty and pushed (see 30-supabase.js).
function tagKitsFromKitBoms() {
  if (!DB || !Array.isArray(DB.parts) || !DB.kitBoms) return 0;
  const partByPn = new Map(DB.parts.map(p => [p.pn, p]));
  let changed = 0;
  for (const pn of Object.keys(DB.kitBoms)) {
    const part = partByPn.get(pn);
    if (!part || part.itemType === "kit") continue;
    part.itemType = "kit";
    changed++;
  }
  if (changed > 0) {
    if (typeof logAudit === "function") logAudit("kit-migration", `Tagged ${changed} part(s) as itemType=kit from kit_boms membership`);
    if (typeof saveDB === "function") saveDB();
    if (typeof bumpStatusCache === "function") bumpStatusCache();
    console.log(`[kits] tagged ${changed} part(s) as itemType=kit from kit_boms`);
  }
  return changed;
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
window.resolveKitComponents = resolveKitComponents;
window.getComponentsOfKit = getComponentsOfKit;
window.getKitsForComponent = getKitsForComponent;
window.tagKitsFromKitBoms = tagKitsFromKitBoms;
