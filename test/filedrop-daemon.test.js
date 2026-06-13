#!/usr/bin/env node
// Integration test for the file-drop task source wired through the daemon (multi-harness
// plan Phase 2, deliverable 1): stub tasks enter the aggregate at the same union point as
// native tasks and flow through buildGraph, the status overlay, dependency edges, the
// write-through router, and survive a daemon restart.
//
// Covers:
//   (A) stub tasks appear as graph nodes with '<harness>/<id>' keys; cross-stub blockedBy
//       becomes a dependency edge (blocked task derives not_ready, blocker ready)
//   (B) status overlay + unwired quarantine apply to stub tasks identically to native ones
//   (C) /overlay/status write-through routes to the STUB file for harness-prefixed keys
//       and still to the Claude native store for '<session>/<id>' keys
//   (D) adopt-on-first-sight: overlay snapshot minted at first peek; terminal status
//       updates existing snapshot without duplicating nodes
//   (F) stub deletion: nodes + deps survive via snapshot fallback after /sync
//   (E) durability: nodes + statuses survive a daemon restart
//
// Sandboxed-daemon convention: private port + tmp CLAUDE_PLUGIN_DATA (see app-restart.test.js).
// Run: node test/filedrop-daemon.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-filedrop-d-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX; // before requires — both modules read env at load
const filedrop = require('../lib/filedrop-tasks');
const overlayStore = require('../lib/overlay');

const PORT = 18840 + Math.floor(Math.random() * 100);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-filedrop-ws-')));
// Fake Claude session for the (C) session-key routing check — mirrors native-write.test.js.
const FAKE_SESSION = `TESTFAKE-filedrop-${process.pid}`;
const FAKE_SESSION_DIR = path.join(os.homedir(), '.claude', 'tasks', FAKE_SESSION);

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

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
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function dropStub(harness, id, extra = {}) {
  const dir = path.join(filedrop.dirFor(WS), harness);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic-write convention: tmp + rename, like a real adapter would.
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id, subject: `stub ${id}`, ...extra }, null, 2));
  fs.renameSync(tmp, file);
}

function spawnDaemon() {
  return spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
}

(async () => {
  let child = spawnDaemon();
  try {
    ok('daemon came up', await waitForPing());
    await req('POST', '/workspace', { path: WS });

    // ------------------------------------------------------------------
    // (A) aggregate union + dependency edge between two stub tasks
    // ------------------------------------------------------------------
    dropStub('cursor', 'aaa', { description: 'the blocker', created_by: { harness: 'cursor', agent_id: 'worker-1' } });
    dropStub('cursor', 'bbb', { blockedBy: ['aaa'] });

    let g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const aaa = g.tasks.find((t) => t.id === 'cursor/aaa');
    const bbb = g.tasks.find((t) => t.id === 'cursor/bbb');
    ok('(A) stub aaa is a graph node', !!aaa);
    ok('(A) stub bbb is a graph node', !!bbb);
    ok('(A) labels come from subject', aaa && aaa.label === 'stub aaa');
    ok('(A) blockedBy became a dependency edge', bbb && bbb.deps.includes('cursor/aaa'));
    ok('(A) blocker derives ready', aaa && aaa.status === 'ready');
    ok('(A) blocked task derives not_ready', bbb && bbb.status === 'not_ready');
    ok('(A) summary counts stub tasks', g.summary && g.summary.tasks_total === 2);
    let ovFirst = overlayStore.load(WS);
    ok('(D) adoption snapshot minted at first sight for cursor/aaa', ovFirst.snapshots && ovFirst.snapshots['cursor/aaa']);
    ok('(D) adopted blockedBy normalized on cursor/bbb', (ovFirst.snapshots['cursor/bbb'].blockedBy || []).includes('cursor/aaa'));

    // ------------------------------------------------------------------
    // (B) overlay machinery parity: unwired quarantine + claims
    // ------------------------------------------------------------------
    // aaa was first seen with no overlay edges -> unwired quarantine refuses an in_progress
    // claim, exactly as for a native task (proves stubs share the same pipeline).
    const claimAaa = await req('POST', '/overlay/status', { workspace: WS, key: 'cursor/aaa', status: 'in_progress', agent_id: 'w1' });
    ok('(B) unwired stub claim refused 409', claimAaa.status === 409 && /unwired/.test(claimAaa.body.error || ''));
    // bbb carries a native dep -> not quarantined; claim lands.
    const claimBbb = await req('POST', '/overlay/status', { workspace: WS, key: 'cursor/bbb', status: 'in_progress', agent_id: 'w1' });
    ok('(B) wired stub claim accepted', claimBbb.status === 200 && claimBbb.body.ok === true);
    g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    ok('(B) overlay status override shows on the stub node', g.tasks.find((t) => t.id === 'cursor/bbb').status === 'in_progress');

    // ------------------------------------------------------------------
    // (C) write-through routing by namespace
    // ------------------------------------------------------------------
    const stubBbb = filedrop.readStub(WS, 'cursor/bbb');
    ok('(C) stub file status updated to in_progress', stubBbb && stubBbb.status === 'in_progress');
    ok('(C) no stray "cursor" dir in ~/.claude/tasks', !fs.existsSync(path.join(os.homedir(), '.claude', 'tasks', 'cursor')));
    // Session-key write-through still reaches the Claude native store.
    fs.mkdirSync(FAKE_SESSION_DIR, { recursive: true });
    fs.writeFileSync(path.join(FAKE_SESSION_DIR, '1.json'), JSON.stringify({ id: '1', subject: 'native demo', status: 'pending', blockedBy: [] }));
    const doneNative = await req('POST', '/overlay/status', { workspace: WS, key: `${FAKE_SESSION}/1`, status: 'done', summary: 'done.' });
    ok('(C) session-key status write accepted', doneNative.status === 200);
    const nativeAfter = JSON.parse(fs.readFileSync(path.join(FAKE_SESSION_DIR, '1.json'), 'utf8'));
    ok('(C) Claude native file got the write-through (completed)', nativeAfter.status === 'completed');

    // ------------------------------------------------------------------
    // (D) snapshotNative safety for stub keys
    // ------------------------------------------------------------------
    const doneAaa = await req('POST', '/overlay/status', { workspace: WS, key: 'cursor/aaa', status: 'done', summary: 'blocker done.' });
    ok('(D) done on a stub key accepted', doneAaa.status === 200 && doneAaa.body.ok === true);
    ok('(D) terminal status GC removes stub file', !filedrop.readStub(WS, 'cursor/aaa'));
    const ovAfter = overlayStore.load(WS);
    ok('(D) adoption snapshot preserved after terminal status', ovAfter.snapshots && ovAfter.snapshots['cursor/aaa']);
    ok('(D) terminal status folded into snapshot', ovAfter.snapshots['cursor/aaa'].status === 'completed');
    g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    ok('(D) no duplicate node after terminal status', g.tasks.filter((t) => t.id === 'cursor/aaa').length === 1);
    ok('(D) stub node shows done', g.tasks.find((t) => t.id === 'cursor/aaa').status === 'done');

    // ------------------------------------------------------------------
    // (E) durability across a daemon restart
    // ------------------------------------------------------------------
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    child = spawnDaemon();
    ok('(E) daemon restarted', await waitForPing());
    await req('POST', '/workspace', { path: WS });
    g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const aaa2 = g.tasks.find((t) => t.id === 'cursor/aaa');
    const bbb2 = g.tasks.find((t) => t.id === 'cursor/bbb');
    ok('(E) stub nodes survive restart', !!aaa2 && !!bbb2);
    ok('(E) terminal status survives restart', aaa2 && aaa2.status === 'done');
    ok('(E) claim survives restart', bbb2 && bbb2.status === 'in_progress');
    ok('(E) dependency edge survives restart', bbb2 && bbb2.deps.includes('cursor/aaa'));

    // ------------------------------------------------------------------
    // (F) stub deletion — snapshot fallback keeps nodes + deps
    // ------------------------------------------------------------------
    // cursor/aaa stub already removed by terminal GC; delete in_progress bbb manually.
    fs.rmSync(path.join(filedrop.stubFile(WS, 'cursor/bbb')), { force: true });
    ok('(F) stub files deleted', !filedrop.readStub(WS, 'cursor/aaa') && !filedrop.readStub(WS, 'cursor/bbb'));
    await req('POST', '/sync', { workspace: WS });
    g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const aaaF = g.tasks.find((t) => t.id === 'cursor/aaa');
    const bbbF = g.tasks.find((t) => t.id === 'cursor/bbb');
    ok('(F) cursor/aaa survives stub deletion via snapshot', !!aaaF);
    ok('(F) cursor/bbb survives stub deletion via snapshot', !!bbbF);
    ok('(F) terminal status survives stub deletion', aaaF && aaaF.status === 'done');
    ok('(F) overlay status survives stub deletion', bbbF && bbbF.status === 'in_progress');
    ok('(F) dependency edge survives stub deletion', bbbF && bbbF.deps.includes('cursor/aaa'));
  } finally {
    child.kill();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(FAKE_SESSION_DIR, { recursive: true, force: true }); } catch { /* */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
