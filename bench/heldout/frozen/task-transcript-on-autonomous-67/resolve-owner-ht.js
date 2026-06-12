'use strict';

/**
 * Resolve the transcript path that holds a task's token usage.
 *
 * A task is claimed by an assignee (a logical agent id). Given the task's
 * assignee, resolve that agent to a transcript:
 *   1. If the agent record carries `transcript_path`, that is the transcript.
 *   2. Else if the agent record carries a `session` that maps to a transcript
 *      via `sessionTranscript`, that is the transcript.
 * Otherwise return null.
 *
 * @param {string} taskKey
 * @param {{
 *   assignee?: Object,
 *   agents?: Object,
 *   sessionTranscript?: Object,
 * }} registry
 * @returns {string|null}
 */
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};

  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null) {
    const path = sessionTranscript[agent.session];
    if (path != null) return path;
  }

  return null;
}

module.exports = { resolveOwner };
