'use strict';

/**
 * Resolve the transcript path for a task, given the daemon's registry.
 *
 * Three-leg attribution (OVERRIDE note:note-mqa3vbpct2c):
 *   1. direct      — agents[assignee].transcript_path
 *   2. session     — agents[assignee].session → sessionTranscript[session]
 *   3. byWindow    — find byWindow entry whose [start,end] overlaps task window[taskKey]
 *
 * Returns null only when all three legs fail.
 */
function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window: win = {}, byWindow = [], sessionTranscript = {} } = registry;

  const agentId = assignee[taskKey];
  if (agentId != null) {
    const rec = agents[agentId] || {};

    // Leg 1: direct transcript_path on agent record
    if (rec.transcript_path) return rec.transcript_path;

    // Leg 2: session → sessionTranscript lookup
    if (rec.session && sessionTranscript[rec.session]) {
      return sessionTranscript[rec.session];
    }
  }

  // Leg 3: byWindow time-overlap fallback
  const taskWin = win[taskKey];
  if (taskWin && taskWin.start && taskWin.end) {
    const tStart = taskWin.start;
    const tEnd   = taskWin.end;
    const hit = byWindow.find(
      (e) => e && e.start && e.end && e.transcript_path &&
             e.start <= tEnd && tStart <= e.end
    );
    if (hit) return hit.transcript_path;
  }

  return null;
}

module.exports = { resolveOwner };
