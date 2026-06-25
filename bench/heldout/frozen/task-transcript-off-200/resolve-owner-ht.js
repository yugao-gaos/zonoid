/**
 * Resolve the transcript path for a given task key using the daemon's registry.
 * @param {string} taskKey
 * @param {object} registry
 * @returns {string|null}
 */
function resolveOwner(taskKey, registry) {
  const agentId = (registry.assignee || {})[taskKey];
  if (!agentId) return null;

  const agent = (registry.agents || {})[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session) {
    const path = (registry.sessionTranscript || {})[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
