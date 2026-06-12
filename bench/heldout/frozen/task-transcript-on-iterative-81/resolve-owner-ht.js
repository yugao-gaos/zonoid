'use strict';

/**
 * Resolve the transcript file that holds a task's token usage.
 *
 * A task is claimed by an assignee (a logical agent id). We resolve that agent
 * to a transcript by one of two routes:
 *   1. the agent record carries a `transcript_path` directly, or
 *   2. the agent record carries a `session` that maps to a transcript via
 *      `registry.sessionTranscript`.
 *
 * @param {string} taskKey
 * @param {object} registry - { assignee, agents, window, byWindow, sessionTranscript }
 * @returns {string|null} the transcript path, or null if none is attributable.
 */
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agents = registry.agents || {};
  const agent = agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session) {
    const sessionTranscript = registry.sessionTranscript || {};
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
