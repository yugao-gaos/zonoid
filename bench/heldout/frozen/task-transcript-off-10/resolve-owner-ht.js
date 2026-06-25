// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolves the transcript file holding a task's token usage by following:
//   task -> assignee (logical agent id) -> agent record -> transcript.
// An agent resolves to a transcript either by a direct `transcript_path`, or
// by a `session` that maps to a transcript via `sessionTranscript`.

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};

  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session != null) {
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
