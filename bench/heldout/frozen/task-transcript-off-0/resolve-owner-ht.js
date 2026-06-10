'use strict';

/**
 * Resolve the transcript path that holds a task's token usage.
 *
 * A task is claimed by an assignee (a logical agent id). The agent is resolved
 * to a transcript either directly (agent record carries `transcript_path`) or
 * indirectly (agent record carries a `session` that maps to a transcript via
 * `sessionTranscript`). Returns the transcript path, or null if none applies.
 *
 * @param {string} taskKey
 * @param {object} registry
 * @returns {string|null}
 */
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const { assignee, agents, sessionTranscript } = registry;

  const agentId = assignee && assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents && agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session && sessionTranscript) {
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
