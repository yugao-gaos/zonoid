// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Given a task, find the transcript file that holds that task's token usage by
// resolving the task's assignee (logical agent id) to a transcript:
//   1. agent record carries transcript_path directly, OR
//   2. agent record carries a session that maps to a transcript via sessionTranscript.
// If neither route yields a transcript, return null.

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee && registry.assignee[taskKey];
  if (!assignee) return null;

  const agent = registry.agents && registry.agents[assignee];
  if (!agent) return null;

  if (agent.transcript_path) return agent.transcript_path;

  if (agent.session && registry.sessionTranscript) {
    const fromSession = registry.sessionTranscript[agent.session];
    if (fromSession) return fromSession;
  }

  return null;
}

module.exports = { resolveOwner };
