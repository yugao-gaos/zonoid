'use strict';

// resolveOwner(taskKey, registry) -> transcript path string | null
//
// For a given task, return the transcript file that holds that task's token
// usage. A task is claimed by an *assignee* (a logical agent id); resolution
// walks three routes in order, returning the first that yields a transcript:
//
//   1. direct   — the assignee's agent record carries `transcript_path`.
//   2. session  — the agent record carries a `session` that maps to a
//                 transcript via `sessionTranscript`.
//   3. window   — fallback. On real data ~40% of assignee agent records carry
//                 neither field, so the exact routes silently drop them. Those
//                 tasks are recoverable only by correlating the task's claim
//                 window against the harness run windows in `byWindow`: pick the
//                 run whose [start,end] interval overlaps the task window most.
//
// Returns null when no route attributes a transcript.

// A single "now" so a run/task with a missing end widens consistently.
const NOW = Date.now();

// Parse an ISO-8601 string to epoch ms; null when absent/unparseable.
function startMs(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// Like startMs, but a missing/unparseable end widens to now (open interval).
function endMs(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? NOW : t;
}

function resolveOwner(taskKey, registry) {
  if (!registry) return null;
  const {
    assignee = {},
    agents = {},
    window = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry;

  // Resolve a transcript from a record that may carry transcript_path or session.
  const fromRecord = (rec) => {
    if (!rec) return null;
    if (rec.transcript_path) return rec.transcript_path;
    if (rec.session && sessionTranscript[rec.session]) {
      return sessionTranscript[rec.session];
    }
    return null;
  };

  // Routes 1 & 2: direct path, then session-of-assignee.
  const direct = fromRecord(agents[assignee[taskKey]]);
  if (direct) return direct;

  // Route 3: time-window overlap correlation against harness runs.
  const w = window[taskKey];
  if (!w) return null;
  const wStart = startMs(w.start);
  if (wStart === null) return null;
  const wEnd = endMs(w.end);

  let best = null;
  let bestOverlap = -Infinity;
  for (const run of byWindow) {
    const rStart = startMs(run.start);
    if (rStart === null) continue;
    const rEnd = endMs(run.end);
    // overlap >= 0 means the intervals touch; larger overlap is a better match.
    const overlap = Math.min(wEnd, rEnd) - Math.max(wStart, rStart);
    if (overlap >= 0 && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = run;
    }
  }

  return fromRecord(best);
}

module.exports = { resolveOwner };
