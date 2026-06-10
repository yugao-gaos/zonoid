'use strict';

// resolveOwner(taskKey, registry) -> transcript path string | null
//
// Resolves the transcript file that holds a task's token usage. A task is
// claimed by an assignee (a logical agent id); we resolve that agent to a
// transcript via three routes, in order:
//
//   1. direct      — the agent record carries `transcript_path`.
//   2. session     — the agent record carries `session`, and that session
//                    maps to a transcript via `sessionTranscript`.
//   3. time-window — neither of the above resolves (on real data ~40% of
//                    assignee records carry no session and no path). Correlate
//                    the task's claim window against the harness run windows in
//                    `byWindow`, picking the run whose [start,end] interval
//                    overlaps the task window the most. Without this fallback an
//                    exact-match-only resolver silently drops those tasks.
//
// Returns the transcript path, or null when none is attributable.

function toMs(iso) {
  if (iso == null) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

// Overlap of two [start,end] intervals in ms. A missing end widens to "now";
// a missing start widens to -Infinity. Returns the overlap length
// (min(ends) - max(starts)); a value >= 0 means the intervals touch or cover.
// Returns null when the intervals are disjoint or unmeasurable.
function overlapMs(aStart, aEnd, bStart, bEnd, now) {
  const s1 = aStart == null ? -Infinity : aStart;
  const s2 = bStart == null ? -Infinity : bStart;
  const e1 = aEnd == null ? now : aEnd;
  const e2 = bEnd == null ? now : bEnd;
  const lo = Math.max(s1, s2);
  const hi = Math.min(e1, e2);
  const ov = hi - lo;
  return ov >= 0 ? ov : null;
}

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const {
    assignee = {},
    agents = {},
    window = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry;

  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents[agentId];

  // Route 1: direct transcript path on the agent record.
  if (agent && agent.transcript_path) return agent.transcript_path;

  // Route 2: agent's session mapped to a known transcript.
  if (agent && agent.session != null) {
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  // Route 3: time-window overlap correlation against harness run windows.
  const win = window[taskKey];
  if (!win || !Array.isArray(byWindow) || byWindow.length === 0) return null;

  const taskStart = toMs(win.start);
  const taskEnd = toMs(win.end);
  const now = Date.now();

  let best = null;
  let bestOverlap = -Infinity;

  for (const run of byWindow) {
    if (!run || !run.transcript_path) continue;
    const ov = overlapMs(taskStart, taskEnd, toMs(run.start), toMs(run.end), now);
    if (ov == null) continue;
    if (ov > bestOverlap) {
      bestOverlap = ov;
      best = run.transcript_path;
    }
  }

  return best;
}

module.exports = { resolveOwner };
