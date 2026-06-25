'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolve a task to the transcript file that holds its token usage by way of
// its assignee agent record:
//   1. agent.transcript_path, if present, is the transcript.
//   2. else agent.session mapped through sessionTranscript, if present.
// Anything missing along the way yields null.

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
