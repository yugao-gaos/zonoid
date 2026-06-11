'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolve a task to the transcript file holding its token usage:
//   1. find the task's assignee (logical agent id)
//   2. direct:  agent record carries transcript_path -> that path
//   3. session: agent record carries session that maps via sessionTranscript -> that path
// Return null if neither route yields a transcript. Every field may be absent.
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
