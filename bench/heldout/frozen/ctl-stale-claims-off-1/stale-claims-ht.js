'use strict';

function findStaleClaims(tasks, nowMs, staleMs) {
  if (!Array.isArray(tasks)) return [];

  const stale = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t || t.status !== 'in_progress') continue;
    if (typeof t.agent !== 'string' || t.agent === '') continue;

    const hb = t.lastHeartbeatMs;
    const missing = hb === undefined || hb === null;
    if (missing || nowMs - hb > staleMs) {
      stale.push({ id: t.id, hb, missing, idx: i });
    }
  }

  stale.sort((a, b) => {
    if (a.missing && b.missing) return a.idx - b.idx;
    if (a.missing) return -1;
    if (b.missing) return 1;
    if (a.hb !== b.hb) return a.hb - b.hb;
    return a.idx - b.idx;
  });

  return stale.map((s) => s.id);
}

module.exports = { findStaleClaims };
