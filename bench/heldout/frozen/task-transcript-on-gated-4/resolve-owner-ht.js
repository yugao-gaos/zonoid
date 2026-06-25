'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Look up the task's assignee, then resolve that agent to a transcript:
//   - agent record's own `transcript_path`, else
//   - agent record's `session` mapped through `sessionTranscript`.
// Return null if neither route yields a transcript.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const agentId = registry.assignee && registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents && registry.agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null && registry.sessionTranscript) {
    const path = registry.sessionTranscript[agent.session];
    if (path != null) return path;
  }

  return null;
}

module.exports = { resolveOwner };
