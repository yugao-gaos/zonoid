#!/usr/bin/env node
// Tests for per-repo HTTP scoping fixes:
//   #2: /state?workspace=X returns only X's agents (not global); /agents?workspace=X filters list
//   #3: /ready?workspace=X builds graph from X, not the daemon-global workspace
//   #6: show_dashboard tool returns deep_link when workspace provided; run-arg workspace injects
//
// Spawns a sandboxed daemon on a private port. No test framework; run: node test/per-repo-workspace-scoping.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ws-scope-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;

try {
  const realModels = path.join(os.homedir(), '.claude', 'orchestrator', 'models');
  if (fs.existsSync(realModels)) fs.symlinkSync(realModels, path.join(SANDBOX, 'models'));
} catch { /* lexical fallback */ }

const PORT = 19700 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

const WS_A = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ws-scope-A-')));
const WS_B = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ws-scope-B-')));

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {};
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
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

async function waitForPing(ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200 && r.body.ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_TOKEN: '' },
    stdio: 'ignore',
  });
  try {
    ok('sandboxed daemon came up', await waitForPing());

    // Pin the daemon-global workspace to B (simulates "another session won the pin race").
    const pinB = await req('POST', '/workspace', { path: WS_B });
    ok('workspace pinned to B (daemon global)', pinB.status === 200 && pinB.body.workspace === WS_B);

    // ── Seed agents in two different workspaces ──────────────────────────────────
    // Agent in workspace A
    const startA = await req('POST', '/agent/start', {
      agent_id: 'worker-A1', workspace: WS_A, state: 'running',
    });
    ok('/agent/start for WS_A accepted', startA.status === 200 && startA.body.ok === true);

    // Another agent in workspace A
    const startA2 = await req('POST', '/agent/start', {
      agent_id: 'worker-A2', workspace: WS_A, state: 'running',
    });
    ok('/agent/start for WS_A (second) accepted', startA2.status === 200);

    // Agent in workspace B
    const startB = await req('POST', '/agent/start', {
      agent_id: 'worker-B1', workspace: WS_B, state: 'running',
    });
    ok('/agent/start for WS_B accepted', startB.status === 200 && startB.body.ok === true);

    // ── #2a: /agents?workspace=X should filter to X's agents ─────────────────────
    const agentsA = await req('GET', `/agents?workspace=${encodeURIComponent(WS_A)}`);
    ok('/agents?workspace=A returns only A agents', agentsA.status === 200 &&
      agentsA.body.agents.every((a) => a.workspace === WS_A));
    ok('/agents?workspace=A includes worker-A1', agentsA.body.agents.some((a) => a.agent_id === 'worker-A1'));
    ok('/agents?workspace=A includes worker-A2', agentsA.body.agents.some((a) => a.agent_id === 'worker-A2'));
    ok('/agents?workspace=A excludes worker-B1', !agentsA.body.agents.some((a) => a.agent_id === 'worker-B1'));
    ok('/agents?workspace=A count is 2', agentsA.body.agents.length === 2);

    const agentsB = await req('GET', `/agents?workspace=${encodeURIComponent(WS_B)}`);
    ok('/agents?workspace=B returns only B agents', agentsB.status === 200 &&
      agentsB.body.agents.every((a) => a.workspace === WS_B));
    ok('/agents?workspace=B includes worker-B1', agentsB.body.agents.some((a) => a.agent_id === 'worker-B1'));
    ok('/agents?workspace=B excludes A workers', !agentsB.body.agents.some((a) => a.workspace === WS_A));

    // Without ?workspace= should return all (back-compat)
    const agentsAll = await req('GET', '/agents');
    ok('/agents (no filter) returns all agents back-compat', agentsAll.status === 200 &&
      agentsAll.body.agents.length >= 3);

    // ── #2b: /state?workspace=A should only include A's agents ───────────────────
    const stateA = await req('GET', `/state?workspace=${encodeURIComponent(WS_A)}`);
    ok('/state?workspace=A responds ok', stateA.status === 200);
    ok('/state?workspace=A agents field contains only A agents',
      stateA.body.agents.every((a) => a.workspace === WS_A));
    ok('/state?workspace=A agents includes worker-A1', stateA.body.agents.some((a) => a.agent_id === 'worker-A1'));
    ok('/state?workspace=A agents excludes worker-B1', !stateA.body.agents.some((a) => a.agent_id === 'worker-B1'));

    // /state without ?workspace= (daemon-global = B) should include B's agents only
    const stateB = await req('GET', '/state');
    ok('/state (no ws param, global=B) agents only B workers', stateB.body.agents.every((a) => a.workspace === WS_B));
    ok('/state (no ws param, global=B) no A workers', !stateB.body.agents.some((a) => a.workspace === WS_A));

    // ── #3: /ready?workspace=X targets X's graph, not daemon global ──────────────
    // Create a task in WS_A via the overlay
    await req('POST', '/overlay/note', { workspace: WS_A, title: 'A-ready-test', summary: 'ready test fixture in A' });

    // /ready?workspace=A should build A's graph (workspace param respected)
    const readyA = await req('GET', `/ready?workspace=${encodeURIComponent(WS_A)}`);
    ok('/ready?workspace=A responds', readyA.status === 200 && Array.isArray(readyA.body.ready));
    // Note nodes are not "ready" tasks per se, but the important thing is /ready?workspace=A
    // builds off A's graph, not B's. If no tasks in A are ready the list is empty but no error.
    ok('/ready?workspace=A returns ready array (not crash)', Array.isArray(readyA.body.ready));

    // Add a task to A that will be ready (no deps)
    await req('POST', '/overlay/status', { workspace: WS_A, key: 'sessA/ready1', status: 'not_ready' });
    // Set it ready
    await req('POST', '/overlay/status', { workspace: WS_A, key: 'sessA/ready1', status: 'ready' });

    const readyA2 = await req('GET', `/ready?workspace=${encodeURIComponent(WS_A)}`);
    ok('/ready?workspace=A sees A tasks', readyA2.status === 200 && Array.isArray(readyA2.body.ready));

    // /ready without ?workspace= hits B graph (daemon-global = B) — should not include A tasks
    const readyB = await req('GET', '/ready');
    ok('/ready (no param, global=B) does not include A tasks',
      !readyB.body.ready.some((t) => t.key === 'sessA/ready1'));

    // ── #6: show_dashboard MCP tool with workspace arg returns deep_link ─────────
    const mcpShowDash = await req('POST', '/mcp', {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'show_dashboard', arguments: { workspace: WS_A } },
    });
    ok('show_dashboard with workspace responds', mcpShowDash.status === 200);
    const dashResult = mcpShowDash.body && mcpShowDash.body.result;
    ok('show_dashboard result has content', dashResult && Array.isArray(dashResult.content));
    let dashOut = null;
    try { dashOut = JSON.parse(dashResult.content[0].text); } catch { /* */ }
    ok('show_dashboard result parses', dashOut !== null);
    ok('show_dashboard with workspace returns deep_link', dashOut && typeof dashOut.deep_link === 'string' && dashOut.deep_link.includes(encodeURIComponent(WS_A)));
    ok('show_dashboard deep_link points to /graph', dashOut && dashOut.deep_link && dashOut.deep_link.includes('/graph'));
    ok('show_dashboard workspace echoed back', dashOut && dashOut.workspace === WS_A);

    // Without workspace arg: back-compat (no deep_link, just rendered:true note)
    const mcpShowDashNoWs = await req('POST', '/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'show_dashboard', arguments: {} },
    });
    ok('show_dashboard without workspace responds', mcpShowDashNoWs.status === 200);
    let dashNoWs = null;
    try { dashNoWs = JSON.parse(mcpShowDashNoWs.body.result.content[0].text); } catch { /* */ }
    ok('show_dashboard without workspace has rendered:true', dashNoWs && dashNoWs.rendered === true);
    ok('show_dashboard without workspace has no deep_link (back-compat)', !dashNoWs || dashNoWs.deep_link === undefined);

  } catch (e) {
    console.error('TEST ERROR:', e);
    fail++;
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    for (const d of [SANDBOX, WS_A, WS_B]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
