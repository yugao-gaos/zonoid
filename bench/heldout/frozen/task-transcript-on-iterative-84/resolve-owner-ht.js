'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Given a task, find the transcript file that holds its token usage. A task is
// claimed by an assignee (logical agent id); we resolve that agent to a
// transcript via three legs (any registry field may be absent):
//
//   1. direct   - the agent record carries transcript_path.
//   2. session  - the agent record carries a session that maps to a transcript
//                 via sessionTranscript.
//   3. byWindow - (override: the public spec omits this) when the agent record
//                 carries neither, fall back to the harness run whose [start,end]
//                 overlaps the task's claim window[taskKey].
//
// Returns null only when all three legs fail.

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee && registry.assignee[taskKey];
  const agent = (assignee != null && registry.agents) ? registry.agents[assignee] : null;

  // Leg 1: direct transcript_path on the agent record.
  if (agent && agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent's session -> sessionTranscript.
  if (agent && agent.session && registry.sessionTranscript) {
    const viaSession = registry.sessionTranscript[agent.session];
    if (viaSession) return viaSession;
  }

  // Leg 3: byWindow overlap with the task's claim window.
  const taskWindow = registry.window && registry.window[taskKey];
  const runs = registry.byWindow;
  if (taskWindow && Array.isArray(runs)) {
    const taskStart = parseTime(taskWindow.start);
    const taskEnd = parseTime(taskWindow.end);
    if (taskStart != null && taskEnd != null) {
      for (const run of runs) {
        if (!run || !run.transcript_path) continue;
        const runStart = parseTime(run.start);
        const runEnd = parseTime(run.end);
        if (runStart == null || runEnd == null) continue;
        // Half-open/closed overlap: intervals touch or cross.
        if (taskStart <= runEnd && runStart <= taskEnd) return run.transcript_path;
      }
    }
  }

  return null;
}

function parseTime(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

module.exports = { resolveOwner };
