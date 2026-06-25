'use strict';

function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: taskWindow = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agent = agents[agentId] || {};

  // Leg 1: agent record carries transcript_path directly
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent record carries session that maps to a transcript
  if (agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3 (OVERRIDE — spec omits this): byWindow overlap fallback
  // ~40% of agent records carry neither field; use claim-window overlap to find the run
  const claim = taskWindow[taskKey];
  if (claim && claim.start && claim.end) {
    const claimStart = new Date(claim.start);
    const claimEnd = new Date(claim.end);
    for (const entry of byWindow) {
      if (!entry.transcript_path || !entry.start || !entry.end) continue;
      if (claimStart < new Date(entry.end) && new Date(entry.start) < claimEnd) {
        return entry.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
