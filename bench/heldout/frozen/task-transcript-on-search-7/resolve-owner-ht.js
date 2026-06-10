'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolves the transcript file that holds a task's token usage. The task is
// claimed by an assignee (a logical agent id); we resolve that agent to a
// transcript. Two direct routes are documented:
//   1. the agent record carries `transcript_path` outright, or
//   2. the agent record carries a `session` that `sessionTranscript` maps.
//
// Recalled gotcha (note-mq7kyiir6sx): on real data ~40% of assignee agent
// records carry NEITHER a session nor a transcript, so an exact-match-only
// resolver silently drops them. The registry ships `window` (the task's claim
// window) and `byWindow` (harness runs + their run windows) precisely so we can
// fall back to time-window overlap correlation: attribute the task to the run
// whose window overlaps the claim window the most.

function resolveTranscriptForSession(registry, session) {
  if (session == null) return null;
  const st = registry.sessionTranscript;
  if (st && typeof st[session] === 'string') return st[session];
  return null;
}

function parseMs(iso) {
  if (typeof iso !== 'string') return NaN;
  return new Date(iso).getTime();
}

// Overlap (in ms) of two ISO intervals; 0 (or negative) means no overlap.
function overlapMs(aStart, aEnd, bStart, bEnd) {
  const as = parseMs(aStart);
  const ae = parseMs(aEnd);
  const bs = parseMs(bStart);
  const be = parseMs(bEnd);
  if ([as, ae, bs, be].some(Number.isNaN)) return -Infinity;
  return Math.min(ae, be) - Math.max(as, bs);
}

function resolveByWindow(taskKey, registry) {
  const win = registry.window && registry.window[taskKey];
  const runs = registry.byWindow;
  if (!win || !Array.isArray(runs)) return null;

  let best = null;
  let bestOverlap = 0; // require strictly positive overlap to attribute
  for (const run of runs) {
    if (!run) continue;
    const ov = overlapMs(win.start, win.end, run.start, run.end);
    if (ov > bestOverlap) {
      bestOverlap = ov;
      best = run;
    }
  }
  if (!best) return null;

  if (typeof best.transcript_path === 'string') return best.transcript_path;
  return resolveTranscriptForSession(registry, best.session);
}

function resolveOwner(taskKey, registry) {
  if (!registry || typeof registry !== 'object') return null;

  const assignee = registry.assignee && registry.assignee[taskKey];
  if (assignee != null) {
    const agent = registry.agents && registry.agents[assignee];
    if (agent) {
      if (typeof agent.transcript_path === 'string') return agent.transcript_path;
      const viaSession = resolveTranscriptForSession(registry, agent.session);
      if (viaSession != null) return viaSession;
    }
  }

  // Fallback: time-window overlap correlation (handles assignee records that
  // carry neither session nor transcript, and tasks with no agent record).
  return resolveByWindow(taskKey, registry);
}

module.exports = { resolveOwner };
