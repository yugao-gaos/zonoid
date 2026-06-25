'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolve the transcript that holds a task's token usage by following:
//   task -> assignee (logical agent id) -> agent record -> transcript.
// An agent resolves to a transcript either directly (transcript_path on the
// record) or indirectly (its session mapped via sessionTranscript).
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const agentId = (registry.assignee || {})[taskKey];
  if (agentId == null) return null;

  const agent = (registry.agents || {})[agentId];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session) {
    const path = (registry.sessionTranscript || {})[agent.session];
    if (path) return path;
  }

  return null;
}

module.exports = { resolveOwner };
