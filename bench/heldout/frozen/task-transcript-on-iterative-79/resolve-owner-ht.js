'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolves the transcript file that holds a task's token usage. A task is
// claimed by an assignee (logical agent id); we resolve that agent to a
// transcript via three legs, in order:
//   1. direct:    the agent record carries transcript_path
//   2. session:   the agent record carries a session that sessionTranscript maps
//   3. byWindow:  fall back to the harness run whose window overlaps the task's
//                 claim window (required — many agent records carry neither
//                 transcript_path nor session)
// Returns null only when all three legs fail. Every lookup is guarded since any
// field may be absent. Pure: no I/O, deterministic.

function overlaps(a, b) {
  if (!a || !b) return false;
  const aStart = Date.parse(a.start);
  const aEnd = Date.parse(a.end);
  const bStart = Date.parse(b.start);
  const bEnd = Date.parse(b.end);
  if ([aStart, aEnd, bStart, bEnd].some(Number.isNaN)) return false;
  return aStart <= bEnd && bStart <= aEnd;
}

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee && registry.assignee[taskKey];
  const agent = assignee && registry.agents && registry.agents[assignee];

  // Leg 1: direct transcript_path on the agent record.
  if (agent && agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent's session -> sessionTranscript.
  if (agent && agent.session && registry.sessionTranscript) {
    const viaSession = registry.sessionTranscript[agent.session];
    if (viaSession) return viaSession;
  }

  // Leg 3: byWindow fallback — the harness run whose window overlaps the task's
  // claim window.
  const taskWindow = registry.window && registry.window[taskKey];
  if (taskWindow && Array.isArray(registry.byWindow)) {
    for (const run of registry.byWindow) {
      if (run && run.transcript_path && overlaps(taskWindow, run)) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
