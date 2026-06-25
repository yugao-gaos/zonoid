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
  if (!agentId) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct transcript_path on the agent record
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent carries a session → look up sessionTranscript
  if (agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3: byWindow overlap — ~40% of agent records have neither field
  // Find a byWindow run whose [start,end] overlaps the task's claim window
  const tw = win[taskKey];
  if (tw && tw.start && tw.end) {
    for (const entry of byWindow) {
      if (entry.transcript_path && entry.start && entry.end) {
        if (entry.start < tw.end && tw.start < entry.end) {
          return entry.transcript_path;
        }
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
