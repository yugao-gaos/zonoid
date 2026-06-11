'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Find the task's assignee, resolve that agent to a transcript:
//   1. agent record carries `transcript_path` directly, or
//   2. agent record carries `session` that maps via `sessionTranscript`.
// If neither route yields a transcript, return null.
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
