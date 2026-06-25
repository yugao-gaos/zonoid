'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// A task is claimed by an assignee (a logical agent id). To find the
// transcript that holds the task's token usage, resolve the assignee's
// agent record to a transcript:
//   1. the agent record's own transcript_path, if present; otherwise
//   2. the agent's session mapped through sessionTranscript, if present.
// If neither route yields a transcript, return null.
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
