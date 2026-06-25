'use strict';

/**
 * Resolve the transcript path for the agent that claimed a task.
 * Three-leg attribution (OVERRIDE note: byWindow fallback is required):
 *   1. direct      — agents[assignee].transcript_path
 *   2. session     — agents[assignee].session → sessionTranscript[session]
 *   3. byWindow    — window[taskKey] overlaps a byWindow entry → that entry's transcript_path
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
    const rec = agents[agentId] || {};

    // Leg 1: direct transcript_path on the agent record
    if (rec.transcript_path != null) return rec.transcript_path;

    // Leg 2: session → sessionTranscript
    if (rec.session != null && sessionTranscript[rec.session] != null) {
      return sessionTranscript[rec.session];
    }
  }

  // Leg 3: byWindow overlap
  const win = claimWindow[taskKey];
  if (win != null && win.start != null && win.end != null) {
    const taskStart = win.start;
    const taskEnd = win.end;
    for (const entry of byWindow) {
      if (
        entry.transcript_path != null &&
        entry.start != null &&
        entry.end != null &&
        entry.start <= taskEnd &&
        entry.end >= taskStart
      ) {
        return entry.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
