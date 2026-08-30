#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildArchitectureProjection } = require('../lib/architecture');
const overlay = require('../lib/overlay');
const frontier = require('../lib/frontier');

const codeNodes = {
  'code:src/api.js#load': { key: 'code:src/api.js#load', file: 'src/api.js', name: 'load', kind: 'function', start_line: 8, exported: true },
  'code:src/api.js#save': { key: 'code:src/api.js#save', file: 'src/api.js', name: 'save', kind: 'function', start_line: 20 },
  'code:lib/db.js#query': { key: 'code:lib/db.js#query', file: 'lib/db.js', name: 'query', kind: 'function', start_line: 3, summary: 'Runs a query' },
};
const codeEdges = [
  { from_file: 'src/api.js', to: 'code:lib/db.js#query', kind: 'calls' },
  { from_file: 'src/api.js', to: 'code:lib/db.js#query', kind: 'calls', ambiguous: true },
  { from_file: 'src/api.js', to_file: 'lib/db.js', kind: 'imports' },
  { from_file: 'src/api.js', to: 'code:src/api.js#save', kind: 'calls' },
  { from_file: 'src/api.js', to_file: 'vendor/pkg.js', kind: 'imports' },
];

const projection = buildArchitectureProjection({ codeNodes, codeEdges });
assert.equal(projection.version, 1);
assert.equal(projection.status, 'ready');
assert.deepEqual(projection.modules.map((module) => module.name), ['lib', 'src', 'vendor']);
assert.deepEqual(projection.files.map((file) => file.path), ['lib/db.js', 'src/api.js', 'vendor/pkg.js']);
assert.equal(projection.summary.indexed_symbols, 3);
assert.equal(projection.summary.indexed_relations, 5);
assert.equal(projection.relations.length, 3, 'cross-file relationships aggregate by kind and endpoints');
const calls = projection.relations.find((edge) => edge.kind === 'calls');
assert.equal(calls.count, 2);
assert.equal(calls.ambiguous_count, 1);
const api = projection.files.find((file) => file.path === 'src/api.js');
assert.equal(api.internal_count, 1, 'same-file calls stay inspectable without adding a self-loop');
assert.equal(api.exported_count, 1);

const bounded = buildArchitectureProjection({ codeNodes, codeEdges }, {
  maxFiles: 2,
  maxRelations: 1,
  maxSymbolsPerFile: 1,
});
assert.equal(bounded.files.length, 2);
assert.equal(bounded.relations.length, 1);
assert.ok(bounded.files.every((file) => file.symbols.length <= 1));
assert.equal(bounded.omitted.files, 1);
assert.ok(bounded.omitted.symbols >= 1);

assert.deepEqual(
  buildArchitectureProjection({ codeNodes, codeEdges }),
  buildArchitectureProjection({ codeNodes: { ...codeNodes }, codeEdges: [...codeEdges].reverse() }),
  'projection is deterministic across input edge order',
);

const empty = buildArchitectureProjection({});
assert.equal(empty.status, 'empty');
assert.equal(empty.files.length, 0);
assert.match(empty.message, /not indexed yet/i);

const route = require('../routes/state')({
  send(_res, status, body) { route.status = status; route.body = body; },
  buildGraph() { return { tasks: [], ghosts: [], summary: { tasks_total: 0 } }; },
  state: { routes: [] },
  overlayStore: overlay,
  targetOverlay() {
    return { graph_repo: '/workspace', ws: '/workspace', workspace_id: null, ov: { ...overlay.EMPTY(), code_nodes: codeNodes, code_edges: codeEdges } };
  },
  respCacheGet() { return undefined; },
  respCachePut(_ws, _key, body) { return body; },
  isTruthy(value) { return value === '1' || value === 'true'; },
  frontier,
  agentsArr() { return []; },
});

(async () => {
  const handled = await route('/state', 'GET', {}, {}, new URL('http://localhost/state'));
  assert.equal(handled, true);
  assert.equal(route.status, 200);
  assert.equal(route.body.architecture.version, 1);
  assert.equal(route.body.architecture.summary.indexed_symbols, 3);
  console.log('PASS  architecture projection contract');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
