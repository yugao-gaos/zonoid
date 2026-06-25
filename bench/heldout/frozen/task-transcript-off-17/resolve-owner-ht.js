'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Look up the task's assignee, then resolve that agent to a transcript:
//   1. direct  — the agent record carries `transcript_path`.
//   2. session — the agent record carries a `session` that maps to a
//                transcript via `sessionTranscript`.
// If neither route yields a transcript, return null.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agents = registry.agents || {};
  const agent = agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session != null) {
    const sessionTranscript = registry.sessionTranscript || {};
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
