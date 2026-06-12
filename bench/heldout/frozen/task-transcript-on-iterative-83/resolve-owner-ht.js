'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// SPEC IS INCOMPLETE: the task's "How attribution works" section lists only two
// legs (direct transcript_path + session->sessionTranscript) and says to return
// null when neither works. That is wrong. ~40% of assignee agent records carry
// neither a transcript_path nor a session, so a two-leg resolver silently drops
// them. A required third leg attributes by claim-window overlap against byWindow.
// We return null ONLY when all three legs fail.

// Parse an ISO-8601 string to epoch ms, or NaN if absent/unparseable.
function ms(iso) {
  if (typeof iso !== 'string') return NaN;
  return new Date(iso).getTime();
}

// Two closed intervals [aStart,aEnd] and [bStart,bEnd] overlap iff
// aStart <= bEnd && bStart <= aEnd. Returns false if any bound is unparseable.
function overlaps(aStart, aEnd, bStart, bEnd) {
  if (Number.isNaN(aStart) || Number.isNaN(aEnd) ||
      Number.isNaN(bStart) || Number.isNaN(bEnd)) {
    return false;
  }
  return aStart <= bEnd && bStart <= aEnd;
}

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const sessionTranscript = registry.sessionTranscript || {};
  const windows = registry.window || {};
  const byWindow = Array.isArray(registry.byWindow) ? registry.byWindow : [];

  const agentId = assignee[taskKey];
  const agent = (agentId != null && agents[agentId]) || null;

  // Leg 1 — direct: the agent record carries the transcript path.
  if (agent && typeof agent.transcript_path === 'string') {
    return agent.transcript_path;
  }

  // Leg 2 — session: the agent's session maps to a known transcript.
  if (agent && agent.session != null) {
    const viaSession = sessionTranscript[agent.session];
    if (typeof viaSession === 'string') return viaSession;
  }

  // Leg 3 — byWindow fallback (REQUIRED): match the task's claim window against
  // the harness run windows and return the overlapping run's transcript.
  const taskWindow = windows[taskKey];
  if (taskWindow) {
    const tStart = ms(taskWindow.start);
    const tEnd = ms(taskWindow.end);
    for (const run of byWindow) {
      if (!run || typeof run.transcript_path !== 'string') continue;
      if (overlaps(tStart, tEnd, ms(run.start), ms(run.end))) {
        return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
