'use strict';

/**
 * Resolve the transcript path for a task, using three-leg attribution:
 * 1. direct: agent record has transcript_path
 * 2. session: agent record has session → look up sessionTranscript
 * 3. byWindow: match task claim window against byWindow entries by overlap
 *
 * Returns null only when all three legs fail.
 */
function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: windows = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  if (agentId != null) {
    const agent = agents[agentId] || {};

    // Leg 1: direct transcript_path on agent record
    if (agent.transcript_path) {
      return agent.transcript_path;
    }

    // Leg 2: session → sessionTranscript lookup
    if (agent.session && sessionTranscript[agent.session]) {
      return sessionTranscript[agent.session];
    }
  }

  // Leg 3: byWindow — find a run whose window overlaps the task's claim window
  const taskWindow = windows[taskKey];
  if (taskWindow && Array.isArray(byWindow)) {
    const taskStart = taskWindow.start ? new Date(taskWindow.start).getTime() : null;
    const taskEnd   = taskWindow.end   ? new Date(taskWindow.end).getTime()   : null;

    for (const run of byWindow) {
      if (!run.transcript_path) continue;
      const runStart = run.start ? new Date(run.start).getTime() : null;
      const runEnd   = run.end   ? new Date(run.end).getTime()   : null;

      // Overlap: neither interval ends before the other begins
      const starts_before_task_ends = runStart == null || taskEnd   == null || runStart <= taskEnd;
      const ends_after_task_starts  = runEnd   == null || taskStart == null || runEnd   >= taskStart;

      if (starts_before_task_ends && ends_after_task_starts) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
