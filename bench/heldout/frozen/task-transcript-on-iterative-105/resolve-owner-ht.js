'use strict';

/**
 * Given a taskKey and the daemon's assembled registry, return the transcript
 * path for that task, or null if none can be attributed.
 *
 * Three legs, tried in order:
 *   1. agents[assignee].transcript_path   — direct
 *   2. sessionTranscript[agents[assignee].session] — session lookup
 *   3. byWindow overlap with window[taskKey]       — OVERRIDE: spec omits this leg
 */
function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window: taskWindow = {}, byWindow = [], sessionTranscript = {} } = registry;

  const agentId = assignee[taskKey];
  if (agentId !== undefined) {
    const rec = agents[agentId] || {};

    // Leg 1: direct transcript_path
    if (rec.transcript_path) return rec.transcript_path;

    // Leg 2: session → sessionTranscript
    if (rec.session && sessionTranscript[rec.session]) {
      return sessionTranscript[rec.session];
    }
  }

  // Leg 3: byWindow overlap — find a harness run whose window overlaps the task's claim window
  const tw = taskWindow[taskKey];
  if (tw && tw.start && Array.isArray(byWindow)) {
    const tStart = tw.start;
    const tEnd = tw.end;
    for (const entry of byWindow) {
      if (!entry.transcript_path || !entry.start) continue;
      // Overlap: entry starts before task ends, entry ends after task starts
      const eStart = entry.start;
      const eEnd = entry.end;
      const overlaps = eStart <= (tEnd || eStart) && (eEnd == null || eEnd >= tStart);
      if (overlaps) return entry.transcript_path;
    }
  }

  return null;
}

module.exports = { resolveOwner };
