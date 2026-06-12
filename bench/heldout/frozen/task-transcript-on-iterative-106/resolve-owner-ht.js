'use strict';

function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: wins = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  if (agentId === undefined) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct transcript_path on agent record
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: session -> sessionTranscript
  if (agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3: byWindow correlation — find run whose window overlaps the task's claim window most
  const taskWindow = wins[taskKey];
  if (!taskWindow || !byWindow.length) return null;

  const taskStart = Date.parse(taskWindow.start);
  const taskEnd = taskWindow.end ? Date.parse(taskWindow.end) : Date.now();

  let bestOverlap = 0;
  let bestPath = null;

  for (const run of byWindow) {
    if (!run.transcript_path) continue;
    const runStart = Date.parse(run.start);
    const runEnd = run.end ? Date.parse(run.end) : Date.now();
    const overlap = Math.max(0, Math.min(taskEnd, runEnd) - Math.max(taskStart, runStart));
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestPath = run.transcript_path;
    }
  }

  return bestPath;
}

module.exports = { resolveOwner };
