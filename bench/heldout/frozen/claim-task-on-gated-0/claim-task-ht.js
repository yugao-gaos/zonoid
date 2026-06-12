function claimTask(store, taskId, agentId) {
  const task = store.tasks[taskId];
  if (!task) return { ok: false, reason: 'not_found' };
  if (task.status !== 'pending') return { ok: false, reason: task.status };
  task.status = 'in_progress';
  task.agent = agentId;
  return { ok: true, task };
}

module.exports = { claimTask };
