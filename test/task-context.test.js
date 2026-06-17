#!/usr/bin/env node
// Tier-1 dependency handoff: context edge weights surface in /task/context ordering.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-task-ctx-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-task-ctx-ws-')));
const PORT = 19650 + Math.floor(Math.random() * 50);
const BASE = `http://127.0.0.1:${PORT}`;
const encodeWorkspace = (p) => String(p).replace(/[/.\\:]/g, '-');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const SID = crypto.randomUUID();
const KEY = `${SID}/1`;

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// P3: ops require an explicit workspace (no daemon-global default). Single-workspace suite ⇒
// default WS into POST bodies and GET query strings (skip /workspace, /ping, explicit workspace).
async function post(p, body) {
  const payload = (p === '/workspace' || (body && body.workspace)) ? body : { ...(body || {}), workspace: WS };
  const res = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  return { status: res.status, body: await res.json() };
}
function withWs(p) {
  if (p.startsWith('/ping') || p.includes('workspace=')) return p;
  return p + (p.includes('?') ? '&' : '?') + 'workspace=' + encodeURIComponent(WS);
}
async function get(p) {
  const res = await fetch(`${BASE}${withWs(p)}`);
  return { status: res.status, body: await res.json() };
}
async function waitForPing(ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r.body && r.body.ok) return true; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJECTS_DIR, `${SID}.jsonl`), '');
  fs.mkdirSync(path.join(os.homedir(), '.claude', 'tasks', SID), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), '.claude', 'tasks', SID, '1.json'), JSON.stringify({ id: '1', subject: 'consumer', status: 'pending' }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_TOKEN: '' },
    stdio: 'ignore',
  });
  try {
    ok('daemon up', await waitForPing());
    ok('workspace pinned', (await post('/workspace', { path: WS })).body.ok === true);

    ok('note a', (await post('/overlay/note', { title: 'low note', summary: 'weaker context', wires_to: [KEY] })).body.ok === true);
    const noteB = (await post('/overlay/note', { title: 'high note', summary: 'stronger context' })).body;
    ok('note b', noteB.ok === true);
    ok('edge weight 0.9', (await post('/overlay/edge', { from: 'note:' + noteB.id, to: KEY, kind: 'context', weight: 0.9 })).body.ok === true);
    ok('edge weight 0.3', (await post('/overlay/edge', { from: 'note:' + (await post('/overlay/note', { title: 'tail note', summary: 'low relevance' })).body.id, to: KEY, kind: 'context', weight: 0.3 })).body.ok === true);

    const ctx = await get(`/task/context?key=${encodeURIComponent(KEY)}`);
    ok('context 200', ctx.status === 200);
    const ctxDeps = (ctx.body.dependencySummaries || []).filter((s) => s.via === 'context');
    ok('three context deps', ctxDeps.length === 3);
    ok('sorted high to low', ctxDeps[0].weight === 1 && ctxDeps[1].weight === 0.9 && ctxDeps[2].weight === 0.3);
    ok('blocking deps omit weight', !(ctx.body.dependencySummaries || []).some((s) => s.via === 'blocking' && 'weight' in s));
  } finally {
    child.kill('SIGTERM');
    try { fs.rmSync(PROJECTS_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(path.join(os.homedir(), '.claude', 'tasks', SID), { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
