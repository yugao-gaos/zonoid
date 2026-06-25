'use strict';

// findStaleClaims(tasks, nowMs, staleMs)
// Returns ids of in_progress tasks whose agent has gone stale, oldest heartbeat first.
//
// A task is a stale claim iff ALL of:
//   - status === 'in_progress'
//   - agent is a non-empty string
//   - heartbeat age (nowMs - lastHeartbeatMs) is STRICTLY > staleMs;
//     a missing/null lastHeartbeatMs counts as stale (never heartbeated, age = infinity).
//
// Order: ascending by lastHeartbeatMs (oldest first). Missing/null heartbeats
// are treated as age infinity, so they come first, among themselves in input order.

function hasHeartbeat(task) {
  return task.lastHeartbeatMs !== undefined && task.lastHeartbeatMs !== null;
}

function findStaleClaims(tasks, nowMs, staleMs) {
  if (!Array.isArray(tasks)) return [];

  const stale = tasks.filter((task) => {
    if (!task || task.status !== 'in_progress') return false;
    if (typeof task.agent !== 'string' || task.agent === '') return false;
    if (!hasHeartbeat(task)) return true; // never heartbeated → stale
    return nowMs - task.lastHeartbeatMs > staleMs;
  });

  // Stable sort: missing/null heartbeats (age infinity) sort first; otherwise
  // ascending by lastHeartbeatMs. Array.prototype.sort is stable, so ties keep
  // input order.
  stale.sort((a, b) => {
    const aHas = hasHeartbeat(a);
    const bHas = hasHeartbeat(b);
    if (!aHas && !bHas) return 0;
    if (!aHas) return -1;
    if (!bHas) return 1;
    return a.lastHeartbeatMs - b.lastHeartbeatMs;
  });

  return stale.map((task) => task.id);
}

module.exports = { findStaleClaims };
