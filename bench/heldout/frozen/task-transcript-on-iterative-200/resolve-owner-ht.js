'use strict';

/**
 * Resolve the transcript path for a task via its assignee agent record.
 *
 * Three legs (applied in order):
 *   1. direct       — agents[assignee].transcript_path
 *   2. session      — agents[assignee].session → sessionTranscript[session]
 *   3. byWindow     — find byWindow entry whose [start,end] overlaps task window[taskKey]
 *
 * Returns null only when all three legs fail or the task has no assignee.
 */
function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window = {}, byWindow = [], sessionTranscript = {} } = registry || {};

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const record = agents[agentId] || {};

  // Leg 1: direct transcript_path on the agent record
  if (record.transcript_path) return record.transcript_path;

  // Leg 2: session → sessionTranscript lookup
  if (record.session && sessionTranscript[record.session]) {
    return sessionTranscript[record.session];
  }

  // Leg 3: byWindow time-window overlap
  const taskWindow = window[taskKey];
  if (taskWindow && taskWindow.start && taskWindow.end) {
    const { start: ts, end: te } = taskWindow;
    for (const entry of byWindow) {
      if (entry.transcript_path && entry.start && entry.end) {
        // ISO-8601 strings compare lexicographically; intervals overlap when start <= other.end && other.start <= end
        if (entry.start <= te && ts <= entry.end) {
          return entry.transcript_path;
        }
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
