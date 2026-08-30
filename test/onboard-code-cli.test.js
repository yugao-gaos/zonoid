'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codeNodeEmbedText } = require('../lib/node-tags');
const { symbolsToCodeNodes } = require('../lib/code-extract/ingest');
const { parseArgs, fullOnboard } = require('../scripts/onboard-code');

function ingestResult() {
  return {
    repo: '/repo', symbols: 2, created: 2, edges: 1, edges_added: 1,
    batches: 1, stats: { symbols: 2 },
  };
}

test('manual full onboarding remains rich unless --thin is explicit', async () => {
  assert.equal(parseArgs([]).thin, false);
  assert.equal(parseArgs(['--thin']).thin, true);

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
