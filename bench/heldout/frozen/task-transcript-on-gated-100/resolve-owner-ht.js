'use strict';

function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct transcript_path on agent record
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent has a session that maps to a transcript
  if (agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3: byWindow fallback — find the harness run whose window overlaps the task's claim window
  const taskWin = window[taskKey];
  if (taskWin && taskWin.start && taskWin.end) {
    const tStart = new Date(taskWin.start).getTime();
    const tEnd = new Date(taskWin.end).getTime();
    const match = byWindow.find(entry => {
      if (!entry.transcript_path || !entry.start || !entry.end) return false;
      const eStart = new Date(entry.start).getTime();
      const eEnd = new Date(entry.end).getTime();
      return eStart <= tEnd && eEnd >= tStart;
    });
    if (match) return match.transcript_path;
  }

  return null;
}

module.exports = { resolveOwner };
