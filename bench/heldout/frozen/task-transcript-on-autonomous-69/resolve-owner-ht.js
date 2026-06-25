// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Given a task, find the transcript file that holds that task's token usage.
// A task is claimed by an assignee (a logical agent id); resolve that agent to
// a transcript via the agent's own path, or via its session.

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const agentId = registry.assignee && registry.assignee[taskKey];
  if (agentId == null) return null;

  const agent = registry.agents && registry.agents[agentId];
  if (!agent) return null;

  // Direct: the agent record carries the transcript path.
  if (agent.transcript_path) return agent.transcript_path;

  // Indirect: the agent's session maps to a transcript.
  if (agent.session != null && registry.sessionTranscript) {
    const path = registry.sessionTranscript[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
