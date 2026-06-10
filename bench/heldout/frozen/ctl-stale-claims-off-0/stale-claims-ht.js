'use strict';

// Find tasks that are marked in_progress but whose agent has stopped
// heartbeating (a "stale claim"). Returns their ids, oldest heartbeat first.
function findStaleClaims(tasks, nowMs, staleMs) {
  if (!Array.isArray(tasks)) return [];

  const stale = tasks.filter((t) => {
    if (!t || t.status !== 'in_progress') return false;
    if (typeof t.agent !== 'string' || t.agent === '') return false;

    const hb = t.lastHeartbeatMs;
    if (hb === undefined || hb === null) return true; // never heartbeated
    return nowMs - hb > staleMs;
  });

  // Oldest heartbeat first; missing/null treated as age infinity (first),
  // ties broken by input order (stable sort).
  stale.sort((a, b) => {
    const aMissing = a.lastHeartbeatMs === undefined || a.lastHeartbeatMs === null;
    const bMissing = b.lastHeartbeatMs === undefined || b.lastHeartbeatMs === null;
    if (aMissing && bMissing) return 0;
    if (aMissing) return -1;
    if (bMissing) return 1;
    return a.lastHeartbeatMs - b.lastHeartbeatMs;
  });

  return stale.map((t) => t.id);
}

module.exports = { findStaleClaims };
