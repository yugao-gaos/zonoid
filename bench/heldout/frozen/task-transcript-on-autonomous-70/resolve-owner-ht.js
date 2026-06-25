'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Finds the transcript file that holds a task's token usage by resolving the
// task's assignee (a logical agent id) to a transcript:
//   1. the agent record's own `transcript_path`, else
//   2. the agent record's `session` mapped through `sessionTranscript`.
// Returns null if neither route yields a transcript.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};

  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null) {
    const path = sessionTranscript[agent.session];
    if (path != null) return path;
  }

  return null;
}

module.exports = { resolveOwner };
