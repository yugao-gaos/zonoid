'use strict';

// Resolve the transcript path that holds a given task's token usage.
//
// A task is claimed by an assignee (a logical agent id). Given a taskKey and
// the registry the daemon assembles at read time, return the transcript path
// for that task, or null if none can be attributed.
function resolveOwner(taskKey, registry) {
  const agentId = registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents[agentId];
  if (agent == null) return null;

  // Direct: the agent record carries the transcript path.
  if (agent.transcript_path != null) return agent.transcript_path;

  // Session: the agent's session maps to a transcript.
  if (agent.session != null) {
    const path = registry.sessionTranscript[agent.session];
    if (path != null) return path;
  }

  return null;
}

module.exports = { resolveOwner };
