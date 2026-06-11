'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// A task is claimed by an assignee (logical agent id). Resolve that agent to a
// transcript: prefer the agent record's own transcript_path; otherwise follow
// its session through sessionTranscript. If neither yields a path, return null.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

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
