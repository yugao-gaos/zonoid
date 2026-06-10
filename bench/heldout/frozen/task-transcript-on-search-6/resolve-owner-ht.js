'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolves the transcript file that holds a task's token usage by way of the
// task's assignee. Three routes, tried in order:
//
//   1. direct   - the assignee's agent record carries a transcript_path.
//   2. session  - the agent record carries a session that maps to a transcript
//                 via sessionTranscript.
//   3. window   - neither field is present (on real data ~40% of assignee
//                 records carry no session and no transcript_path, so routes
//                 1-2 alone silently drop them). Correlate the task's claim
//                 window against the harness run windows in byWindow and pick
//                 the run whose [start,end] interval overlaps it the most.

function toMs(iso) {
  if (!iso) return NaN;
  return new Date(iso).getTime();
}

// Overlap of two intervals: min(ends) - max(starts). >= 0 means they touch.
// A missing end widens that interval to "now".
function overlapMs(aStart, aEnd, bStart, bEnd, now) {
  const as = toMs(aStart);
  const bs = toMs(bStart);
  if (Number.isNaN(as) || Number.isNaN(bs)) return null;
  let ae = toMs(aEnd);
  let be = toMs(bEnd);
  if (Number.isNaN(ae)) ae = now;
  if (Number.isNaN(be)) be = now;
  return Math.min(ae, be) - Math.max(as, bs);
}

function resolveOwner(taskKey, registry) {
  const reg = registry || {};
  const assignee = reg.assignee || {};
  const agents = reg.agents || {};
  const window = reg.window || {};
  const byWindow = reg.byWindow || [];
  const sessionTranscript = reg.sessionTranscript || {};

  const agentId = assignee[taskKey];
  const agent = agentId != null ? agents[agentId] : undefined;

  // Route 1: direct transcript_path on the agent record.
  if (agent && agent.transcript_path) {
    return agent.transcript_path;
  }

  // Route 2: agent's session -> sessionTranscript.
  if (agent && agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Route 3: time-window overlap correlation.
  const win = window[taskKey];
  if (win) {
    const now = Date.now();
    let best = null;
    let bestOverlap = -Infinity;
    for (const run of byWindow) {
      if (!run || !run.transcript_path) continue;
      const ov = overlapMs(win.start, win.end, run.start, run.end, now);
      if (ov === null || ov < 0) continue; // require a touching interval
      if (ov > bestOverlap) {
        bestOverlap = ov;
        best = run;
      }
    }
    if (best) return best.transcript_path;
  }

  return null;
}

module.exports = { resolveOwner };
