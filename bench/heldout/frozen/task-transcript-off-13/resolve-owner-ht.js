'use strict';

// Resolve the transcript file that holds a given task's token usage.
// A task is claimed by an assignee (a logical agent id); resolve that agent
// to a transcript either directly or via its session.
function resolveOwner(taskKey, registry) {
  const agentId = registry.assignee && registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents && registry.agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null && registry.sessionTranscript) {
    const path = registry.sessionTranscript[agent.session];
    if (path != null) return path;
  }

  return null;
}

module.exports = { resolveOwner };
