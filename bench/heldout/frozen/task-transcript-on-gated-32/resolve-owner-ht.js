'use strict';

// resolveOwner(taskKey, registry) -> transcript path string | null
//
// Resolves the transcript that holds a task's token usage. A task is claimed
// by an assignee (a logical agent id); we resolve that agent to a transcript.
//
// Resolution order:
//   1. assignee agent record carries transcript_path directly.
//   2. assignee agent record carries a session that maps via sessionTranscript.
//   3. fallback: correlate the task's claim window against harness run windows
//      (byWindow) and pick the run with the largest time overlap, then resolve
//      its transcript_path / session. This recovers tasks whose assignee record
//      carries neither session nor path (~40% on real data), which routes 1-2
//      silently miss.

function parseMs(iso) {
  if (iso == null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

// Resolve a record (agent or run) to a transcript via direct path then session.
function recordTranscript(rec, sessionTranscript) {
  if (!rec) return null;
  if (rec.transcript_path) return rec.transcript_path;
  if (rec.session != null && sessionTranscript[rec.session]) {
    return sessionTranscript[rec.session];
  }
  return null;
}

function bestOverlappingRun(win, runs, now) {
  const ws = parseMs(win.start);
  if (ws == null) return null;
  const we = win.end == null ? now : parseMs(win.end);
  const winEnd = we == null ? now : we;

  let best = null;
  let bestOverlap = -Infinity;
  for (const run of runs) {
    if (!run) continue;
    const rs = parseMs(run.start);
    if (rs == null) continue;
    const re = run.end == null ? now : parseMs(run.end);
    const runEnd = re == null ? now : re;

    // overlap = min(ends) - max(starts); >= 0 means the intervals touch.
    const overlap = Math.min(winEnd, runEnd) - Math.max(ws, rs);
    if (overlap >= 0 && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = run;
    }
  }
  return best;
}

function resolveOwner(taskKey, registry) {
  const reg = registry || {};
  const assignee = reg.assignee || {};
  const agents = reg.agents || {};
  const sessionTranscript = reg.sessionTranscript || {};

  // Routes 1 & 2: resolve through the task's assignee agent record.
  const agentId = assignee[taskKey];
  if (agentId != null) {
    const direct = recordTranscript(agents[agentId], sessionTranscript);
    if (direct) return direct;
  }

  // Route 3: time-window overlap correlation against harness run windows.
  const win = (reg.window || {})[taskKey];
  const runs = reg.byWindow || [];
  if (win && runs.length) {
    const now = Date.now();
    const run = bestOverlappingRun(win, runs, now);
    const viaWindow = recordTranscript(run, sessionTranscript);
    if (viaWindow) return viaWindow;
  }

  return null;
}

module.exports = { resolveOwner };
