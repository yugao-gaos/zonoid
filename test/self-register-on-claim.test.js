#!/usr/bin/env node
// E2E: /overlay/status (start_task) self-register-on-claim fallback.
// The SubagentStart hook does NOT fire for run_in_background Agent-tool spawns (note-mqed9vz7vr9),
// so such a worker never carries agent_tool_spawn:true and the isSubagent check is false for it.
// The fallback: a claim bearing an agent_id AND backed by a registered worktree (branch_task was
// called — the dispatcher never does that) is a legitimate hook-less worker → register + allow.
// A claim with NO worktree is still refused (the worktree stays the security boundary).
// Run: node test/self-register-on-claim.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const git = require('../lib/git');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-selfreg-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const PORT = 19170 + Math.floor(Math.random() * 200);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-selfreg-ws-')));

const SESSION = 'aaaaaaaa-feedface-0000-4000-800000000003';
const { encodeWorkspace } = require('../lib/native-tasks');
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const K = (id) => `${SESSION}/${id}`;

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch { resolve({ status: res.statusCode, body: {} }); } });
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

(async () => {
  git.initRepo(WS);
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, `${SESSION}.jsonl`), '');
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TASKS_DIR, '1.json'), JSON.stringify({ id: '1', subject: 'hookless worker claim alpha', status: 'pending' }));
  fs.writeFileSync(path.join(TASKS_DIR, '2.json'), JSON.stringify({ id: '2', subject: 'no worktree claim beta', status: 'pending' }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    ok('daemon came up', await waitForPing());
    ok('workspace pinned', (await req('POST', '/workspace', { path: WS })).status === 200);
    await req('GET', '/state');

    const mr1 = await req('POST', '/mark-root', { task_key: K(1) });
    const mr2 = await req('POST', '/mark-root', { task_key: K(2) });
    ok('roots declared', mr1.status === 200 && mr2.status === 200);

    // No /agent/start is ever called — these agents are hook-less, exactly like a real
    // run_in_background Agent-tool spawn (agent_tool_spawn never set → isSubagent is false).

    // Claim WITHOUT a worktree → refused, and the message points to branch_task.
    const noWt = await req('POST', '/overlay/status', { key: K(2), status: 'in_progress', agent_id: 'hookless-worker', session_id: SESSION, workspace: WS });
    ok('hook-less claim with NO worktree refused 409', noWt.status === 409);
    ok('409 points to branch_task', /branch_task/.test(String(noWt.body.error)));

    // Branch a worktree (proof of delegation) via the real branch_task endpoint, which registers
    // it in overlay.git — then claim → self-register-on-claim allows it.
    const wt = await req('POST', '/git/worktree', { key: K(1) });
    ok('attempt worktree created + registered', wt.status === 200 && String(wt.body.branch).startsWith('orch/attempt/'));
    // Claim carries the session workspace (main repo), exactly as the start_task MCP tool does —
    // the overlay (and its git registration) is keyed on the repo, not the worktree path.
    const claim = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'hookless-worker', session_id: SESSION, workspace: WS });
    ok('hook-less claim WITH worktree self-registers and succeeds', claim.status === 200 && claim.body.ok === true);

    // The claim bound the assignee to this worker (proves it took effect end-to-end): the same
    // worker can re-claim its own in_progress task without the "already claimed by another" 409.
    const reclaim = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'hookless-worker', session_id: SESSION, workspace: WS });
    ok('worker owns its task — idempotent re-claim by same agent succeeds', reclaim.status === 200 && reclaim.body.ok === true);
    // And a DIFFERENT agent cannot steal the in_progress task without force (boundary intact).
    const steal = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'other-worker', session_id: SESSION, workspace: WS });
    ok('different agent cannot steal the claim without force', steal.status === 409);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    fs.rmSync(TASKS_DIR, { recursive: true, force: true });
    fs.rmSync(PROJ_DIR, { recursive: true, force: true });
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.rmSync(WS, { recursive: true, force: true });
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
