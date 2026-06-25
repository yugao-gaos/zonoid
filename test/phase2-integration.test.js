#!/usr/bin/env node
// P2-A4 integration test: Phase 2 durability, GC resilience, namespace safety.
//
// Covers the acceptance criteria not already isolated in sibling files:
//   (A) local/ and cursor/ harness keys coexist with a Claude session-uuid key that shares
//       the same bare id — three distinct graph nodes, no overwrite
//   (B) writeStatus routes per namespace: harness keys → stub files; session keys → native
//       files; no cross-contamination at any call site (/overlay/status)
//   (C) file-drop stub tasks (local/, cursor/) survive a daemon restart with statuses intact
//   (D) adopt-on-first-sight: Claude native task node survives native-file GC (deletion)
//   (E) POST /sync idempotent when no new stubs appear
//
// Sandboxed-daemon convention: private port + tmp CLAUDE_PLUGIN_DATA (see filedrop-daemon.test.js).
// Run: node test/phase2-integration.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const git = require('../lib/git');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-p2int-d-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const filedrop = require('../lib/filedrop-tasks');
const nt = require('../lib/native-tasks');
const overlayStore = require('../lib/overlay');

const PORT = 18880 + Math.floor(Math.random() * 100);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-p2int-ws-')));
const SESSION = `cccccccc1111${process.pid.toString(16).padStart(8, '0')}`;
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', nt.encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const K = (id) => `${SESSION}/${id}`;

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
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

async function waitForTaskStatus(key, status, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const t = g.tasks.find((x) => x.id === key);
    if (t && t.status === status) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function dropStub(harness, id, extra = {}) {
  const dir = path.join(filedrop.dirFor(WS), harness);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ id, subject: `${harness} task ${id}`, ...extra }, null, 2));
  fs.renameSync(tmp, file);
}

const writeNative = (id, extra = {}) =>
  fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), JSON.stringify({ id: String(id), subject: `native ${id}`, status: 'pending', blockedBy: [], ...extra }, null, 2));

function spawnDaemon() {
  return spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), JUDGE_TIMEOUT_MS: '1', JUDGE_HARD_CEILING_MS: '1' },
    stdio: 'ignore',
  });
}

(async () => {
  git.initRepo(WS); // claim gate needs a registered worktree, which needs a git repo
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, `${SESSION}.jsonl`), '');
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  // Same bare id across all three namespaces — the collision scenario Phase 2 must isolate.
  const SHARED_ID = 'alpha';
  dropStub('local', SHARED_ID, { created_by: { harness: 'local', agent_id: 'worker-local' } });
  dropStub('cursor', SHARED_ID, { created_by: { harness: 'cursor', agent_id: 'worker-cursor' } });
  writeNative(SHARED_ID, { subject: 'claude native alpha' });

  let child = spawnDaemon();
  try {
    ok('daemon came up', await waitForPing());
    await req('POST', '/workspace', { path: WS });

    // ------------------------------------------------------------------
    // (A) namespace safety: three distinct nodes for the same bare id
    // ------------------------------------------------------------------
    let g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const localNode = g.tasks.find((t) => t.id === `local/${SHARED_ID}`);
    const cursorNode = g.tasks.find((t) => t.id === `cursor/${SHARED_ID}`);
    const nativeNode = g.tasks.find((t) => t.id === K(SHARED_ID));
    ok('(A) local/alpha is a graph node', !!localNode);
    ok('(A) cursor/alpha is a graph node', !!cursorNode);
    ok('(A) session/alpha is a graph node', !!nativeNode);
    ok('(A) three nodes, not one', g.tasks.filter((t) => t.id.endsWith(`/${SHARED_ID}`)).length === 3);
    ok('(A) labels are namespace-distinct', localNode && cursorNode && nativeNode
      && localNode.label === 'local task alpha'
      && cursorNode.label === 'cursor task alpha'
      && nativeNode.label === 'claude native alpha');

    // ------------------------------------------------------------------
    // (B) writeStatus routing per namespace via /overlay/status
    // ------------------------------------------------------------------
    // P3: no daemon-global workspace — mark-root must name the workspace so it clears the
    // unwired flag on the RIGHT overlay (else the subsequent in_progress claim 409s as unwired).
    const rootLocal = await req('POST', '/mark-root', { task_key: `local/${SHARED_ID}`, reason: 'test root', workspace: WS });
    const rootCursor = await req('POST', '/mark-root', { task_key: `cursor/${SHARED_ID}`, reason: 'test root', workspace: WS });
    ok('(B) mark-root local accepted', rootLocal.status === 200);
    ok('(B) mark-root cursor accepted', rootCursor.status === 200);
    await waitForTaskStatus(`local/${SHARED_ID}`, 'ready');
    await waitForTaskStatus(`cursor/${SHARED_ID}`, 'ready');
    // DG1/DG2 claim gate: register a worktree per claimed key + supply session_id.
    await req('POST', '/git/worktree', { workspace: WS, key: `local/${SHARED_ID}`, repo_path: WS });
    await req('POST', '/git/worktree', { workspace: WS, key: `cursor/${SHARED_ID}`, repo_path: WS });
    const markLocal = await req('POST', '/overlay/status', { workspace: WS, key: `local/${SHARED_ID}`, status: 'in_progress', agent_id: 'w-local', session_id: 'p2-local-sid' });
    const markCursor = await req('POST', '/overlay/status', { workspace: WS, key: `cursor/${SHARED_ID}`, status: 'in_progress', agent_id: 'w-cursor', session_id: 'p2-cursor-sid' });
    const markNative = await req('POST', '/overlay/status', { workspace: WS, key: K(SHARED_ID), status: 'done', summary: 'native done.' });
    ok('(B) local status write accepted', markLocal.status === 200);
    ok('(B) cursor status write accepted', markCursor.status === 200);
    ok('(B) native status write accepted', markNative.status === 200);

    const localStub = filedrop.readStub(WS, `local/${SHARED_ID}`);
    const cursorStub = filedrop.readStub(WS, `cursor/${SHARED_ID}`);
    const nativeAfter = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, `${SHARED_ID}.json`), 'utf8'));
    ok('(B) local write-through hit stub file', localStub && localStub.status === 'in_progress');
    ok('(B) cursor write-through hit stub file', cursorStub && cursorStub.status === 'in_progress');
    ok('(B) native write-through hit Claude file', nativeAfter.status === 'completed');
    ok('(B) no ~/.claude/tasks/local dir created', !fs.existsSync(path.join(os.homedir(), '.claude', 'tasks', 'local')));
    ok('(B) no ~/.claude/tasks/cursor dir created', !fs.existsSync(path.join(os.homedir(), '.claude', 'tasks', 'cursor')));
    ok('(B) stub files untouched by native write', localStub.status === 'in_progress' && cursorStub.status === 'in_progress');

    // ------------------------------------------------------------------
    // (D) adopt-on-first-sight survives native-file GC
    // ------------------------------------------------------------------
    fs.rmSync(path.join(TASKS_DIR, `${SHARED_ID}.json`));
    g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const nativeAfterGc = g.tasks.find((t) => t.id === K(SHARED_ID));
    ok('(D) native node survives file GC', !!nativeAfterGc);
    ok('(D) adopted label preserved after GC', nativeAfterGc && nativeAfterGc.label === 'claude native alpha');
    ok('(D) harness nodes unaffected by native GC', g.tasks.filter((t) => t.id === `local/${SHARED_ID}` || t.id === `cursor/${SHARED_ID}`).length === 2);

    // ------------------------------------------------------------------
    // (E) /sync idempotent
    // ------------------------------------------------------------------
    const s1 = await req('POST', '/sync', { workspace: WS });
    const s2 = await req('POST', '/sync', { workspace: WS });
    ok('(E) first sync ok', s1.status === 200 && s1.body.ok === true);
    ok('(E) second sync adopts nothing', s2.status === 200 && Array.isArray(s2.body.adopted) && s2.body.adopted.length === 0);

    // ------------------------------------------------------------------
    // (C) stub durability across daemon restart
    // ------------------------------------------------------------------
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    child = spawnDaemon();
    ok('(C) daemon restarted', await waitForPing());
    await req('POST', '/workspace', { path: WS });
    g = (await req('GET', `/peek?workspace=${encodeURIComponent(WS)}`)).body;
    const local2 = g.tasks.find((t) => t.id === `local/${SHARED_ID}`);
    const cursor2 = g.tasks.find((t) => t.id === `cursor/${SHARED_ID}`);
    const native2 = g.tasks.find((t) => t.id === K(SHARED_ID));
    ok('(C) local stub survives restart', !!local2);
    ok('(C) cursor stub survives restart', !!cursor2);
    ok('(C) adopted native survives restart', !!native2);
    ok('(C) stub in_progress status survives restart', local2 && cursor2 && local2.status === 'in_progress' && cursor2.status === 'in_progress');
    ok('(C) native done status survives restart', native2 && native2.status === 'done');
    ok('(C) no namespace collision after restart', g.tasks.filter((t) => t.id.endsWith(`/${SHARED_ID}`)).length === 3);

    // Overlay snapshots minted for native adoption and harness stubs at first sight.
    const ov = overlayStore.load(WS);
    ok('(C) adoption snapshot for native key', ov.snapshots && ov.snapshots[K(SHARED_ID)]);
    ok('(C) adoption snapshot for harness keys at first sight', ov.snapshots && ov.snapshots[`local/${SHARED_ID}`] && ov.snapshots[`cursor/${SHARED_ID}`]);
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
