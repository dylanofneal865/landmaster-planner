/* =====================================================
   02-utils.js
   Sections: UTILITIES
   ===================================================== */

/* ============================================================
   UTILITIES
   ============================================================ */
const $ = (sel, ctx=document) => ctx.querySelector(sel);
const $$ = (sel, ctx=document) => Array.from(ctx.querySelectorAll(sel));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[m]));
const fmtNum = (n, d=0) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
};
const fmtMoney = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
};
const fmtMoneyDec = (n) => {
  if (n === null || n === undefined || isNaN(n)) return "—";
  return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const fmtDate = (d) => {
  if (!d) return "—";
  let dt;
  // Bare "YYYY-MM-DD" strings (from the Acumatica PO sync) must be parsed as
  // a local calendar date — `new Date("2026-05-27")` treats it as UTC midnight,
  // which shifts back one day for US users at render time.
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split("-").map(Number);
    dt = new Date(y, m - 1, day);
  } else {
    dt = (d instanceof Date) ? d : new Date(d);
  }
  if (isNaN(dt.getTime())) return "—";
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
};
const fmtDateLong = (d) => {
  if (!d) return "—";
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return "—";
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
};
const fmtTime = (d) => {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
// Projected stockout date string for a parts-with-status daysOfCover value.
// Returns M/D/YY in local time, or a phrase for edge cases:
//   Infinity         → ""             (caller decides whether to render)
//   0                → "STOCKED OUT"
//   > 365 (finite)   → ">1yr"
//   NaN / negative   → "?"
// Date is built via addDays(TODAY, ...) so it never goes through ISO/UTC —
// no off-by-one shift at the day boundary.
const stockoutDateStr = (daysOfCover) => {
  if (daysOfCover === Infinity) return "";
  if (typeof daysOfCover !== "number" || isNaN(daysOfCover) || daysOfCover < 0) return "?";
  if (daysOfCover === 0) return "STOCKED OUT";
  if (daysOfCover > 365) return ">1yr";
  const d = addDays(TODAY, daysOfCover);
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;
};
const isoDate = (d) => {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toISOString().slice(0,10);
};
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const ucFirst = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
const round = (n, d=0) => Math.round(n * Math.pow(10,d)) / Math.pow(10,d);
const clamp = (n, mn, mx) => Math.max(mn, Math.min(mx, n));
const displayBuyer = (po) => (po && po.buyer) ? po.buyer : "";

// Shared gate for all destructive actions (delete part / delete PO / remove
// PO line / delete usage / clear audit log / reset DB / delete supplier),
// plus the page-access gate on the Usage screens. Single password, one
// helper — change DELETE_PIN to rotate.
const DELETE_PIN = "4616";
function gateDelete() {
  const v = prompt("Enter delete password:");
  if (v === null) return false;
  if (v === DELETE_PIN) return true;
  showToast("Incorrect password", "warn");
  return false;
}

function uid(prefix="id") {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function nextPONumber() {
  const n = DB.poNum || (DB.settings.poNumStart || 10001);
  DB.poNum = n + 1;
  return DB.settings.poPrefix + n;
}
