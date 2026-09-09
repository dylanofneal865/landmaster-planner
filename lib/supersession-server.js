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

module.exports = {
  supersessionChainServer,
  supersessionLineageServer,
  chainDisplayDailyServer,
  classifyChainMember,
};
