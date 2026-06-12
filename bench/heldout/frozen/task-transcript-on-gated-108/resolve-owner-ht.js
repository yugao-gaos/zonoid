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
  if (agentId == null) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct transcript_path on agent record (takes priority over session)
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: session -> sessionTranscript lookup
  if (agent.session != null) {
    const path = sessionTranscript[agent.session];
    if (path != null) return path;
  }

  // Leg 3: byWindow overlap — find run with maximum overlap against task's claim window
  const taskWindow = win[taskKey];
  if (!taskWindow || !taskWindow.start) return null;

  const taskStart = new Date(taskWindow.start).getTime();
  const taskEnd = taskWindow.end ? new Date(taskWindow.end).getTime() : Date.now();

  let bestPath = null;
  let bestOverlap = 0;

  for (const entry of byWindow) {
    if (!entry.transcript_path || !entry.start) continue;
    const entryStart = new Date(entry.start).getTime();
    const entryEnd = entry.end ? new Date(entry.end).getTime() : Date.now();

    const overlap = Math.max(0, Math.min(taskEnd, entryEnd) - Math.max(taskStart, entryStart));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestPath = entry.transcript_path;
    }
  }

  return bestPath;
}

module.exports = { resolveOwner };
