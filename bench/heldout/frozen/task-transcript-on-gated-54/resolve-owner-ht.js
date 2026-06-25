// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Given a task and the read-time registry the daemon assembles, return the
// transcript file attributed to that task. A task is claimed by an assignee
// (a logical agent id); we resolve that agent to a transcript via one of two
// routes:
//   1. the agent record carries a transcript_path directly, or
//   2. the agent record carries a session that maps to a transcript through
//      sessionTranscript.
// If neither route yields a transcript, return null.

function resolveOwner(taskKey, registry) {
  const assignee = (registry && registry.assignee) || {};
  const agents = (registry && registry.agents) || {};
  const sessionTranscript = (registry && registry.sessionTranscript) || {};

  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agent = agents[agentId];
  if (!agent) return null;

  // Route 1: direct transcript path on the agent record.
  if (agent.transcript_path) return agent.transcript_path;

  // Route 2: agent's session maps to a known transcript.
  if (agent.session != null) {
    const viaSession = sessionTranscript[agent.session];
    if (viaSession) return viaSession;
  }

  return null;
}

module.exports = { resolveOwner };
