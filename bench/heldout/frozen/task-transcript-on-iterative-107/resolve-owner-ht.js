'use strict';

/**
 * Returns the transcript path for the agent that claimed taskKey, or null.
 *
 * Three legs in priority order:
 *   1. agent record carries transcript_path directly
 *   2. agent record carries a session that maps via sessionTranscript
 *   3. byWindow overlap: find the harness run whose window overlaps the task's
 *      claim window most (spec omits this leg but it is required — see OVERRIDE
 *      note "resolveOwner task transcript attribution")
 */
function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window: wins = {}, byWindow = [], sessionTranscript = {} } = registry;

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const rec = agents[agentId] || {};

  // Leg 1: direct transcript_path on agent record
  if (rec.transcript_path) return rec.transcript_path;

  // Leg 2: session → sessionTranscript
  if (rec.session && sessionTranscript[rec.session]) {
    return sessionTranscript[rec.session];
  }

  // Leg 3: byWindow time-overlap fallback
  const taskWin = wins[taskKey];
  if (!taskWin || !taskWin.start || !taskWin.end || !byWindow.length) return null;

  const tStart = new Date(taskWin.start).getTime();
  const tEnd   = new Date(taskWin.end).getTime();

  let best = null;
  let bestOverlap = 0;

  for (const run of byWindow) {
    if (!run.transcript_path || !run.start || !run.end) continue;
    const rStart = new Date(run.start).getTime();
    const rEnd   = new Date(run.end).getTime();
    const overlap = Math.min(tEnd, rEnd) - Math.max(tStart, rStart);
    if (overlap > 0 && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = run.transcript_path;
    }
  }

  return best;
}

module.exports = { resolveOwner };
