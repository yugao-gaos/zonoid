'use strict';

/**
 * Resolve the transcript path for the task that claimed a given task key.
 *
 * Three-leg lookup (applied in order, first hit wins):
 *   1. direct   — agents[assignee].transcript_path
 *   2. session  — agents[assignee].session → sessionTranscript[session]
 *   3. byWindow — window[taskKey] interval overlap against byWindow entries
 *
 * Returns null only when all three legs fail.
 */
function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window: windowMap = {}, byWindow = [], sessionTranscript = {} } = registry || {};

  const agentId = assignee[taskKey];
  const agent = agentId != null ? agents[agentId] : undefined;

  // Leg 1: direct transcript_path on the agent record
  if (agent && agent.transcript_path) {
    return agent.transcript_path;
  }

  // Leg 2: session → sessionTranscript
  if (agent && agent.session) {
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  // Leg 3: byWindow overlap using the task's claim window
  const taskWindow = windowMap[taskKey];
  if (taskWindow && taskWindow.start && taskWindow.end) {
    const taskStart = taskWindow.start;
    const taskEnd = taskWindow.end;
    for (const entry of byWindow) {
      if (entry.transcript_path && entry.start && entry.end) {
        // Overlap: entry.start < taskEnd && entry.end > taskStart
        if (entry.start < taskEnd && entry.end > taskStart) {
          return entry.transcript_path;
        }
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
