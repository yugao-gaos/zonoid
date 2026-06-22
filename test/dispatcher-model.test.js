/**
 * Dispatcher model integration tests (DG6):
 *   - Main/dispatcher start_task → 409; subagent start_task → ok
 *   - GET /dispatcher/children attribution meta (sole vs multi-child + focus)
 *   - Trivial patch gate (orch-gate.sh) against a live sandbox daemon
 *   - POST /usage/dispatcher-edit attribution to correct task_key
 *
 * Complements test/endpoints.test.js (sections 1c–1e) with hook+daemon e2e and
 * /dispatcher/children attribution fields. Unit-level gate paths live in
 * test/orch-gate.test.js (stub curl) and test/orch-gate-bash.test.js.
 *
 * Run: node test/dispatcher-model.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, spawnSync, execSync } = require('child_process');
const filedrop = require('../lib/filedrop-tasks');

const REPO = path.resolve(__dirname, '..');
const HOOK = path.join(REPO, 'hooks', 'orch-gate.sh');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dispatch-d-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-dispatch-ws-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
let PORT = 0;
let BASE = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function post(p, body) {
  // Mirror the real MCP client (lib/mcp-core makeCall): inject the session's workspace into every
  // POST body so workspace-required routes resolve it (the daemon-global default was removed).
  const payload = (body && body.workspace) ? body : { workspace: WS, ...body };
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

async function get(p) {
  // Mirror makeCall: append ?workspace= unless the path already carries one.
  const u = /[?&]workspace=/.test(p) ? p : `${p}${p.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(WS)}`;
  const res = await fetch(`${BASE}${u}`);
  return { status: res.status, body: await res.json() };
}

async function waitForPing(ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r.body && r.body.ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function dropStub(id, extra = {}) {
  const dir = path.join(filedrop.dirFor(WS), 'local');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, subject: `dispatch ${id}`, status: 'pending', ...extra }, null, 2));
}

function readOverlay() {
  const dir = path.join(SANDBOX, 'overlay');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('.diagnostics.'));
  if (files.length !== 1) throw new Error(`expected one overlay file, got ${files.length}`);
  return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
}

async function assertStubsVisible(syncBody, keys) {
  const adopted = new Set((syncBody && syncBody.adopted) || []);
  if (keys.every((key) => adopted.has(key))) return;
  const state = await get('/state?compact=1');
  assert.equal(state.status, 200, 'state after sync');
  const visible = new Set((state.body.tasks || []).map((t) => t.id));
  for (const key of keys) assert.ok(visible.has(key), `stub ${key} visible after sync`);
}

function runGate(sessionId, patch, extraEnv = {}) {
  const input = JSON.stringify({
    tool_input: { file_path: '/Users/x/proj/dispatch-test.js', new_string: patch },
    session_id: sessionId,
  });
  return spawnSync('bash', [HOOK], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      ORCH_PORT: String(PORT),
      CLAUDE_PLUGIN_DATA: SANDBOX,
      ...extraEnv,
    },
  });
}

test('dispatcher model — claim gate, children, trivial gate, attribution', async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  dropStub('dm-a');
  dropStub('dm-b');
  const KEY_A = 'local/dm-a';
  const KEY_B = 'local/dm-b';

  const SID_DISPATCHER = crypto.randomUUID();
  const SID_WORKER = crypto.randomUUID();
  const SID_WORKER_B = crypto.randomUUID();

  const child = spawn(process.execPath, [path.join(REPO, 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_TOKEN: '', JUDGE_TIMEOUT_MS: '1', JUDGE_HARD_CEILING_MS: '1' },
    stdio: 'ignore',
  });

  try {
    assert.ok(await waitForPing(), 'sandbox daemon up');
    execSync('git init -q', { cwd: WS });
    execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: WS });
    assert.equal((await post('/workspace', { path: WS })).body.ok, true);
    let r = await post('/sync', { workspace: WS });
    assert.equal(r.status, 200, 'sync ok');
    await assertStubsVisible(r.body, [KEY_A, KEY_B]);

    await post('/agent/start', { agent_id: 'dispatch-main', session: SID_DISPATCHER });
    assert.equal((await post('/mark-root', { task_key: KEY_A, reason: 'dispatch test' })).body.ok, true);

    // Dispatcher claim with NO worktree → refused (worktree is the claim-side security boundary).
    r = await post('/overlay/status', {
      key: KEY_A,
      status: 'in_progress',
      agent_id: 'dispatch-main',
      session_id: SID_DISPATCHER,
    });
    assert.equal(r.status, 409, 'dispatcher start_task → 409');
    assert.match(r.body.error, /prepare.*accept|isolated worktree assignment/);

    await post('/agent/start', {
      agent_id: 'dispatch-worker',
      session: SID_DISPATCHER,
      subagent_session: SID_WORKER,
    });
    // DG1/DG2: the legit subagent claim needs a registered worktree (branch_task precondition).
    assert.equal((await post('/git/worktree', { key: KEY_A, repo_path: WS })).status, 200, 'KEY_A worktree');
    r = await post('/overlay/status', {
      key: KEY_A,
      status: 'in_progress',
      agent_id: 'dispatch-worker',
      session_id: SID_WORKER,
    });
    assert.equal(r.body.ok, true, 'subagent start_task → ok');

    r = await get(`/dispatcher/children?session=${SID_DISPATCHER}`);
    assert.equal(r.body.children.length, 1);
    assert.equal(r.body.attribution, KEY_A, 'sole child → auto attribution');
    assert.equal(r.body.needs_focus, false);

    await post('/agent/start', {
      agent_id: 'dispatch-worker-b',
      session: SID_DISPATCHER,
      subagent_session: SID_WORKER_B,
    });
    assert.equal((await post('/mark-root', { task_key: KEY_B, reason: 'second worker' })).body.ok, true);
    assert.equal((await post('/git/worktree', { key: KEY_B, repo_path: WS })).status, 200, 'KEY_B worktree');
    assert.equal((await post('/overlay/status', {
      key: KEY_B,
      status: 'in_progress',
      agent_id: 'dispatch-worker-b',
      session_id: SID_WORKER_B,
    })).body.ok, true);

    r = await get(`/dispatcher/children?session=${SID_DISPATCHER}`);
    assert.equal(r.body.children.length, 2);
    assert.equal(r.body.needs_focus, true);
    assert.equal(r.body.attribution, null, 'multi-child without focus → no attribution');

    assert.equal((await post('/overlay/dispatcher-focus', {
      session_id: SID_DISPATCHER,
      task_key: KEY_B,
    })).body.ok, true);
    r = await get(`/dispatcher/children?session=${SID_DISPATCHER}`);
    assert.equal(r.body.attribution, KEY_B, 'focus pins attribution');

    const sidNoWorkers = crypto.randomUUID();
    const blocked = runGate(sidNoWorkers, 'x=1\n');
    assert.equal(blocked.status, 2, 'main without workers → exit 2');
    assert.match(blocked.stderr, /no in-flight workers/);

    const sidTrivial = SID_DISPATCHER;
    const patch = 'x=1\n';
    const first = runGate(sidTrivial, patch);
    assert.equal(first.status, 0, 'main trivial patch with workers → exit 0');

    const ovAfter = readOverlay();
    const rec = ovAfter.usage_records['dispatch-worker-b'];
    assert.ok(rec, 'trivial patch records usage slice');
    assert.equal(rec.task_key, KEY_B, 'hook uses focused attribution when multi-child');
    assert.equal(rec.attributed_from, 'dispatcher');
    assert.ok(rec.dispatcher_edits.length >= 1);

    const second = runGate(sidTrivial, patch);
    assert.equal(second.status, 2, 'second trivial patch same turn → exit 2');
    assert.match(second.stderr, /trivial patch budget exhausted/);

    r = await post('/usage/dispatcher-edit', {
      parent_session: SID_DISPATCHER,
      chars: 5,
      file: 'focus-test.js',
    });
    assert.equal(r.status, 200, 'dispatcher-edit with focus → 200');
    assert.equal(r.body.task_key, KEY_B, 'focused multi-child attributes to focus target');

    r = await post('/usage/dispatcher-edit', {
      parent_session: SID_DISPATCHER,
      chars: 3,
      file: 'explicit.js',
      task_key: KEY_A,
    });
    assert.equal(r.status, 200, 'explicit task_key override → 200');
    assert.equal(r.body.task_key, KEY_A);

    assert.equal((await post('/overlay/status', { key: KEY_A, status: 'done', agent_id: 'dispatch-worker', session_id: SID_WORKER, summary: 'dm ok' })).body.ok, true);
    assert.equal((await post('/overlay/status', { key: KEY_B, status: 'done', agent_id: 'dispatch-worker-b', session_id: SID_WORKER_B, summary: 'dm ok' })).body.ok, true);
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.rmSync(WS, { recursive: true, force: true });
  }
});
