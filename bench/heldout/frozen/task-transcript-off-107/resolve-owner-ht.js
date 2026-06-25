function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, sessionTranscript = {} } = registry;
  const agentId = assignee[taskKey];
  if (!agentId) return null;
  const agent = agents[agentId];
  if (!agent) return null;
  if (agent.transcript_path) return agent.transcript_path;
  if (agent.session && sessionTranscript[agent.session]) return sessionTranscript[agent.session];
  return null;
}

module.exports = { resolveOwner };
