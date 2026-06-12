/**
 * Returns ids of stale claims: in_progress tasks whose agent has stopped heartbeating.
 * Ordered ascending by lastHeartbeatMs (null/missing treated as -Infinity, i.e. oldest first).
 *
 * @param {Array<{id, status, agent, lastHeartbeatMs}>} tasks
 * @param {number} nowMs
 * @param {number} staleMs
 * @returns {string[]}
 */
function findStaleClaims(tasks, nowMs, staleMs) {
  return tasks
    .filter(t =>
      t.status === 'in_progress' &&
      typeof t.agent === 'string' && t.agent !== '' &&
      (t.lastHeartbeatMs == null || nowMs - t.lastHeartbeatMs > staleMs)
    )
    .sort((a, b) => {
      const aHb = a.lastHeartbeatMs ?? -Infinity;
      const bHb = b.lastHeartbeatMs ?? -Infinity;
      return aHb - bHb;
    })
    .map(t => t.id);
}

module.exports = { findStaleClaims };
