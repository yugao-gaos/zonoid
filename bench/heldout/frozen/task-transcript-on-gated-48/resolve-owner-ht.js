'use strict';

// Resolve the transcript file that holds a task's token usage.
// A task is claimed by an assignee (a logical agent id); the agent record
// either carries the transcript path directly or a session that maps to one.
function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session != null) {
    const viaSession = sessionTranscript[agent.session];
    if (viaSession) return viaSession;
  }

  return null;
}

module.exports = { resolveOwner };
