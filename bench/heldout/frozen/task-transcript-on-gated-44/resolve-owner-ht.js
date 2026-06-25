'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolve the transcript file that holds a task's token usage. A task is
// claimed by an assignee (a logical agent id); we resolve that agent to a
// transcript via three legs, in order:
//
//   1. direct  — agents[assignee].transcript_path
//   2. session — agents[assignee].session -> sessionTranscript[session]
//   3. window  — task claim window[taskKey] overlapping a byWindow run's
//                [start, end]; return that run's transcript_path
//
// Any field may be absent, so every lookup is guarded. Return null only when
// all three legs fail.

function overlaps(a, b) {
  if (!a || !b) return false;
  const aStart = Date.parse(a.start);
  const aEnd = Date.parse(a.end);
  const bStart = Date.parse(b.start);
  const bEnd = Date.parse(b.end);
  if (Number.isNaN(aStart) || Number.isNaN(aEnd)) return false;
  if (Number.isNaN(bStart) || Number.isNaN(bEnd)) return false;
  // Two intervals overlap when each starts no later than the other ends.
  return aStart <= bEnd && bStart <= aEnd;
}

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const window = registry.window || {};
  const byWindow = Array.isArray(registry.byWindow) ? registry.byWindow : [];
  const sessionTranscript = registry.sessionTranscript || {};

  const agentId = assignee[taskKey];
  const agent = agentId != null ? agents[agentId] : undefined;

  if (agent) {
    // Leg 1: direct transcript on the agent record.
    if (agent.transcript_path) return agent.transcript_path;

    // Leg 2: agent's session mapped to a known transcript.
    if (agent.session != null) {
      const t = sessionTranscript[agent.session];
      if (t) return t;
    }
  }

  // Leg 3: fall back to the task's claim window, matching a harness run whose
  // window overlaps it. Required when the agent record carries neither a
  // transcript_path nor a resolvable session.
  const taskWindow = window[taskKey];
  if (taskWindow) {
    for (const run of byWindow) {
      if (run && run.transcript_path && overlaps(taskWindow, run)) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
