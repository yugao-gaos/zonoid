function resolveOwner(taskKey, registry) {
  const agentId = registry.assignee?.[taskKey];
  if (!agentId) return null;

  const agent = registry.agents?.[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session) {
    return registry.sessionTranscript?.[agent.session] ?? null;
  }

  return null;
}

module.exports = { resolveOwner };
