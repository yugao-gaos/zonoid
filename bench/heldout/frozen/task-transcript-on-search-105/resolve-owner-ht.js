'use strict';

/**
 * Three-leg resolver:
 * 1. direct   — agents[assignee].transcript_path
 * 2. session  — agents[assignee].session → sessionTranscript[session]
 * 3. byWindow — task claim window overlaps a byWindow entry's run window
 */
function resolveOwner(taskKey, registry) {
  const assignee = registry.assignee && registry.assignee[taskKey];
  if (assignee) {
    const agent = registry.agents && registry.agents[assignee];
    if (agent) {
      if (agent.transcript_path) return agent.transcript_path;
      if (agent.session) {
        const path = registry.sessionTranscript && registry.sessionTranscript[agent.session];
        if (path) return path;
      }
    }
  }

  // Leg 3: byWindow overlap fallback
  const win = registry.window && registry.window[taskKey];
  if (win && registry.byWindow) {
    const taskStart = win.start ? new Date(win.start).getTime() : null;
    const taskEnd   = win.end   ? new Date(win.end).getTime()   : null;
    for (const entry of registry.byWindow) {
      if (!entry.transcript_path) continue;
      const eStart = entry.start ? new Date(entry.start).getTime() : null;
      const eEnd   = entry.end   ? new Date(entry.end).getTime()   : null;
      if (taskStart !== null && taskEnd !== null && eStart !== null && eEnd !== null) {
        if (taskStart < eEnd && eStart < taskEnd) return entry.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
