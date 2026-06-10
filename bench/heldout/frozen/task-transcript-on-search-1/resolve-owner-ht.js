'use strict';

// Parse an ISO-8601 string to epoch ms, falling back when absent/invalid.
function toMs(iso, fallback) {
  if (iso == null) return fallback;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? fallback : t;
}

// Resolve a single run/agent record to a transcript path:
// prefer a direct transcript_path, else its session via sessionTranscript.
function pathOf(rec, sessionTranscript) {
  if (!rec) return null;
  if (rec.transcript_path) return rec.transcript_path;
  if (rec.session && sessionTranscript && sessionTranscript[rec.session]) {
    return sessionTranscript[rec.session];
  }
  return null;
}

// Given a taskKey and the registry the daemon assembles at read time, return
// the transcript path attributed to that task, or null if none can be found.
//
// Three routes, tried in order:
//   1. the assignee's agent record carries a transcript_path directly;
//   2. the assignee's agent record carries a session that maps to a transcript;
//   3. fallback — correlate the task's claim window against harness run windows
//      (byWindow) and pick the run whose interval overlaps the task window most.
// Route 3 matters because on real data a large fraction of assignee records
// carry neither field; exact-match alone silently drops those tasks.
function resolveOwner(taskKey, registry) {
  if (!registry) return null;
  const {
    assignee = {},
    agents = {},
    window = {},
    byWindow = [],
    sessionTranscript = {},
  } = registry;

  // Routes 1 & 2: resolve via the task's assignee agent record.
  const agentId = assignee[taskKey];
  if (agentId != null) {
    const direct = pathOf(agents[agentId], sessionTranscript);
    if (direct) return direct;
  }

  // Route 3: time-window overlap correlation against harness runs.
  const taskWin = window[taskKey];
  if (!taskWin || !Array.isArray(byWindow) || byWindow.length === 0) return null;

  const now = Date.now();
  const tStart = toMs(taskWin.start, -Infinity);
  const tEnd = toMs(taskWin.end, now);

  let best = null;
  let bestOverlap = -Infinity;
  for (const run of byWindow) {
    const path = pathOf(run, sessionTranscript);
    if (!path) continue;
    const rStart = toMs(run.start, -Infinity);
    const rEnd = toMs(run.end, now);
    // overlap = min(ends) - max(starts); >= 0 means the intervals touch.
    const overlap = Math.min(tEnd, rEnd) - Math.max(tStart, rStart);
    if (overlap >= 0 && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = path;
    }
  }

  return best;
}

module.exports = { resolveOwner };
