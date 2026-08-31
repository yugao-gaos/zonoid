'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codeNodeEmbedText } = require('../lib/node-tags');
const { symbolsToCodeNodes } = require('../lib/code-extract/ingest');
const { parseArgs, fullOnboard } = require('../scripts/onboard-code');
const { repairRepo } = require('../lib/code-extract/sync');

function ingestResult() {
  return {
    repo: '/repo', symbols: 2, created: 2, edges: 1, edges_added: 1,
    batches: 1, stats: { symbols: 2 },
  };
}

test('manual full onboarding remains rich unless --thin is explicit', async () => {
  assert.equal(parseArgs([]).thin, false);
  assert.equal(parseArgs(['--thin']).thin, true);
  assert.equal(parseArgs(['--repair']).repair, true);
  assert.equal(parseArgs(['--repair-batch', '7']).repairBatchSize, '7');

  let ingestOptions;
  await fullOnboard({
    repoAbs: '/repo', workspace: '/workspace', daemon: 'http://daemon', async: true,
  }, {
    ingestRepo: async (_repo, opts) => { ingestOptions = opts; return ingestResult(); },
    headCommit: () => null,
  });
  assert.equal(ingestOptions.enrichBody, true);
});

test('thin full onboarding preserves symbol/edge counts and the watermark', async () => {
  let ingestOptions;
  let watermark;
  const result = await fullOnboard({
    repoAbs: '/repo', workspace: '/workspace', daemon: 'http://daemon', async: true,
    thin: true, expectedHead: 'abc123',
  }, {
    ingestRepo: async (_repo, opts) => { ingestOptions = opts; return ingestResult(); },
    headCommit: () => 'abc123',
    httpDaemonClient: () => ({
      setLastIndexedCommit: async (value) => { watermark = value; },
    }),
  });

  assert.equal(ingestOptions.enrichBody, false);
  assert.deepEqual({
    symbols: result.symbols, created: result.created,
    edges: result.edges, edges_added: result.edges_added,
  }, { symbols: 2, created: 2, edges: 1, edges_added: 1 });
  assert.equal(result.watermark_recorded, true);
  assert.deepEqual(watermark, { key: '/repo', commit: 'abc123', workspace: '/workspace' });
});

test('thin nodes still embed name, signature, and file', () => {
  const [node] = symbolsToCodeNodes([{
    name: 'loadGraph', kind: 'function', file: 'lib/graph.js',
    signature: 'loadGraph(workspace)', start_line: 1, end_line: 3, exported: true,
  }]);

  assert.equal('summary' in node, false);
  assert.equal(codeNodeEmbedText(node), 'loadGraph — loadGraph(workspace) in lib/graph.js');
});

test('repairRepo rewrites only files whose canonical code edges diverge from persisted overlay state', async () => {
  const extracted = {
    repo: '/repo',
    symbols: [
      { name: 'foo', kind: 'function', file: 'src/a.js', exported: true },
      { name: 'caller', kind: 'function', file: 'src/b.js', exported: true },
      { name: 'legacy', kind: 'function', file: 'src/c.js', exported: true },
    ],
    edges: [
      { from: 'src/b.js', caller: 'caller', to: 'foo', kind: 'calls' },
      { from: 'src/c.js', caller: 'legacy', to: 'foo', kind: 'calls' },
    ],
  };
  const calls = [];
  let watermark;

  const result = await repairRepo({
    repo: '/repo',
    workspace: '/workspace',
    daemon: 'http://daemon',
    expectedHead: 'HEAD123',
  }, {
    git: async (_repo, args) => {
      if (args[0] === 'rev-parse') return 'HEAD123';
      return '';
    },
    extractRepo: async () => extracted,
    loadOverlay: () => ({
      code_edges: [
        // b.js is missing entirely -> repair should rewrite it.
        { from_file: 'src/c.js', from: 'code:src/c.js#legacy', to: 'code:src/a.js#bar', kind: 'calls' },
        // d.js is stale-only -> repair should clear it.
        { from_file: 'src/d.js', from: 'code:src/d.js#old', to: 'code:src/a.js#foo', kind: 'calls' },
      ],
    }),
    daemon: {
      replaceEdges: async ({ file, edges, workspace, deferPublish }) => {
        calls.push({ file, edges, workspace, deferPublish });
        return { created: edges.length };
      },
      setLastIndexedCommit: async (value) => { watermark = value; },
    },
  });

  assert.equal(result.mode, 'repair');
  assert.equal(result.compared_files, 3);
  assert.deepEqual(result.missing_files, ['src/b.js']);
  assert.deepEqual(result.mismatched_files, ['src/c.js', 'src/d.js']);
  assert.deepEqual(calls.map((c) => c.file), ['src/c.js', 'src/d.js', 'src/b.js']);
  assert.ok(calls.every((c) => c.deferPublish === true));
  assert.deepEqual(calls.find((c) => c.file === 'src/b.js').edges, [
    {
      from_file: 'src/b.js',
      from: 'code:src/b.js#caller',
      to: 'code:src/a.js#foo',
      kind: 'calls',
      name: 'foo',
    },
  ]);
  assert.deepEqual(calls.find((c) => c.file === 'src/c.js').edges, [
    {
      from_file: 'src/c.js',
      from: 'code:src/c.js#legacy',
      to: 'code:src/a.js#foo',
      kind: 'calls',
      name: 'foo',
    },
  ]);
  assert.deepEqual(calls.find((c) => c.file === 'src/d.js').edges, []);
  assert.equal(result.files_replaced, 3);
  assert.equal(result.edges_replaced, 2);
  assert.equal(result.watermark_recorded, true);
  assert.deepEqual(watermark, { key: '/repo', commit: 'HEAD123', workspace: '/workspace' });
});
