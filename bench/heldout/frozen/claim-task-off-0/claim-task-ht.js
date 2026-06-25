function claimTask(store, taskId, agentId) {
  const task = store.tasks[taskId];
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status === 'in_progress') return { ok: false, reason: 'already_claimed' };
  if (task.status !== 'pending') return { ok: false, reason: 'not_claimable' };
  task.status = 'in_progress';
  task.agent = agentId;
  return { ok: true, task };
}

module.exports = { claimTask };
