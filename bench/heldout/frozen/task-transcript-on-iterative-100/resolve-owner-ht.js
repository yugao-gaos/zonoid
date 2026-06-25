/**
 * resolveOwner — given a taskKey and the daemon registry, return the transcript
 * path attributed to that task, or null if none can be found.
 *
 * Three-leg resolution (OVERRIDE: spec's two-leg description is incomplete):
 *   1. direct      — agents[assignee].transcript_path
 *   2. session     — agents[assignee].session → sessionTranscript[session]
 *   3. byWindow    — find byWindow entry whose run window overlaps task claim window
 */
function resolveOwner(taskKey, registry) {
  const {
    assignee = {},
    agents = {},
    window: taskWindow = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry || {};

  const agentId = assignee[taskKey];
  if (agentId != null) {
    const rec = agents[agentId] || {};

    // Leg 1: direct transcript_path on the agent record
    if (rec.transcript_path) return rec.transcript_path;

    // Leg 2: session → sessionTranscript lookup
    if (rec.session && sessionTranscript[rec.session]) {
      return sessionTranscript[rec.session];
    }
  }

  // Leg 3: byWindow overlap — find a harness run whose window overlaps the task's claim window
  const claim = taskWindow[taskKey];
  if (claim && claim.start && claim.end) {
    const claimStart = claim.start;
    const claimEnd = claim.end;
    for (const run of byWindow) {
      if (run.transcript_path && run.start && run.end) {
        if (run.start <= claimEnd && claimStart <= run.end) {
          return run.transcript_path;
        }
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
