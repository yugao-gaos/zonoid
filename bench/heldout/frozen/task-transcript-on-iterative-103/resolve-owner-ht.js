// Three-leg resolver for task → transcript attribution.
// OVERRIDE note (note-mqa3vbpct2c): spec omits leg 3 (byWindow fallback);
// ~40% of agent records carry neither transcript_path nor session.
function resolveOwner(taskKey, registry) {
  const { assignee = {}, agents = {}, window: wins = {}, byWindow = [], sessionTranscript = {} } = registry || {};

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agent = agents[agentId] || {};

  // Leg 1: direct transcript_path on the agent record
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: session → sessionTranscript
  if (agent.session) {
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  // Leg 3: byWindow — find the harness run whose window overlaps the task's claim window
  const taskWin = wins[taskKey];
  if (taskWin && taskWin.start && taskWin.end) {
    const tStart = taskWin.start;
    const tEnd = taskWin.end;
    for (const run of byWindow) {
      if (run.transcript_path && run.start && run.end && run.start < tEnd && tStart < run.end) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
