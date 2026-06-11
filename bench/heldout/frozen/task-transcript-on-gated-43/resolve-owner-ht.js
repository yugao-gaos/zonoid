'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Attribution: find the task's assignee, then resolve that agent to a transcript.
//   1. direct:  agents[assignee].transcript_path
//   2. session: agents[assignee].session -> sessionTranscript[session]
// If neither route yields a transcript, return null. (byWindow is not consulted;
// the contract returns null when neither direct nor session route attributes a path.)
//
// Any field within a record may be absent, so every lookup is guarded.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee && registry.assignee[taskKey];
  if (!assignee) return null;

  const agent = registry.agents && registry.agents[assignee];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session && registry.sessionTranscript) {
    const path = registry.sessionTranscript[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
