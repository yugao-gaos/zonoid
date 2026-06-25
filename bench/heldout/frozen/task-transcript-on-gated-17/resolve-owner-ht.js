'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Look up the task's assignee, then resolve that agent to a transcript:
//   1. the agent record's transcript_path directly, else
//   2. the agent record's session mapped through sessionTranscript.
// If neither route yields a transcript, return null.
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
