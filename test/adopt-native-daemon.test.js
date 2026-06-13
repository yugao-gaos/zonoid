#!/usr/bin/env node
// Integration test for P2-A3 adopt-on-first-sight + precedence flip (Claude native tasks).
// Run: node test/adopt-native-daemon.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-adopt-d-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const nt = require('../lib/native-tasks');
const overlayStore = require('../lib/overlay');

const PORT = 18860 + Math.floor(Math.random() * 100);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-adopt-ws-')));
const SESSION = `bbbbbbbb0000${process.pid.toString(16).padStart(8, '0')}`;
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', nt.encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const K = (id) => `${SESSION}/${id}`;

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); }
        catch (e) { reject(e); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const writeTask = (id, extra = {}) =>
  fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), JSON.stringify({ id: String(id), subject: `task ${id}`, status: 'pending', blockedBy: [], ...extra }, null, 2));

function spawnDaemon() {
  return spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
}

(async () => {
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, `${SESSION}.jsonl`), '');
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  writeTask('blk', { subject: 'blocker alpha' });
  writeTask('dep', { subject: 'dependent beta', blockedBy: ['blk'] });

  let child = spawnDaemon();
  try {
    ok('daemon came up', await waitForPing());
    await req('POST', '/workspace', { path: WS });

    // (A) first buildGraph adopts native stub into overlay snapshot
    await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`);
    let ov = overlayStore.load(WS);
    ok('(A) adoption snapshot created on first sight', ov.snapshots && ov.snapshots[K('blk')] && ov.snapshots[K('dep')]);
    ok('(A) adopted blockedBy preserved', (ov.snapshots[K('dep')].blockedBy || []).includes('blk'));

    // (B) precedence flip: native blockedBy change ignored; title/status fold in
    writeTask('dep', { subject: 'renamed beta', status: 'in_progress', blockedBy: [] });
    await new Promise((r) => setTimeout(r, 400));
    let g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const dep = g.tasks.find((t) => t.id === K('dep'));
    ok('(B) live echo title', dep && dep.label === 'renamed beta');
    ok('(B) adopted deps unchanged after native blockedBy cleared', dep && dep.deps.includes(K('blk')));

    // (C) terminal status does not re-snapshot (adoption already durable)
    const adoptedSubject = ov.snapshots[K('blk')].subject;
    const markRoot = await req('POST', '/mark-root', { task_key: K('blk'), reason: 'test root' });
    ok('(C) mark-root for unwired blocker', markRoot.status === 200);
    const done = await req('POST', '/overlay/status', { workspace: WS, key: K('blk'), status: 'done', summary: 'blocker done.' });
    ok('(C) terminal status accepted', done.status === 200);
    ov = overlayStore.load(WS);
    ok('(C) adoption fields preserved at terminal', ov.snapshots[K('blk')].subject === adoptedSubject);
    g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    ok('(C) no duplicate node', g.tasks.filter((t) => t.id === K('blk')).length === 1);

    // (D) native file deletion — node survives from adoption snapshot
    fs.rmSync(path.join(TASKS_DIR, 'blk.json'));
    g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const blk = g.tasks.find((t) => t.id === K('blk'));
    ok('(D) node survives native GC', !!blk);
    ok('(D) label from adoption snapshot', blk && blk.label === 'blocker alpha');
  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(TASKS_DIR, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
