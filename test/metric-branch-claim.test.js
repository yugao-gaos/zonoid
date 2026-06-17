#!/usr/bin/env node
// E2E: /overlay/status (start_task) refuses in_progress claims on metric-spec tasks unless the
// Claim workspace is on an orch/attempt/* branch — mirrors hook worktree-confinement behavior.
// Run: node test/metric-branch-claim.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const git = require('../lib/git');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-metric-claim-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const PORT = 18970 + Math.floor(Math.random() * 200);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-metric-claim-ws-')));

const SESSION = 'aaaaaaaa-feedface-0000-4000-800000000002';
const { encodeWorkspace } = require('../lib/native-tasks');
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const K = (id) => `${SESSION}/${id}`;
const METRIC = { metric: 'score', direction: 'max', measure_command: 'echo 1' };
// The DG1/DG2 claim gate (subagent + registered worktree + session_id) runs BEFORE the
// metric-branch invariant, so the worker registers as a subagent and supplies a worktree + SID;
// only then does the claim reach the metric-branch check this test exercises.
const WORKER_SID = 'metric-worker-sid';

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
  fs.writeFileSync(path.join(TASKS_DIR, '1.json'), JSON.stringify({ id: '1', subject: 'metric claim guard alpha', status: 'pending' }));
  fs.writeFileSync(path.join(TASKS_DIR, '2.json'), JSON.stringify({ id: '2', subject: 'plain claim guard beta', status: 'pending' }));

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

    const setMetric = await req('POST', '/task/metric', { key: K(1), spec: METRIC });
    ok('metric spec set on task 1', setMetric.status === 200 && setMetric.body.ok === true);

    // Register the claiming worker as a subagent (DG1/DG2 gate arm a). K(2) (no metric) gets a
    // worktree on WS so its plain claim can land. K(1)'s metric claim is exercised from its OWN
    // attempt worktree below.
    await req('POST', '/agent/start', { workspace: WS, agent_id: 'test-agent', session: 'disp-sid', subagent_session: WORKER_SID });
    await req('POST', '/git/worktree', { workspace: WS, key: K(2), repo_path: WS });

    // K(1) on the MAIN-branch workspace, with NO worktree registered: the claim is refused 409 and
    // the message names branch_task (both the worktree-precondition 409 and the metric-branch 409
    // tell the worker to call branch_task first — either satisfies this assertion).
    const badClaim = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'test-agent', session_id: WORKER_SID, workspace: WS });
    ok('metric task claim on main branch refused 409', badClaim.status === 409);
    ok('409 names branch_task', /branch_task/.test(String(badClaim.body.error)));

    // The daemon creates the attempt worktree (on orch/attempt/*) AND registers it in the WORKTREE
    // overlay's git[K(1)]; mirror the metric spec + root there so the claim reaches (and passes) the
    // metric-branch invariant — git.currentBranch(worktree) is the attempt branch.
    const wt = (await req('POST', '/git/worktree', { workspace: WS, key: K(1), repo_path: WS })).body;
    ok('attempt worktree created', String(wt.branch).startsWith('orch/attempt/'));
    await req('POST', '/task/metric', { workspace: wt.worktree, key: K(1), spec: METRIC });
    await req('POST', '/git/worktree', { workspace: wt.worktree, key: K(1), repo_path: WS });
    await req('POST', '/mark-root', { workspace: wt.worktree, task_key: K(1), reason: 'metric claim worktree root' });
    const goodClaim = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'test-agent', session_id: WORKER_SID, workspace: wt.worktree });
    ok('metric task claim from attempt worktree succeeds', goodClaim.status === 200 && goodClaim.body.ok === true);

    const plainClaim = await req('POST', '/overlay/status', { key: K(2), status: 'in_progress', agent_id: 'test-agent', session_id: WORKER_SID, workspace: WS });
    ok('task without metric claims on main branch', plainClaim.status === 200 && plainClaim.body.ok === true);
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
