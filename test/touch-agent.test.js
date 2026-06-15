#!/usr/bin/env node
// P3-B1: start_task auto-register + heartbeat stamping (touchAgent).
//   - Unknown agents auto-register (state running, startedAt/lastSeen now) on agent_id POSTs
//   - Mutating routes carrying agent_id stamp lastSeen (readBody hook)
//   - Idempotent with /agent/start (SubagentStart hook) — double touch safe
// Run: node test/touch-agent.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const git = require('../lib/git');
const { touchAgent, __setAgentsForTest, __getAgentsForTest } = require('../daemon.js');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

// ── Unit: touchAgent register + heartbeat ────────────────────────────────────
{
  __setAgentsForTest({});
  touchAgent('foreign-worker', { status: 'in_progress', task_key: 'local/b1', workspace: '/tmp/ws' });
  const a = __getAgentsForTest()['foreign-worker'];
  ok('unknown agent auto-registers', !!a);
  ok('state running on claim', a && a.state === 'running');
  ok('startedAt set', a && typeof a.startedAt === 'string' && a.startedAt.length > 10);
  ok('lastSeen set', a && typeof a.lastSeen === 'string' && a.lastSeen.length > 10);
  ok('task_key recorded', a && a.task === 'local/b1');
  ok('workspace recorded', a && a.workspace === '/tmp/ws');
  ok('endedAt null while running', a && a.endedAt === null);

  const startedAt = a.startedAt;
  touchAgent('foreign-worker', { status: 'done' });
  const done = __getAgentsForTest()['foreign-worker'];
  ok('terminal status → done', done && done.state === 'done');
  ok('startedAt preserved', done && done.startedAt === startedAt);
  ok('endedAt set on done', done && typeof done.endedAt === 'string');
}


// ── Unit: subagent_session must not equal parent session ─────────────────────
{
  __setAgentsForTest({});
  touchAgent('eq-sess-worker', { state: 'running', session: 'parent-sid', subagent_session: 'parent-sid' });
  const a = __getAgentsForTest()['eq-sess-worker'];
  ok('subagent_session equals session stored as null', a && a.subagent_session === null);
}

// ── Unit: agent_tool_spawn persists through touchAgent (gate arm (b) input) ───
// Regression: touchAgent rebuilt the record and silently dropped agent_tool_spawn,
// so the overlay claim gate arm (b) (a.agent_tool_spawn && a.agent_id === b.agent_id)
// could never match a legit Agent-tool spawn inheriting the dispatcher session.
{
  __setAgentsForTest({});
  touchAgent('spawn-worker', { state: 'running', agent_tool_spawn: true, session: 'dispatcher-sid' });
  const a = __getAgentsForTest()['spawn-worker'];
  ok('agent_tool_spawn:true persisted', a && a.agent_tool_spawn === true);

  // Preserved across a later touch that does not re-supply the field.
  touchAgent('spawn-worker', { status: 'in_progress' });
  const a2 = __getAgentsForTest()['spawn-worker'];
  ok('agent_tool_spawn preserved across touch', a2 && a2.agent_tool_spawn === true);

  // Absent => null, never undefined (a non-spawn worker stays falsy for the gate).
  __setAgentsForTest({});
  touchAgent('plain-worker', { state: 'running', session: 'sess-x' });
  const p = __getAgentsForTest()['plain-worker'];
  ok('agent_tool_spawn null when absent', p && p.agent_tool_spawn === null);
}

// ── Unit: idempotent with hook path (/agent/start semantics) ─────────────────
{
  __setAgentsForTest({});
  touchAgent('hook-worker', { state: 'running', agent_type: 'agent', task: 't/1', session: 'sess-a' });
  const first = __getAgentsForTest()['hook-worker'];
  touchAgent('hook-worker', { status: 'in_progress', task_key: 't/1' });
  const second = __getAgentsForTest()['hook-worker'];
  ok('double touch keeps one record', Object.keys(__getAgentsForTest()).length === 1);
  ok('startedAt preserved across double touch', second.startedAt === first.startedAt);
  ok('still running after in_progress touch', second.state === 'running');
  ok('session preserved', second.session === 'sess-a');
}

// ── Integration: sandboxed daemon stamps via mutating POSTs ──────────────────
(async () => {
  const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-touch-agent-')));
  const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-touch-ws-')));
  // WS must be a git repo: the start_task claim gate requires a registered worktree
  // (subagents branch_task before claiming), so probe tasks claim from an attempt worktree.
  git.initRepo(WS);
  const PORT = 19850 + Math.floor(Math.random() * 100);
  const readAgentsFile = () => JSON.parse(fs.readFileSync(path.join(SANDBOX, 'agents.json'), 'utf8'));

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
      try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* not up */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_TOKEN: '' },
    stdio: 'ignore',
  });

  try {
    ok('daemon up', await waitForPing());
    ok('workspace pin', (await req('POST', '/workspace', { path: WS })).body.ok === true);

    // Wire a task so start_task claim succeeds (unwired quarantine would 409 otherwise).
    await req('POST', '/overlay/edge', { workspace: WS, from: 'local/root', to: 'local/touch-probe', kind: 'blocking' });
    await req('POST', '/overlay/status', { workspace: WS, key: 'local/touch-probe', status: 'ready' });
    // Register as a standard subagent (distinct subagent_session) + attempt worktree, so the
    // claim gate (arm a + worktree precondition) accepts it.
    await req('POST', '/git/worktree', { workspace: WS, key: 'local/touch-probe', repo_path: WS });
    await req('POST', '/agent/start', {
      workspace: WS, agent_id: 'silent-foreign', task: 'local/touch-probe',
      session: 'disp-sf', subagent_session: 'sub-sf',
    });
    const claim = await req('POST', '/overlay/status', {
      workspace: WS, key: 'local/touch-probe', status: 'in_progress', agent_id: 'silent-foreign',
    });
    ok('start_task claim ok', claim.status === 200 && claim.body.ok === true);

    const agents1 = await req('GET', '/agents');
    const reg = (agents1.body.agents || []).find((x) => x.agent_id === 'silent-foreign');
    ok('GET /agents lists auto-registered worker', !!reg);
    ok('auto-registered state running', reg && reg.state === 'running');
    ok('auto-registered task set', reg && reg.task === 'local/touch-probe');

    const seen1 = readAgentsFile()['silent-foreign'].lastSeen;
    await new Promise((r) => setTimeout(r, 20));
    const complete = await req('POST', '/overlay/status', {
      workspace: WS, key: 'local/touch-probe', status: 'done', agent_id: 'silent-foreign', summary: 'done',
    });
    ok('complete_task ok', complete.status === 200 && complete.body.ok === true);

    const doneReg = readAgentsFile()['silent-foreign'];
    ok('lastSeen advanced on terminal POST', doneReg && doneReg.lastSeen >= seen1);
    ok('terminal POST marks done', doneReg && doneReg.state === 'done');

    // Hook + MCP path idempotency: /agent/start then another touch via set_status stamp.
    await req('POST', '/agent/start', { agent_id: 'hook-plus-mcp', task: 'local/touch-probe', session: 's1' });
    const hookSeen = readAgentsFile()['hook-plus-mcp'].lastSeen;
    await new Promise((r) => setTimeout(r, 20));
    await req('POST', '/overlay/status', {
      workspace: WS, key: 'local/touch-probe', status: 'in_progress', agent_id: 'hook-plus-mcp', force: true,
    });
    const hookReg2 = readAgentsFile()['hook-plus-mcp'];
    ok('hook then start_task: single agent record', Object.keys(readAgentsFile()).filter((k) => k === 'hook-plus-mcp').length === 1);
    ok('hook then start_task: lastSeen stamped', hookReg2 && hookReg2.lastSeen >= hookSeen);

    // ── Gate: Agent-tool spawn (no distinct subagent_session) CAN claim via arm (b) ──
    // This is the regression target: touchAgent now persists agent_tool_spawn, so the overlay
    // claim gate arm (b) (a.agent_tool_spawn && a.agent_id === b.agent_id) can match.
    await req('POST', '/overlay/edge', { workspace: WS, from: 'local/root', to: 'local/spawn-probe', kind: 'blocking' });
    await req('POST', '/overlay/status', { workspace: WS, key: 'local/spawn-probe', status: 'ready' });
    await req('POST', '/git/worktree', { workspace: WS, key: 'local/spawn-probe', repo_path: WS });
    // SubagentStart hook for an Agent-tool spawn: parent_session_id === session, no subagent_session.
    await req('POST', '/agent/start', {
      workspace: WS, agent_id: 'tool-spawn', task: 'local/spawn-probe', session: 'disp-sid', parent_session_id: 'disp-sid',
    });
    const spawnReg = readAgentsFile()['tool-spawn'];
    ok('agent_tool_spawn persisted to disk', spawnReg && spawnReg.agent_tool_spawn === true);
    const spawnClaim = await req('POST', '/overlay/status', {
      workspace: WS, key: 'local/spawn-probe', status: 'in_progress', agent_id: 'tool-spawn', session_id: 'disp-sid',
    });
    ok('Agent-tool spawn claim accepted (gate arm b)', spawnClaim.status === 200 && spawnClaim.body.ok === true);

    // ── Gate: genuine dispatcher session (no spawn flag, no subagent, NO worktree) STILL rejected ──
    // No /git/worktree call here: the worktree is the claim-side security boundary, so a claim with
    // NO registered worktree is refused even when it carries an agent_id + session_id. (Registering
    // a worktree would trip the self-register-on-claim fallback and the claim would be ALLOWED.)
    await req('POST', '/overlay/edge', { workspace: WS, from: 'local/root', to: 'local/disp-probe', kind: 'blocking' });
    await req('POST', '/overlay/status', { workspace: WS, key: 'local/disp-probe', status: 'ready' });
    await req('POST', '/agent/start', { workspace: WS, agent_id: 'plain-disp', task: 'local/disp-probe', session: 'disp2-sid' });
    const dispClaim = await req('POST', '/overlay/status', {
      workspace: WS, key: 'local/disp-probe', status: 'in_progress', agent_id: 'plain-disp', session_id: 'disp2-sid',
    });
    ok('dispatcher session still rejected', dispClaim.status === 409);
  } finally {
    child.kill('SIGTERM');
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
