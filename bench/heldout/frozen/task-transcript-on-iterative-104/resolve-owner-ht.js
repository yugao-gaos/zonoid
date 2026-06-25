'use strict';

/**
 * Resolve the transcript path for a task.
 *
 * Three-leg attribution (override: spec's two-leg description is incomplete):
 *   1. direct      — agents[assignee].transcript_path
 *   2. session     — agents[assignee].session → sessionTranscript[session]
 *   3. byWindow    — task claim window overlaps a byWindow entry → that entry's transcript_path
 *
 * Returns null only when all three legs fail.
 */
function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: claimWindow = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  if (agentId != null) {
    const agent = agents[agentId] || {};

    // Leg 1: direct transcript_path on the agent record
    if (agent.transcript_path != null) return agent.transcript_path;

    // Leg 2: session → sessionTranscript lookup
    if (agent.session != null) {
      const path = sessionTranscript[agent.session];
      if (path != null) return path;
    }
  }

  // Leg 3: byWindow overlap fallback
  const taskWin = claimWindow[taskKey];
  if (taskWin && taskWin.start != null && taskWin.end != null) {
    for (const entry of byWindow) {
      if (
        entry.transcript_path != null &&
        entry.start != null &&
        entry.end != null &&
        entry.start < taskWin.end &&
        taskWin.start < entry.end
      ) {
        return entry.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
