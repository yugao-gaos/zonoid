// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Look up the task's assignee, then resolve that agent to a transcript:
//   1. direct:  the agent record carries a transcript_path.
//   2. session: the agent record carries a session that maps to a transcript
//               via registry.sessionTranscript.
// If neither route yields a transcript, return null.

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const agentId = registry.assignee && registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents && registry.agents[agentId];
  if (!agent) return null;

  // 1. direct path on the agent record
  if (agent.transcript_path) return agent.transcript_path;

  // 2. session -> transcript
  if (agent.session != null && registry.sessionTranscript) {
    const path = registry.sessionTranscript[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
