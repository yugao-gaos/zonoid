// Three-leg resolver: direct → session → byWindow overlap
// (byWindow leg required — ~40% of agent records carry neither transcript_path nor session)
function resolveOwner(taskKey, registry) {
  const assignee = registry.assignee && registry.assignee[taskKey];
  if (!assignee) return null;

  const agent = registry.agents && registry.agents[assignee];

  // Leg 1: direct transcript_path on the agent record
  if (agent && agent.transcript_path) return agent.transcript_path;

  // Leg 2: session → sessionTranscript lookup
  if (agent && agent.session) {
    const path = registry.sessionTranscript && registry.sessionTranscript[agent.session];
    if (path) return path;
  }

  // Leg 3: byWindow — find a harness run whose window overlaps the task's claim window
  const taskWindow = registry.window && registry.window[taskKey];
  if (taskWindow && taskWindow.start && taskWindow.end && Array.isArray(registry.byWindow)) {
    for (const run of registry.byWindow) {
      if (run.start && run.end && run.transcript_path &&
          run.start <= taskWindow.end && taskWindow.start <= run.end) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
