#!/usr/bin/env node
// Tests the embed-warmup gate in scripts/retrieval-bench.js (warmupGate).
//
// THE BUG IT GUARDS: the held-out bench used to fire its first queries before the MiniLM sidecar
// (lib/embed.js) had warmed in the daemon process, so /search silently fell back to LEXICAL-only
// ranking (qvec===null in compiler-backed memory search) and the whole recall ladder was measured
// against an under-scored cold baseline. warmupGate() now blocks until /search returns SEMANTIC
// results (detected via the per-result `via` field) and HARD-FAILS if the embedder never warms.
//
//   - module surface: warmupGate is exported and is a function; WARMUP_PROBE is a non-empty string.
//   - local: warmupGate uses the same workspace-aware search helper path the benchmark uses.
//   - (live, skippable) boots the isolated snapshot daemon, runs warmupGate against it, and asserts
//     it returns { warm:true } with all probe hits via='semantic' (NOT lexical fallback).
//
// Skipped under ZONOID_SKIP_LIVE=1 (the live arm boots a real daemon on a private port).
//
// Run: node test/retrieval-warmup-gate.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const rb = require('../scripts/retrieval-bench');
const snap = require('../scripts/bench-snapshot-daemon');
const REPO = path.resolve(__dirname, '..');

let pass = 0, fail = 0, skip = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const skipped = (label, why) => { console.log(`SKIP  ${label} (${why})`); skip++; };

function getJSON(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

(async () => {
  // -- module surface ---------------------------------------------------------
  ok('export warmupGate is a function', typeof rb.warmupGate === 'function');
  ok('export WARMUP_PROBE is a non-empty string', typeof rb.WARMUP_PROBE === 'string' && rb.WARMUP_PROBE.length > 0);
  ok('export buildSearchPath is a function', typeof rb.buildSearchPath === 'function');

  {
    const p = rb.buildSearchPath('query with spaces', 7, '/tmp/work space');
    const u = new URL(`http://127.0.0.1${p}`);
    ok('buildSearchPath includes workspace', u.searchParams.get('workspace') === '/tmp/work space');
    ok('buildSearchPath includes query and k', u.searchParams.get('q') === 'query with spaces' && u.searchParams.get('k') === '7');
  }

  {
    let calls = 0;
    const r = await rb.warmupGate({
      probe: 'local warmup probe',
      timeoutMs: 1000,
      pollMs: 1,
      searchFn: async () => {
        calls++;
        return { results: [{ via: calls === 1 ? 'lexical' : 'semantic' }] };
      },
    });
    ok('warmupGate polls until semantic via', r.warm === true && r.attempts === 2 && calls === 2);
  }

  // -- live: warmupGate reaches a warm SEMANTIC state (skippable) --------------
  if (process.env.ZONOID_SKIP_LIVE === '1') {
    skipped('live: warmupGate blocks until /search serves semantic', 'ZONOID_SKIP_LIVE=1');
  } else if (!fs.existsSync(path.join(REPO, '.graph'))) {
    skipped('live: warmupGate', 'no live .graph to snapshot');
  } else {
    const createdSnapshot = !fs.existsSync(snap.SNAPSHOT_WS);
    try {
      snap.teardown();  // ensure a fresh daemon so warmup timing is predictable, not a stale reuse
      const port = await snap.ensureRunning();
      let sawLexical = false;
      const r = await rb.warmupGate({
        searchFn: async (q, k) => {
          const body = await getJSON(port, rb.buildSearchPath(q, k, snap.SNAPSHOT_WS));
          const vias = (body && body.results || []).map((x) => x.via).filter(Boolean);
          if (vias.includes('lexical')) sawLexical = true;
          return body;
        },
      });
      ok('live: warmupGate converges to all-semantic (embedder warm)', r && r.warm === true && r.vias.every((v) => v === 'semantic'));
      // Not strictly required (sidecar may already be warm from a prior run), but when observed it
      // confirms the gate is guarding a real cold->warm transition rather than a no-op.
      if (sawLexical) ok('live: observed cold lexical fallback before warming (gate is load-bearing)', true);
      else skipped('live: cold lexical fallback observation', 'sidecar already warm - transition not observable this run');
    } finally {
      snap.teardown();
      if (createdSnapshot) { try { fs.rmSync(snap.SNAPSHOT_WS, { recursive: true, force: true }); } catch { /* best effort */ } }
    }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail === 0 ? 0 : 1);
})();
