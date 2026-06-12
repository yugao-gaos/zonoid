'use strict';

/**
 * Resolve the transcript path for the agent that claimed a task.
 *
 * Three legs (OVERRIDE note: spec only documents legs 1-2; leg 3 is required):
 *   1. agent record carries transcript_path directly
 *   2. agent record carries session → sessionTranscript lookup
 *   3. byWindow overlap: task claim window intersects a harness run window
 *      (needed when the main agent works inline — no SubagentStart hook fires,
 *       so the agent record has neither transcript_path nor session)
 *
 * @param {string} taskKey
 * @param {object} registry
 * @returns {string|null}
 */
function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: taskWindows = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry;

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct transcript path on the agent record
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: session → sessionTranscript
  if (agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3: byWindow time-window overlap fallback
  const taskWindow = taskWindows[taskKey];
  if (taskWindow && taskWindow.start && taskWindow.end) {
    for (const entry of byWindow) {
      if (!entry.start || !entry.end) continue;
      // ISO-8601 strings are lexicographically comparable
      if (entry.start <= taskWindow.end && entry.end >= taskWindow.start) {
        if (entry.transcript_path) return entry.transcript_path;
        if (entry.session && sessionTranscript[entry.session]) {
          return sessionTranscript[entry.session];
        }
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
