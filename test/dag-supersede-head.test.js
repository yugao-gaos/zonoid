#!/usr/bin/env node
// Regression test for SUPERSEDE-AWARE DAG injection (routes/graph.js).
//
// When a task's context_dep points at a note that has since been SUPERSEDED, the DAG tier must
// follow the supersededBy chain to the CURRENT HEAD and inject that — not the stale note. This
// matters most under dagOnly (fully-judged task): RAG-fill is dropped, so without head-resolution
// the current replacement note would NEVER surface and the stale one would be injected at score 1.0.
//
// Recipe (modeled on test/dag-only-claim-context.test.js + test/supersede-roundtrip.test.js):
//   - spawn the real daemon on a private port with a sandboxed CLAUDE_PLUGIN_DATA
//   - a filedrop stub task `tjudged` (fully-judged: its only context edge is asserted, so the
//     projection is non-provisional ⇒ dagOnly path, RAG-fill dropped)
//   - create note A via POST /overlay/note, then note B via POST /overlay/note { supersedes: A }
//     so the supersede chain is persisted through the real supersedeNote path (a hand-set
//     validTo/supersededBy on note_nodes does NOT survive the daemon's graph-store reload)
//   - wire the STALE note A as a context_dep of tjudged via POST /overlay/edge (kind=context)
//   - GET /search?task_key=tjudged and assert the HEAD B is injected at tier=dag and A is not
//
// Run: node test/dag-supersede-head.test.js
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

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dagsup-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dagsup-ws-')));
// Reuse already-downloaded embedding weights if present so /overlay/note doesn't try a network
// download from the empty sandbox cache. Absent ⇒ embed() degrades to null (lexical fallback is fine).
try {
  const realModels = path.join(os.homedir(), '.claude', 'orchestrator', 'models');
  if (fs.existsSync(realModels)) fs.symlinkSync(realModels, path.join(SANDBOX, 'models'));
} catch { /* lexical fallback */ }

// filedrop stub task: <SANDBOX>/tasks/<workspace-key>/<harness>/<id>.json (lib/filedrop-tasks).
function workspaceKey(ws) {
  const h = crypto.createHash('sha1').update(String(ws)).digest('hex').slice(0, 16);
  const base = (path.basename(ws) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return `${base}-${h}`;
}
const stubDir = path.join(SANDBOX, 'tasks', workspaceKey(WS), 'local');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(path.join(stubDir, 'tjudged.json'),
  JSON.stringify({ id: 'tjudged', subject: 'wire up the deploy target config', status: 'in_progress' }));

const PORT = 19420 + Math.floor(Math.random() * 200);
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const get = (p) => req('GET', p);
const post = (p, b) => req('POST', p, b);

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r.status === 200) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const wsq = encodeURIComponent(WS);
const q = encodeURIComponent('deploy target config');
const keys = (results) => (results || []).map((r) => r.key);

(async () => {
  const daemon = spawn(process.execPath, [path.join(REPO, 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    if (!(await waitForPing())) { console.log('FAIL  daemon did not come up'); process.exit(1); }
    await post('/workspace', { path: WS });

    // 1. Create note A (the to-be-stale note), then note B superseding A — via the real API so the
    //    supersede chain (validTo on A, supersededBy A->B, supersedes B->A) is genuinely persisted.
    const rA = await post('/overlay/note', { workspace: WS, title: 'deploy target is fly.io', summary: 'STALE: we deploy the daemon to fly.io' });
    ok('note A created', rA.body.ok && String(rA.body.key || '').startsWith('note:'));
    const keyA = rA.body.key;
    const rB = await post('/overlay/note', { workspace: WS, title: 'deploy target is render.com', summary: 'CURRENT: we moved the daemon to render.com', supersedes: keyA });
    ok('note B created superseding A', rB.body.ok && rB.body.superseded && rB.body.superseded.old_key === keyA);
    const keyB = rB.body.key;

    // 2. Wire the STALE note A as a context_dep of the fully-judged task (asserted context edge).
    const rE = await post('/overlay/edge', { workspace: WS, from: keyA, to: 'local/tjudged', kind: 'context', weight: 0.5 });
    ok('context edge A->task added', rE.body.ok);

    // 3. Claim-context consult: the DAG tier must follow A's supersede chain and inject the HEAD B.
    const r = await get(`/search?workspace=${wsq}&q=${q}&k=5&task_key=${encodeURIComponent('local/tjudged')}`);
    ok('HTTP 200', r.status === 200);
    const results = r.body.results || [];
    ok('head note B injected at tier=dag', results.some((x) => x.key === keyB && x.tier === 'dag'));
    ok('stale note A NOT injected', !keys(results).includes(keyA));
    const headHit = results.find((x) => x.key === keyB);
    ok('head injected at score 1.0', !!headHit && headHit.score === 1.0);
    ok('head carries via-supersede path marker', !!headHit && /via supersede/.test((headHit.path || []).join(' ')));
  } finally {
    daemon.kill('SIGKILL');
    for (const d of [SANDBOX, WS]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e && e.message); process.exit(1); });
