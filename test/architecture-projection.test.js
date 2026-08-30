#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { buildArchitectureProjection, classifyFileNoise } = require('../lib/architecture');
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
assert.equal(projection.module_relations.length, 2, 'clean cross-module relationships aggregate separately for the overview');
const calls = projection.relations.find((edge) => edge.kind === 'calls');
assert.equal(calls.count, 2);
assert.equal(calls.ambiguous_count, 1);
const moduleCalls = projection.module_relations.find((edge) => edge.kind === 'calls');
assert.deepEqual(moduleCalls, {
  id: 'module-relation:src:calls:lib',
  from: 'module:src',
  to: 'module:lib',
  kind: 'calls',
  count: 2,
  ambiguous_count: 1,
});
const api = projection.files.find((file) => file.path === 'src/api.js');
assert.equal(api.internal_count, 1, 'same-file calls stay inspectable without adding a self-loop');
assert.equal(api.exported_count, 1);
assert.equal(api.noise, null);
assert.equal(api.is_noisy, false);
const vendorFile = projection.files.find((file) => file.path === 'vendor/pkg.js');
assert.equal(vendorFile.noise, 'generated');
assert.equal(vendorFile.is_noisy, true);
assert.deepEqual(projection.modules.find((module) => module.name === 'src'), {
  id: 'module:src',
  name: 'src',
  file_ids: ['file:src/api.js'],
  file_count: 1,
  default_file_count: 1,
  hidden_file_count: 0,
  symbol_count: 2,
  incoming_count: 0,
  outgoing_count: 3,
});
assert.equal(projection.modules.find((module) => module.name === 'vendor').default_file_count, 0);
assert.equal(projection.modules.find((module) => module.name === 'vendor').hidden_file_count, 1);

assert.deepEqual([
  'src/server.js',
  'tests/server.test.js',
  'bench/throughput.js',
  'src/fixtures/sample.js',
  'archive/v1/server.js',
  'dist/server.generated.js',
  '.worktrees/attempt/server.js',
].map(classifyFileNoise), [null, 'test', 'bench', 'fixture', 'archive', 'generated', 'worktree']);

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

const boundedModules = buildArchitectureProjection({ codeNodes, codeEdges }, {
  maxFiles: 1,
  maxModuleRelations: 1,
});
assert.deepEqual(boundedModules.modules.map((module) => module.name), ['lib', 'src', 'vendor'],
  'module aggregates cover the full index even when file detail is bounded');
assert.equal(boundedModules.module_relations.length, 1);
assert.equal(boundedModules.omitted.module_relations, 1);

const noiseProjection = buildArchitectureProjection({ codeNodes: {
  'code:tests/api.test.js#testLoad': { file: 'tests/api.test.js', name: 'testLoad' },
  'code:bench/load.js#run': { file: 'bench/load.js', name: 'run' },
  'code:src/fixtures/api.js#fake': { file: 'src/fixtures/api.js', name: 'fake' },
  'code:archive/api.js#old': { file: 'archive/api.js', name: 'old' },
  'code:dist/api.generated.js#load': { file: 'dist/api.generated.js', name: 'load' },
  'code:.worktrees/try/api.js#load': { file: '.worktrees/try/api.js', name: 'load' },
} });
assert.deepEqual(noiseProjection.files.map((file) => [file.path, file.noise]), [
  ['.worktrees/try/api.js', 'worktree'],
  ['archive/api.js', 'archive'],
  ['bench/load.js', 'bench'],
  ['dist/api.generated.js', 'generated'],
  ['src/fixtures/api.js', 'fixture'],
  ['tests/api.test.js', 'test'],
]);
assert.equal(noiseProjection.files.length, 6, 'noise classification preserves searchable file detail');
assert.ok(noiseProjection.modules.every((module) => module.default_file_count === 0));

assert.deepEqual(
  buildArchitectureProjection({ codeNodes, codeEdges }),
  buildArchitectureProjection({
    codeNodes: Object.fromEntries(Object.entries(codeNodes).reverse()),
    codeEdges: [...codeEdges].reverse(),
  }),
  'projection is deterministic across input edge order',
);

const empty = buildArchitectureProjection({});
assert.equal(empty.status, 'empty');
assert.equal(empty.files.length, 0);
assert.match(empty.message, /not indexed yet/i);

const indexing = buildArchitectureProjection({ codeIndexStatus: { state: 'running', attempts: 1 } });
assert.equal(indexing.status, 'indexing');
assert.match(indexing.message, /indexing source/i);
assert.equal(indexing.code_index.state, 'running');

const failed = buildArchitectureProjection({ codeIndexStatus: {
  state: 'failed', retryable: true, error: 'tree-sitter failed', retry_at: 123,
} });
assert.equal(failed.status, 'error');
assert.match(failed.message, /tree-sitter failed/);
assert.equal(failed.code_index.retryable, true);

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
