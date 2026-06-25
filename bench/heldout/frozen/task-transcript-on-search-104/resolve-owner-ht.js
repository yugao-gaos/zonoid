'use strict';

// Proxy for an open-ended interval end: ~year 275760, well beyond any real timestamp.
const INF = 8.64e15;

function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window: win = {}, byWindow = [], sessionTranscript = {} } = registry || {};

  const agentId = assignee[taskKey];
  if (agentId != null) {
    const agent = agents[agentId] || {};

    // Leg 1: direct transcript_path on agent record (takes priority over session)
    if (agent.transcript_path) return agent.transcript_path;

    // Leg 2: session -> sessionTranscript lookup
    if (agent.session && sessionTranscript[agent.session]) {
      return sessionTranscript[agent.session];
    }
  }

  // Leg 3: byWindow correlation — find the run whose window overlaps the task's claim window the most.
  // Missing end on either side widens that endpoint to INF (open-ended / still running).
  const taskWin = win[taskKey];
  if (!taskWin) return null;

  const tStart = Date.parse(taskWin.start);
  const tEnd = taskWin.end ? Date.parse(taskWin.end) : INF;

  let best = null;
  let bestOverlap = 0;

  for (const run of byWindow) {
    const rStart = Date.parse(run.start);
    const rEnd = run.end ? Date.parse(run.end) : INF;

    if (tStart >= rEnd || rStart >= tEnd) continue;

    const overlap = Math.min(tEnd, rEnd) - Math.max(tStart, rStart);
    if (overlap > bestOverlap && run.transcript_path) {
      bestOverlap = overlap;
      best = run.transcript_path;
    }
  }

  return best;
}

module.exports = { resolveOwner };
