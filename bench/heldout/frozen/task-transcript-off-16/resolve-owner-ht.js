'use strict';

// Resolve the transcript file that holds a task's token usage.
// A task is claimed by an assignee (a logical agent id); we resolve that
// agent to a transcript either directly or via its session.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agents = registry.agents || {};
  const agent = agents[agentId];
  if (!agent) return null;

  // Direct: the agent record carries the transcript path.
  if (agent.transcript_path) return agent.transcript_path;

  // Indirect: the agent's session maps to a known transcript.
  if (agent.session != null) {
    const sessionTranscript = registry.sessionTranscript || {};
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
