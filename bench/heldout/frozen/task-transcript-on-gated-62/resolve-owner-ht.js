'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Find the task's assignee, then resolve that agent to a transcript via one of
// two routes:
//   1. the agent record's own `transcript_path`, or
//   2. the agent record's `session` mapped through `sessionTranscript`.
// If neither route yields a transcript, return null. Every field may be absent.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};

  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents[agentId];
  if (!agent) return null;

  // Route 1: direct transcript path on the agent record.
  if (agent.transcript_path != null) return agent.transcript_path;

  // Route 2: agent's session mapped to a known transcript.
  if (agent.session != null) {
    const viaSession = sessionTranscript[agent.session];
    if (viaSession != null) return viaSession;
  }

  return null;
}

module.exports = { resolveOwner };
