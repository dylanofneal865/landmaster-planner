// Cycle Count -- MORNING ASSIGNMENT (cron).
//
// Runs weekday mornings (see netlify.toml). Populates
// cycle_count_items with three tiers:
//
//   HOT (every weekday, no recency limit):
//     * parts where onHand < 0 (real negative -- something wrong)
//     * parts where onHand <= 0 AND has a positive daily
//     * parts where (daily > 0) AND (onHand / daily) <= HOT_COVER_DAYS
//       (critical-status proxy: at or below one week of cover)
//     * operator-flagged pns from today already land as HOT via
//       cycle-count-write "flag" op -- we DON'T re-insert those,
//       just count them so the summary is right.
//
//   RUNWAY (Mondays only):
//     * daysOfCover < RUNWAY_COVER_DAYS AND not counted in the last
//       RUNWAY_RECENCY_DAYS days.
//     * shortest runway first.
//     * capped at RUNWAY_CAP_PER_WEEK; overflow rolls forward
//       naturally -- next Monday's cron re-considers.
//     * reason: "runway <N>d"
//
//   ROTATION (Mondays only):
//     * fill up to WEEKLY_TOTAL_TARGET total assignments this week
//       with least-recently-counted parts (nothing >180 days
//       uncounted -- oldest go first).
//     * frame SKUs (FRAME_PNS) forced onto a 30-day cycle: if any
//       frame pn hasn't been counted in >= FRAME_ROTATION_DAYS,
//       insert it regardless of the weekly cap.
//     * reason: "rotation" (or "rotation frame" for frames).
//
// IDEMPOTENCY: runs may fire more than once per morning (Netlify
// retries, manual triggers). For each planned pn we check whether
// an item already exists for today (or this week for RUNWAY /
// ROTATION) and skip if so.
//
// ISOLATION: reads parts + cycle_count_items + cycle_count_log,
// writes ONLY to cycle_count_items. NEVER touches parts, pos,
// po_receipts, or frame_schedule.

const { createClient } = require("@supabase/supabase-js");
const { classifyChainRole } = require("../../lib/supersession-server.js");

// Frames get forced onto a 30-day rotation cycle -- keeps the six
// finished-goods SKUs on a predictable audit rhythm. Kept in sync
// with lib/frame-scheduler.js FRAME_PNS.
const FRAME_PNS = ["UT101001", "UT101002", "UT101003", "UT101004", "UT101005", "UT101006"];

const HOT_COVER_DAYS = 7;              // <= 1 week of cover reads as critical
const RUNWAY_COVER_DAYS = 60;
const RUNWAY_RECENCY_DAYS = 45;
const RUNWAY_CAP_PER_WEEK = 45;
const WEEKLY_TOTAL_TARGET = 60;
const ROTATION_STALE_DAYS = 180;
const FRAME_ROTATION_DAYS = 30;
// Chain transition run-up window (fix 3b): predecessor is assigned
// as HOT when we're within `lead_time_of_successor + this many
// days` of the successor's transitionStartDate.
const TRANSITION_RUNUP_EXTRA_DAYS = 30;
// Cut-in follow-up window (fix 3d): successor gets a "cut-in --
// verify initial stock" reason when today - transitionStartDate is
// within this many days.
const POST_CUTIN_VERIFY_DAYS = 14;

// v-cc-loc-2 VENDOR-MANAGED (fix 2). Suppliers on this list are
// consignment / VMI -- the vendor counts them, we don't.
//
// v-cc-loc-3.1 BUGFIX -- 16U00003 (real supplier "FASTENAL
// COMPANY") kept being assigned after 8a7fced because the match
// was `VMI_SUPPLIERS.includes(supplierNorm)` -- exact equality,
// not the contains-match the header claimed. Fixed here to
// case-insensitive SUBSTRING match. Also reads the same field(s)
// the drawer round-trips: js/10's part-drawer SAVE writes to
// `part.supplier` (line 995ish, via id="pd-supplier"), and js/10's
// row / drawer reads all read `part.supplier`, so that is
// canonical. The legacy-alias check on `vendor` / `vendorName` /
// `Supplier` (case-variant) is a belt-and-suspenders catch for
// older rows a prior sync may have written with a different key.
//
// VMI_SUPPLIER_TOKENS: each entry is lowercased and matched as a
// substring against the lowercased trimmed supplier field. Add
// aliases (e.g. "fastenal", "fastenal, inc") to cover distinct
// legal names for the same vendor.
const VMI_SUPPLIER_TOKENS = ["fastenal"];
// Legacy alias kept for the older shipped constant name so an
// operator grepping the code base still finds one thing.
const VMI_SUPPLIERS = VMI_SUPPLIER_TOKENS;

// Reads every supplier-ish field on a part.data blob and returns
// true when any of them contains any VMI token as a substring
// (case-insensitive). js/10's drawer canonical is `supplier`; the
// aliases guard against older rows written under a different key
// before the drawer/sync stabilized on that name.
function _isVmiPart(d) {
  if (!d || typeof d !== "object") return false;
  const candidates = [
    d.supplier,
    d.vendor,
    d.vendorName,
    d.supplierName,
    d.Supplier,
    d.SupplierName,
  ];
  for (const raw of candidates) {
    const norm = String(raw || "").toLowerCase().trim();
    if (!norm) continue;
    for (const token of VMI_SUPPLIER_TOKENS) {
      if (token && norm.includes(token)) return true;
    }
  }
  return false;
}

function _todayIsoUtc() {
  const d = new Date();
  return d.getFullYear() + "-"
    + String(d.getMonth() + 1).padStart(2, "0") + "-"
    + String(d.getDate()).padStart(2, "0");
}

function _mondayOfIso(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  const dow = dt.getDay(); // 0=Sun..6=Sat
  const shift = (dow === 0) ? -6 : (1 - dow);
  dt.setDate(dt.getDate() + shift);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function _daysBetweenIso(isoOlder, isoNewer) {
  const older = new Date(isoOlder);
  const newer = new Date(isoNewer);
  if (isNaN(older) || isNaN(newer)) return Infinity;
  return Math.floor((newer.getTime() - older.getTime()) / (24 * 60 * 60 * 1000));
}

async function _fetchAll(supa, table, cols) {
  const all = [];
  const PAGE = 1000;
  let from = 0;
  while (true) {
    const { data, error } = await supa.from(table).select(cols).range(from, from + PAGE - 1);
    if (error) throw new Error(`fetch ${table} failed: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

exports.handler = async (event) => {
  const t0 = Date.now();
  const log = (msg, data) => console.log(`[cycle-count-assign] ${msg}`, data === undefined ? "" : data);
  const isCron = !!(event && event.headers && (event.headers["x-nf-scheduled"] || event.headers["X-Nf-Scheduled"]));

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: "server not configured" }) };
  }

  const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const today = _todayIsoUtc();
  const monday = _mondayOfIso(today);
  const weekday = new Date(today).getUTCDay(); // 0=Sun..6=Sat, UTC
  const isMonday = weekday === 1;
  const isWeekend = weekday === 0 || weekday === 6;
  const q = (event && event.queryStringParameters) || {};
  const force = q.force === "1" || q.force === "true";
  const dryRun = q.dry === "1" || q.dry === "true";

  if (isWeekend && !force) {
    log("weekend -- skipping (pass ?force=1 to run anyway)");
    return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: "weekend", today, weekday }) };
  }

  // ---- Load inputs ----------------------------------------------
  // v-cc-loc-2 -- pos loaded too, for handoff-watch (fix 3c).
  // v-cc-loc-4 -- part_locations loaded so we can build PHYSICAL
  // on-hand per pn (sum non-sentinel locations, else __warehouse__
  // sentinel, else fall back to parts.data.onHand).
  let partsRows, todaysItems, weeksItems, posRows, locRows, lastCountedByPn;
  try {
    [partsRows, todaysItems, weeksItems, posRows, locRows] = await Promise.all([
      _fetchAll(supa, "parts", "pn, data"),
      _fetchAll(supa, "cycle_count_items", "pn, tier, assigned_date, status"),  // filtered below
      _fetchAll(supa, "cycle_count_log", "pn, counted_at, outcome"),  // for last-counted-by-pn
      _fetchAll(supa, "pos", "id, data"),                              // for onPO per pn
      _fetchAll(supa, "part_locations", "pn, location, qty"),          // for physical on-hand
    ]);
  } catch (err) {
    log("input fetch failed", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: "input fetch failed", detail: err.message }) };
  }

  // v-cc-loc-4 -- physical on-hand per pn. Priority:
  //   1. Sum of non-sentinel part_locations rows (per-location pns)
  //   2. __warehouse__ sentinel row's qty (aggregate-only pns)
  //   3. parts.data.onHand FALLBACK (only for pns Acumatica hasn't
  //      synced a location row for yet -- rare; keeps HOT alive
  //      for a new pn between its parts-row creation and the next
  //      location sync).
  // The fallback uses available (parts.data.onHand); the log flags
  // how many pns hit that path so we can watch for drift.
  const WAREHOUSE_SENTINEL = "__warehouse__";
  const physicalByPn = new Map();
  const sentinelByPn = new Map();
  const locSumByPn = new Map();
  for (const l of (locRows || [])) {
    if (!l || !l.pn) continue;
    const qty = Number(l.qty) || 0;
    if (String(l.location) === WAREHOUSE_SENTINEL) {
      sentinelByPn.set(l.pn, qty);
    } else {
      locSumByPn.set(l.pn, (locSumByPn.get(l.pn) || 0) + qty);
    }
  }
  const physicalSourceStats = { fromLocations: 0, fromSentinel: 0, fromFallback: 0 };
  function _physicalFor(pn, availFallback) {
    if (locSumByPn.has(pn)) { physicalSourceStats.fromLocations++; return locSumByPn.get(pn); }
    if (sentinelByPn.has(pn)) { physicalSourceStats.fromSentinel++; return sentinelByPn.get(pn); }
    physicalSourceStats.fromFallback++;
    return Number(availFallback) || 0;
  }
  // Reduce items to today + this-week sets.
  const hotTodayPns = new Set(
    todaysItems.filter(r => r && r.assigned_date === today && r.tier === "hot").map(r => r.pn)
  );
  const runwayThisWeekPns = new Set(
    todaysItems.filter(r => r && r.tier === "runway" && r.assigned_date >= monday).map(r => r.pn)
  );
  const rotationThisWeekPns = new Set(
    todaysItems.filter(r => r && r.tier === "rotation" && r.assigned_date >= monday).map(r => r.pn)
  );
  const anyThisWeekPns = new Set(
    todaysItems.filter(r => r && r.assigned_date >= monday).map(r => r.pn)
  );
  const weeklyTotalSoFar = new Set(anyThisWeekPns).size;

  // Latest counted_at per pn (from log; only "counted"/"reconciled"
  // outcomes count as a valid last-count for recency purposes --
  // "skipped" doesn't reset the clock).
  lastCountedByPn = new Map();
  for (const r of weeksItems) {
    if (!r || !r.pn) continue;
    if (r.outcome !== "counted" && r.outcome !== "reconciled") continue;
    const prev = lastCountedByPn.get(r.pn);
    if (!prev || String(r.counted_at) > String(prev)) lastCountedByPn.set(r.pn, r.counted_at);
  }

  // Live catalog map. Cycle counts are for PRODUCTION parts only --
  // Base BOM per the part drawer's ITEM TYPE selector (js/10, field
  // part.itemType stored as the lowercase string "base_bom"). The
  // six FRAME_PNS are already tagged base_bom so they carry through
  // unchanged. Excludes: Options, Service, Kit, Do Not Order, and
  // any parts with no itemType set (untagged catalog rows are not
  // production-eligible until an operator classifies them).
  //
  // v-cc-loc-2 also excludes:
  //   * VMI suppliers (fix 2, VMI_SUPPLIERS)
  //   * phasingOut parts (burning down; not on the audit rhythm)
  //
  // We still want the FULL raw-data map (allPartsData) so the chain
  // classifier can walk supersededBy links across the whole catalog
  // -- a predecessor of a base_bom successor might itself be tagged
  // Options / Service, and the lineage walk needs to see it.
  const allPartsData = new Map();
  for (const p of partsRows) {
    if (!p || !p.pn) continue;
    allPartsData.set(String(p.pn), p.data || {});
  }
  const allEntries = [...allPartsData.entries()];
  const todayDateForChain = new Date(today + "T00:00:00");
  todayDateForChain.setHours(0, 0, 0, 0);

  // Local helper: "does this part's own transitionStartDate say
  // it's still pre-launch today?" -- byte-for-byte with js/03
  // isPreLaunch(part) semantics (parse as local midnight, future
  // start = pre-launch; missing or past = not). Chained-successor
  // pre-launch is decided by classifyChainMember above and its
  // successor.transitionStartDate check, which reads the same
  // field the same way -- so the two callsites agree.
  function _isStandalonePreLaunch(d) {
    const raw = d && d.transitionStartDate;
    if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(raw)) return false;
    const [y, mo, da] = raw.slice(0, 10).split("-").map(Number);
    const dt = new Date(y, mo - 1, da);
    dt.setHours(0, 0, 0, 0);
    if (isNaN(dt.getTime())) return false;
    return dt.getTime() > todayDateForChain.getTime();
  }

  // v-cc-loc-3.1 -- one-shot diagnostic for the pn the operator
  // called out as still slipping through the VMI filter. Prints
  // the raw parts.data key list + every supplier-ish value so the
  // next run's log shows exactly what shape the row is stored in
  // (proves whether the drawer save path uses `supplier`, an
  // alias, or something else entirely). Cheap: one log line when
  // the row exists, nothing when it doesn't.
  const DIAG_PN = "16U00003";
  const diagRow = partsRows.find(r => r && String(r.pn) === DIAG_PN);
  if (diagRow) {
    const d = diagRow.data || {};
    log(`[VMI-DIAG] ${DIAG_PN} parts.data keys: ${Object.keys(d).sort().join(", ")}`);
    log(`[VMI-DIAG] ${DIAG_PN} supplier-ish values: supplier=${JSON.stringify(d.supplier)} vendor=${JSON.stringify(d.vendor)} vendorName=${JSON.stringify(d.vendorName)} supplierName=${JSON.stringify(d.supplierName)} Supplier=${JSON.stringify(d.Supplier)} SupplierName=${JSON.stringify(d.SupplierName)}`);
    log(`[VMI-DIAG] ${DIAG_PN} _isVmiPart => ${_isVmiPart(d)}`);
  } else {
    log(`[VMI-DIAG] ${DIAG_PN} not present in parts feed`);
  }

  const partsByPn = new Map();
  let excludedNonBaseBom = 0;
  let excludedPhasingOut = 0;   // count only; retained in partsByPn -- see note
  let excludedVmi = 0;
  let excludedQueuedChain = 0;         // v-cc-loc-6: queued chain members (any hops)
  let excludedRetiredChain = 0;        // v-cc-loc-6: fully-burned-down predecessors
  let excludedPreLaunchStandalone = 0;
  // v-cc-loc-6 -- as we filter, remember every chain we swept a
  // queued/retired member from so the plan loop can force-assign
  // the chain's ACTIVE member (the one that actually needs to be
  // counted) alongside the sweep. Keyed by anchorPn so each chain
  // only lands once.
  const chainsNeedingActive = new Map();
  for (const p of partsRows) {
    if (!p || !p.pn) continue;
    const d = p.data || {};
    const itemType = String(d.itemType || "").toLowerCase().trim();
    if (itemType !== "base_bom") { excludedNonBaseBom++; continue; }
    if (_isVmiPart(d)) { excludedVmi++; continue; }
    // v-cc-loc-6 -- MULTI-HOP CHAIN CLASSIFICATION.
    //   QUEUED   -- any hops out with a future transitionStartDate
    //               OR any lineage member AFTER the ACTIVE index
    //               (implicit queue). Never HOT for zero/negative.
    //   RETIRED  -- lineage members ordered BEFORE the ACTIVE member.
    //               With zero stock, nothing to count -> excluded.
    //               With residual stock (unusual: a burned-down
    //               predecessor that unexpectedly has units), we
    //               KEEP it in partsByPn so the HOT loop can still
    //               catch real anomalies.
    //   ACTIVE   -- the member currently being consumed; fed into
    //               partsByPn and evaluated by the HOT chain rules
    //               below (transition run-up, handoff-risk, cut-in).
    //   Chain not transitioning / not in a chain -> standalone,
    //   evaluated by the plain (non-chain) rules.
    const chain = classifyChainRole(String(p.pn), allPartsData, allEntries, todayDateForChain);
    if (chain.transitioning) {
      if (chain.role === "queued") {
        excludedQueuedChain++;
        chainsNeedingActive.set(chain.anchorPn, chain);
        continue;
      }
      if (chain.role === "retired") {
        const stock = _physicalFor(String(p.pn), d.onHand);
        if (stock <= 0) {
          excludedRetiredChain++;
          chainsNeedingActive.set(chain.anchorPn, chain);
          continue;
        }
        // Residual-stock retired -- fall through to partsByPn so
        // real negatives / anomalies still land in HOT.
      }
      // role === "active" -> fall through to the partsByPn insert
      // below; chain-hot reasons decided in the HOT loop.
    }
    // v-cc-loc-3 -- STANDALONE pre-launch parts (own
    // transitionStartDate in the future, no chain / not a chain
    // successor) also get excluded from HOT. Same reason: zero
    // on-hand is the expected state until cut-in -- flagging it
    // burns a slot on the daily list for no audit value. The
    // policy sweep gives these rows their own note so they can
    // be told apart from chain-successors in the log:
    //   "pre-launch -- excluded until cut-in window"
    if (_isStandalonePreLaunch(d)) {
      excludedPreLaunchStandalone++;
      continue;
    }
    // Fix 3b: phasingOut is normally dropped from RUNWAY / ROTATION
    // (they're being burned down and aren't on the audit rhythm),
    // but a phasing-out chain PREDECESSOR in the transition run-up
    // window MUST still reach the HOT loop so the run-up rule can
    // force it -- the chain's runway depends on that count being
    // accurate. Keep phasingOut parts in the map with a flag; the
    // per-tier loops decide what to do with them.
    if (d.phasingOut) excludedPhasingOut++;
    // v-cc-loc-4 -- onHand is PHYSICAL (shelf) qty from
    // part_locations. Zero-on-hand HOT should only fire when the
    // shelf is actually empty; a part with 0 available but 5
    // allocated is still 5 on the shelf and should not be tagged
    // zero-onHand. RUNWAY / ROTATION cover math still uses the
    // physical figure -- runway is about "when does the bin get
    // empty", same physical shelf.
    const physical = _physicalFor(String(p.pn), d.onHand);
    partsByPn.set(String(p.pn), {
      pn: String(p.pn),
      onHand: physical,                       // PHYSICAL, was parts.data.onHand
      available: Number(d.onHand) || 0,        // kept for diagnostics only
      daily: Number(d.daily) || 0,
      partClass: d.partClass || "",
      itemType,
      supplier: d.supplier || "",
      ltWeeks: Number(d.ltWeeks) || 0,
      phasingOut: !!d.phasingOut,
      chain,   // pre-computed so the HOT loop reads it O(1)
    });
  }
  log(`catalog scope: ${partsByPn.size} base_bom parts eligible; skipped ${excludedNonBaseBom} non-BaseBOM, ${excludedVmi} vendor-managed, ${excludedQueuedChain} queued-chain, ${excludedRetiredChain} retired-chain, ${excludedPreLaunchStandalone} pre-launch-standalone (${excludedPhasingOut} of the eligible carry phasingOut -- HOT chain rules apply, RUNWAY/ROTATION skip them; ${chainsNeedingActive.size} chain(s) will force-assign their active member)`);
  log(`[PHYSICAL] on-hand source per eligible pn: ${physicalSourceStats.fromLocations} from location-sum, ${physicalSourceStats.fromSentinel} from __warehouse__ sentinel, ${physicalSourceStats.fromFallback} from parts.data.onHand fallback (no location row yet)`);

  // Pre-compute onPO per pn from the loaded pos rows -- used by the
  // handoff-watch (fix 3c). PO shape (mirrors the client's DB.pos):
  // po.data.lines is an array of {pn, qty, qtyReceived, ...}.
  const onPoByPn = new Map();
  for (const po of (posRows || [])) {
    const d = (po && po.data) || {};
    if (d.status && String(d.status).toLowerCase() === "closed") continue;
    const lines = Array.isArray(d.lines) ? d.lines : [];
    for (const ln of lines) {
      if (!ln || !ln.pn) continue;
      // Skip blanket lines -- they're commitments, not scheduled
      // deliveries. Approximation matches openPOQty in js/03: any
      // line with type === "blanket" excluded.
      if (String(ln.type || "").toLowerCase() === "blanket") continue;
      const remaining = Math.max(0, (Number(ln.qty) || 0) - (Number(ln.qtyReceived) || 0));
      if (remaining <= 0) continue;
      const key = String(ln.pn);
      onPoByPn.set(key, (onPoByPn.get(key) || 0) + remaining);
    }
  }

  // BACKLOG CLEANUP -- any currently-pending item whose pn is no
  // longer eligible gets marked "skipped" with a policy note. The
  // note prefix ("non-BaseBOM", "vendor-managed", "pre-launch
  // successor", "phasing-out") is later matched by js/26's
  // _isAutoSweptSkip so these auto-skips DON'T inflate the
  // completion metric (fix 1). Operator skips have a typed reason
  // that never starts with "excluded by policy" -- they stay in
  // the denominator as unworked.
  //
  // Ineligibility is decided by rebuilding the exclusion set from
  // the current parts.data feed: not-in-partsByPn AND we know why
  // (non-BaseBOM / VMI / pre-launch successor / phasing-out).
  // Anything ineligible for an unknown reason falls back to
  // "non-BaseBOM -- excluded by policy" so the sweep is complete.
  //
  // NOTE: we intentionally do NOT append a cycle_count_log row for
  // these -- log rows are completed audit work.
  function _sweepNoteFor(pn) {
    const d = allPartsData.get(pn);
    if (!d) return "non-BaseBOM -- excluded by policy";
    const itemType = String(d.itemType || "").toLowerCase().trim();
    if (itemType !== "base_bom") return "non-BaseBOM -- excluded by policy";
    if (_isVmiPart(d)) return "vendor-managed -- excluded by policy";
    // v-cc-loc-6 -- multi-hop chain awareness. QUEUED/RETIRED
    // members get a specific note pointing at the ACTIVE member.
    // Two adjacent notes let the supervisor see WHY a pn stopped
    // being on the list and WHERE to look instead.
    const chain = classifyChainRole(pn, allPartsData, allEntries, todayDateForChain);
    if (chain.transitioning) {
      if (chain.role === "queued") {
        return "chain -- counting active member " + chain.activePn + " instead";
      }
      if (chain.role === "retired") {
        const stock = _physicalFor(pn, d.onHand);
        if (stock <= 0) return "chain -- counting active member " + chain.activePn + " instead";
        // Residual stock retired -- fall through (keep normal
        // handling; note not needed since not swept).
      }
    }
    if (d.phasingOut) return "phasing-out -- excluded by policy";
    if (_isStandalonePreLaunch(d)) return "pre-launch -- excluded until cut-in window";
    return "non-BaseBOM -- excluded by policy";
  }

  const openItems = todaysItems.filter(r => r && (r.status === "pending" || r.status === "recount"));
  const ineligibleOpen = openItems.filter(r => !partsByPn.has(String(r.pn)));
  // Bucket ineligibles by the exact policy note so each row gets
  // the right reason (and we can log a per-policy tally). Fewer
  // round trips: one UPDATE per bucket.
  const buckets = new Map();
  for (const r of ineligibleOpen) {
    const pn = String(r.pn);
    const note = _sweepNoteFor(pn);
    let b = buckets.get(note);
    if (!b) { b = new Set(); buckets.set(note, b); }
    b.add(pn);
  }
  let cleanedOpen = 0;
  const cleanedByPolicy = {};
  if (buckets.size > 0 && !dryRun) {
    const nowIso = new Date().toISOString();
    for (const [note, pnSet] of buckets.entries()) {
      const { data: cleaned, error: cleanErr } = await supa
        .from("cycle_count_items")
        .update({
          status: "skipped",
          note,
          updated_at: nowIso,
        })
        .in("status", ["pending", "recount"])
        .in("pn", [...pnSet])
        .select("id, pn");
      if (cleanErr) {
        log("backlog cleanup failed (non-fatal)", { note, message: cleanErr.message });
        continue;
      }
      const n = (cleaned || []).length;
      cleanedOpen += n;
      cleanedByPolicy[note] = n;
    }
    log(`backlog cleanup: skipped ${cleanedOpen} open row(s) across ${buckets.size} policy bucket(s): ${JSON.stringify(cleanedByPolicy)}`);
  } else if (buckets.size > 0 && dryRun) {
    for (const [note, pnSet] of buckets.entries()) {
      cleanedByPolicy[note] = pnSet.size;
    }
    log(`backlog cleanup (dry): would skip ${ineligibleOpen.length} open row(s): ${JSON.stringify(cleanedByPolicy)}`);
  }

  const plans = [];   // rows to insert
  const summary = {
    hot: 0,
    runway: 0,
    rotation: 0,
    framesForced: 0,
    skippedExisting: 0,
    excludedNonBaseBom,
    excludedVmi,
    excludedQueuedChain,
    excludedRetiredChain,
    excludedPreLaunchStandalone,
    excludedPhasingOut,
    chainsWithForcedActive: chainsNeedingActive.size,
    backlogCleaned: cleanedOpen,
    cleanedByPolicy,
    // per-reason HOT tally, filled below.
    hotReasons: {},
  };
  const bumpReason = (label) => {
    summary.hotReasons[label] = (summary.hotReasons[label] || 0) + 1;
  };

  // ---- HOT -------------------------------------------------------
  //
  // v-cc-loc-2 CHAIN-AWARE HOT (fixes 3a-3d):
  //
  //   3a  Pre-launch successors are already dropped from partsByPn
  //       above, so they can't reach this loop -- their zero on-hand
  //       is expected and MUST NOT flag HOT.
  //
  //   3b  In the transition run-up window (today within lead_time +
  //       30 days of the successor's cut-in), the PREDECESSOR is
  //       forced HOT regardless of stock level -- the chain's
  //       runway depends on the old part being accurately counted.
  //       Reason: "transition -- chain runs on <old pn> until
  //       <cut-in>; verify remaining stock". Overrides / wins over
  //       the plain onHand/cover reason if the predecessor already
  //       qualified.
  //
  //   3c  HANDOFF WATCH -- when the chain's combined runway (sum
  //       of on-hand across lineage / anchor's daily) will run out
  //       BEFORE the successor's on-order stock arrives (proxied
  //       here as `chainRunoutDays <= leadDaysOfSuccessor` AND
  //       successor.onPO === 0), BOTH the predecessor AND the
  //       successor are forced HOT with reason "transition at risk
  //       -- count both ends", regardless of the recency cap.
  //       Loading pos costs one extra table read per run (added
  //       above); the classifier caches per-chain evaluation via
  //       chainHandoffAssessed so a lineage is only priced once.
  //
  //   3d  After cut-in (today >= transitionStartDate) but within
  //       POST_CUTIN_VERIFY_DAYS, the successor is forced HOT with
  //       reason "cut-in -- verify initial stock". The predecessor
  //       reverts to normal rules (whatever HOT criteria stock
  //       levels imply, plus rotation on Mondays).
  //
  // A chain's assessment is idempotent per run -- chainHandoffAssessed
  // stores the outcome keyed by anchorPn.
  // v-cc-loc-6 -- chain rules refactored around the ACTIVE / QUEUED /
  // RETIRED role trio from classifyChainRole:
  //   * Transition run-up: force the ACTIVE pn (regardless of hop
  //     count) when today is within lead_time_of_next_queued + 30
  //     days of the next queued member's cut-in.
  //   * Post-cut-in: force whichever chain member just cut in
  //     (its own role flips to active on the day, with a past
  //     transitionStartDate) with "cut-in -- verify initial stock".
  //   * Handoff-risk: for the CURRENTLY-ACTIVE member and the NEXT
  //     queued member. Assessed once per chain (by anchor); the
  //     next queued's onPO is what we watch, not the terminal's.
  const chainHandoffAssessed = new Map();
  const forcedHotByPn = new Map();   // pn -> reason (from chain rules)
  const chainMeta = new Map();       // anchorPn -> chain descriptor (for the
                                     // active-member force-assign below)
  for (const [pn, p] of partsByPn.entries()) {
    const c = p.chain;
    if (!c || !c.transitioning) continue;
    // Track every transitioning chain we see so the force-assign
    // pass below can walk them all.
    chainMeta.set(c.anchorPn, c);
    // TRANSITION RUN-UP -- fires on the ACTIVE member only. The
    // active pn stays the current one (regardless of hop count);
    // "next cut-in" is the next queued member's own date.
    if (c.role === "active" && c.daysUntilStart !== null && c.daysUntilStart >= 0) {
      const nextPnData = allPartsData.get(c.nextQueuedPn) || {};
      const leadDaysNext = (Number(nextPnData.ltWeeks) || 0) * 7;
      const window = leadDaysNext + TRANSITION_RUNUP_EXTRA_DAYS;
      if (c.daysUntilStart <= window) {
        const cutInIso = c.nextCutinDate
          ? (c.nextCutinDate.getFullYear() + "-" + String(c.nextCutinDate.getMonth() + 1).padStart(2, "0") + "-" + String(c.nextCutinDate.getDate()).padStart(2, "0"))
          : "unknown";
        forcedHotByPn.set(pn, `transition -- chain runs on ${pn} until ${cutInIso}; verify remaining stock`);
      }
    }
    // POST-CUT-IN -- fires when the ACTIVE pn's OWN
    // transitionStartDate is within POST_CUTIN_VERIFY_DAYS
    // in the past (freshly cut in).
    if (c.role === "active" && c.postCutInSuccessor) {
      forcedHotByPn.set(pn, "cut-in -- verify initial stock");
    }
    // HANDOFF WATCH -- assess once per chain (by anchor). Applies
    // to ACTIVE + NEXT queued specifically.
    if (!chainHandoffAssessed.has(c.anchorPn)) {
      const nextPn = c.nextQueuedPn;
      if (nextPn) {
        const nextData = allPartsData.get(nextPn) || {};
        const leadDaysNext = (Number(nextData.ltWeeks) || 0) * 7;
        const nextOnPo = Number(onPoByPn.get(nextPn) || 0);
        // Combined chain on-hand from raw parts data.
        let chainOnHand = 0;
        for (const memberPn of c.lineage) {
          const mp = allPartsData.get(memberPn);
          chainOnHand += Math.max(0, Number(mp && mp.onHand) || 0);
        }
        const anchor = allPartsData.get(c.anchorPn) || {};
        const anchorDaily = Number(anchor.daily) || 0;
        const chainRunoutDays = anchorDaily > 0 ? (chainOnHand / anchorDaily) : Infinity;
        const atRisk = (nextOnPo <= 0) && Number.isFinite(chainRunoutDays) && chainRunoutDays <= (leadDaysNext + TRANSITION_RUNUP_EXTRA_DAYS);
        chainHandoffAssessed.set(c.anchorPn, { atRisk, chainOnHand, chainRunoutDays, leadDaysNext, nextOnPo, nextPn, activePn: c.activePn });
        if (atRisk) {
          // ACTIVE + NEXT queued -- but the NEXT queued isn't in
          // partsByPn (it was filtered out). The HOT loop iterates
          // partsByPn, so setting forcedHotByPn on the queued pn
          // won't fire from that loop -- handle it as a
          // "chainsNeedingActive" force-assign below with the
          // atRisk-both-ends note.
          forcedHotByPn.set(c.activePn, "transition at risk -- count both ends");
        }
      } else {
        chainHandoffAssessed.set(c.anchorPn, { atRisk: false });
      }
    }
  }

  for (const [pn, p] of partsByPn.entries()) {
    if (hotTodayPns.has(pn)) { summary.skippedExisting++; continue; }
    let hot = false;
    let reason = "";
    // Chain-forced reasons win over plain stock-level reasons.
    if (forcedHotByPn.has(pn)) {
      hot = true;
      reason = forcedHotByPn.get(pn);
    } else if (p.phasingOut) {
      // A phasing-out part without a chain-forced reason is being
      // deliberately burned down -- don't count it just because it
      // trips a stock-level threshold. The chain rules above
      // handle the "still active predecessor" case.
      continue;
    } else if (p.onHand < 0) {
      hot = true;
      reason = `negative on-hand (${p.onHand})`;
    } else if (p.onHand <= 0) {
      hot = true;
      reason = "zero on-hand";
    } else if (p.daily > 0) {
      const cover = p.onHand / p.daily;
      if (cover <= HOT_COVER_DAYS) {
        hot = true;
        reason = `critical -- ${cover.toFixed(1)}d cover`;
      }
    }
    if (!hot) continue;
    // Categorize the reason for reporting.
    let reasonLabel = "critical-cover";
    if (reason.startsWith("negative")) reasonLabel = "negative-onHand";
    else if (reason === "zero on-hand") reasonLabel = "zero-onHand";
    else if (reason.startsWith("transition at risk")) reasonLabel = "chain-handoff-risk";
    else if (reason.startsWith("transition --")) reasonLabel = "chain-runup-active";
    else if (reason.startsWith("cut-in --")) reasonLabel = "chain-postcutin-active";
    bumpReason(reasonLabel);
    plans.push({
      assigned_date: today,
      tier: "hot",
      reason,
      pn,
      system_qty_at_assign: p.onHand,
      status: "pending",
    });
    summary.hot++;
  }

  // v-cc-loc-6 -- FORCE-ASSIGN THE ACTIVE MEMBER of every chain we
  // swept a queued/retired member from, so the swap from "count JP"
  // to "count 19920" is visible in the same run rather than silent.
  // Skip when:
  //   * activePn is already in plans (would double-add)
  //   * activePn is already on hotTodayPns (existing item covers it)
  //   * activePn isn't in partsByPn (excluded upstream -- shouldn't
  //     happen for a valid active member but be defensive)
  for (const [anchorPn, c] of chainsNeedingActive.entries()) {
    const activePn = c.activePn;
    if (!activePn) continue;
    if (hotTodayPns.has(activePn)) continue;
    if (plans.some(pl => pl.pn === activePn)) continue;
    const activeRow = partsByPn.get(activePn);
    if (!activeRow) {
      // Active member isn't Base BOM or was filtered for another
      // policy reason. Log and move on -- we can't force it in.
      log(`[chain] active member ${activePn} for anchor ${anchorPn} not in partsByPn (was it filtered upstream?); skipping force-assign`);
      continue;
    }
    // Reason: prefer the chain-forced reason from the HOT loop if
    // one was set (handoff-risk / run-up / cut-in), else generic
    // "chain -- active member; verify remaining stock".
    let reason = forcedHotByPn.get(activePn);
    if (!reason) reason = "chain -- active member " + activePn + "; verify remaining stock";
    bumpReason("chain-active-force-assigned");
    plans.push({
      assigned_date: today,
      tier: "hot",
      reason,
      pn: activePn,
      system_qty_at_assign: activeRow.onHand,
      status: "pending",
    });
    summary.hot++;
  }

  // ---- RUNWAY + ROTATION -- Mondays only ------------------------
  if (isMonday) {
    // RUNWAY.
    const runwayCandidates = [];
    for (const [pn, p] of partsByPn.entries()) {
      if (runwayThisWeekPns.has(pn)) continue;
      if (hotTodayPns.has(pn)) continue;   // HOT wins the same-day battle
      if (p.phasingOut) continue;          // burn-down parts skip RUNWAY
      if (p.daily <= 0) continue;
      const cover = p.onHand / p.daily;
      if (cover >= RUNWAY_COVER_DAYS) continue;
      const lastAt = lastCountedByPn.get(pn);
      if (lastAt && _daysBetweenIso(lastAt, today) < RUNWAY_RECENCY_DAYS) continue;
      runwayCandidates.push({ pn, cover, p });
    }
    runwayCandidates.sort((a, b) => a.cover - b.cover);
    const runwayLimit = Math.max(0, RUNWAY_CAP_PER_WEEK);
    for (const c of runwayCandidates.slice(0, runwayLimit)) {
      plans.push({
        assigned_date: today,
        tier: "runway",
        reason: `runway ${c.cover.toFixed(1)}d`,
        pn: c.pn,
        system_qty_at_assign: c.p.onHand,
        status: "pending",
      });
      summary.runway++;
    }

    // ROTATION -- fill to WEEKLY_TOTAL_TARGET with LRU counts,
    // nothing >ROTATION_STALE_DAYS uncounted, plus forced frames
    // on 30-day cycle.
    const already = weeklyTotalSoFar + summary.hot + summary.runway;
    const rotationSlots = Math.max(0, WEEKLY_TOTAL_TARGET - already);
    const rotationCandidates = [];
    for (const [pn, p] of partsByPn.entries()) {
      if (rotationThisWeekPns.has(pn)) continue;
      if (hotTodayPns.has(pn)) continue;
      if (runwayThisWeekPns.has(pn) || plans.some(pl => pl.pn === pn)) continue;
      if (p.phasingOut) continue;          // burn-down parts skip ROTATION
      const lastAt = lastCountedByPn.get(pn);
      const daysSince = lastAt ? _daysBetweenIso(lastAt, today) : Infinity;
      rotationCandidates.push({ pn, daysSince, p, isFrame: FRAME_PNS.includes(pn) });
    }
    // Force frames on their 30-day cycle regardless of the cap.
    for (const c of rotationCandidates) {
      if (!c.isFrame) continue;
      if (c.daysSince < FRAME_ROTATION_DAYS) continue;
      plans.push({
        assigned_date: today,
        tier: "rotation",
        reason: `rotation frame (${c.daysSince === Infinity ? "never" : c.daysSince + "d"} since last count)`,
        pn: c.pn,
        system_qty_at_assign: c.p.onHand,
        status: "pending",
      });
      summary.rotation++;
      summary.framesForced++;
    }
    // Fill remaining slots with oldest-counted first (Infinity is
    // never-counted -- ranks worst).
    rotationCandidates.sort((a, b) => (b.daysSince === Infinity ? Number.MAX_SAFE_INTEGER : b.daysSince) - (a.daysSince === Infinity ? Number.MAX_SAFE_INTEGER : a.daysSince));
    let picked = 0;
    for (const c of rotationCandidates) {
      if (picked >= rotationSlots) break;
      if (c.isFrame && c.daysSince >= FRAME_ROTATION_DAYS) continue;  // already forced above
      if (plans.some(pl => pl.pn === c.pn)) continue;
      // Ignore if never-counted AND weekly quota is already met
      // (age > STALE always wins).
      const staleWin = c.daysSince >= ROTATION_STALE_DAYS;
      if (!staleWin && picked >= rotationSlots) break;
      plans.push({
        assigned_date: today,
        tier: "rotation",
        reason: c.daysSince === Infinity ? "rotation (never counted)" : `rotation (${c.daysSince}d)`,
        pn: c.pn,
        system_qty_at_assign: c.p.onHand,
        status: "pending",
      });
      summary.rotation++;
      picked++;
    }
  }

  log(`plan: hot=${summary.hot} runway=${summary.runway} rotation=${summary.rotation} (frames forced=${summary.framesForced})`);

  if (plans.length === 0) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, today, isMonday, summary, inserted: 0 }) };
  }

  if (dryRun) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, today, isMonday, summary, inserted: 0, dryPlan: plans }),
    };
  }

  // Batched insert (Supabase can eat 200+ rows in one call). We
  // ask for `id` back so the location-snapshot pass below can key
  // its inserts to each fresh item row.
  const { data: insertedRows, error: insErr } = await supa
    .from("cycle_count_items")
    .insert(plans)
    .select("id, pn, tier, system_qty_at_assign");
  if (insErr) {
    log("insert failed", insErr);
    return { statusCode: 500, body: JSON.stringify({ error: "insert failed", detail: insErr.message }) };
  }

  // v-cc-loc-1 phase 1 -- LOCATION SNAPSHOT.
  //
  // For every fresh cycle_count_item we just inserted, snapshot
  // the current part_locations rows into cycle_count_item_locations
  // so the count card shows the buyer's real bin list AND the
  // system_qty_at_assign per bin is frozen at assignment time
  // (subsequent Acumatica syncs won't move the goalposts on the
  // counter mid-shift).
  //
  // Parts with no part_locations row (aggregate-only pn, or
  // legacy pre-per-location parts) get ZERO snapshot rows and
  // fall through to the existing single-total flow -- the UI
  // renders them the same way it did in the previous release.
  const insertedIds = (insertedRows || []).map(r => r.id);
  const insertedPns = [...new Set((insertedRows || []).map(r => r.pn))];
  let locSnapshotCount = 0;
  if (insertedIds.length > 0 && insertedPns.length > 0) {
    const { data: locRows, error: locErr } = await supa
      .from("part_locations")
      .select("pn, location, location_desc, qty")
      .in("pn", insertedPns);
    if (locErr) {
      log("part_locations fetch failed for snapshot (non-fatal)", locErr.message);
    } else {
      const locsByPn = new Map();
      for (const r of (locRows || [])) {
        if (!r || !r.pn) continue;
        // v-cc-loc-4 -- exclude the __warehouse__ sentinel from
        // the counter-visible bin list; it's a per-pn aggregate,
        // not a countable bin.
        if (String(r.location) === WAREHOUSE_SENTINEL) continue;
        let arr = locsByPn.get(r.pn);
        if (!arr) { arr = []; locsByPn.set(r.pn, arr); }
        arr.push(r);
      }
      const snapshotRows = [];
      for (const item of (insertedRows || [])) {
        const locs = locsByPn.get(item.pn) || [];
        for (const l of locs) {
          snapshotRows.push({
            item_id: item.id,
            pn: item.pn,
            location: l.location,
            location_desc: l.location_desc || null,
            system_qty_at_assign: Number(l.qty) || 0,
            counted_qty: null,
            counted_at: null,
          });
        }
      }
      if (snapshotRows.length > 0) {
        // Batched insert -- chunk at 500 for wire-size safety.
        const CHUNK = 500;
        for (let i = 0; i < snapshotRows.length; i += CHUNK) {
          const batch = snapshotRows.slice(i, i + CHUNK);
          const { error: sErr } = await supa.from("cycle_count_item_locations").insert(batch);
          if (sErr) {
            log("cycle_count_item_locations insert failed (non-fatal)", { chunk: i, message: sErr.message });
            continue;
          }
          locSnapshotCount += batch.length;
        }
      }
    }
  }

  log(`inserted ${plans.length} items (+ ${locSnapshotCount} location snapshots) in ${Date.now() - t0}ms`);
  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      today,
      isMonday,
      isCron,
      summary,
      inserted: plans.length,
      locationSnapshots: locSnapshotCount,
      tookMs: Date.now() - t0,
    }),
  };
};
