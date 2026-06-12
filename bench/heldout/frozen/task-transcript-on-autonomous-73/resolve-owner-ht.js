'use strict';

/**
 * Resolve the transcript path that holds a task's token usage.
 *
 * A task is claimed by an assignee (a logical agent id). Given the task and the
 * read-time registry, resolve that assignee to a transcript:
 *   1. direct  — the agent record carries `transcript_path`.
 *   2. session — the agent record carries `session`, mapped via `sessionTranscript`.
 * Return the transcript path, or `null` when none is attributable.
 *
 * @param {string} taskKey
 * @param {{
 *   assignee?: Object,
 *   agents?: Object,
 *   window?: Object,
 *   byWindow?: Array,
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
