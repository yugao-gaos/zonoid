/**
 * Resolve the transcript path for a task given the daemon's assembled registry.
 *
 * Three attribution legs (in order):
 *   1. agent record carries transcript_path directly
 *   2. agent record carries session → sessionTranscript lookup
 *   3. (OVERRIDE — spec incomplete) task claim window overlaps a byWindow entry
 *      Used when inline main-agent work leaves no session/transcript on the agent record.
 */
function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry;

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct path on agent record
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: session → sessionTranscript
  if (agent.session && sessionTranscript[agent.session]) {
    return sessionTranscript[agent.session];
  }

  // Leg 3: byWindow overlap using task claim window
  const taskWindow = window[taskKey];
  if (taskWindow && taskWindow.start) {
    const taskStart = taskWindow.start;
    const taskEnd = taskWindow.end || taskStart;
    for (const entry of byWindow) {
      if (!entry.transcript_path || !entry.start || !entry.end) continue;
      if (entry.start <= taskEnd && entry.end >= taskStart) {
        return entry.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
