'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Look up the task's assignee, then resolve that agent to a transcript:
//   1. direct:  the agent record carries a transcript_path.
//   2. session: the agent record carries a session that maps to a transcript
//               via registry.sessionTranscript.
// If neither route yields a transcript, return null. Any field may be absent,
// so every lookup is guarded.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee && registry.assignee[taskKey];
  if (!assignee) return null;

  const agent = registry.agents && registry.agents[assignee];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session && registry.sessionTranscript) {
    const fromSession = registry.sessionTranscript[agent.session];
    if (fromSession) return fromSession;
  }

  return null;
}

module.exports = { resolveOwner };
