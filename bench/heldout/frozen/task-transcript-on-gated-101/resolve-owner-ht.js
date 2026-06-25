/**
 * Resolve the transcript path for a task given the daemon's registry.
 *
 * Three-leg attribution (OVERRIDE note:note-mqa3vbpct2c):
 *   1. direct     — agents[assignee].transcript_path
 *   2. session    — agents[assignee].session → sessionTranscript[session]
 *   3. byWindow   — task claim window overlaps a harness run window → that run's transcript_path
 *
 * Returns null only when all three legs fail.
 */
function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: windowMap = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  if (agentId !== undefined) {
    const agent = agents[agentId] || {};

    // Leg 1: direct transcript_path on the agent record
    if (agent.transcript_path) return agent.transcript_path;

    // Leg 2: agent session → sessionTranscript
    if (agent.session && sessionTranscript[agent.session]) {
      return sessionTranscript[agent.session];
    }
  }

  // Leg 3: byWindow overlap — find a harness run whose window overlaps the task's claim window
  const taskWindow = windowMap[taskKey];
  if (taskWindow && taskWindow.start && taskWindow.end) {
    for (const run of byWindow) {
      if (
        run.transcript_path &&
        run.start &&
        run.end &&
        run.start <= taskWindow.end &&
        taskWindow.start <= run.end
      ) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
