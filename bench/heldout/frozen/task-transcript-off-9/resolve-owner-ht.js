'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolves the transcript file that holds a task's token usage by following
// the task's assignee to an agent record, then the agent record to a transcript:
//   1. agent record carries `transcript_path` directly, OR
//   2. agent record carries a `session` that maps to a transcript via
//      `sessionTranscript`.
// Returns null if neither route yields a transcript.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const agentId = registry.assignee && registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents && registry.agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session) {
    const viaSession =
      registry.sessionTranscript && registry.sessionTranscript[agent.session];
    if (viaSession) return viaSession;
  }

  return null;
}

module.exports = { resolveOwner };
