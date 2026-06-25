'use strict';

// Resolve, for a given task, the transcript file that holds that task's token
// usage. A task is claimed by an assignee (a logical agent id); we resolve that
// agent to a transcript either directly (the agent record carries the path) or
// via its session (the session maps to a transcript). Returns the path string,
// or null when none is attributable.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};

  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents[agentId];
  if (!agent) return null;

  // Direct: the agent record carries the transcript path.
  if (agent.transcript_path != null) return agent.transcript_path;

  // Session: the agent record carries a session that maps to a transcript.
  if (agent.session != null) {
    const viaSession = sessionTranscript[agent.session];
    if (viaSession != null) return viaSession;
  }

  return null;
}

module.exports = { resolveOwner };
