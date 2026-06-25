'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolve the task's assignee, then map that agent to a transcript:
//   1. the agent record's own `transcript_path`, else
//   2. the agent's `session` looked up in `sessionTranscript`.
// Return null if no transcript is attributable.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const { assignee, agents, sessionTranscript } = registry;

  const agentId = assignee && assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents && agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session != null && sessionTranscript) {
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
