'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Look up the task's assignee, then resolve that agent to a transcript:
//   1. direct:  the agent record carries a transcript_path.
//   2. session: the agent record carries a session that maps to a
//               transcript via sessionTranscript.
// If neither route yields a transcript, return null.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const agentId = registry.assignee && registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents && registry.agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null) {
    const path = registry.sessionTranscript && registry.sessionTranscript[agent.session];
    if (path != null) return path;
  }

  return null;
}

module.exports = { resolveOwner };
