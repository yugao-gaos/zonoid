/**
 * Resolve the transcript path for a task given the daemon's runtime registry.
 *
 * Three legs (all guarded — any field may be absent):
 *  1. direct:    agents[assignee].transcript_path
 *  2. session:   sessionTranscript[agents[assignee].session]
 *  3. byWindow:  find the byWindow entry whose [start,end] overlaps window[taskKey]
 *
 * Returns the first path found, or null when all three fail.
 */
function resolveOwner(taskKey, registry) {
  const assignee = registry.assignee?.[taskKey];
  if (!assignee) return null;

  const agent = registry.agents?.[assignee];

  // Leg 1: direct transcript_path on the agent record
  if (agent?.transcript_path) return agent.transcript_path;

  // Leg 2: session → sessionTranscript lookup
  if (agent?.session) {
    const path = registry.sessionTranscript?.[agent.session];
    if (path) return path;
  }

  // Leg 3: byWindow overlap — task claim window vs harness run windows
  const claim = registry.window?.[taskKey];
  if (claim?.start && claim?.end && Array.isArray(registry.byWindow)) {
    for (const run of registry.byWindow) {
      if (run.start && run.end && run.transcript_path &&
          run.start <= claim.end && run.end >= claim.start) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
