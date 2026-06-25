'use strict';

// resolveOwner(taskKey, registry) -> transcript path (string) | null
//
// Returns the transcript file that holds a task's token usage. A task is claimed
// by an assignee (a logical agent id); we resolve that agent to a transcript via
// three routes, in order:
//
//   1. direct  — the assignee's agent record carries `transcript_path`.
//   2. session — the assignee's agent record carries a `session` that maps to a
//                transcript via `sessionTranscript`.
//   3. window  — correlate the task's claim window against the harness run
//                windows in `byWindow`, picking the run with the largest time
//                overlap. On real data ~40% of assignee agent records carry
//                neither a session nor a transcript_path; those tasks are
//                recoverable only by this time-window correlation, so it must
//                run after (not instead of) the direct/session lookups.
//
// Returns null when no route attributes a transcript.

function toMs(iso) {
  if (iso == null) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

function resolveOwner(taskKey, registry) {
  if (!registry || typeof registry !== 'object') return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const window = registry.window || {};
  const byWindow = Array.isArray(registry.byWindow) ? registry.byWindow : [];
  const sessionTranscript = registry.sessionTranscript || {};

  // Routes 1 & 2: resolve via the task's assignee agent record.
  const agentId = assignee[taskKey];
  if (agentId != null) {
    const rec = agents[agentId];
    if (rec) {
      if (rec.transcript_path) return rec.transcript_path;
      if (rec.session && sessionTranscript[rec.session]) {
        return sessionTranscript[rec.session];
      }
    }
  }

  // Route 3: time-window overlap correlation against harness run windows.
  const win = window[taskKey];
  if (win && byWindow.length) {
    const now = Date.now();
    const taskStart = toMs(win.start);
    const taskEnd = toMs(win.end);

    // Need at least one bound to correlate. A missing end widens to now.
    if (taskStart != null || taskEnd != null) {
      const tStart = taskStart == null ? -Infinity : taskStart;
      const tEnd = taskEnd == null ? now : taskEnd;

      let best = null;
      let bestOverlap = -Infinity;
      for (const run of byWindow) {
        if (!run) continue;
        const path = run.transcript_path || sessionTranscript[run.session];
        if (!path) continue;

        const rStart = toMs(run.start);
        const rEnd = toMs(run.end);
        if (rStart == null && rEnd == null) continue; // no window info
        const s = rStart == null ? -Infinity : rStart;
        const e = rEnd == null ? now : rEnd;

        // overlap >= 0 means the intervals touch; pick the largest.
        const overlap = Math.min(tEnd, e) - Math.max(tStart, s);
        if (overlap >= 0 && overlap > bestOverlap) {
          bestOverlap = overlap;
          best = path;
        }
      }
      if (best) return best;
    }
  }

  return null;
}

module.exports = { resolveOwner };
