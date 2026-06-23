#!/usr/bin/env node
// E2E: terminal /overlay/status accepts structured task_result.causal_edges, validates the
// relation/endpoints, and writes accepted edges as non-blocking context edges.
// Run: node test/causal-task-result.test.js
'use strict';
if (process.env.ZONOID_SKIP_LIVE) { console.log('SKIP  causal-task-result suite: ZONOID_SKIP_LIVE set'); process.exit(0); }
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const git = require('../lib/git');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-causal-result-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const PORT = 19170 + Math.floor(Math.random() * 200);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-causal-result-ws-')));

const SESSION = 'bbbbbbbb-caaa-0000-4000-800000000042';
const { encodeWorkspace } = require('../lib/native-tasks');
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const K = (id) => `${SESSION}/${id}`;
const taskResult = (status, summary, extra = {}) => ({
  version: 1,
  status,
  summary,
  files_changed: [],
  tests_run: 'not run',
  decisions: [],
  ...extra,
});

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
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const task = { id: String(id), subject: `causal task ${id}`, status: 'pending', blockedBy: [] };
    if (id === 8) task.blockedBy = ['7'];
    fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), JSON.stringify(task));
  }

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    ok('daemon came up', await waitForPing());
    ok('workspace pinned', (await req('POST', '/workspace', { path: WS })).status === 200);
    await req('GET', '/state');
    for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) await req('POST', '/mark-root', { workspace: WS, task_key: K(id) });

    const accepted = await req('POST', '/overlay/status', {
      key: K(3),
      status: 'tested',
      agent_id: 'causal-worker',
      summary: 'completed with causal edge',
      task_result: taskResult('tested', 'completed with causal edge', {
        causal_edges: [
          { from: K(1), to: K(2), relation: 'fixed', confidence: 0.8, evidence: 'unit regression passed' },
        ],
      }),
    });
    ok('valid causal_edges accepted on terminal status', accepted.status === 200 && accepted.body.ok === true);

    const state = await req('GET', `/state?workspace=${encodeURIComponent(WS)}`);
    const edge = (state.body.edges || []).find((e) => e.from === K(1) && e.to === K(2));
    ok('causal edge written as context edge', edge && edge.kind === 'context');
    ok('causal edge keeps relation and origin', edge && edge.relation === 'fixed' && edge.origin === 'task-result-causal');
    ok('causal edge keeps confidence and evidence', edge && edge.confidence === 0.8 && edge.evidence === 'unit regression passed');

    const beforeCollision = await req('GET', `/state?workspace=${encodeURIComponent(WS)}`);
    const preBlocking = (beforeCollision.body.edges || []).find((e) => e.from === K(7) && e.to === K(8) && (!e.kind || e.kind === 'blocking'));
    ok('native blockedBy edge present before causal collision', !!preBlocking);

    const collision = await req('POST', '/overlay/status', {
      key: K(9),
      status: 'tested',
      agent_id: 'causal-worker',
      summary: 'completed with causal edge matching blocking edge',
      task_result: taskResult('tested', 'completed with causal edge matching blocking edge', {
        causal_edges: [
          { from: K(7), to: K(8), relation: 'supports', confidence: 0.7, evidence: 'dependency informed the fix' },
        ],
      }),
    });
    ok('causal edge sharing blocking endpoints accepted', collision.status === 200 && collision.body.ok === true);

    const afterCollision = await req('GET', `/state?workspace=${encodeURIComponent(WS)}`);
    const collidingEdges = (afterCollision.body.edges || []).filter((e) => e.from === K(7) && e.to === K(8));
    const blockingEdge = collidingEdges.find((e) => !e.kind || e.kind === 'blocking');
    const causalEdge = collidingEdges.find((e) => e.kind === 'context' && e.origin === 'task-result-causal');
    ok('blocking dependency remains blocking after same-endpoint causal edge', !!blockingEdge);
    ok('same-endpoint causal evidence is preserved as context', causalEdge && causalEdge.relation === 'supports' && causalEdge.confidence === 0.7 && causalEdge.evidence === 'dependency informed the fix');

    const badRelation = await req('POST', '/overlay/status', {
      key: K(4),
      status: 'tested',
      agent_id: 'causal-worker',
      task_result: taskResult('tested', 'bad relation', {
        causal_edges: [{ from: K(1), to: K(2), relation: 'related_to' }],
      }),
    });
    ok('invalid causal relation rejected', badRelation.status === 409 && badRelation.body.field === 'causal_edges[0].relation');

    const unknownEndpoint = await req('POST', '/overlay/status', {
      key: K(5),
      status: 'tested',
      agent_id: 'causal-worker',
      task_result: taskResult('tested', 'unknown endpoint', {
        causal_edges: [{ from: K(1), to: K(999), relation: 'supports' }],
      }),
    });
    ok('unknown causal endpoint rejected', unknownEndpoint.status === 404 && unknownEndpoint.body.field === 'causal_edges[0].to');

    const extraField = await req('POST', '/overlay/status', {
      key: K(6),
      status: 'tested',
      agent_id: 'causal-worker',
      task_result: taskResult('tested', 'extra field still rejected', { causal_edges: [], surprise: true }),
    });
    ok('task_result still rejects extra fields while allowing causal_edges', extraField.status === 409 && Array.isArray(extraField.body.extra) && extraField.body.extra.includes('surprise'));
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
