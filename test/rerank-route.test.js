#!/usr/bin/env node
// Test for the CROSS-ENCODER rerank stage in GET /search (routes/graph.js), behind ORCH_RERANK.
// Mirrors test/dag-only-claim-context.test.js: spawns the real daemon on a private port with a
// sandboxed CLAUDE_PLUGIN_DATA, seeds LEXICAL-only notes (no vectors ⇒ never needs MiniLM), and
// hits /search over HTTP. Asserts the two SAFETY invariants that must hold regardless of the model:
//
//   1. FLAG OFF ⇒ inert: default /search is byte-identical to today — lexical order preserved and
//      no result carries a `reranked` flag.
//   2. NULL-DEGRADE ⇒ today: with ?rerank=1 on a FRESH sandbox the rerank sidecar is cold, so the
//      first rerank() call returns null and the route keeps the cosine order. We assert the result
//      SET is preserved and HTTP 200; and when the response shows the null-degrade path (no
//      `reranked` flags), the ORDER equals the off baseline. (If the sidecar happened to warm and
//      rerank, the same-set + 200 assertions still hold — rerank reorders, never drops/adds.)
//
// Run: node test/rerank-route.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rerank-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const overlayStore = require('../lib/overlay');   // BASE read at require-time → sandbox
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-rerank-ws-')));

// Three lexical-only notes with DECREASING overlap to the query ⇒ deterministic cosine order A>B>C.
{
  const ov = overlayStore.load(WS);
  ov.note_nodes = {
    noteA: { id: 'noteA', title: 'locale decimal sum parsing gotcha', summary: 'parse locale decimal sum values carefully', created_at: new Date().toISOString() },
    noteB: { id: 'noteB', title: 'decimal parsing notes',            summary: 'decimal parsing edge cases',                 created_at: new Date().toISOString() },
    noteC: { id: 'noteC', title: 'parsing overview',                 summary: 'general parsing remarks',                    created_at: new Date().toISOString() },
  };
  overlayStore.save(WS, ov);
}

const PORT = 19420 + Math.floor(Math.random() * 200);
function get(p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    r.end();
  });
}
async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r.status === 200) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const wsq = encodeURIComponent(WS);
const q = encodeURIComponent('locale decimal sum parsing');
const noteKeys = (b) => (b.results || []).filter((r) => String(r.key).startsWith('note:')).map((r) => r.key);

(async () => {
  const daemon = spawn(process.execPath, [path.join(REPO, 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    if (!(await waitForPing())) { console.log('FAIL  daemon did not come up'); process.exit(1); }

    // 1. FLAG OFF ⇒ inert. Default lexical order is A>B>C and nothing is reranked.
    const base = await get(`/search?workspace=${wsq}&q=${q}&k=5`);
    ok('off: HTTP 200', base.status === 200);
    const baseKeys = noteKeys(base.body);
    ok('off: all three notes returned', baseKeys.length === 3);
    ok('off: lexical order A>B>C', baseKeys.join(',') === 'note:noteA,note:noteB,note:noteC');
    ok('off: no result carries reranked flag', !(base.body.results || []).some((r) => r.reranked === true));

    // 2. ?rerank=1 on a COLD sandbox ⇒ rerank() returns null ⇒ cosine order kept (null-degrade).
    const rr = await get(`/search?workspace=${wsq}&q=${q}&k=5&rerank=1`);
    ok('rerank=1: HTTP 200', rr.status === 200);
    const rrKeys = noteKeys(rr.body);
    ok('rerank=1: result SET preserved (rerank reorders, never drops/adds)',
       rrKeys.length === baseKeys.length && [...rrKeys].sort().join(',') === [...baseKeys].sort().join(','));
    const anyReranked = (rr.body.results || []).some((r) => r.reranked === true);
    if (!anyReranked) {
      // null-degrade path (expected on a cold sidecar): order MUST equal the off baseline.
      ok('rerank=1 (null-degrade): order identical to off baseline', rrKeys.join(',') === baseKeys.join(','));
    } else {
      // The sidecar warmed and actually reranked — set-preservation already asserted above.
      console.log('NOTE  rerank=1: sidecar warmed and reranked; set-preservation asserted, order check skipped');
    }
  } finally {
    daemon.kill('SIGKILL');
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e && e.message); process.exit(1); });
