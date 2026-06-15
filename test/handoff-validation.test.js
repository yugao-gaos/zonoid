#!/usr/bin/env node
// E2E: /overlay/status (complete_task) refuses a TERMINAL status when the caller sends a structured
// task_result that is INCOMPLETE — specifically a metric-carrying task (overlay.metrics[key]) that
// reports no metric_measurements. Mirrors the metric-branch invariant 409 (T2). Gating:
//   (1) opt-in   — only enforced when a structured task_result object is present;
//   (2) scoped   — only when the task carries a metric spec.
// Legacy free-string complete_task (no task_result) and non-metric tasks pass through untouched.
// Run: node test/handoff-validation.test.js
'use strict';
if (process.env.ZONOID_SKIP_LIVE) { console.log('SKIP  handoff-validation suite: ZONOID_SKIP_LIVE set'); process.exit(0); }
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const git = require('../lib/git');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-handoff-val-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const PORT = 19170 + Math.floor(Math.random() * 200);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-handoff-val-ws-')));

const SESSION = 'aaaaaaaa-feedface-0000-4000-800000000042';
const { encodeWorkspace } = require('../lib/native-tasks');
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const K = (id) => `${SESSION}/${id}`;
const METRIC = { metric: 'score', direction: 'max', measure_command: 'echo 1' };

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
  fs.writeFileSync(path.join(TASKS_DIR, '1.json'), JSON.stringify({ id: '1', subject: 'metric handoff alpha', status: 'pending' }));
  fs.writeFileSync(path.join(TASKS_DIR, '2.json'), JSON.stringify({ id: '2', subject: 'metric handoff legacy beta', status: 'pending' }));
  fs.writeFileSync(path.join(TASKS_DIR, '3.json'), JSON.stringify({ id: '3', subject: 'plain handoff gamma', status: 'pending' }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    ok('daemon came up', await waitForPing());
    ok('workspace pinned', (await req('POST', '/workspace', { path: WS })).status === 200);
    await req('GET', '/state');

    for (const id of [1, 2, 3]) await req('POST', '/mark-root', { task_key: K(id) });

    // Tasks 1 and 2 carry a metric spec; task 3 does not.
    ok('metric spec set on task 1', (await req('POST', '/task/metric', { key: K(1), spec: METRIC })).status === 200);
    ok('metric spec set on task 2', (await req('POST', '/task/metric', { key: K(2), spec: METRIC })).status === 200);

    // --- Refusal: metric task + structured task_result WITHOUT metric_measurements → 409 ---
    const r1 = await req('POST', '/overlay/status', {
      key: K(1), status: 'tested', agent_id: 'a1',
      task_result: { status: 'tested', summary: 'did the thing', files_changed: ['x.js'] },
    });
    ok('metric task + incomplete task_result refused 409', r1.status === 409);
    ok('409 names metric_measurements', r1.body.missing === 'metric_measurements');

    // --- Pass: metric task + structured task_result WITH metric_measurements → 200 ---
    const r2 = await req('POST', '/overlay/status', {
      key: K(1), status: 'tested', agent_id: 'a1',
      task_result: { status: 'tested', summary: 'measured', metric_measurements: { score: 1 } },
    });
    ok('metric task + complete task_result accepted', r2.status === 200 && r2.body.ok === true);

    // --- Back-compat: metric task + LEGACY free-string summary (no task_result) → 200 ---
    const r3 = await req('POST', '/overlay/status', { key: K(2), status: 'tested', agent_id: 'a2', summary: 'legacy free string' });
    ok('metric task + legacy free-string summary still accepted (no hard break)', r3.status === 200 && r3.body.ok === true);

    // --- Scope: NON-metric task + structured task_result without measurements → 200 (not refused) ---
    const r4 = await req('POST', '/overlay/status', {
      key: K(3), status: 'tested', agent_id: 'a3',
      task_result: { status: 'tested', summary: 'no metric here' },
    });
    ok('non-metric task + incomplete task_result not refused', r4.status === 200 && r4.body.ok === true);
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
