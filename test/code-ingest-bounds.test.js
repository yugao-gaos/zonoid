#!/usr/bin/env node
'use strict';

// Regression for full-index EPIPEs: a large resolved edge graph and symbol set must be split by
// serialized request bytes before postJSON reaches daemon.js' 1 MiB readBody limit.

const http = require('http');
const ingest = require('../lib/code-extract/ingest');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

(async () => {
  const savedToken = process.env.ORCH_TOKEN;
  process.env.ORCH_TOKEN = 'bounded-ingest-token';
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const data = Buffer.concat(chunks);
      const body = JSON.parse(data.toString('utf8'));
      requests.push({
        path: req.url,
        bytes: data.length,
        contentLength: Number(req.headers['content-length']),
        token: req.headers['x-orch-token'] || null,
        body,
      });
      const created = Array.isArray(body.nodes) ? body.nodes.length : body.edges.length;
      const response = Array.isArray(body.nodes)
        ? { ok: true, created }
        : { ok: true, created, edges_added: created };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const symbolCount = 1800;
    const edgeCount = 16000;
    const symbols = Array.from({ length: symbolCount }, (_, i) => ({
      name: `target_${i}`,
      kind: 'function',
      file: `lib/target_${i}.js`,
      start_line: 1,
      end_line: 2,
      signature: `target_${i}(${`argument_${i}_`.repeat(55)})`,
      exported: true,
    }));
    const edges = Array.from({ length: edgeCount }, (_, i) => ({
      from: `lib/callsite_${i}.js`,
      to: `target_${i % symbolCount}`,
      kind: 'calls',
    }));
    const rawBytes = Buffer.byteLength(JSON.stringify({ nodes: symbols, edges, workspace: '/large/workspace' }));
    ok('synthetic unbatched graph exceeds daemon 1 MiB cap', rawBytes > 1024 * 1024);

    const result = await ingest.ingestExtracted({
      repo: '/synthetic/repo',
      symbols,
      edges,
      stats: { symbols: symbolCount, edges: edgeCount },
    }, {
      daemonUrl: `http://127.0.0.1:${server.address().port}`,
      workspace: '/large/workspace',
      enrichBody: false,
      // Make item-count caps irrelevant: this regression must exercise the byte cap.
      batchSize: symbolCount + 1,
      edgeBatchSize: edgeCount + 1,
    });

    const nodeRequests = requests.filter((r) => r.path === '/overlay/code-nodes/bulk');
    const edgeRequests = requests.filter((r) => r.path === '/overlay/code-edges/bulk');
    ok('byte cap split symbols across requests', nodeRequests.length > 1);
    ok('byte cap split edges across requests', edgeRequests.length > 1);
    ok('every emitted request stays below daemon 1 MiB cap', requests.every((r) => r.bytes < 1024 * 1024));
    ok('every emitted request stays within ingest safety cap', requests.every((r) => r.bytes <= ingest.DEFAULT_MAX_REQUEST_BYTES));
    ok('Content-Length matches serialized UTF-8 bytes', requests.every((r) => r.contentLength === r.bytes));
    ok('auth token is present on every full-ingest request', requests.every((r) => r.token === 'bounded-ingest-token'));
    ok('all symbols were sent and counted', result.symbols === symbolCount && result.created === symbolCount
      && nodeRequests.reduce((n, r) => n + r.body.nodes.length, 0) === symbolCount);
    ok('all resolved edges were sent and counted', result.edges === edgeCount && result.edges_added === edgeCount
      && edgeRequests.reduce((n, r) => n + r.body.edges.length, 0) === edgeCount);
    ok('result reports symbol and edge batch counts', result.batches === nodeRequests.length && result.edge_batches === edgeRequests.length);

    let oversizedRejected = false;
    try {
      ingest.boundedPayloads([{ value: 'x'.repeat(200) }], { field: 'nodes', maxBytes: 100 });
    } catch (err) {
      oversizedRejected = /exceeds/.test(String(err && err.message));
    }
    ok('a single oversized item is rejected before emission', oversizedRejected);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (savedToken === undefined) delete process.env.ORCH_TOKEN;
    else process.env.ORCH_TOKEN = savedToken;
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
