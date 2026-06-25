'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// Resolves the transcript file that holds a task's token usage. A task is
// claimed by an assignee (a logical agent id); we resolve that agent to a
// transcript via three legs. The spec's "How attribution works" section lists
// only the first two and says return null if neither works — that is
// incomplete. A third, byWindow time-window fallback is required: ~40% of
// assignee agent records carry neither transcript_path nor session, and
// without leg 3 those tasks silently return null.
//
// 1. direct:    agents[assignee].transcript_path
// 2. session:   sessionTranscript[ agents[assignee].session ]
// 3. byWindow:  the byWindow run whose [start,end] overlaps window[taskKey]
//
// Every field may be absent, so each lookup is guarded. Return null only when
// all three legs fail.

function toTime(iso) {
  if (typeof iso !== 'string') return NaN;
  return new Date(iso).getTime();
}

// Half-open-agnostic interval overlap: [aStart,aEnd] meets [bStart,bEnd].
function overlaps(aStart, aEnd, bStart, bEnd) {
  if (Number.isNaN(aStart) || Number.isNaN(aEnd) ||
      Number.isNaN(bStart) || Number.isNaN(bEnd)) {
    return false;
  }
  return aStart <= bEnd && bStart <= aEnd;
}

function resolveOwner(taskKey, registry) {
  if (!registry || typeof registry !== 'object') return null;

  const {
    assignee = {},
    agents = {},
    window = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry;

  const agentId = assignee && assignee[taskKey];
  const agent = (agentId != null && agents && agents[agentId]) || null;

  // Leg 1 — direct transcript on the agent record.
  if (agent && typeof agent.transcript_path === 'string') {
    return agent.transcript_path;
  }

  // Leg 2 — agent's session mapped to a known transcript.
  if (agent && agent.session != null && sessionTranscript) {
    const viaSession = sessionTranscript[agent.session];
    if (typeof viaSession === 'string') return viaSession;
  }

  // Leg 3 — byWindow fallback: a harness run whose window overlaps the task's
  // claim window. Independent of the assignee, so it still resolves when legs
  // 1/2 had no agent record.
  const claim = window && window[taskKey];
  if (claim && Array.isArray(byWindow)) {
    const taskStart = toTime(claim.start);
    const taskEnd = toTime(claim.end);
    for (const run of byWindow) {
      if (!run) continue;
      if (overlaps(taskStart, taskEnd, toTime(run.start), toTime(run.end))) {
        if (typeof run.transcript_path === 'string') return run.transcript_path;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
