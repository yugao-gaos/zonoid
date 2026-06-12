'use strict';

// resolveOwner(taskKey, registry) -> transcript path string | null
//
// For a given task, find the transcript file that holds its token usage.
// A task is claimed by an assignee (a logical agent id); resolve that agent
// to a transcript via three legs, in order:
//
//   1. direct      — the agent record carries a transcript_path
//   2. session     — the agent record carries a session that maps via
//                    sessionTranscript to a transcript
//   3. byWindow    — fallback (REQUIRED): match the task's claim window against
//                    the harness run windows in byWindow; an overlapping run's
//                    transcript is the task's transcript
//
// ~40% of assignee agent records carry neither transcript_path nor session, so
// leg 3 is not optional — without it those tasks silently resolve to null.
// Any field may be absent, so every lookup is guarded. Return null only when
// all three legs fail.

function resolveOwner(taskKey, registry) {
  if (!registry || typeof registry !== 'object') return null;

  const {
    assignee = {},
    agents = {},
    window = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry;

  const agentId = assignee[taskKey];
  const agent = (agentId != null && agents[agentId]) || null;

  // Leg 1: direct transcript on the agent record.
  if (agent && agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent's session mapped to a known transcript.
  if (agent && agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3: window-overlap fallback against harness run windows.
  const claim = window[taskKey];
  if (claim && Array.isArray(byWindow)) {
    const cStart = toTime(claim.start);
    const cEnd = toTime(claim.end);
    if (cStart != null && cEnd != null) {
      for (const run of byWindow) {
        if (!run) continue;
        const rStart = toTime(run.start);
        const rEnd = toTime(run.end);
        if (rStart == null || rEnd == null) continue;
        // Overlap: the two intervals intersect.
        if (rStart <= cEnd && rEnd >= cStart) {
          if (run.transcript_path) return run.transcript_path;
          if (run.session && sessionTranscript[run.session]) {
            return sessionTranscript[run.session];
          }
        }
      }
    }
  }

  return null;
}

function toTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

module.exports = { resolveOwner };
