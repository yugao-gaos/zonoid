'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Attribution: a task is claimed by an assignee (a logical agent id). Resolve
// that agent to a transcript by one of two routes:
//   1. the agent record carries a `transcript_path` directly, or
//   2. the agent record carries a `session` that maps to a transcript via
//      `sessionTranscript`.
// If neither route yields a transcript, return null.
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
