'use strict';

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const {
    assignee = {},
    agents = {},
    window: taskWindows = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry;

  const agentId = assignee[taskKey];
  if (agentId == null) return null;

  const agentRecord = agents[agentId] || {};

  // Leg 1: direct transcript_path on agent record
  if (agentRecord.transcript_path) return agentRecord.transcript_path;

  // Leg 2: session -> sessionTranscript
  if (agentRecord.session) {
    const path = sessionTranscript[agentRecord.session];
    if (path) return path;
  }

  // Leg 3: byWindow time-window overlap (required — ~40% of records carry no session/transcript_path)
  const taskWin = taskWindows[taskKey];
  if (!taskWin || !taskWin.start) return null;

  const taskStart = Date.parse(taskWin.start);
  const taskEnd = taskWin.end ? Date.parse(taskWin.end) : Infinity;

  let best = null;
  let bestOverlap = 0;

  for (const entry of byWindow) {
    if (!entry.start || !entry.transcript_path) continue;
    const entryStart = Date.parse(entry.start);
    const entryEnd = entry.end ? Date.parse(entry.end) : Infinity;
    const overlap = Math.min(taskEnd, entryEnd) - Math.max(taskStart, entryStart);
    if (overlap > 0 && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = entry.transcript_path;
    }
  }

  return best;
}

module.exports = { resolveOwner };
