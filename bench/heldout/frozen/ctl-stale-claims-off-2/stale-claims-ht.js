'use strict';

function findStaleClaims(tasks, nowMs, staleMs) {
  if (!Array.isArray(tasks)) return [];

  const stale = [];
  for (const task of tasks) {
    if (!task || task.status !== 'in_progress') continue;
    if (typeof task.agent !== 'string' || task.agent === '') continue;

    const hb = task.lastHeartbeatMs;
    const missing = hb === undefined || hb === null;
    if (missing) {
      stale.push({ id: task.id, hb: null });
      continue;
    }
    if (nowMs - hb > staleMs) {
      stale.push({ id: task.id, hb });
    }
  }

  // Oldest heartbeat first; missing/null heartbeats are age-infinity (come first),
  // among themselves in input order (stable sort preserves it).
  stale.sort((a, b) => {
    if (a.hb === null && b.hb === null) return 0;
    if (a.hb === null) return -1;
    if (b.hb === null) return 1;
    return a.hb - b.hb;
  });

  return stale.map((s) => s.id);
}

module.exports = { findStaleClaims };
