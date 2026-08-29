'use strict';

const frontier = require('./frontier');
const overlayStore = require('./overlay');

// Versioned, presentation-neutral contract for the dashboard Kanban view. Cards retain the existing
// task key used by selection and /task/detail; columns carry ordered references instead of copying
// task detail. Scope is Frontier membership plus explicit pins and tasks with unresolved user gates.
const COLUMNS = Object.freeze([
  Object.freeze({ id: 'queue', label: 'Plan' }),
  Object.freeze({ id: 'ready', label: 'Ready' }),
  Object.freeze({ id: 'wip', label: 'WIP' }),
  Object.freeze({ id: 'review', label: 'Review' }),
  Object.freeze({ id: 'done', label: 'Done' }),
]);

function laneForTask(task) {
  const status = String(task && task.status || 'not_ready').toLowerCase();
  const reviewState = String(task && task.review_state || '').toLowerCase();
  const mergeState = String(task && task.merge_state || '').toLowerCase();

  if (status === 'done' || status === 'canceled' || mergeState === 'merged' || reviewState === 'landed') return 'done';
  if (status === 'tested') return 'review';
  if (status === 'in_progress') return 'wip';
  if (status === 'ready') return 'ready';
  return 'queue';
}

function reviewCue(task) {
  const state = String(task && task.review_state || '').toLowerCase();
  const verdict = String(task && task.review_verdict || '').toUpperCase();
  const merge = String(task && task.merge_state || '').toLowerCase();
  if (verdict === 'KICK_BACK' || state === 'rejected') return 'kick_back';
  if (task && task.status === 'tested' && (merge === 'review_pending' || state === 'pending' || state === 'requested')) return 'pending';
  if (verdict === 'APPROVE' || state === 'approved') return 'approved';
  return null;
}

function mergeCue(task) {
  const state = String(task && task.merge_state || '').toLowerCase();
  return ['pending', 'conflict', 'failed', 'merged'].includes(state) ? state : null;
}

function guidanceTaskKey(guidance) {
  if (!guidance) return null;
  const action = guidance.action || {};
  return action.task_key || action.taskKey || guidance.origin_task || null;
}

function userGatesByTask(guidance) {
  const gates = new Map();
  for (const item of guidance || []) {
    if (!item || item.resolved || overlayStore.guidanceAudience(item) !== 'user') continue;
    const taskKey = guidanceTaskKey(item);
    if (!taskKey) continue;
    const gate = gates.get(taskKey) || { count: 0, blocking: false };
    gate.count++;
    gate.blocking = gate.blocking || item.severity !== 'review';
    gates.set(taskKey, gate);
  }
  return gates;
}

function idSet(values) {
  return new Set([...(values || [])].filter(Boolean).map(String));
}

function isOperationalTask(task) {
  return !!(task && task.id && !overlayStore.isNonTaskNode(task) && !frontier.isInternalTask(task));
}

function buildKanbanProjection({ tasks = [], frontierTaskIds, pinnedTaskIds = [], guidance = [] } = {}) {
  const operationalTasks = tasks.filter(isOperationalTask);
  const frontierIds = frontierTaskIds == null
    ? frontier.frontierKeep(operationalTasks)
    : idSet(frontierTaskIds);
  const explicitPins = idSet(pinnedTaskIds);
  const userGates = userGatesByTask(guidance);
  const cards = [];

  for (const task of operationalTasks) {
    const inFrontier = frontierIds.has(task.id);
    const explicitlyPinned = explicitPins.has(task.id);
    const gate = userGates.get(task.id) || null;
    if (!inFrontier && !explicitlyPinned && !gate) continue;

    cards.push({
      task_key: task.id,
      label: task.label || task.id,
      lane: laneForTask(task),
      status: task.status || null,
      assignee: task.agent_id || null,
      tags: Array.isArray(task.tags) ? task.tags : [],
      frontier: inFrontier,
      pinned: explicitlyPinned || !!gate,
      cues: {
        review: reviewCue(task),
        merge: mergeCue(task),
        user_gate: gate ? { state: gate.blocking ? 'blocked' : 'pending', count: gate.count } : null,
      },
    });
  }

  const columns = COLUMNS.map((column) => ({
    ...column,
    task_keys: cards.filter((card) => card.lane === column.id).map((card) => card.task_key),
  }));
  const lanes = Object.fromEntries(columns.map((column) => [column.id, column.task_keys.length]));

  return {
    version: 1,
    columns,
    cards,
    summary: { total: cards.length, lanes },
  };
}

module.exports = {
  COLUMNS,
  buildKanbanProjection,
  laneForTask,
  reviewCue,
  mergeCue,
};
