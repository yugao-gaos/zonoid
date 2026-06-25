#!/usr/bin/env node
/**
 * POST /classify endpoint — heuristic routing, model selection, ready-flag cache, injection text.
 * Spawns a sandboxed daemon on a private port. Run: node test/classify-endpoint.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { classifyHeuristic } = require('../lib/prompt-heuristic');
const { refreshReadyFlag, readyInjection, _resetForTests } = require('../lib/ready-flag-cache');
const { assembleClassifyResponse } = require('../lib/classify-assemble');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-classify-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-classify-ws-')));
const PORT = 19660 + Math.floor(Math.random() * 30);
const BASE = `http://127.0.0.1:${PORT}`;
const SID = 'classify-test-session';

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
}

async function post(p, body) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function waitForPing(ms = 12000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${BASE}/ping`);
      const j = await r.json();
      if (j && j.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  fs.mkdirSync(path.join(WS, '.graph'), { recursive: true });
  fs.writeFileSync(path.join(WS, '.graph', 'checkpoint.json'), JSON.stringify({ nodes: {}, edges: [] }));

  const child = spawn(process.execPath, ['daemon.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      ORCH_PORT: String(PORT),
      CLAUDE_PLUGIN_DATA: SANDBOX,
      ZONOID_SKIP_LIVE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    if (!(await waitForPing())) throw new Error('daemon failed to start');
    await post('/workspace', { path: WS, force: true });

    // ── ready-flag cache unit checks ────────────────────────────────────────
    _resetForTests();
    const entry = refreshReadyFlag(SID, () => [{ key: 't1', label: 'Task One' }, { key: 't2', label: 'Task Two' }]);
    ok('ready cache stores count', entry && entry.count === 2);
    ok('ready cache stores labels', entry && entry.labels.includes('Task One'));
    const inj1 = readyInjection(SID, 'hello');
    ok('ready injection first time', inj1.injected && inj1.text.includes('2 tasks ready'));
    const inj2 = readyInjection(SID, 'hello again');
    ok('ready injection suppressed while busy', !inj2.injected);
    const inj3 = readyInjection(SID, 'Autonomous loop tick');
    ok('loop tick clears busy and re-injects', inj3.injected);

    // ── POST /classify happy path ───────────────────────────────────────────
    let r = await post('/classify', { prompt: 'fix the login button color' });
    ok('classify 200', r.status === 200);
    ok('decision solo', r.body.decision === 'solo');
    ok('main_model present', typeof r.body.main_model === 'string');
    ok('context_classify nested', typeof r.body.context_classify === 'object');
    ok('additional_context has model routing', String(r.body.additional_context).includes('[Model routing]'));
    ok('additional_context has gate reminder', String(r.body.additional_context).includes('[Orch gate]'));
    ok('gate reminder points dispatcher to Subconscious assignments', String(r.body.additional_context).includes('subconscious_assignment action:"prepare"'));
    ok('additional_context has heartbeat', String(r.body.additional_context).includes('[Orchestrator heartbeat]'));

    const DISPATCHER_SID = 'classify-dispatcher-parent';
    const WORKER_SID = 'classify-dispatcher-worker';
    await post('/agent/start', { agent_id: 'classify-child', session: DISPATCHER_SID, subagent_session: WORKER_SID });
    await post('/mark-root', { task_key: 'local/classify-child-task', reason: 'classify in-flight test' });
    await post('/overlay/status', { key: 'local/classify-child-task', status: 'in_progress', agent_id: 'classify-child', session_id: WORKER_SID });
    r = await post('/classify', { prompt: 'hello dispatcher', session_id: DISPATCHER_SID });
    ok('dispatcher classify includes in-flight block', String(r.body.additional_context).includes('[In-flight workers]'));
    ok('in-flight lists worker agent', String(r.body.additional_context).includes('classify-child'));
    r = await post('/classify', { prompt: 'hello worker', session_id: WORKER_SID });
    ok('subagent classify omits in-flight block', !String(r.body.additional_context).includes('[In-flight workers]'));
    await post('/overlay/status', { key: 'local/classify-child-task', status: 'done', agent_id: 'classify-child', summary: 'classify test' });
    await post('/agent/done', { agent_id: 'classify-child' });

    r = await post('/classify', { prompt: 'keep running until all tests pass' });
    ok('loop decision', r.body.decision === 'loop');
    ok('loop steer in context', String(r.body.additional_context).includes('iterative/convergent'));

    r = await post('/classify', { prompt: 'compare redis vs postgres for caching' });
    ok('team decision', r.body.decision === 'team');

    r = await post('/classify', { prompt: 'audit every file in the codebase' });
    ok('workflow decision', r.body.decision === 'workflow');

    r = await post('/classify', {});
    ok('missing prompt 400', r.status === 400);

    r = await post('/classify', { prompt: 'hello', orch_gate_off: true });
    ok('orch_gate_off suppresses judge nudge', !String(r.body.additional_context).includes('[Judge]'));

    // assembleClassifyResponse direct
    const heur = classifyHeuristic('fix typo');
    const assembled = assembleClassifyResponse({
      prompt: 'fix typo',
      sessionId: null,
      heuristic: heur,
      contextClassify: { complexity: 0.2, gate_decision: 'abstain', rag_score: 0, dag_score: 0 },
      hasMetricSpec: false,
      readyEntry: null,
      judgePressure: null,
      labelPressure: null,
      orchGateOff: false,
    });
    ok('assembled sonnet for simple abstain', assembled.main_model === 'claude-sonnet-4-6');

    // context-classify unchanged
    r = await post('/context-classify', { prompt: 'fix the login button color' });
    ok('context-classify still works', r.status === 200 && typeof r.body.complexity === 'number');
  } finally {
    child.kill('SIGTERM');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ok */ }
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* ok */ }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
