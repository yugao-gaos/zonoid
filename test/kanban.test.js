#!/usr/bin/env node
'use strict';

const assert = require('assert');
const frontier = require('../lib/frontier');
const overlay = require('../lib/overlay');
const { HARNESS_JUDGE_DRAIN_KEY } = require('../lib/harness-task');
const { COLUMNS, buildKanbanProjection, laneForTask } = require('../lib/kanban');

const task = (id, status, extra = {}) => ({ id, label: id, status, deps: [], context_deps: [], ...extra });

assert.deepEqual(COLUMNS.map((column) => column.label), ['Queue', 'Ready', 'WIP', 'Review', 'Done']);
assert.equal(laneForTask(task('queue', 'not_ready')), 'queue');
assert.equal(laneForTask(task('retry', 'failed')), 'queue');
assert.equal(laneForTask(task('ready', 'ready')), 'ready');
assert.equal(laneForTask(task('wip', 'in_progress')), 'wip');
assert.equal(laneForTask(task('review', 'tested')), 'review');
assert.equal(laneForTask(task('done', 'done')), 'done');
assert.equal(laneForTask(task('canceled', 'canceled')), 'done');
assert.equal(laneForTask(task('landed', 'tested', { merge_state: 'merged' })), 'done');

const tasks = [
  task('queue', 'not_ready'),
  task('ready', 'ready'),
  task('wip', 'in_progress'),
  task('review', 'tested', { review_state: 'pending', merge_state: 'review_pending' }),
  task('merge', 'tested', { review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending' }),
  task('done', 'done'),
  task('pinned-done', 'done'),
  task('gated-done', 'done'),
  task('kickback', 'failed', { review_state: 'rejected', review_verdict: 'KICK_BACK', merge_state: 'blocked' }),
  task(HARNESS_JUDGE_DRAIN_KEY, 'ready'),
  task('legacy-judge', 'ready', { label: 'Judge: implementation' }),
  { id: 'note:context', label: 'Context', status: 'note', kind: 'note', deps: [], context_deps: [] },
];
const frontierIds = new Set(['queue', 'ready', 'wip', 'review', 'merge', 'done', 'kickback', HARNESS_JUDGE_DRAIN_KEY, 'legacy-judge', 'note:context']);
const guidance = [
  { id: 'g-user', question: 'Proceed?', severity: 'blocking', resolved: false, origin_task: 'gated-done' },
  { id: 'g-user-2', question: 'Proceed another way?', severity: 'review', resolved: false, action: { kind: 'follow-up', task_key: 'gated-done' } },
  { id: 'g-internal', question: 'Deduplicate?', severity: 'review', resolved: false, action: { kind: 'dup-cluster', keys: ['note:a', 'note:b'], task_key: 'done' } },
  { id: 'g-resolved', question: 'Old gate', severity: 'blocking', resolved: true, origin_task: 'pinned-done' },
];

const projection = buildKanbanProjection({
  tasks,
  frontierTaskIds: frontierIds,
  pinnedTaskIds: ['pinned-done', HARNESS_JUDGE_DRAIN_KEY, 'note:context'],
  guidance,
});
const byKey = Object.fromEntries(projection.cards.map((card) => [card.task_key, card]));

assert.equal(projection.version, 1);
assert.equal(projection.summary.total, projection.cards.length);
assert.deepEqual(projection.summary.lanes, { queue: 2, ready: 1, wip: 1, review: 2, done: 3 });
assert.deepEqual(projection.columns.find((column) => column.id === 'review').task_keys, ['review', 'merge']);
assert.equal(byKey['pinned-done'].frontier, false);
assert.equal(byKey['pinned-done'].pinned, true);
assert.equal(byKey['gated-done'].pinned, true);
assert.deepEqual(byKey['gated-done'].cues.user_gate, { state: 'blocked', count: 2 });
assert.equal(byKey.review.cues.review, 'pending');
assert.equal(byKey.merge.cues.review, 'approved');
assert.equal(byKey.merge.cues.merge, 'pending');
assert.equal(byKey.kickback.cues.review, 'kick_back');
assert.ok(!byKey[HARNESS_JUDGE_DRAIN_KEY]);
assert.ok(!byKey['legacy-judge']);
assert.ok(!byKey['note:context']);

const derived = buildKanbanProjection({
  tasks: [task('seed', 'ready', { deps: ['dep'] }), task('dep', 'done'), task('outside', 'done')],
});
assert.deepEqual(derived.cards.map((card) => card.task_key), ['seed', 'dep']);
assert.ok(frontier.frontierKeep([task('seed', 'ready', { deps: ['dep'] }), task('dep', 'done')]).has('dep'));

const route = require('../routes/state')({
  send(_res, status, body) { route.status = status; route.body = body; },
  buildGraph() { return { tasks: [task('seed', 'ready'), task('pin-me', 'done')], ghosts: [], summary: { tasks_total: 2 } }; },
  state: { routes: {} },
  overlayStore: overlay,
  targetOverlay() { return { graph_repo: '/workspace', ws: '/workspace', workspace_id: null, ov: overlay.EMPTY() }; },
  respCacheGet() { return undefined; },
  respCachePut(_ws, _key, body) { return body; },
  isTruthy(value) { return value === '1' || value === 'true'; },
  frontier,
  agentsArr() { return []; },
});

(async () => {
  const handled = await route('/state', 'GET', {}, {}, new URL('http://localhost/state?kanban_pin=pin-me'));
  assert.equal(handled, true);
  assert.equal(route.status, 200);
  assert.equal(route.body.kanban.version, 1);
  assert.ok(route.body.kanban.cards.some((card) => card.task_key === 'pin-me' && card.pinned));
  console.log('PASS  Kanban operational projection contract');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
