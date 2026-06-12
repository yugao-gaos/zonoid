'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Given a task, find the transcript file that holds its token usage. A task is
// claimed by an assignee (a logical agent id); resolve that agent to a transcript.
//
// Attribution has THREE legs (the prose spec only documents the first two and
// wrongly says to return null after them — a byWindow fallback is required):
//   1. direct:    agents[assignee].transcript_path
//   2. session:   sessionTranscript[ agents[assignee].session ]
//   3. byWindow:  the byWindow run whose [start,end] overlaps the task's claim
//                 window[taskKey] [start,end] -> that run's transcript_path
// Return null only when all three legs fail. Every lookup is guarded since any
// field within any record may be absent.

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};
  const window = registry.window || {};
  const byWindow = registry.byWindow || [];

  const agentId = assignee[taskKey];
  const agent = agentId != null ? agents[agentId] : undefined;

  // Leg 1: direct transcript on the agent record.
  if (agent && agent.transcript_path) return agent.transcript_path;

  // Leg 2: agent's session maps to a transcript.
  if (agent && agent.session != null) {
    const viaSession = sessionTranscript[agent.session];
    if (viaSession) return viaSession;
  }

  // Leg 3: byWindow fallback — the run whose window overlaps the task's claim window.
  const claim = window[taskKey];
  if (claim && claim.start != null && claim.end != null && Array.isArray(byWindow)) {
    const claimStart = Date.parse(claim.start);
    const claimEnd = Date.parse(claim.end);
    if (!Number.isNaN(claimStart) && !Number.isNaN(claimEnd)) {
      for (const run of byWindow) {
        if (!run || !run.transcript_path || run.start == null || run.end == null) continue;
        const runStart = Date.parse(run.start);
        const runEnd = Date.parse(run.end);
        if (Number.isNaN(runStart) || Number.isNaN(runEnd)) continue;
        // Two intervals overlap iff each starts no later than the other ends.
        if (claimStart <= runEnd && runStart <= claimEnd) return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
