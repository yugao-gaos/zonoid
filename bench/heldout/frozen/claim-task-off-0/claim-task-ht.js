'use strict';

// claimTask: an agent takes a task from the shared graph before working it.
// A task is claimable only while it is 'pending'. Any other status means
// someone/something already moved it, so the claim is refused and the task
// is left untouched.
function claimTask(store, taskId, agentId) {
  const task = store.tasks[taskId];

  if (!task) {
    return { ok: false, reason: 'not_found' };
  }

  if (task.status !== 'pending') {
    // 'in_progress' -> already claimed; 'done'/'canceled' -> not workable.
    const reason = task.status === 'in_progress' ? 'already_claimed' : task.status;
    return { ok: false, reason };
  }

  task.status = 'in_progress';
  task.agent = agentId;
  return { ok: true, task };
}

module.exports = { claimTask };
