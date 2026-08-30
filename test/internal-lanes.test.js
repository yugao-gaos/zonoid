#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const overlay = require('../lib/overlay');
const { buildInternalLaneProjection } = require('../lib/internal-lanes');

const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-internal-lanes-')));

const ov = overlay.EMPTY();
ov.epoch = 1;
ov.note_nodes = {
  n1: { id: 'n1', title: 'Needs edge', summary: 'Unwired note', validTo: null },
};
ov.edges = [
  { from: 'note:n2', to: 'task/a', kind: 'context', judged: false },
];
ov.status['task/ready'] = 'ready';
ov.status['task/run'] = 'in_progress';
ov.assignee['task/run'] = 'worker-a';
overlay.setReviewLifecycle(ov, 'task/review', {
  review_state: 'requested',
  merge_state: 'review_pending',
  attempt_branch: 'orch/attempt/task-review',
});
overlay.setReviewLifecycle(ov, 'task/merge', {
  review_state: 'approved',
  review_verdict: 'APPROVE',
  merge_state: 'pending',
  attempt_branch: 'orch/attempt/task-merge',
});
overlay.setReviewLifecycle(ov, 'task/kick', {
  review_state: 'rejected',
  review_verdict: 'KICK_BACK',
  merge_state: 'blocked',
});
overlay.setReviewLifecycle(ov, 'task/cancel', {
  review_state: 'canceled',
  review_verdict: 'APPROVE',
  merge_state: 'conflict',
});
overlay.setReviewLifecycle(ov, 'task/blocked-merge', {
  review_state: 'approved',
  review_verdict: 'APPROVE',
  merge_state: 'pending',
});
overlay.setBlocked(ov, 'task/blocked-merge', 'unsafe stale integration');
overlay.setBlocked(ov, 'task/canceled-blocked', 'stale historical hold');
overlay.setReviewLifecycle(ov, 'note:historical', {
  review_state: 'approved',
  review_verdict: 'APPROVE',
  merge_state: 'pending',
});
ov.notes['task/discard'] = 'discard requested by judge/1: obsolete attempt';
ov.notes['task/cancel'] = 'canceled by judge/1: superseded';
overlay.addGuidance(ov, {
  question: 'Should this outward action proceed?',
  context: 'Needs user approval',
  trigger: 'manual',
  severity: 'blocking',
});
overlay.addGuidance(ov, {
  question: 'Internal duplicate cluster',
  context: 'Judge housekeeping',
  trigger: 'dup_cluster',
  severity: 'review',
  action: { kind: 'dup-cluster', keys: ['note:a', 'note:b'] },
});
overlay.addGuidance(ov, {
  question: 'Resolve readiness repair for task/blocked',
  context: 'Missing dependency can be removed by the judge',
  trigger: 'readiness_repair',
  action: { kind: 'readiness-repair', task_key: 'task/blocked', dependency: 'task/missing' },
});

const graph = {
  tasks: [
    { id: 'task/ready', label: 'Ready task', status: 'ready', deps: [] },
    { id: 'task/run', label: 'Running task', status: 'in_progress', deps: [], agent_id: 'worker-a' },
    { id: 'task/review', label: 'Review task', status: 'tested', deps: [] },
    { id: 'task/merge', label: 'Merge task', status: 'tested', deps: [] },
    { id: 'task/kick', label: 'Kick task', status: 'failed', deps: [] },
    { id: 'task/discard', label: 'Discard task', status: 'tested', deps: [] },
    { id: 'task/cancel', label: 'Cancel task', status: 'canceled', deps: [] },
    { id: 'task/blocked-merge', label: 'Blocked merge', status: 'not_ready', deps: [] },
    { id: 'task/canceled-blocked', label: 'Canceled blocked', status: 'canceled', deps: [] },
    { id: 'note:historical', label: 'Historical note', kind: 'note', status: 'note', deps: [] },
  ],
};

const projection = buildInternalLaneProjection({ workspace: ws, graph, overlay: ov });

assert.equal(projection.version, 1);
assert.equal(projection.workspace, ws);
assert.ok(projection.generated_at);
assert.ok(Array.isArray(projection.items));

assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'judge_queue' && item.count >= 2));
assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'review' && item.key === 'task/review' && item.merge_state === 'review_pending'));
assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'task-decision' && item.task_key === 'task/review' && item.action === 'review'));
assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'task-decision' && item.task_key === 'task/merge' && item.action === 'merge' && item.merge_state === 'pending'));
assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'task-decision' && item.task_key === 'task/kick' && item.action === 'kick_back'));
assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'task-decision' && item.task_key === 'task/discard' && item.action === 'discard'));
assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'task-decision' && item.task_key === 'task/cancel' && item.action === 'cancel'));
assert.ok(!projection.items.some((item) => item.lane === 'decision' && item.kind === 'review' && item.key === 'task/cancel'));
assert.ok(!projection.items.some((item) => item.lane === 'decision' && item.kind === 'merge' && item.key === 'task/blocked-merge'));
assert.ok(!projection.items.some((item) => item.lane === 'work' && item.key === 'task/canceled-blocked'));
assert.ok(!projection.items.some((item) => item.lane === 'decision' && item.key === 'note:historical'));
assert.ok(!ov.reviews['task/merge-judge']);
assert.ok(projection.items.some((item) => item.lane === 'work' && item.kind === 'task' && item.key === 'task/ready'));
assert.ok(projection.items.some((item) => item.lane === 'work' && item.key === 'task/run' && item.agent_id === 'worker-a'));
assert.ok(projection.items.some((item) => item.lane === 'user_gate' && item.kind === 'guidance' && item.severity === 'blocking'));
assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'guidance' && item.action_kind === 'dup-cluster'));
assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'guidance' && item.action_kind === 'readiness-repair' && item.task_key === 'task/blocked'));
assert.ok(!projection.items.some((item) => item.lane === 'user_gate' && item.action_kind === 'dup-cluster'));
assert.ok(!projection.items.some((item) => item.lane === 'user_gate' && item.action_kind === 'readiness-repair'));
assert.equal(projection.summary.total, projection.items.length);
assert.ok(projection.summary.lanes.decision.count >= 2);
assert.ok(projection.summary.lanes.work.count >= 2);
assert.equal(projection.summary.lanes.user_gate.count, 1);

console.log('PASS  internal lane projection is read-only unified shape');
