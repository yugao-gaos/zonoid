'use strict';

function resolveOwner(taskKey, registry) {
  const agentId = registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents[agentId];
  if (agent == null) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null) {
    const transcript = registry.sessionTranscript[agent.session];
    if (transcript != null) return transcript;
  }

  return null;
}

module.exports = { resolveOwner };
