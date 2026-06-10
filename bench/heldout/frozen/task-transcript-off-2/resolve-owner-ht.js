'use strict';

// Resolve the transcript path that holds a task's token usage.
// A task is claimed by an assignee (logical agent id); resolve that agent to a
// transcript via its direct transcript_path, or via its session + sessionTranscript.
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
