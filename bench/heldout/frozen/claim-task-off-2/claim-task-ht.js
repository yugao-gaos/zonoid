'use strict';

/**
 * Claim a task from a shared task-graph store on behalf of an agent.
 *
 * @param {{ tasks: Object<string, {id: string, status: string, agent: ?string}> }} store
 * @param {string} taskId
 * @param {string} agentId
 * @returns {{ ok: true, task: object } | { ok: false, reason: string }}
 */
function claimTask(store, taskId, agentId) {
  const task = store.tasks[taskId];

  if (!task) {
    return { ok: false, reason: 'not_found' };
  }

  // Only an unclaimed, pending task can be taken. Anything already
  // in_progress/done/canceled is refused without mutation, so a claim never
  // steals work from another agent or revives a finished task.
  if (task.status !== 'pending') {
    return { ok: false, reason: 'not_pending' };
  }

  task.status = 'in_progress';
  task.agent = agentId;

  return { ok: true, task };
}

module.exports = { claimTask };
