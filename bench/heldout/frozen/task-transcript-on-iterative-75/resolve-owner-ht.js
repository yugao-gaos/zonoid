'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolves the transcript file that holds a task's token usage. A task is
// claimed by an assignee (a logical agent id); we resolve that agent to a
// transcript via three legs, in order. Any field in the registry may be
// absent, so every lookup is guarded.
//
//   1. direct:   agents[assignee].transcript_path
//   2. session:  sessionTranscript[ agents[assignee].session ]
//   3. byWindow: the byWindow run whose [start,end] overlaps the task's
//                claim window[taskKey] — its transcript_path
//
// Returns null only when all three legs fail.

function resolveOwner(taskKey, registry) {
  if (!registry || typeof registry !== 'object') return null;

  const assignee = registry.assignee && registry.assignee[taskKey];
  if (assignee != null) {
    const agent = registry.agents && registry.agents[assignee];
    if (agent && typeof agent === 'object') {
      // Leg 1 — direct transcript on the agent record.
      if (agent.transcript_path) return agent.transcript_path;

      // Leg 2 — agent's session maps to a known transcript.
      if (agent.session != null && registry.sessionTranscript) {
        const fromSession = registry.sessionTranscript[agent.session];
        if (fromSession) return fromSession;
      }
    }
  }

  // Leg 3 — fall back to the harness run window that overlaps the task's
  // claim window. Required: ~40% of agent records carry neither a
  // transcript_path nor a session, and would otherwise be lost.
  const taskWindow = registry.window && registry.window[taskKey];
  if (taskWindow && Array.isArray(registry.byWindow)) {
    const taskStart = toTime(taskWindow.start);
    const taskEnd = toTime(taskWindow.end);
    if (taskStart != null && taskEnd != null) {
      for (const run of registry.byWindow) {
        if (!run || !run.transcript_path) continue;
        const runStart = toTime(run.start);
        const runEnd = toTime(run.end);
        if (runStart == null || runEnd == null) continue;
        // Two intervals overlap iff each starts no later than the other ends.
        if (taskStart <= runEnd && runStart <= taskEnd) {
          return run.transcript_path;
        }
      }
    }
  }

  return null;
}

function toTime(iso) {
  if (iso == null) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

module.exports = { resolveOwner };
