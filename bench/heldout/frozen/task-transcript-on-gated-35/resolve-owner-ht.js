'use strict';

// resolveOwner(taskKey, registry) -> transcript path string, or null.
//
// A task is claimed by an assignee (a logical agent id). We resolve that agent
// to the transcript file that holds the task's token usage:
//   1. direct  — the agent record carries a transcript_path
//   2. session — the agent record carries a session that maps via sessionTranscript
//   3. window  — fall back to time-window overlap between the task's claim window
//                and the harness run windows (byWindow).
//
// Route 3 matters because on real data ~40% of assignee agent records carry no
// session and no transcript_path; an exact-match-only resolver silently misses
// them. Correlating the task's claim window against run windows by time overlap
// recovers the transcript (graph note note-mq7kyiir6sx).

function toMs(iso) {
  if (typeof iso !== 'string') return NaN;
  return new Date(iso).getTime();
}

// Resolve a record that may carry { transcript_path } and/or { session } to a path.
function transcriptFor(record, sessionTranscript) {
  if (!record) return null;
  if (record.transcript_path) return record.transcript_path;
  const session = record.session;
  if (session && sessionTranscript && sessionTranscript[session]) {
    return sessionTranscript[session];
  }
  return null;
}

function resolveOwner(taskKey, registry) {
  if (!registry) return null;

  const assignee = registry.assignee || {};
  const agents = registry.agents || {};
  const window = registry.window || {};
  const byWindow = registry.byWindow || [];
  const sessionTranscript = registry.sessionTranscript || {};

  // Routes 1 & 2: task -> assignee -> agent record -> transcript (direct or session).
  const agentId = assignee[taskKey];
  if (agentId != null) {
    const direct = transcriptFor(agents[agentId], sessionTranscript);
    if (direct) return direct;
  }

  // Route 3: correlate the task's claim window with harness run windows by overlap.
  const claim = window[taskKey];
  if (claim) {
    const cs = toMs(claim.start);
    const ce = toMs(claim.end);
    if (!Number.isNaN(cs) && !Number.isNaN(ce)) {
      let best = null;
      let bestOverlap = 0;
      for (const run of byWindow) {
        if (!run) continue;
        const rs = toMs(run.start);
        const re = toMs(run.end);
        if (Number.isNaN(rs) || Number.isNaN(re)) continue;
        const overlap = Math.min(ce, re) - Math.max(cs, rs);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = run;
        }
      }
      if (best) {
        const t = transcriptFor(best, sessionTranscript);
        if (t) return t;
      }
    }
  }

  return null;
}

module.exports = { resolveOwner };
