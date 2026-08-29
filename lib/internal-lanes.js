'use strict';

const overlayStore = require('./overlay');
const judge = require('./judge');
const headlessDrain = require('./headless-drain');
const { isEligibleIntegrationTask } = require('./loop-autostart');

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
    for (const q of queue) {
      if (q.kind !== 'task-decision') continue;
      items.push({
        lane: 'decision',
        kind: 'task-decision',
        key: q.id,
        label: `${q.action} ${q.task_key}`,
        status: 'pending',
        source: 'judge',
        task_key: q.task_key,
        action: q.action,
        review_state: q.review_state || null,
        review_verdict: q.review_verdict || null,
        merge_state: q.merge_state || null,
        attempt_branch: q.attempt_branch || null,
        attempt_worktree: q.attempt_worktree || null,
      });
    }
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
    if (!isEligibleIntegrationTask(task, overlay)) continue;
    const lifecycle = overlayStore.reviewLifecycleFor(overlay, task.id, task.status);
    if (!lifecycle.review_state && !lifecycle.merge_state) continue;
    // TESTED GATE: prepare stamps review_state 'requested' at dispatch, so an in_progress/ready
    // task with a requested review is a worker still mid-flight — not a reviewable attempt.
    // Only status 'tested' produces a 'review' item (mirrors daemon.js
    // pendingReviewOrIntegrationAction, which iterates only t.status === 'tested').
    // Merge/conflict items need no extra gate: merge_state 'pending' requires an approved
    // review and 'conflict' is only stamped by a merge attempt — both states already derive
    // the task's status to 'tested' via lifecycleDerivedStatus (lib/overlay.js).
    const pendingReview = task.status === 'tested' && (lifecycle.review_state === 'requested'
      || lifecycle.review_state === 'pending'
      || lifecycle.merge_state === 'review_pending');
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

function internalGuidanceItems(overlay) {
  return overlayStore.internalGuidance(overlay).map((g) => guidanceItem('decision', g));
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
    ...internalGuidanceItems(ov),
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
