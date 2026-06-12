'use strict';

// Resolve the transcript file that holds a task's token usage.
// A task is claimed by an assignee (a logical agent id); we resolve that
// agent to a transcript either directly or via its session.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const agentId = registry.assignee && registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents && registry.agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session && registry.sessionTranscript) {
    const path = registry.sessionTranscript[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
