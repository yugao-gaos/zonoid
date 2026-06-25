'use strict';

function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: win = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  const agent = agentId != null ? (agents[agentId] || {}) : {};

  // Leg 1: agent record carries a direct transcript path
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent record carries a session → look up sessionTranscript
  if (agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3: byWindow overlap fallback — ~40% of agent records carry neither field
  const taskWin = win[taskKey];
  if (taskWin && taskWin.start && taskWin.end) {
    for (const entry of byWindow) {
      if (entry.transcript_path && entry.start && entry.end) {
        if (entry.start < taskWin.end && taskWin.start < entry.end) {
          return entry.transcript_path;
        }
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
