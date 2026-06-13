'use strict';

// Tasks whose completion can unblock dependents — complete_task and terminal set_status
// responses carry newly_ready so hookless harnesses get the post-agent.sh nudge in-band.
const TERMINAL_STATUSES = new Set(['done', 'tested', 'failed', 'canceled']);

/** Ready task keys from a buildGraph() payload (excludes note nodes). */
function readyKeys(graph) {
  const out = new Set();
  for (const t of (graph && graph.tasks) || []) {
    if (t.kind === 'note') continue;
    if (t.status === 'ready') out.add(t.id);
  }
  return out;
}

/** Keys present in `after` but not `before` — tasks unblocked by this completion. */
function diffNewlyReady(before, after) {
  const out = [];
  for (const key of after) {
    if (!before.has(key)) out.push(key);
  }
  out.sort();
  return out;
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

module.exports = { TERMINAL_STATUSES, readyKeys, diffNewlyReady, isTerminalStatus };
