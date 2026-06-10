'use strict';

// claimTask(store, taskId, agentId) — an agent takes a pending task before working it.
// A task is owned by exactly one agent from claim until completion, so only a `pending`
// task is claimable; any other status means it is already owned or terminal.
function claimTask(store, taskId, agentId) {
  const task = store.tasks[taskId];
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status !== 'pending') return { ok: false, reason: task.status };

  task.status = 'in_progress';
  task.agent = agentId;
  return { ok: true, task };
}

module.exports = { claimTask };
