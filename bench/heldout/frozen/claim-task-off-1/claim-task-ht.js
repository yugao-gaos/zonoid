'use strict';

// claimTask: an agent takes a task from the shared graph before working it.
// Only a pending task can be claimed; any other status (or a missing task) is
// refused without mutating the store.
function claimTask(store, taskId, agentId) {
  const task = store.tasks[taskId];

  if (!task) {
    return { ok: false, reason: 'not_found' };
  }

  if (task.status !== 'pending') {
    // Already in_progress, done, or canceled — surface why we can't claim it.
    return { ok: false, reason: task.status === 'in_progress' ? 'already_claimed' : task.status };
  }

  task.status = 'in_progress';
  task.agent = agentId;
  return { ok: true, task };
}

module.exports = { claimTask };
