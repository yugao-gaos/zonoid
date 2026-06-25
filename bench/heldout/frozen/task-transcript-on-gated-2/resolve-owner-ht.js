'use strict';

/**
 * Resolve the transcript file that holds a task's token usage.
 *
 * A task is claimed by an assignee (a logical agent id). We look up the task's
 * assignee, resolve that agent to a transcript via one of two routes, and return
 * the transcript path — or null when none can be attributed.
 *
 * @param {string} taskKey
 * @param {object} registry
 * @returns {string|null}
 */
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const agentId = registry.assignee && registry.assignee[taskKey];
  if (!agentId) return null;

  const agent = registry.agents && registry.agents[agentId];
  if (!agent) return null;

  // Direct route: the agent record carries the transcript path.
  if (agent.transcript_path) return agent.transcript_path;

  // Session route: the agent's session maps to a known transcript.
  if (agent.session && registry.sessionTranscript) {
    const fromSession = registry.sessionTranscript[agent.session];
    if (fromSession) return fromSession;
  }

  return null;
}

module.exports = { resolveOwner };
