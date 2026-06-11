// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Attribute a task to the transcript file holding its token usage. A task is
// claimed by an assignee (a logical agent id); resolve that agent to a transcript:
//   1. direct:  the agent record carries `transcript_path` -> use it.
//   2. session: the agent record carries a `session` that maps to a transcript
//               via `sessionTranscript` -> use it.
// If neither route yields a transcript, return null.
//
// Any field within any record may be absent, so every lookup is guarded.

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee && registry.assignee[taskKey];
  if (assignee == null) return null;

  const agent = registry.agents && registry.agents[assignee];
  if (!agent) return null;

  // 1. direct
  if (agent.transcript_path) return agent.transcript_path;

  // 2. session -> sessionTranscript
  if (agent.session && registry.sessionTranscript) {
    const viaSession = registry.sessionTranscript[agent.session];
    if (viaSession) return viaSession;
  }

  return null;
}

module.exports = { resolveOwner };
