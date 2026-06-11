'use strict';

/**
 * Resolve the transcript path that holds a task's token usage.
 *
 * Look up the task's assignee, then resolve that agent to a transcript:
 *   1. the agent record's own `transcript_path`, if present; otherwise
 *   2. the agent record's `session` mapped through `sessionTranscript`.
 *
 * @param {string} taskKey
 * @param {object} registry
 * @returns {string|null} the transcript path, or null if none is attributable.
 */
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const { assignee, agents, sessionTranscript } = registry;

  const agentId = assignee && assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents && agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null && sessionTranscript) {
    const path = sessionTranscript[agent.session];
    if (path != null) return path;
  }

  return null;
}

module.exports = { resolveOwner };
