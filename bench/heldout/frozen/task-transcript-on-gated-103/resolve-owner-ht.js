'use strict';

function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: windowMap = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct transcript_path on agent record
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent session → sessionTranscript lookup
  if (agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3: byWindow overlap with task claim window
  // Required for inline-work cases where agent record carries neither field.
  const taskWin = windowMap[taskKey];
  if (taskWin && taskWin.start && taskWin.end) {
    for (const entry of byWindow) {
      if (
        entry.transcript_path &&
        entry.start &&
        entry.end &&
        entry.start <= taskWin.end &&
        entry.end >= taskWin.start
      ) {
        return entry.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
