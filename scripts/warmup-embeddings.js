#!/usr/bin/env node
'use strict';

const http = require('http');

const PORT = process.env.ORCH_PORT || 8787;
const MAX_WAIT_MS = 120000;
const RETRY_INTERVAL_MS = 3000;

function ping() {
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: 'localhost', port: PORT, path: '/search?q=warmup&k=1', method: 'GET' },
      (res) => {
        res.resume();
        resolve(res.statusCode < 500);
      }
    );
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function main() {
  console.log(`warmup-embeddings: waiting for daemon at localhost:${PORT}...`);
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    const ok = await ping();
    if (ok) {
      console.log(`warmup-embeddings: ready (${Date.now() - start}ms)`);
      process.exit(0);
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, RETRY_INTERVAL_MS));
  }
  console.error('\nwarmup-embeddings: timed out waiting for daemon');
  process.exit(1);
}

main();
