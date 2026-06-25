'use strict';

// resolveOwner(taskKey, registry) -> transcript path string | null
//
// Given a task and the registry the daemon assembles at read time, return the
// transcript file that holds that task's token usage, or null if none can be
// attributed.
//
// Attribution proceeds in three legs (the first that yields a transcript wins):
//   1. direct   — the assignee's agent record carries `transcript_path`.
//   2. session  — the agent record carries a `session` that maps to a
//                 transcript via `sessionTranscript`.
//   3. byWindow — fall back to time-window overlap: the task's claim window
//                 (`window[taskKey]`) vs. the harness run windows in
//                 `byWindow`; the overlapping run's `transcript_path` wins.
//                 (The prose "How attribution works" omits this leg, but
//                 direct + session alone fail to attribute a large fraction of
//                 tasks — runs whose agent record lacks both fields.)
// Only after all three miss do we return null.

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// Overlap of two closed intervals, or null if they do not overlap / are
// ill-formed. Returns the overlap duration (>= 0) so callers can rank.
function overlapMs(aStart, aEnd, bStart, bEnd) {
  const as = parseTime(aStart);
  const ae = parseTime(aEnd);
  const bs = parseTime(bStart);
  const be = parseTime(bEnd);
  if (as === null || ae === null || bs === null || be === null) return null;
  const lo = as > bs ? as : bs;
  const hi = ae < be ? ae : be;
  return lo <= hi ? hi - lo : null;
}

function resolveOwner(taskKey, registry) {
  if (!registry || typeof registry !== 'object') return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const window = registry.window || {};
  const byWindow = Array.isArray(registry.byWindow) ? registry.byWindow : [];
  const sessionTranscript = registry.sessionTranscript || {};

  const agentId = assignee[taskKey];
  const agent = agentId != null ? agents[agentId] : undefined;

  // Leg 1: direct transcript_path on the agent record.
  if (agent && typeof agent.transcript_path === 'string' && agent.transcript_path) {
    return agent.transcript_path;
  }

  // Leg 2: agent's session -> transcript via sessionTranscript.
  if (agent && agent.session != null) {
    const viaSession = sessionTranscript[agent.session];
    if (typeof viaSession === 'string' && viaSession) return viaSession;
  }

  // Leg 3: byWindow time-window overlap against the task's claim window.
  const claim = window[taskKey];
  if (claim) {
    let best = null;
    let bestOverlap = -1;
    let bestStart = Infinity;
    for (const run of byWindow) {
      if (!run || typeof run.transcript_path !== 'string' || !run.transcript_path) continue;
      const ov = overlapMs(claim.start, claim.end, run.start, run.end);
      if (ov === null) continue;
      const start = parseTime(run.start);
      // Prefer the largest overlap; tie-break on the earliest-starting run.
      if (ov > bestOverlap || (ov === bestOverlap && start !== null && start < bestStart)) {
        best = run.transcript_path;
        bestOverlap = ov;
        bestStart = start === null ? Infinity : start;
      }
    }
    if (best) return best;
  }

  return null;
}

module.exports = { resolveOwner };
