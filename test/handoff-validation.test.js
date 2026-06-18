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
    let pathWithWorkspace = p;
    const needsWorkspace = p !== '/ping' && p !== '/workspace' && !p.startsWith('/mcp');
    if (needsWorkspace && method === 'GET' && !/[?&]workspace=/.test(p)) {
      pathWithWorkspace += (p.includes('?') ? '&' : '?') + `workspace=${encodeURIComponent(WS)}`;
    }
    const payload = needsWorkspace && body && !body.workspace ? { ...body, workspace: WS } : body;
    const data = payload ? JSON.stringify(payload) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathWithWorkspace, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch { resolve({ status: res.statusCode, body: {} }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function mcpTool(name, args) {
  const data = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name, arguments: args || {} } });
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/mcp',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
        'x-orch-workspace': WS,
        'mcp-session-id': SESSION,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch { resolve({ status: res.statusCode, body: {} }); } });
    });
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

function mcpPayload(resp) {
  const txt = resp && resp.body && resp.body.result && resp.body.result.content && resp.body.result.content[0] && resp.body.result.content[0].text;
  try { return JSON.parse(txt || '{}'); } catch { return {}; }
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
  // Extra metric-carrying tasks for the additional level-1 gap assertions below (failed/canceled
  // terminal statuses, empty-vs-absent measurements, non-terminal scoping, guardrails-only).
  for (const id of [4, 5, 6, 7, 8, 9]) fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), JSON.stringify({ id: String(id), subject: `metric handoff gap ${id}`, status: 'pending' }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    ok('daemon came up', await waitForPing());
    ok('workspace pinned', (await req('POST', '/workspace', { path: WS })).status === 200);
    await req('GET', '/state');

    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await req('POST', '/mark-root', { task_key: K(id) });

    // Tasks 1, 2, and 4-8 carry a metric spec; task 3 does not.
    ok('metric spec set on task 1', (await req('POST', '/task/metric', { key: K(1), spec: METRIC })).status === 200);
    ok('metric spec set on task 2', (await req('POST', '/task/metric', { key: K(2), spec: METRIC })).status === 200);
    for (const id of [4, 5, 6, 7, 8, 9]) await req('POST', '/task/metric', { key: K(id), spec: METRIC });

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

    // ===================================================================================
    // ADDED LEVEL-1 GAPS (T4): the gate fires on ALL terminal statuses + distinguishes
    // empty-vs-absent measurements + is scoped to terminal only. T2 covered the four core
    // paths above with status='tested' and an absent measurements field; these widen that.
    // ===================================================================================

    // --- Other terminal status `failed`: metric task + incomplete task_result → 409 ---
    // The gate keys off newlyReady.isTerminalStatus, which includes failed — not just tested.
    const rFailed = await req('POST', '/overlay/status', {
      key: K(4), status: 'failed', agent_id: 'a4',
      task_result: { status: 'failed', summary: 'could not measure' },
    });
    ok('metric task + terminal=failed + incomplete task_result refused 409', rFailed.status === 409 && rFailed.body.missing === 'metric_measurements');

    // --- Other terminal status `canceled`: metric task + incomplete task_result → 409 ---
    const rCanceled = await req('POST', '/overlay/status', {
      key: K(5), status: 'canceled', agent_id: 'a5',
      task_result: { status: 'failed', summary: 'abandoned' },
    });
    ok('metric task + terminal=canceled + incomplete task_result refused 409', rCanceled.status === 409 && rCanceled.body.missing === 'metric_measurements');

    // --- Empty (not absent) measurements: metric_measurements:{} → still 409 ---
    // The handler checks Object.keys(mm).length>0, so an empty object is as incomplete as absent.
    const rEmptyObj = await req('POST', '/overlay/status', {
      key: K(6), status: 'tested', agent_id: 'a6',
      task_result: { status: 'tested', summary: 'empty measures', metric_measurements: {} },
    });
    ok('metric task + EMPTY metric_measurements object refused 409', rEmptyObj.status === 409 && rEmptyObj.body.missing === 'metric_measurements');

    // --- Empty array measurements: metric_measurements:[] → still 409 (array branch of the check) ---
    const rEmptyArr = await req('POST', '/overlay/status', {
      key: K(7), status: 'tested', agent_id: 'a7',
      task_result: { status: 'tested', summary: 'empty array measures', metric_measurements: [] },
    });
    ok('metric task + EMPTY metric_measurements array refused 409', rEmptyArr.status === 409 && rEmptyArr.body.missing === 'metric_measurements');

    // --- Scope to terminal: NON-terminal (in_progress) + incomplete task_result → the handoff gate
    // never runs (it is gated on newlyReady.isTerminalStatus). Asserted on the NON-metric task 3 so
    // the metric-mode branch-check arm (overlay.js — metric task must be on orch/attempt/* to claim)
    // does not confound the result: any non-200 here would then be that arm, not the handoff gate.
    // A worktree is registered first so the self-register-on-claim path admits the hook-less claim.
    const wt3 = await req('POST', '/git/worktree', { key: K(3) });
    ok('worktree registered for non-terminal scope check', wt3.status === 200);
    const rInProgress = await req('POST', '/overlay/status', {
      key: K(3), status: 'in_progress', agent_id: 'a3', session_id: SESSION, workspace: WS,
      task_result: { status: 'tested', summary: 'mid-flight, no measures yet' },
    });
    ok('NON-terminal status + structured task_result not refused by handoff gate (gate is terminal-only)', rInProgress.status === 200 && rInProgress.body.ok === true);

    // --- Positive: guardrails-shaped measurements count as present → 200 ---
    // mm carrying value + guardrails is non-empty under the Object.keys check, so it passes the gate
    // (schema-shape validation of value/guardrails is the schema's job, not this 409 completeness gate).
    const rGuard = await req('POST', '/overlay/status', {
      key: K(8), status: 'tested', agent_id: 'a8',
      task_result: { status: 'tested', summary: 'measured', metric_measurements: { value: 2, guardrails: { latency: 5 } } },
    });
    ok('metric task + complete metric_measurements (value+guardrails) accepted', rGuard.status === 200 && rGuard.body.ok === true);

    // --- MCP pass-through: complete_task must forward task_result into the same daemon gate. ---
    const mcpIncomplete = await mcpTool('complete_task', {
      task_key: K(9),
      summary: 'mcp incomplete result',
      agent_id: 'a9',
      task_result: { status: 'tested', summary: 'missing measurements' },
    });
    const mcpOut = mcpPayload(mcpIncomplete);
    ok('MCP complete_task forwards task_result to handoff gate', mcpIncomplete.status === 200 && mcpIncomplete.body.result && mcpIncomplete.body.result.isError === true && mcpOut.missing === 'metric_measurements');
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
