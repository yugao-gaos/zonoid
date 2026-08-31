/**
 * Regression for task #29 — unify worker-registration into one /agent/start path.
 *
 * THE BUG: the SubagentStart hook POSTs {agent_id, session, agent_tool_spawn:true} with NO
 * parent_session_id. routes/exec.js used to derive agentToolSpawn ONLY from parent_session_id,
 * IGNORING the explicit hook flag — so hook-registered workers got agent_tool_spawn=false and
 * routes/overlay.js start_task refused the claim ("dispatcher sessions cannot claim tasks").
 *
 * THE FIX: exec.js honors BOTH signals at the single /agent/start chokepoint:
 *   const agentToolSpawn = b.agent_tool_spawn === true || (parent_session_id === session)
 *
 * This test asserts, end-to-end against a sandboxed daemon:
 *   (1) /agent/start with {agent_tool_spawn:true} and NO parent_session_id persists an agent
 *       record with agent_tool_spawn===true (read from the sandbox agents.json).
 *   (2) overlay/status in_progress (the start_task path) then ACCEPTS that agent_id.
 *   (3) negative control: an agent registered WITHOUT the flag and WITHOUT a matching
 *       parent_session_id persists agent_tool_spawn===false (the exec.js gate is not loosened).
 *
 * NOTE: the claim-refusal boundaries (no-worktree claim refused, with-worktree claim allowed via
 * the self-register-on-claim fallback) live in test/self-register-on-claim.test.js. This test no
 * longer asserts a 409 on a worktree-backed dispatcher-like claim: that fallback now legitimately
 * self-registers any claim bearing an agent_id AND a registered worktree, so the worktree — not the
 * agent_tool_spawn flag — is the claim-side security boundary.
 *
 * Sandboxed daemon on a private port — same pattern as test/endpoints.test.js. Never the live
 * daemon (8787). Run: node test/agent-tool-spawn-register.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const { freePort } = require('./helpers/port');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ats-base-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-ats-ws-')));

// Ask the OS for a free port rather than picking one out of a reserved-by-comment range. The old
// range (19560-19589) was neither exclusive — endpoints.test.js owns 19550-19649, which contains it
// — nor checked for occupancy, so a daemon leaked by an earlier run answered /ping from a deleted
// sandbox and every assertion below it failed. See test/helpers/port.js.
let PORT = 0;
let BASE = '';

// P3: ops require an explicit workspace (no daemon-global default). Single-workspace suite ⇒
// default WS into POST bodies and GET query strings (skip /workspace, /ping, explicit workspace).
async function post(p, body) {
  const payload = (p === '/workspace' || (body && body.workspace)) ? body : { ...(body || {}), workspace: WS };
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}
function withWs(p) {
  if (p.startsWith('/ping') || p.includes('workspace=')) return p;
  return p + (p.includes('?') ? '&' : '?') + 'workspace=' + encodeURIComponent(WS);
}
async function get(p) { const res = await fetch(`${BASE}${withWs(p)}`); return { status: res.status, body: await res.json() }; }
// Boot deadline, not a latency budget: waitForReady returns the moment /health reports phase:'ready', so a
// generous ceiling costs nothing on a fast boot and only decides how long a SLOW one is tolerated.
// 8s was under the real cold-start cost of a full daemon on Windows (fresh Node + AV scan of the
// runtime dir), so suites failed on "daemon came up" intermittently while the daemon was merely
// still starting. No test asserts that a daemon FAILS to boot, so nothing depends on a tight bound.
//
// Probe /health, NOT /ping: daemon.js calls server.listen() before loadState() and /ping is in
// LOADING_WHITELIST, so /ping answers 200 while every non-whitelisted route still 503s
// {phase:'loading'}. Waiting on /ping therefore races boot, and the first real request after it
// can get the 503 body instead of data.

async function waitForReady(ms = 30000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/health'); if (r.body && r.body.phase === 'ready') return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
function readAgent(agentId) {
  const all = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'agents.json'), 'utf8'));
  return all[agentId] || null;
}

test('hook-style /agent/start (agent_tool_spawn:true, no parent_session_id) registers + claims', async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;

  // WS doubles as the workspace AND the task repo (claim requires a registered worktree).
  execSync('git init -q', { cwd: WS });
  execSync('git -c user.email=t@t -c user.name=t commit -q --allow-empty -m init', { cwd: WS });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_TOKEN: '' },
    stdio: 'ignore',
  });
  try {
    assert.ok(await waitForReady(), 'sandboxed daemon came up');
    assert.equal((await post('/workspace', { path: WS })).body.ok, true, 'workspace pinned');

    const SID = crypto.randomUUID();      // the (shared) dispatcher session the hook reports
    const KEY = `${crypto.randomUUID()}/1`;

    // ── (1) hook-style registration: explicit flag, NO parent_session_id ──
    assert.equal((await post('/agent/start', {
      agent_id: 'hook-worker', session: SID, agent_tool_spawn: true,
    })).body.ok, true, '/agent/start accepted');
    assert.equal(readAgent('hook-worker').agent_tool_spawn, true,
      'explicit hook flag persisted as agent_tool_spawn===true (the unification)');

    // ── (2) the claim (start_task path) accepts that worker ──
    await post('/mark-root', { task_key: KEY, reason: 'ats test root' });   // clear quarantine
    assert.equal((await post('/git/worktree', { key: KEY, repo_path: WS })).status, 200,
      'worktree registered (branch_task precondition)');
    const claim = await post('/overlay/status', { key: KEY, status: 'in_progress', agent_id: 'hook-worker', session_id: SID });
    assert.equal(claim.body.ok, true, 'isSubagent check accepts the hook-registered worker — claim lands');

    const HOOKLESS_SID = crypto.randomUUID();
    const HOOKLESS_KEY = `${crypto.randomUUID()}/hookless`;
    await post('/mark-root', { task_key: HOOKLESS_KEY, reason: 'ats hookless root' });
    assert.equal((await post('/git/worktree', { key: HOOKLESS_KEY, repo_path: WS })).status, 200,
      'hookless worktree registered (branch_task precondition)');
    const hooklessClaim = await post('/overlay/status', {
      key: HOOKLESS_KEY, status: 'in_progress', agent_id: 'hookless-worker', session_id: HOOKLESS_SID,
    });
    assert.equal(hooklessClaim.body.ok, true, 'worktree-backed hookless claim self-registers');
    const hooklessInfo = await get(`/session-info?session=${encodeURIComponent(HOOKLESS_SID)}`);
    assert.equal(hooklessInfo.body.is_subagent, true,
      '/session-info classifies hookless same-session agent_tool_spawn workers as subagents');

    // ── (3) negative control: no flag + no matching parent_session_id => agent_tool_spawn===false ──
    // This is the exec.js half of the gate: registration without the explicit flag and without a
    // matching parent_session_id must persist agent_tool_spawn===false. The claim-side boundary
    // (worktree-backed claims self-register and are allowed; worktree-less claims are refused 409)
    // is covered end-to-end by test/self-register-on-claim.test.js, so it is not re-asserted here.
    const SID2 = crypto.randomUUID();
    assert.equal((await post('/agent/start', {
      agent_id: 'dispatcher-like', session: SID2, parent_session_id: 'some-other-session',
    })).body.ok, true, 'dispatcher-like /agent/start accepted (registration always ok)');
    assert.equal(readAgent('dispatcher-like').agent_tool_spawn, false,
      'no flag + mismatched parent => agent_tool_spawn===false (gate not loosened)');
    const dispatcherInfo = await get(`/session-info?session=${encodeURIComponent(SID2)}`);
    assert.equal(dispatcherInfo.body.is_subagent, false,
      '/session-info does not classify dispatcher-like registrations as subagents');
  } finally {
    child.kill('SIGKILL');
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* best effort */ }
    try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
