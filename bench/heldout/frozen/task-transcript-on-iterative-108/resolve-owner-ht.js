'use strict';

function resolveOwner(taskKey, registry) {
  const assignee = (registry.assignee || {})[taskKey];
  if (!assignee) return null;

  const agent = (registry.agents || {})[assignee];

  // Leg 1: direct transcript_path on the agent record
  if (agent && agent.transcript_path) {
    return agent.transcript_path;
  }

  // Leg 2: session → sessionTranscript lookup
  if (agent && agent.session) {
    const path = (registry.sessionTranscript || {})[agent.session];
    if (path) return path;
  }

  // Leg 3: byWindow — find a harness run whose window overlaps the task's claim window
  const taskWindow = (registry.window || {})[taskKey];
  if (taskWindow && taskWindow.start && taskWindow.end) {
    for (const run of (registry.byWindow || [])) {
      if (run.transcript_path && run.start && run.end &&
          run.start <= taskWindow.end && taskWindow.start <= run.end) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
