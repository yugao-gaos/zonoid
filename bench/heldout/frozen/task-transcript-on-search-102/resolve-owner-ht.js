'use strict';

/**
 * Resolve the transcript path for a given task key.
 *
 * Three-leg attribution (OVERRIDE note: spec's two-leg return-null is incomplete):
 *   1. direct       — agents[assignee].transcript_path
 *   2. session      — agents[assignee].session → sessionTranscript[session]
 *   3. byWindow     — window[taskKey] overlap with byWindow entries
 *
 * Returns null only when all three legs fail.
 */
function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window: win = {}, byWindow = [], sessionTranscript = {} } = registry || {};

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct transcript_path on the agent record
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: session → sessionTranscript lookup
  if (agent.session) {
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  // Leg 3: byWindow overlap fallback
  const taskWindow = win[taskKey];
  if (taskWindow && taskWindow.start && taskWindow.end) {
    const { start: ts, end: te } = taskWindow;
    for (const entry of byWindow) {
      if (entry.transcript_path && entry.start && entry.end) {
        // Overlap: task interval and entry interval share at least one point (exclusive end)
        if (ts < entry.end && entry.start < te) {
          return entry.transcript_path;
        }
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
