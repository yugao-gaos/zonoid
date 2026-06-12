#!/usr/bin/env node
// Tests the isolated snapshot-daemon helper (scripts/bench-snapshot-daemon.js):
//   - module surface (ensureRunning/teardown fns, SNAPSHOT_WS/SNAPSHOT_GRAPH paths)
//   - teardown() is safe when nothing is running
//   - (live, skippable) ensureRunning boots a private daemon over a FROZEN .graph snapshot,
//     /ping works, the daemon's workspace is the snapshot, a second call is idempotent, and
//     teardown() actually kills it.
//
// The live boot copies the real .graph into bench/snapshot/ and spawns a real daemon on a private
// port (8810-8899, never the live :8787). Skipped under ZONOID_SKIP_LIVE=1.
//
// Run: node test/bench-snapshot-daemon.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const snap = require('../scripts/bench-snapshot-daemon');
const REPO = path.resolve(__dirname, '..');

let pass = 0, fail = 0, skip = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const skipped = (label, why) => { console.log(`SKIP  ${label} (${why})`); skip++; };

function ping(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ping', method: 'GET', timeout: 800 },
      (res) => { let s = ''; res.setEncoding('utf8'); res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, body: s })); });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── module surface ──────────────────────────────────────────────────────────
  ok('export ensureRunning is a function', typeof snap.ensureRunning === 'function');
  ok('export teardown is a function', typeof snap.teardown === 'function');
  ok('export SNAPSHOT_WS is a string', typeof snap.SNAPSHOT_WS === 'string');
  ok('export SNAPSHOT_GRAPH is a string', typeof snap.SNAPSHOT_GRAPH === 'string');
  ok('SNAPSHOT_WS under repo/bench', snap.SNAPSHOT_WS.startsWith(path.join(REPO, 'bench')));

  // ── teardown is safe when idle ───────────────────────────────────────────────
  let threw = false;
  try { snap.teardown(); } catch { threw = true; }
  ok('teardown() does not throw when nothing is running', !threw);

  // ── live boot smoke (skippable) ──────────────────────────────────────────────
  if (process.env.ZONOID_SKIP_LIVE === '1') {
    skipped('live boot: ensureRunning boots + pings + workspace + idempotent + teardown', 'ZONOID_SKIP_LIVE=1');
  } else if (!fs.existsSync(path.join(REPO, '.graph'))) {
    skipped('live boot', 'no live .graph to snapshot');
  } else {
    const createdSnapshot = !fs.existsSync(snap.SNAPSHOT_WS);
    let port = null;
    try {
      port = await snap.ensureRunning();
      ok('booted: port in private range 8810-8899', typeof port === 'number' && port >= 8810 && port < 8900);
      ok('booted: port is NOT the live daemon 8787', port !== 8787);

      const pong = await ping(port);
      ok('booted: /ping returns 200', pong && pong.status === 200);

      let ws = null;
      try { ws = JSON.parse(pong.body).workspace; } catch { /* ignore */ }
      ok('booted: daemon workspace is the frozen snapshot', ws === snap.SNAPSHOT_WS);
      ok('booted: frozen .graph snapshot exists on disk', fs.existsSync(snap.SNAPSHOT_GRAPH));

      const port2 = await snap.ensureRunning();
      ok('idempotent: second ensureRunning returns the same port', port2 === port);

      snap.teardown();
      await sleep(600);
      const after = await ping(port);
      ok('teardown: daemon is down afterward (ping fails)', after === null);
    } finally {
      snap.teardown();
      // Don't leave a large frozen snapshot behind if WE created it (real bench runs recreate it).
      if (createdSnapshot) { try { fs.rmSync(snap.SNAPSHOT_WS, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail === 0 ? 0 : 1);
})();
