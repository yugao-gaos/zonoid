'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolves the transcript file that holds a task's token usage. A task is
// claimed by an assignee (a logical agent id); we resolve that agent to a
// transcript via three legs, in order:
//
//   1. direct      — agents[assignee].transcript_path
//   2. session     — agents[assignee].session -> sessionTranscript[session]
//   3. byWindow    — task's claim window[taskKey] overlapped against the run
//                    windows in byWindow; the overlapping run's transcript.
//
// The documented attribution only describes legs 1 and 2, but the registry
// carries window/byWindow precisely for leg 3: assignee agent records
// frequently carry neither transcript_path nor a mapped session, and without
// the time-window fallback those tasks return null incorrectly.
//
// Any field may be absent, so every lookup is guarded. Returns null only when
// all three legs fail.

function resolveOwner(taskKey, registry) {
  if (!registry || typeof registry !== 'object') return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};
  const window = registry.window || {};
  const byWindow = Array.isArray(registry.byWindow) ? registry.byWindow : [];

  const agentId = assignee[taskKey];
  const agent = (agentId != null && agents[agentId]) ? agents[agentId] : null;

  // Leg 1: direct transcript_path on the agent record.
  if (agent && agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent's session mapped to a known transcript.
  if (agent && agent.session != null) {
    const t = sessionTranscript[agent.session];
    if (t) return t;
  }

  // Leg 3: time-window overlap between the task's claim window and a run.
  const tWin = window[taskKey];
  const best = bestOverlap(tWin, byWindow);
  if (best) return best;

  return null;
}

// Returns the transcript_path of the byWindow run with the greatest temporal
// overlap against the task window, or null if none overlap.
function bestOverlap(taskWin, byWindow) {
  const tStart = parseTime(taskWin && taskWin.start);
  const tEnd = parseTime(taskWin && taskWin.end);
  if (tStart == null || tEnd == null) return null;

  let bestPath = null;
  let bestAmount = -1;

  for (const run of byWindow) {
    if (!run || !run.transcript_path) continue;
    const rStart = parseTime(run.start);
    const rEnd = parseTime(run.end);
    if (rStart == null || rEnd == null) continue;

    // Overlap requires the intervals to intersect.
    const lo = tStart > rStart ? tStart : rStart;
    const hi = tEnd < rEnd ? tEnd : rEnd;
    if (lo > hi) continue;

    const amount = hi - lo;
    if (amount > bestAmount) {
      bestAmount = amount;
      bestPath = run.transcript_path;
    }
  }

  return bestPath;
}

function parseTime(iso) {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

module.exports = { resolveOwner };
