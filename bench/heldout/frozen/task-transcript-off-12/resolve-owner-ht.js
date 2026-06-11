'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Find the transcript that holds a task's token usage by resolving the task's
// assignee agent to a transcript:
//   1. direct  — the agent record carries `transcript_path`.
//   2. session — the agent record carries `session`, mapped via sessionTranscript.
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
