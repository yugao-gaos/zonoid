'use strict';

// Resolve the transcript file that holds a task's token usage.
// A task is claimed by an assignee (a logical agent id); the assignee's agent
// record points at a transcript either directly or via its session.
function resolveOwner(taskKey, registry) {
  const agentId = registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents[agentId];
  if (agent == null) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null) {
    const path = registry.sessionTranscript[agent.session];
    if (path != null) return path;
  }

  return null;
}

module.exports = { resolveOwner };
