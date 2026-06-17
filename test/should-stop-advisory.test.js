/**
 * P3-B4: should_stop advisory in MCP tool responses.
 * When a tools/call carries agent_id and that agent has stop_requested set, the MCP result
 * includes should_stop:true + reason WITHOUT blocking the call (orch-stop.sh advisory in-band).
 * Run: node test/should-stop-advisory.test.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { handleRpc, makeCall } = require('../lib/mcp-core');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stop-adv-base-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-stop-adv-ws-')));
const PORT = 19650 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = 'adv-worker';
const TASK = 'local/stop-adv';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// P3: ops require an explicit workspace (no daemon-global default). Single-workspace suite ⇒
// default WS into POST bodies and GET query strings (skip /workspace, /ping, explicit workspace).
async function post(p, body) {
  const payload = (p === '/workspace' || (body && body.workspace)) ? body : { ...(body || {}), workspace: WS };
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

function withWs(p) {
  if (p.startsWith('/ping') || p.includes('workspace=')) return p;
  return p + (p.includes('?') ? '&' : '?') + 'workspace=' + encodeURIComponent(WS);
}

async function get(p) {
  const res = await fetch(`${BASE}${withWs(p)}`);
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

async function mcpTool(name, args, session) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers['mcp-session-id'] = session;
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name, arguments: args || {} } }),
  });
  return { status: res.status, body: await res.json() };
}

(async () => {
  fs.mkdirSync(path.join(WS, 'tasks', 'zonoid-stop-adv', 'local'), { recursive: true });
  fs.writeFileSync(path.join(WS, 'tasks', 'zonoid-stop-adv', 'local', 'stop-adv.json'), JSON.stringify({
    id: 'stop-adv', subject: 'stop advisory probe', status: 'pending', blockedBy: [],
  }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_TOKEN: '' },
    stdio: 'ignore',
  });

  try {
    ok('daemon up', await waitForPing());
    ok('workspace pinned', (await post('/workspace', { path: WS })).body.ok === true);
    ok('task marked root', (await post('/mark-root', { task_key: TASK })).body.ok === true);

    // DG1/DG2 claim gate: a start_task claim needs a registered worktree (branch_task) + a session.
    // branch_task auto-inits the repo and registers the worktree; the mcp-session-id header feeds
    // ctx.session, which start_task uses as the claim session_id (mcp-core fallback).
    const WSID = 'stop-adv-worker-sid';
    ok('branch_task registers worktree', (await mcpTool('branch_task', { task_key: TASK }, WSID)).status === 200);

    let r = await mcpTool('start_task', { task_key: TASK, agent_id: AGENT }, WSID);
    ok('clean call has no should_stop', r.body.result && r.body.result.should_stop !== true);
    ok('clean call still executes', JSON.parse(r.body.result.content[0].text).ok === true);

    ok('stop flag set', (await post('/agent/stop', { agent_id: AGENT })).body.ok === true);
    r = await mcpTool('start_task', { task_key: TASK, agent_id: AGENT }, WSID);
    ok('flagged agent gets should_stop', r.body.result && r.body.result.should_stop === true);
    ok('reason is stop_requested', r.body.result && r.body.result.reason === 'stop_requested');
    ok('call not blocked (re-claim ok)', JSON.parse(r.body.result.content[0].text).ok === true);

    r = await mcpTool('list_agents', {});
    ok('no agent_id means no should_stop', r.body.result && r.body.result.should_stop !== true);

    const call = makeCall(PORT, WS);
    const direct = await handleRpc(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'start_task', arguments: { task_key: TASK, agent_id: AGENT } } },
      { call, session: null },
    );
    ok('handleRpc direct path surfaces advisory', direct.result.should_stop === true);
    ok('handleRpc direct path reason', direct.result.reason === 'stop_requested');
  } catch (e) {
    console.error('TEST ERROR:', e);
    fail++;
  } finally {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    for (const d of [SANDBOX, WS]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
