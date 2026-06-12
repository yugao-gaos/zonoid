'use strict';

// Three-leg resolver per KB override note-mqa3vbpct2c:
//   1. direct:     agents[assignee].transcript_path
//   2. session:    agents[assignee].session -> sessionTranscript[session]
//   3. byWindow:   task's claim window overlaps a harness run window -> that run's transcript_path
// Missing window end is treated as +infinity (open-ended claim still in progress).
function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: win = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  if (!agentId) return null;

  const agent = agents[agentId];
  if (!agent) return null;

  // Leg 1: direct transcript path
  if (agent.transcript_path) return agent.transcript_path;

  // Leg 2: session -> sessionTranscript
  if (agent.session) {
    const path = sessionTranscript[agent.session];
    if (path) return path;
  }

  // Leg 3: byWindow temporal overlap
  const taskWindow = win[taskKey];
  if (!taskWindow) return null;

  const { start: taskStart, end: taskEnd } = taskWindow;

  for (const entry of byWindow) {
    if (!entry.transcript_path) continue;
    // Two intervals overlap when each starts before the other ends.
    // Missing end fields are treated as +infinity (no upper bound).
    const taskBeforeEntryEnd = !entry.end || taskStart <= entry.end;
    const entryBeforeTaskEnd = !taskEnd || entry.start <= taskEnd;
    if (taskBeforeEntryEnd && entryBeforeTaskEnd) return entry.transcript_path;
  }

  return null;
}

module.exports = { resolveOwner };
