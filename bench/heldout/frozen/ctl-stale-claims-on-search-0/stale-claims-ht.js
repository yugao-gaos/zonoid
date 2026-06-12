'use strict';

function findStaleClaims(tasks, nowMs, staleMs) {
  const stale = tasks.filter(t =>
    t.status === 'in_progress' &&
    typeof t.agent === 'string' && t.agent !== '' &&
    (t.lastHeartbeatMs == null || nowMs - t.lastHeartbeatMs > staleMs)
  );

  stale.sort((a, b) => {
    const aNone = a.lastHeartbeatMs == null;
    const bNone = b.lastHeartbeatMs == null;
    if (aNone && bNone) return 0;
    if (aNone) return -1;
    if (bNone) return 1;
    return a.lastHeartbeatMs - b.lastHeartbeatMs;
  });

  return stale.map(t => t.id);
}

module.exports = { findStaleClaims };
