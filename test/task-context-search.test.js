#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildTaskContextPack, DEFAULT_CONTEXT_WEIGHT } = require('../lib/search/task-context');

let pass = 0;
let fail = 0;
const ok = (label, fn) => {
  try {
    fn();
    console.log(`PASS  ${label}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${label}`);
    console.error(err && err.stack ? err.stack : err);
    fail++;
  }
};

const node = (id, label, extra = {}) => ({
  id,
  label,
  status: extra.status || 'done',
  deps: extra.deps || [],
  context_deps: extra.context_deps || [],
  context_weights: extra.context_weights || {},
  summary: extra.summary || `${label} summary`,
  kind: extra.kind,
});

const graph = {
  tasks: [
    node('task/target', 'Target task', {
      status: 'ready',
      deps: ['task/blocking', 'ghost:/remote/ws|task/remote'],
      context_deps: ['note:low', 'task/context-high', 'note:high', 'note:zero'],
      context_weights: {
        'note:low': 0.2,
        'task/context-high': 0.8,
        'note:high': 0.9,
        'note:zero': 0,
      },
    }),
    node('task/blocking', 'Blocking dep', {
      context_deps: ['note:blocking-support'],
      context_weights: { 'note:blocking-support': 0.7 },
    }),
    node('task/context-high', 'High context task', {
      context_deps: ['task/context-neighbor'],
      context_weights: { 'task/context-neighbor': 0.4 },
    }),
    node('note:high', 'High context note', {
      kind: 'note',
      context_deps: ['note:support', 'task/context-high'],
      context_weights: { 'note:support': 0.6, 'task/context-high': 0.5 },
    }),
    node('note:low', 'Low context note', {
      kind: 'note',
      context_deps: ['note:support', 'note:low-support'],
      context_weights: { 'note:support': 0.4, 'note:low-support': 0.3 },
    }),
    node('note:zero', 'Zero weight note', { kind: 'note' }),
    node('note:support', 'Shared support note', { kind: 'note' }),
    node('note:low-support', 'Low support note', { kind: 'note' }),
    node('note:blocking-support', 'Blocking support note', { kind: 'note' }),
    node('task/context-neighbor', 'Context neighbor task'),
    node('task/dependent', 'Dependent task', { deps: ['task/target'] }),
    node('task/sibling', 'Sibling task', {
      context_deps: ['note:high'],
      context_weights: { 'note:high': 0.95 },
    }),
  ],
  ghosts: [
    { workspace: '/remote/ws', key: 'task/remote', label: 'Remote dep', status: 'done' },
  ],
};

const pack = buildTaskContextPack(graph, 'task/target');
const keys = (items) => items.map((item) => item.key);

ok('builds a task-context pack', () => {
  assert.equal(pack.ok, true);
  assert.equal(pack.mode, 'task-context');
  assert.equal(pack.task.key, 'task/target');
});

ok('pins blocking deps before weighted context deps', () => {
  assert.deepEqual(keys(pack.results.slice(0, 4)), [
    'task/blocking',
    'note:high',
    'task/context-high',
    'note:low',
  ]);
  assert.deepEqual(keys(pack.pinned.context), ['note:high', 'task/context-high', 'note:low']);
  assert.deepEqual(pack.pinned.context.map((entry) => entry.weight), [0.9, 0.8, 0.2]);
});

ok('excludes zero-weight context deps from the pinned pack', () => {
  assert.equal(pack.results.some((entry) => entry.key === 'note:zero'), false);
  assert.equal(pack.dependencySummaries.some((entry) => entry.key === 'note:zero'), false);
});

ok('adds note support deps after direct DAG entries and dedupes them', () => {
  assert.deepEqual(keys(pack.pinned.notes), ['note:support', 'note:low-support']);
  assert.equal(pack.results[4].key, 'note:support');
  assert.equal(pack.results[5].key, 'note:low-support');
  assert(pack.pinned.notes.every((entry) => entry.pinned === true));
  assert.equal(pack.results.filter((entry) => entry.key === 'note:support').length, 1);
});

ok('adds one-hop surrounding wired nodes after pinned DAG entries', () => {
  assert.deepEqual(keys(pack.pinned.surrounding), [
    'task/dependent',
    'note:blocking-support',
    'task/sibling',
    'task/context-neighbor',
  ]);
  assert(pack.pinned.surrounding.every((entry) => entry.tier === 'surrounding'));
  assert(pack.results.indexOf(pack.pinned.surrounding[0]) > pack.results.indexOf(pack.pinned.notes[1]));
});

ok('keeps /task/context-compatible direct dependency summaries', () => {
  assert.deepEqual(pack.dependencySummaries.map((entry) => entry.via), ['blocking', 'context', 'context', 'context']);
  assert(!('weight' in pack.dependencySummaries[0]));
  assert.equal(pack.dependencySummaries[1].weight, 0.9);
});

ok('returns ghost dependencies separately, not as result entries', () => {
  assert.deepEqual(pack.ghostDependencies, [
    { workspace: '/remote/ws', key: 'task/remote', label: 'Remote dep', status: 'done' },
  ]);
  assert.equal(pack.results.some((entry) => entry.key.startsWith('ghost:')), false);
});

ok('falls back to default context weight when projected weight is absent', () => {
  const missingWeight = buildTaskContextPack({
    tasks: [
      node('task/a', 'Task A', { context_deps: ['note:b'], context_weights: {} }),
      node('note:b', 'Note B', { kind: 'note' }),
    ],
  }, 'task/a');
  assert.equal(missingWeight.pinned.context[0].weight, DEFAULT_CONTEXT_WEIGHT);
});

ok('honors explicit zero limits', () => {
  const limited = buildTaskContextPack(graph, 'task/target', {
    directContextLimit: 0,
    noteDepLimit: 0,
    surroundingLimit: 0,
  });
  assert.deepEqual(keys(limited.results), ['task/blocking']);
});

ok('unknown task returns an empty failed pack instead of throwing', () => {
  const missing = buildTaskContextPack(graph, 'task/missing');
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.results, []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
