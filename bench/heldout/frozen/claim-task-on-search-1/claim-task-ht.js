'use strict';

// Claim a task from a shared task graph: mark it in_progress and record the
// claiming agent. Only a `pending` task is claimable — a task that is already
// in_progress is owned by another agent, and done/canceled tasks are terminal.
// Refusals leave the task completely unchanged.
function claimTask(store, taskId, agentId) {
  const task = store.tasks[taskId];
  if (!task) return { ok: false, reason: 'not_found' };

  if (task.status !== 'pending') {
    const reason = task.status === 'in_progress' ? 'already_claimed' : task.status;
    return { ok: false, reason };
  }

  task.status = 'in_progress';
  task.agent = agentId;
  return { ok: true, task };
}

module.exports = { claimTask };
