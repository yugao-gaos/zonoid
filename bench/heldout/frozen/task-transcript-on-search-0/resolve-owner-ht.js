'use strict';

// resolveOwner(taskKey, registry) -> transcript path string | null
//
// Resolve the transcript file that holds a task's token usage. A task is
// claimed by an assignee (a logical agent id); we resolve that agent to a
// transcript via three routes, in order:
//
//   1. direct   - the agent record carries `transcript_path`.
//   2. session  - the agent record carries `session` mapping to a transcript
//                 via `sessionTranscript`.
//   3. window   - fallback correlation: on real data ~40% of assignee agent
//                 records carry neither field, so routes 1-2 silently miss
//                 them. Those are recoverable only by overlapping the task's
//                 claim window (`window[taskKey]`) against the harness run
//                 windows (`byWindow`) and picking the run with the largest
//                 positive overlap.

function toMs(iso) {
  if (iso == null) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

// Transcript carried by a byWindow run (direct path, else via its session).
function runTranscript(run, sessionTranscript) {
  if (!run) return null;
  if (run.transcript_path) return run.transcript_path;
  if (run.session && sessionTranscript && sessionTranscript[run.session]) {
    return sessionTranscript[run.session];
  }
  return null;
}

function resolveByWindow(taskKey, registry) {
  const win = registry.window && registry.window[taskKey];
  const runs = registry.byWindow;
  if (!win || !Array.isArray(runs)) return null;

  const now = Date.now();
  const tStart = toMs(win.start);
  // A missing end widens the interval to "now".
  const tEnd = win.end != null ? toMs(win.end) : now;
  if (tStart == null || tEnd == null) return null;

  let best = null;
  let bestOverlap = -Infinity;
  for (const run of runs) {
    if (!run) continue;
    const rStart = toMs(run.start);
    const rEnd = run.end != null ? toMs(run.end) : now;
    if (rStart == null || rEnd == null) continue;

    // overlap = min(ends) - max(starts); >= 0 means the intervals touch.
    const overlap = Math.min(tEnd, rEnd) - Math.max(tStart, rStart);
    if (overlap < 0) continue;

    const transcript = runTranscript(run, registry.sessionTranscript);
    if (!transcript) continue;

    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = transcript;
    }
  }
  return best;
}

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const agentId = registry.assignee && registry.assignee[taskKey];
  const agent = agentId != null && registry.agents ? registry.agents[agentId] : null;

  if (agent) {
    // Route 1: direct transcript path.
    if (agent.transcript_path) return agent.transcript_path;
    // Route 2: session -> transcript.
    if (agent.session && registry.sessionTranscript && registry.sessionTranscript[agent.session]) {
      return registry.sessionTranscript[agent.session];
    }
  }

  // Route 3: time-window overlap correlation.
  return resolveByWindow(taskKey, registry);
}

module.exports = { resolveOwner };
