'use strict';

const overlayStore = require('./overlay');
const judge = require('./judge');
const headlessDrain = require('./headless-drain');

function taskItem(lane, kind, task, extra = {}) {
  return {
    lane,
    kind,
    key: task.id,
    label: task.label || task.id,
    status: task.status || null,
    source: extra.source || 'graph',
    ...extra,
  };
}

function guidanceItem(lane, g) {
  return {
    lane,
    kind: 'guidance',
    key: g.id,
    label: g.question || g.id,
    status: 'pending',
    source: 'guidance',
    severity: g.severity || 'blocking',
    trigger: g.trigger || null,
    action_kind: g.action && g.action.kind ? g.action.kind : null,
    task_key: g.action && (g.action.task_key || g.action.taskKey) || null,
  };
}

function judgeItems(overlay) {
  const items = [];
  const queue = judge.buildQueue(overlay);
  if (queue.length) {
    items.push({
      lane: 'decision',
      kind: 'judge_queue',
      key: 'judge:queue',
      label: 'judge queue',
      status: 'pending',
      source: 'judge',
      count: queue.length,
      by_kind: queue.reduce((acc, item) => {
        acc[item.kind] = (acc[item.kind] || 0) + 1;
        return acc;
      }, {}),
    });
  }
  const eager = judge.eagerJudgeNodes(overlay);
  if (eager.length) {
    items.push({
      lane: 'decision',
      kind: 'eager_judge',
      key: 'judge:eager',
      label: 'eager judge nodes',
      status: 'pending',
      source: 'judge',
      count: eager.length,
      nodes: eager.map((e) => e.node || e.key || e),
    });
  }
  return items;
}

function reviewItems(graph, overlay) {
  const items = [];
  for (const task of (graph && graph.tasks) || []) {
    const lifecycle = overlayStore.reviewLifecycleFor(overlay, task.id, task.status);
    if (!lifecycle.review_state && !lifecycle.merge_state) continue;
    const pendingReview = lifecycle.review_state === 'requested'
      || lifecycle.review_state === 'pending'
      || lifecycle.merge_state === 'review_pending';
    const pendingMerge = lifecycle.review_state === 'approved'
      && lifecycle.review_verdict === 'APPROVE'
      && lifecycle.merge_state === 'pending';
    const conflict = lifecycle.merge_state === 'conflict';
    if (!pendingReview && !pendingMerge && !conflict) continue;
    items.push(taskItem('decision', pendingMerge ? 'merge' : 'review', task, {
      source: 'review_lifecycle',
      review_state: lifecycle.review_state,
      review_verdict: lifecycle.review_verdict,
      merge_state: lifecycle.merge_state,
      attempt_branch: lifecycle.attempt_branch,
      attempt_worktree: lifecycle.attempt_worktree,
    }));
  }
  return items;
}

function learningItems(workspace) {
  if (!workspace) return [];
  let queues = [];
  try { queues = headlessDrain.findPendingLearnerQueues(workspace) || []; } catch { queues = []; }
  return queues.map((q) => ({
    lane: 'learning',
    kind: 'learner_queue',
    key: q.outDir || q.repo,
    label: q.repo || q.outDir || 'learner queue',
    status: q.injecting ? 'in_progress' : 'pending',
    source: 'learner',
    repo: q.repo || null,
    outDir: q.outDir || null,
    pending: q.pending || q.remaining || null,
    total: q.total || null,
    kept: q.kept || null,
    last_error: q.lastError || q.error || null,
  }));
}

function workItems(graph, overlay) {
  const blocked = overlay.blocked || {};
  return ((graph && graph.tasks) || [])
    .filter((task) => ['ready', 'in_progress', 'tested'].includes(task.status) || blocked[task.id])
    .map((task) => taskItem('work', blocked[task.id] ? 'blocked_task' : 'task', task, {
      source: 'graph',
      blocked_reason: blocked[task.id] || null,
      agent_id: task.agent_id || (overlay.assignee && overlay.assignee[task.id]) || null,
    }));
}

function userGateItems(overlay) {
  return overlayStore.userAttentionGuidance(overlay).map((g) => guidanceItem('user_gate', g));
}

function summarize(items) {
  const lanes = {};
  for (const item of items) {
    if (!lanes[item.lane]) lanes[item.lane] = { count: 0, by_kind: {} };
    lanes[item.lane].count++;
    lanes[item.lane].by_kind[item.kind] = (lanes[item.lane].by_kind[item.kind] || 0) + 1;
  }
  return { total: items.length, lanes };
}

function buildInternalLaneProjection({ workspace, graph, overlay, includeItems = true } = {}) {
  const ov = overlay || overlayStore.EMPTY();
  const g = graph || { tasks: [] };
  const items = [
    ...judgeItems(ov),
    ...reviewItems(g, ov),
    ...learningItems(workspace),
    ...workItems(g, ov),
    ...userGateItems(ov),
  ];
  const projection = {
    version: 1,
    workspace: workspace || null,
    generated_at: new Date().toISOString(),
    summary: summarize(items),
  };
  if (includeItems) projection.items = items;
  return projection;
}

module.exports = { buildInternalLaneProjection };
