'use strict';

// resolveOwner(taskKey, registry) -> transcript path string | null
//
// Resolve the transcript file that holds a task's token usage by following the
// task's assignee to a transcript:
//   1. assignee:           taskKey -> agentId
//   2. agent record:       transcript_path wins directly, if present
//   3. otherwise:          session -> sessionTranscript[session]
// If neither route yields a transcript, return null.
//
// Any field within a record may be absent, so every hop is guarded.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};

  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents[agentId];
  if (!agent) return null;

  if (agent.transcript_path != null) return agent.transcript_path;

  if (agent.session != null) {
    const path = sessionTranscript[agent.session];
    if (path != null) return path;
  }

  return null;
}

module.exports = { resolveOwner };
