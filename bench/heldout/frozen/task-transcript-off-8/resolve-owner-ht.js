'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Find the task's assignee, then resolve that agent to a transcript:
//   1. the agent record's own transcript_path, or
//   2. the transcript its session maps to via sessionTranscript.
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
    const bySession = registry.sessionTranscript || {};
    const transcript = bySession[agent.session];
    if (transcript) return transcript;
  }

  return null;
}

module.exports = { resolveOwner };
