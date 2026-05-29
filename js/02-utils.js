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
const isoDate = (d) => {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toISOString().slice(0,10);
};
const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
const ucFirst = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
const round = (n, d=0) => Math.round(n * Math.pow(10,d)) / Math.pow(10,d);
const clamp = (n, mn, mx) => Math.max(mn, Math.min(mx, n));
const displayBuyer = (po) => (po && po.buyer) ? po.buyer : "";

function uid(prefix="id") {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function nextPONumber() {
  const n = DB.poNum || (DB.settings.poNumStart || 10001);
  DB.poNum = n + 1;
  return DB.settings.poPrefix + n;
}
