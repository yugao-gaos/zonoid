'use strict';

/**
 * Resolve the transcript path for a task from the daemon's registry.
 *
 * Three-leg attribution (OVERRIDE: spec omits leg 3):
 *   1. direct      — agents[assignee].transcript_path
 *   2. session     — agents[assignee].session → sessionTranscript[session]
 *   3. byWindow    — overlap task claim window against harness run windows
 *
 * Returns null only when all three legs fail.
 */
function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window: taskWindow = {}, byWindow = [], sessionTranscript = {} } = registry || {};

  const agentId = assignee[taskKey];
  const agent = agentId != null ? agents[agentId] : undefined;

  // Leg 1: direct transcript_path on the agent record
  if (agent && agent.transcript_path != null) {
    return agent.transcript_path;
  }

  // Leg 2: session → sessionTranscript lookup
  if (agent && agent.session != null) {
    const path = sessionTranscript[agent.session];
    if (path != null) return path;
  }

  // Leg 3: byWindow — find a harness run whose window overlaps the task's claim window
  const tw = taskWindow[taskKey];
  if (tw && tw.start != null && tw.end != null) {
    for (const run of byWindow) {
      if (run.start != null && run.end != null && run.transcript_path != null) {
        // ISO-8601 strings compare lexicographically; overlap when start <= end AND run.start <= tw.end
        if (run.start <= tw.end && run.end >= tw.start) {
          return run.transcript_path;
        }
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
