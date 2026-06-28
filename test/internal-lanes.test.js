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

const graph = {
  tasks: [
    { id: 'task/ready', label: 'Ready task', status: 'ready', deps: [] },
    { id: 'task/run', label: 'Running task', status: 'in_progress', deps: [], agent_id: 'worker-a' },
    { id: 'task/review', label: 'Review task', status: 'tested', deps: [] },
  ],
};

const projection = buildInternalLaneProjection({ workspace: ws, graph, overlay: ov });

assert.equal(projection.version, 1);
assert.equal(projection.workspace, ws);
assert.ok(projection.generated_at);
assert.ok(Array.isArray(projection.items));

assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'judge_queue' && item.count >= 2));
assert.ok(projection.items.some((item) => item.lane === 'decision' && item.kind === 'review' && item.key === 'task/review' && item.merge_state === 'review_pending'));
assert.ok(projection.items.some((item) => item.lane === 'work' && item.kind === 'task' && item.key === 'task/ready'));
assert.ok(projection.items.some((item) => item.lane === 'work' && item.key === 'task/run' && item.agent_id === 'worker-a'));
assert.ok(projection.items.some((item) => item.lane === 'user_gate' && item.kind === 'guidance' && item.severity === 'blocking'));
assert.ok(!projection.items.some((item) => item.lane === 'user_gate' && item.action_kind === 'dup-cluster'));
assert.equal(projection.summary.total, projection.items.length);
assert.ok(projection.summary.lanes.decision.count >= 2);
assert.ok(projection.summary.lanes.work.count >= 2);
assert.equal(projection.summary.lanes.user_gate.count, 1);

console.log('PASS  internal lane projection is read-only unified shape');
