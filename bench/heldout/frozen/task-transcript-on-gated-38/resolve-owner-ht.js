'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolve a task to the transcript file that holds its token usage:
//   task -> assignee (logical agent id) -> agent record -> transcript.
// An agent record yields a transcript either directly (transcript_path) or
// indirectly via its session (sessionTranscript[session]).
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
