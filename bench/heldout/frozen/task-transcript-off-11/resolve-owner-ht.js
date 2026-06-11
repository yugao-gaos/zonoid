// Resolve the transcript file that holds a given task's token usage.
//
// A task is claimed by an assignee (a logical agent id). We resolve that agent
// to a transcript either directly (the agent record carries transcript_path) or
// indirectly (the agent record carries a session that maps to a transcript via
// sessionTranscript). Returns the transcript path, or null if none attributable.

function resolveOwner(taskKey, registry) {
  const assignee = registry.assignee[taskKey];
  if (assignee == null) return null;

  const agent = registry.agents[assignee];
  if (agent == null) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null) {
    const transcript = registry.sessionTranscript[agent.session];
    if (transcript != null) return transcript;
  }

  return null;
}

module.exports = { resolveOwner };
