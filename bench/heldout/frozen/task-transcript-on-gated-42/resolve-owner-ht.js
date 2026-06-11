'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Attribution: find the task's assignee, then resolve that agent to a
// transcript via one of two routes:
//   1. the agent record carries a transcript_path directly, or
//   2. the agent record carries a session that maps to a transcript
//      through registry.sessionTranscript.
// If neither route yields a transcript, return null.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const agentId = registry.assignee && registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents && registry.agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null) {
    const bySession =
      registry.sessionTranscript && registry.sessionTranscript[agent.session];
    if (bySession != null) return bySession;
  }

  return null;
}

module.exports = { resolveOwner };
