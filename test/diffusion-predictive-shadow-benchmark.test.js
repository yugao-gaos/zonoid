#!/usr/bin/env node
'use strict';

const assert = require('assert');
const retrievalWeights = require('../lib/search/retrieval-weights');
const benchmark = require('../lib/search/diffusion-shadow-benchmark');

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

function row(overrides = {}) {
  return {
    _key: 'row-1',
    task_key: 'task/a',
    decision: 'inject',
    topKey: 'note:a',
    quadrant: 'TP',
    label: 1,
    recalled_context_edges: [edge('task/a', 'note:a')],
    ...overrides,
  };
}

function edge(from, to, extra = {}) {
  return {
    from,
    to,
    relation: 'context',
    result_key: to,
    result_kind: to.startsWith('note:') ? 'note' : 'task',
    direct: true,
    ...extra,
  };
}

function node(id, extra = {}) {
  return {
    id,
    label: id,
    status: 'done',
    deps: [],
    context_deps: [],
    context_weights: {},
    ...extra,
  };
}

function weight(result, from, to) {
  const canonical = retrievalWeights.canonicalEdge(from, to, 'context');
  return retrievalWeights.weightFromMap(result.weightMap, canonical.from, canonical.to, canonical.relation);
}

function approx(actual, expected, epsilon = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} !== ${expected}`);
}

ok('direct baseline updates only the matched direct edge', () => {
  const direct = benchmark.applyDirectBaseline([
    row({
      recalled_context_edges: [
        edge('task/a', 'note:a'),
        edge('task/a', 'note:other', { result_key: 'note:other' }),
      ],
    }),
  ]);

  assert.equal(direct.metrics.updatedEdgeCount, 1);
  approx(weight(direct, 'task/a', 'note:a'), 1.1);
  approx(weight(direct, 'task/a', 'note:other'), 1);
  assert.equal(direct.updates[0].source, 'direct');
});

ok('diffusion updates nearby eligible context edges with decay', () => {
  const graph = {
    tasks: [
      node('task/a', { context_deps: ['note:a'], context_weights: { 'note:a': 1 } }),
      node('note:a', { kind: 'note', context_deps: ['note:b'], context_weights: { 'note:b': 0.8 } }),
      node('note:b', { kind: 'note', context_deps: ['note:c'], context_weights: { 'note:c': 0.5 } }),
      node('note:c', { kind: 'note' }),
      node('note:far', { kind: 'note' }),
    ],
  };

  const diffused = benchmark.applyDiffusedStrategy([row()], graph, {
    diffusionScale: 0.5,
    decay: 0.5,
    maxDepth: 2,
  });

  approx(weight(diffused, 'task/a', 'note:a'), 1.1);
  approx(weight(diffused, 'note:a', 'note:b'), 1.04);
  approx(weight(diffused, 'note:b', 'note:c'), 1.0125);
  approx(weight(diffused, 'note:c', 'note:far'), 1);
  assert.equal(diffused.metrics.updatedEdgeCount, 3);
  assert.equal(diffused.rowResults[0].diffusedEdgeCount, 2);
});

ok('TN is a no-op for direct and diffused strategies', () => {
  const rows = [row({
    decision: 'abstain',
    topKey: null,
    quadrant: 'TN',
    label: 0,
  })];
  const graph = {
    tasks: [
      node('task/a', { context_deps: ['note:a'], context_weights: { 'note:a': 1 } }),
      node('note:a', { kind: 'note', context_deps: ['note:b'], context_weights: { 'note:b': 1 } }),
      node('note:b', { kind: 'note' }),
    ],
  };

  const direct = benchmark.applyDirectBaseline(rows);
  const diffused = benchmark.applyDiffusedStrategy(rows, graph);

  assert.equal(direct.metrics.updatedEdgeCount, 0);
  assert.equal(diffused.metrics.updatedEdgeCount, 0);
  assert.equal(direct.metrics.skippedReasons['tn-noop'], 1);
  assert.equal(diffused.metrics.skippedReasons['tn-noop'], 1);
});

ok('feedback updates are bounded', () => {
  const initial = new Map();
  const high = retrievalWeights.canonicalEdge('task/a', 'note:a', 'context');
  initial.set(high.key, { ...high, weight: 1.48 });

  const direct = benchmark.applyDirectBaseline([row()], { initialWeights: initial });
  approx(weight(direct, 'task/a', 'note:a'), retrievalWeights.MAX_RETRIEVAL_WEIGHT);

  const low = retrievalWeights.canonicalEdge('task/b', 'note:b', 'context');
  initial.set(low.key, { ...low, weight: 0.51 });
  const negative = benchmark.applyDirectBaseline([
    row({
      _key: 'row-2',
      task_key: 'task/b',
      topKey: 'note:b',
      quadrant: 'FP',
      label: 0,
      recalled_context_edges: [edge('task/b', 'note:b')],
    }),
  ], { initialWeights: initial });
  approx(weight(negative, 'task/b', 'note:b'), retrievalWeights.MIN_RETRIEVAL_WEIGHT);
});

ok('diffusion does not mutate structural graph edge weights', () => {
  const graph = {
    tasks: [
      node('task/a', { context_deps: ['note:a'], context_weights: { 'note:a': 1 } }),
      node('note:a', { kind: 'note', context_deps: ['note:b'], context_weights: { 'note:b': 0.8 } }),
      node('note:b', { kind: 'note' }),
    ],
  };
  const before = JSON.parse(JSON.stringify(graph));

  benchmark.applyDiffusedStrategy([row()], graph, {
    diffusionScale: 0.5,
    decay: 0.5,
    maxDepth: 2,
  });

  assert.deepStrictEqual(graph, before);
  assert.equal(graph.tasks[1].context_weights['note:b'], 0.8);
});

ok('checkpoint graph state normalizes context edges into task adjacency', () => {
  const graph = benchmark.normalizeGraphState({
    nodes: {
      'task/a': { id: 'task/a', label: 'Task A' },
      'note:a': { id: 'note:a', label: 'Note A', kind: 'note' },
    },
    edges: [
      { from: 'note:a', to: 'task/a', kind: 'context', weight: 0.9 },
    ],
  });

  const task = graph.tasks.find((item) => item.id === 'task/a');
  assert.ok(task);
  assert.deepStrictEqual(task.context_deps, ['note:a']);
  assert.equal(task.context_weights['note:a'], 0.9);
});

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
