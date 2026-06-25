'use strict';

// resolveOwner(taskKey, registry)
// Return the transcript path attributable to a task, or null.
//
// A task is claimed by an assignee (logical agent id). Resolve that agent to a
// transcript via one of two routes, in order:
//   1. direct:  the agent record carries a transcript_path.
//   2. session: the agent record carries a session that maps to a transcript
//               via sessionTranscript.
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
  if (agent.session != null) {
    const viaSession = registry.sessionTranscript && registry.sessionTranscript[agent.session];
    if (viaSession) return viaSession;
  }

  return null;
}

module.exports = { resolveOwner };
