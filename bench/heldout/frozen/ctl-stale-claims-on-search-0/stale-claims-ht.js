'use strict';

// Returns ids of stale agent claims, oldest heartbeat first.
// A task is a stale claim iff: status === 'in_progress', agent is a non-empty
// string, and its heartbeat age (nowMs - lastHeartbeatMs) is strictly greater
// than staleMs. A task with no/null lastHeartbeatMs counts as stale (age = ∞).
// Order: ascending by lastHeartbeatMs (oldest first); missing/null heartbeats
// sort first (infinite age), among themselves in input order.
function findStaleClaims(tasks, nowMs, staleMs) {
  if (!Array.isArray(tasks)) return [];

  const stale = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t || t.status !== 'in_progress') continue;
    if (typeof t.agent !== 'string' || t.agent === '') continue;

    const hb = t.lastHeartbeatMs;
    const missing = hb === undefined || hb === null;
    if (!missing && !(nowMs - hb > staleMs)) continue;

    stale.push({ id: t.id, hb, missing, idx: i });
  }

  stale.sort((a, b) => {
    if (a.missing && b.missing) return a.idx - b.idx;
    if (a.missing) return -1;
    if (b.missing) return 1;
    return a.hb - b.hb;
  });

  return stale.map((s) => s.id);
}

module.exports = { findStaleClaims };
