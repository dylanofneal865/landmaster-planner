// lib/supersession-server.js -- shared supersession-chain helpers
// for Netlify functions. Byte-for-byte port of the js/03-calc.js
// browser helpers (supersessionChain, supersessionLineage,
// chainDisplayDaily). Loaded via require() by:
//
//   netlify/functions/frame-schedule-compute.js -- for chain-aware
//     daily rates the scheduler consumes.
//   netlify/functions/cycle-count-assign.js -- for pre-launch /
//     transition classification of chain members (fixes 3a-3d in
//     the cycle-count phase-2 ticket).
//
// The browser's canonical impl lives in js/03-calc.js; keep the
// three functions in this file byte-identical to their browser
// counterparts so both environments agree on which chains are
// transitioning and which anchor's daily to use.
//
// `byPn` is Map<pn -> partData> where partData is the SUPABASE
// parts.data blob (top-level onHand, daily, supersededBy,
// phasingOut, transitionStartDate, ltWeeks, itemType, supplier).
// `allEntries` is [...byPn.entries()] cached by the caller for
// the backward-walk O(N) scan.

function supersessionChainServer(pn, byPn) {
  const out = [];
  const visited = new Set();
  let cur = pn ? String(pn).trim() : "";
  while (cur && !visited.has(cur)) {
    out.push(cur);
    visited.add(cur);
    const p = byPn.get(cur);
    const next = (p && p.supersededBy) ? String(p.supersededBy).trim() : "";
    if (!next || next === cur) break;
    cur = next;
  }
  return out;
}

function supersessionLineageServer(pn, byPn, allEntries) {
  const start = pn ? String(pn).trim() : "";
  if (!start) return [];
  const back = [];
  const seen = new Set([start]);
  let cur = start;
  while (true) {
    let pred = null;
    for (const [predPn, predData] of allEntries) {
      if (predData && predData.supersededBy && String(predData.supersededBy).trim() === cur) {
        pred = { pn: predPn };
        break;
      }
    }
    if (!pred) break;
    if (seen.has(pred.pn)) break;
    back.unshift(pred.pn);
    seen.add(pred.pn);
    cur = pred.pn;
  }
  const forward = supersessionChainServer(start, byPn);
  return [...back, ...forward];
}

function chainDisplayDailyServer(pn, byPn, allEntries) {
  const own = byPn.get(pn) || {};
  const ownDaily = Number(own.daily) || 0;
  const lineage = supersessionLineageServer(pn, byPn, allEntries);
  if (lineage.length < 2) {
    return { daily: ownDaily, ownDaily, chainMembers: lineage, chainTransitioning: false, chainAnchorPn: null };
  }
  const transitioning = lineage.some(memberPn => {
    const m = byPn.get(memberPn);
    return !!(m && m.phasingOut);
  });
  const anchorPn = lineage[0];
  if (!transitioning) {
    return { daily: ownDaily, ownDaily, chainMembers: lineage, chainTransitioning: false, chainAnchorPn: anchorPn };
  }
  const anchor = byPn.get(anchorPn);
  const daily = anchor ? (Number(anchor.daily) || 0) : ownDaily;
  return { daily, ownDaily, chainMembers: lineage, chainTransitioning: true, chainAnchorPn: anchorPn };
}

/* ------------------------------------------------------------------
   classifyChainMember -- adds the phase-2 cycle-count fields on top
   of the chain shape. Returns:
     {
       inChain,
       transitioning,          -- any member has phasingOut === true
       lineage,                -- anchor-first ordered pn list
       anchorPn,
       predecessorPn,          -- lineage[phasingOutIdx] || anchorPn
       successorPn,            -- lineage[last] (the terminal / new part)
       successor,              -- byPn.get(successorPn) or null
       predecessor,            -- byPn.get(predecessorPn) or null
       startDate,              -- successor.transitionStartDate parsed
                                  to a local-midnight Date or null
       daysUntilStart,         -- calendar-day gap today -> startDate
                                  (negative when cut-in has passed)
       preLaunchSuccessor,     -- startDate > today
       postCutInSuccessor,     -- startDate <= today
       role,                   -- "predecessor" | "successor" | "midchain"
                                  | "standalone" (not in a transitioning chain)
     }
   Called per pn during the assignment loop.
   ------------------------------------------------------------------ */
function classifyChainMember(pn, byPn, allEntries, todayDate) {
  const chain = chainDisplayDailyServer(pn, byPn, allEntries);
  if (chain.chainMembers.length < 2) return { inChain: false, transitioning: false, role: "standalone" };
  if (!chain.chainTransitioning) return { inChain: true, transitioning: false, role: "standalone", lineage: chain.chainMembers, anchorPn: chain.chainAnchorPn };
  const lineage = chain.chainMembers;
  const anchorPn = lineage[0];
  const successorPn = lineage[lineage.length - 1];
  const successor = byPn.get(successorPn) || null;
  let predecessorPn = anchorPn;
  for (const memberPn of lineage) {
    const mp = byPn.get(memberPn);
    if (mp && mp.phasingOut) { predecessorPn = memberPn; break; }
  }
  const predecessor = byPn.get(predecessorPn) || null;
  const startRaw = (successor && successor.transitionStartDate) ? String(successor.transitionStartDate).slice(0, 10) : "";
  let startDate = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(startRaw)) {
    const [y, mo, da] = startRaw.split("-").map(Number);
    const d = new Date(y, mo - 1, da);
    d.setHours(0, 0, 0, 0);
    if (!isNaN(d.getTime())) startDate = d;
  }
  let daysUntilStart = null;
  if (startDate && todayDate) {
    daysUntilStart = Math.round((startDate.getTime() - todayDate.getTime()) / (24 * 60 * 60 * 1000));
  }
  const preLaunchSuccessor = !!(startDate && daysUntilStart !== null && daysUntilStart > 0);
  const postCutInSuccessor = !!(startDate && daysUntilStart !== null && daysUntilStart <= 0);
  const role = pn === successorPn ? "successor"
             : pn === predecessorPn ? "predecessor"
             : "midchain";
  return {
    inChain: true,
    transitioning: true,
    lineage,
    anchorPn,
    predecessorPn,
    successorPn,
    successor,
    predecessor,
    startDate,
    daysUntilStart,
    preLaunchSuccessor,
    postCutInSuccessor,
    role,
  };
}

/* ------------------------------------------------------------------
   classifyChainRole -- MULTI-HOP-aware chain classification.

   The 2-member "predecessor / successor" shape in
   classifyChainMember above is incomplete for chains longer than
   two hops. Live case:
     19920 (327 on hand, phasingOut)
       -> CP00666 (0 on hand, no transitionStartDate)
       -> JP00001 (0 on hand, transitionStartDate 2026-12-21)
   The 2-member classifier picks JP00001 as the successor and
   19920 as the predecessor; CP00666 is "midchain" and evaluated
   under the plain HOT rules, and JP00001 (SUCCESSOR + preLaunch)
   is supposed to be excluded but only fires when transitionStartDate
   is set on the terminal node -- and even then, the MIDDLE hop
   CP00666 has no such guard.

   This function classifies EVERY member of a transitioning chain
   into one of three roles as of `todayDate`:

     ACTIVE   -- the member currently being consumed. Defined as
                 the earliest lineage member that is NOT queued
                 (no future transitionStartDate) AND has stock > 0.
                 If no such member exists (chain fully depleted
                 before any queued member has cut in yet), the
                 first non-queued member is ACTIVE anyway so it
                 stays on the audit rhythm.
     QUEUED   -- any member whose own transitionStartDate is
                 strictly in the future. Any number of members
                 can be queued (JP-style far successors).
     RETIRED  -- lineage members ordered BEFORE the ACTIVE member
                 (already burned down; nothing to count).

   Return shape:
     {
       inChain,
       transitioning,       -- any member has phasingOut
       lineage,             -- anchor-first ordered pn list
       anchorPn,
       activePn,
       nextQueuedPn,        -- first queued member AFTER activeIdx,
                               or null if none.
       nextCutinDate,       -- transitionStartDate of nextQueuedPn,
                               parsed to a local-midnight Date, or null.
       roleByPn,            -- Map<pn, "active"|"queued"|"retired">
       role,                -- shortcut for the passed pn.
       // Back-compat aliases so callers that used the older
       // classifyChainMember shape still work:
       predecessorPn,       -- alias for activePn (the "current" one)
       successorPn,         -- alias for nextQueuedPn (or lineage[last]
                               when no queued member exists)
       preLaunchSuccessor,  -- true if this pn is QUEUED
       postCutInSuccessor,  -- true if this pn is ACTIVE and had a
                               transitionStartDate in the past.
       daysUntilStart,      -- days until nextCutinDate (or null).
     }

   For chains that are NOT transitioning (no phasingOut), returns
   { inChain: true|false, transitioning: false, role: "standalone" }.
   ------------------------------------------------------------------ */
function classifyChainRole(pn, byPn, allEntries, todayDate) {
  const chain = chainDisplayDailyServer(pn, byPn, allEntries);
  if (!chain.chainMembers || chain.chainMembers.length < 2) {
    return { inChain: false, transitioning: false, role: "standalone" };
  }
  if (!chain.chainTransitioning) {
    return { inChain: true, transitioning: false, role: "standalone", lineage: chain.chainMembers, anchorPn: chain.chainAnchorPn };
  }
  const lineage = chain.chainMembers;
  const anchorPn = lineage[0];
  const today = (todayDate instanceof Date) ? todayDate : (function () {
    const t = new Date(); t.setHours(0, 0, 0, 0); return t;
  })();

  // Step 1 -- identify QUEUED members by their own transitionStartDate
  // being strictly in the future. Any depth of hops handled by
  // iterating the whole lineage.
  const roleByPn = new Map();
  const cutinByPn = new Map();
  for (const memberPn of lineage) {
    const md = byPn.get(memberPn);
    const raw = md && md.transitionStartDate;
    if (typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const parts = raw.slice(0, 10).split("-").map(Number);
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      d.setHours(0, 0, 0, 0);
      if (!isNaN(d.getTime())) {
        cutinByPn.set(memberPn, d);
        if (d.getTime() > today.getTime()) roleByPn.set(memberPn, "queued");
      }
    }
  }

  // Step 2 -- ACTIVE = earliest non-queued member with stock > 0.
  // Fallback (chain fully depleted before any queued member has cut
  // in): first non-queued member, even at zero, so the counter can
  // physically confirm zero. If EVERY member is queued (shouldn't
  // happen since transitioning requires a phasingOut member, which
  // couldn't also be pre-launch), fall back to lineage[0].
  let activePn = null;
  for (const memberPn of lineage) {
    if (roleByPn.get(memberPn) === "queued") continue;
    const md = byPn.get(memberPn);
    const stock = Number(md && md.onHand) || 0;
    if (stock > 0) { activePn = memberPn; break; }
  }
  if (!activePn) {
    for (const memberPn of lineage) {
      if (roleByPn.get(memberPn) !== "queued") { activePn = memberPn; break; }
    }
  }
  if (!activePn) activePn = lineage[0];

  // Step 3 -- label the rest by lineage position vs activePn.
  const activeIdx = lineage.indexOf(activePn);
  lineage.forEach((memberPn, idx) => {
    if (roleByPn.has(memberPn)) return;   // queued already stamped
    if (idx === activeIdx) roleByPn.set(memberPn, "active");
    else if (idx < activeIdx) roleByPn.set(memberPn, "retired");
    else roleByPn.set(memberPn, "queued");   // members after active with no
                                               // own transitionStartDate --
                                               // implicit queue.
  });

  // Next queued (for handoff-risk both-ends).
  let nextQueuedPn = null;
  for (let i = activeIdx + 1; i < lineage.length; i++) {
    if (roleByPn.get(lineage[i]) === "queued") { nextQueuedPn = lineage[i]; break; }
  }
  const nextCutinDate = nextQueuedPn ? (cutinByPn.get(nextQueuedPn) || null) : null;
  const daysUntilStart = nextCutinDate
    ? Math.round((nextCutinDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const myRole = roleByPn.get(pn);
  const activeCutin = cutinByPn.get(activePn) || null;
  const postCutInActive = !!(activeCutin && activeCutin.getTime() <= today.getTime());

  return {
    inChain: true,
    transitioning: true,
    lineage,
    anchorPn,
    activePn,
    nextQueuedPn,
    nextCutinDate,
    daysUntilStart,
    roleByPn,
    role: myRole,
    // Back-compat aliases.
    predecessorPn: activePn,
    successorPn: nextQueuedPn || lineage[lineage.length - 1],
    successor: byPn.get(nextQueuedPn || lineage[lineage.length - 1]) || null,
    predecessor: byPn.get(activePn) || null,
    startDate: nextCutinDate,
    preLaunchSuccessor: myRole === "queued",
    postCutInSuccessor: (myRole === "active" && postCutInActive),
  };
}

module.exports = {
  supersessionChainServer,
  supersessionLineageServer,
  chainDisplayDailyServer,
  classifyChainMember,
  classifyChainRole,
};
