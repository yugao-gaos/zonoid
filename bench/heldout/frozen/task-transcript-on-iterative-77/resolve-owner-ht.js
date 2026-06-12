'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Given a task, find the transcript file that holds its token usage. The task
// is claimed by an assignee (a logical agent id); we resolve that agent to a
// transcript via three legs, in order:
//
//   1. direct:  the assignee's agent record carries a transcript_path.
//   2. session: the assignee's agent record carries a session, and that
//               session maps to a transcript via sessionTranscript.
//   3. window:  the task's claim window overlaps a harness run window in
//               byWindow; that run's transcript_path is the transcript.
//
// The third leg is REQUIRED: a large share of assignee agent records carry
// neither transcript_path nor session, and those tasks would otherwise be
// silently unattributed. Return null only when all three legs fail.
//
// Every field may be absent, so every lookup is guarded.

function resolveOwner(taskKey, registry) {
  if (!registry || typeof registry !== 'object') return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};
  const window = registry.window || {};
  const byWindow = Array.isArray(registry.byWindow) ? registry.byWindow : [];

  const agentId = assignee[taskKey];
  const agent = (agentId != null && agents[agentId]) || null;

  // Leg 1: direct transcript on the agent record.
  if (agent && agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent session -> sessionTranscript.
  if (agent && agent.session != null) {
    const viaSession = sessionTranscript[agent.session];
    if (viaSession) return viaSession;
  }

  // Leg 3: task claim window overlaps a harness run window in byWindow.
  const taskWindow = window[taskKey];
  if (taskWindow) {
    const taskStart = toTime(taskWindow.start);
    const taskEnd = toTime(taskWindow.end);
    for (const run of byWindow) {
      if (!run || !run.transcript_path) continue;
      const runStart = toTime(run.start);
      const runEnd = toTime(run.end);
      if (overlaps(taskStart, taskEnd, runStart, runEnd)) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

// Parse an ISO-8601 string to epoch ms, or null if absent/unparseable.
function toTime(iso) {
  if (iso == null) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

// Two closed intervals overlap when each starts no later than the other ends.
// Both bounds of both intervals must be known to assert an overlap.
function overlaps(aStart, aEnd, bStart, bEnd) {
  if (aStart == null || aEnd == null || bStart == null || bEnd == null) {
    return false;
  }
  return aStart <= bEnd && bStart <= aEnd;
}

module.exports = { resolveOwner };
