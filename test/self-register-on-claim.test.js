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
const { spawn, spawnSync } = require('child_process');
const git = require('../lib/git');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-selfreg-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const PORT = 19170 + Math.floor(Math.random() * 200);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-selfreg-ws-')));

const SESSION = 'aaaaaaaa-feedface-0000-4000-800000000003';
const REAL_SESSION = 'bbbbbbbb-feedface-0000-4000-800000000004';
const { encodeWorkspace } = require('../lib/native-tasks');
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const K = (id) => `${SESSION}/${id}`;

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function req(method, p, body) {
  // P3: ops require an explicit workspace (no daemon-global default). Single-workspace suite =>
  // default WS into POST bodies and GET query strings (skip /workspace, /ping, explicit workspace).
  let _p = p, _b = body;
  if (p !== '/workspace' && !p.startsWith('/ping') && !p.includes('workspace=')) {
    if (_b && typeof _b === 'object' && _b.workspace === undefined) _b = { ..._b, workspace: WS };
    else if (!_b) _p = p + (p.includes('?') ? '&' : '?') + 'workspace=' + encodeURIComponent(WS);
  }
  return new Promise((resolve, reject) => {
    const data = _b ? JSON.stringify(_b) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: _p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
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

function runWriteGate(filePath, sessionId = SESSION) {
  const env = { ...process.env, ORCH_PORT: String(PORT), CLAUDE_PLUGIN_DATA: SANDBOX };
  delete env.CODEX_THREAD_ID;
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'orch-gate.js')], {
    input: JSON.stringify({
      session_id: sessionId,
      agent_id: 'hookless-worker',
      tool_name: 'Write',
      tool_input: { file_path: filePath, new_string: 'x' },
    }),
    encoding: 'utf8',
    env,
  });
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

    // Claim WITHOUT a worktree → refused, and the message points to the Subconscious assignment surface.
    const noWt = await req('POST', '/overlay/status', { key: K(2), status: 'in_progress', agent_id: 'hookless-worker', session_id: SESSION, workspace: WS });
    ok('hook-less claim with NO worktree refused 409', noWt.status === 409);
    ok('409 points to Subconscious assignment surface', /subconscious_assignment action:"(accept|prepare)"/.test(String(noWt.body.error)));

    // Branch a worktree (proof of delegation) via the real branch_task endpoint, which registers
    // it in overlay.git — then claim → self-register-on-claim allows it.
    const wt = await req('POST', '/git/worktree', { key: K(1), target_repo: WS });
    ok('attempt worktree created + registered', wt.status === 200 && String(wt.body.branch).startsWith('orch/attempt/'));
    // Claim carries the session workspace (main repo), exactly as the start_task MCP tool does —
    // the overlay (and its git registration) is keyed on the repo, not the worktree path.
    const claim = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'hookless-worker', session_id: SESSION, workspace: WS });
    ok('hook-less claim WITH worktree self-registers and succeeds', claim.status === 200 && claim.body.ok === true);
    const permit = claim.body.execution_permit;
    ok('accepted worker claim auto-issues active execution permit',
      permit &&
      permit.status === 'active' &&
      permit.session_id === SESSION &&
      permit.agent_id === 'hookless-worker' &&
      permit.task_key === K(1) &&
      permit.worktree === wt.body.worktree &&
      permit.branch === wt.body.branch);
    const readPermit = await req(
      'GET',
      `/subconscious/permit?session_id=${encodeURIComponent(SESSION)}&agent_id=hookless-worker&task_key=${encodeURIComponent(K(1))}`,
    );
    ok('auto-issued permit is readable without manual permit step',
      readPermit.status === 200 &&
      readPermit.body.valid === true &&
      readPermit.body.execution_permit.id === (permit && permit.id));
    const gateAllow = runWriteGate(path.join(wt.body.worktree, 'normal-worker-write.js'));
    ok('branch_task -> start_task -> write passes gate without manual permit step',
      gateAllow.status === 0);

    // The claim bound the assignee to this worker (proves it took effect end-to-end): the same
    // worker can re-claim its own in_progress task without the "already claimed by another" 409.
    const reclaim = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'hookless-worker', session_id: SESSION, workspace: WS });
    ok('worker owns its task — idempotent re-claim by same agent succeeds', reclaim.status === 200 && reclaim.body.ok === true);
    ok('idempotent re-claim reuses valid execution permit',
      reclaim.body.execution_permit && reclaim.body.execution_permit.id === (permit && permit.id));

    const missingAgentRebind = await req('POST', '/overlay/claim-session', {
      task_key: K(1), session_id: REAL_SESSION, workspace: WS,
    });
    ok('claim-session rebind requires agent_id', missingAgentRebind.status === 400 && /agent_id/.test(String(missingAgentRebind.body.error)));
    const wrongAgentRebind = await req('POST', '/overlay/claim-session', {
      task_key: K(1), session_id: REAL_SESSION, agent_id: 'other-worker', workspace: WS,
    });
    ok('claim-session rebind rejects a different agent', wrongAgentRebind.status === 409 && /agent_id/.test(String(wrongAgentRebind.body.error)));
    const unpreparedRebind = await req('POST', '/overlay/claim-session', {
      task_key: K(2), session_id: REAL_SESSION, agent_id: 'hookless-worker', workspace: WS,
    });
    ok('claim-session rebind rejects an inactive unprepared task', unpreparedRebind.status === 409 && /active claimed task/.test(String(unpreparedRebind.body.error)));
    const terminal = await req('POST', '/overlay/status', {
      key: K(2), status: 'canceled', agent_id: 'hookless-worker', session_id: SESSION, workspace: WS,
    });
    const terminalRebind = await req('POST', '/overlay/claim-session', {
      task_key: K(2), session_id: REAL_SESSION, expected_session_id: SESSION, agent_id: 'hookless-worker', workspace: WS,
    });
    ok('claim-session rebind rejects a terminal task',
      terminal.status === 200 && terminalRebind.status === 409 && /active claimed task/.test(String(terminalRebind.body.error)));

    // Codex Desktop can accept through an MCP fallback session, while PostToolUse observes the
    // actual worker thread id. Rebinding must atomically move both the claim alias and its permit.
    const missingExpected = await req('POST', '/overlay/claim-session', {
      task_key: K(1), session_id: REAL_SESSION, agent_id: 'hookless-worker', workspace: WS,
    });
    ok('session-changing claim-session rebind requires expected_session_id',
      missingExpected.status === 409 && /expected_session_id/.test(String(missingExpected.body.error)));
    const rebind = await req('POST', '/overlay/claim-session', {
      task_key: K(1), session_id: REAL_SESSION, expected_session_id: SESSION, agent_id: 'hookless-worker', workspace: WS,
    });
    const reboundPermit = rebind.body.execution_permit;
    ok('claim-session rebind issues an active same-session execution permit',
      rebind.status === 200 &&
      rebind.body.rebound === true &&
      rebind.body.previous_session_id === SESSION &&
      reboundPermit &&
      reboundPermit.status === 'active' &&
      reboundPermit.session_id === REAL_SESSION &&
      reboundPermit.agent_id === 'hookless-worker' &&
      reboundPermit.task_key === K(1));
    ok('rebound permit preserves exact prepared branch/worktree scope',
      reboundPermit &&
      reboundPermit.branch === wt.body.branch &&
      reboundPermit.worktree === wt.body.worktree &&
      reboundPermit.scope === 'worktree' &&
      Array.isArray(reboundPermit.allowed_paths) &&
      reboundPermit.allowed_paths.length === 1 &&
      reboundPermit.allowed_paths[0] === wt.body.worktree);
    const oldPermit = await req(
      'GET',
      `/subconscious/permit?session_id=${encodeURIComponent(SESSION)}&agent_id=hookless-worker&task_key=${encodeURIComponent(K(1))}`,
    );
    ok('fallback-session execution permit is revoked after rebind',
      oldPermit.status === 200 &&
      oldPermit.body.valid === false &&
      oldPermit.body.execution_permit &&
      oldPermit.body.execution_permit.id === (permit && permit.id) &&
      oldPermit.body.execution_permit.status === 'revoked');
    const newPermit = await req(
      'GET',
      `/subconscious/permit?session_id=${encodeURIComponent(REAL_SESSION)}&agent_id=hookless-worker&task_key=${encodeURIComponent(K(1))}`,
    );
    ok('real-session execution permit is readable after rebind',
      newPermit.status === 200 &&
      newPermit.body.valid === true &&
      newPermit.body.execution_permit.id === (reboundPermit && reboundPermit.id));

    const staleReplay = await req('POST', '/overlay/claim-session', {
      task_key: K(1),
      session_id: SESSION,
      expected_session_id: SESSION,
      agent_id: 'hookless-worker',
      workspace: WS,
    });
    ok('stale fallback replay is rejected by claim-session compare-and-swap',
      staleReplay.status === 409 && /expected_session_id/.test(String(staleReplay.body.error)));
    const preservedPermit = await req(
      'GET',
      `/subconscious/permit?session_id=${encodeURIComponent(REAL_SESSION)}&agent_id=hookless-worker&task_key=${encodeURIComponent(K(1))}`,
    );
    ok('stale replay preserves the active child execution permit',
      preservedPermit.status === 200 &&
      preservedPermit.body.valid === true &&
      preservedPermit.body.execution_permit.id === (reboundPermit && reboundPermit.id));
    const staleFallbackPermit = await req(
      'GET',
      `/subconscious/permit?session_id=${encodeURIComponent(SESSION)}&agent_id=hookless-worker&task_key=${encodeURIComponent(K(1))}`,
    );
    ok('stale replay does not reissue the revoked fallback permit',
      staleFallbackPermit.status === 200 &&
      staleFallbackPermit.body.valid === false &&
      staleFallbackPermit.body.execution_permit &&
      staleFallbackPermit.body.execution_permit.status === 'revoked');
    const oldGate = runWriteGate(path.join(wt.body.worktree, 'fallback-session-write.js'));
    const realGate = runWriteGate(path.join(wt.body.worktree, 'real-session-write.js'), REAL_SESSION);
    ok('fallback session can no longer pass the write gate after rebind', oldGate.status === 2);
    ok('real worker session passes the write gate immediately after rebind', realGate.status === 0);
    const idempotentRebind = await req('POST', '/overlay/claim-session', {
      task_key: K(1), session_id: REAL_SESSION, agent_id: 'hookless-worker', workspace: WS,
    });
    ok('idempotent same-session rebind reuses its active permit',
      idempotentRebind.status === 200 &&
      idempotentRebind.body.rebound === false &&
      idempotentRebind.body.execution_permit &&
      idempotentRebind.body.execution_permit.id === (reboundPermit && reboundPermit.id));

    // And a DIFFERENT agent cannot steal the in_progress task without force (boundary intact).
    const steal = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'other-worker', session_id: REAL_SESSION, workspace: WS });
    ok('different agent cannot steal the claim without force', steal.status === 409);

    const badCompleteAgent = await req('POST', '/overlay/status', { key: K(1), status: 'tested', agent_id: 'other-worker', session_id: REAL_SESSION, summary: 'malicious done', workspace: WS });
    ok('different agent cannot terminal-complete another worker claim', badCompleteAgent.status === 409 && /agent_id/.test(String(badCompleteAgent.body.error)));
    const badCompleteSession = await req('POST', '/overlay/status', { key: K(1), status: 'tested', agent_id: 'hookless-worker', session_id: SESSION, summary: 'malicious done', workspace: WS });
    ok('wrong session cannot terminal-complete active claim', badCompleteSession.status === 409 && /session_id/.test(String(badCompleteSession.body.error)));
    const missingSessionComplete = await req('POST', '/overlay/status', { key: K(1), status: 'tested', agent_id: 'hookless-worker', summary: 'malicious done', workspace: WS });
    ok('terminal completion of active claim requires session_id', missingSessionComplete.status === 409 && missingSessionComplete.body.missing === 'session_id');

    const revoke = await req('POST', '/subconscious/permit', {
      action: 'revoke',
      permit_id: reboundPermit && reboundPermit.id,
      session_id: REAL_SESSION,
      agent_id: 'hookless-worker',
      task_key: K(1),
      reason: 'test revoke',
      workspace: WS,
    });
    ok('permit revoke succeeds', revoke.status === 200 && revoke.body.execution_permit.status === 'revoked');
    const gateDeny = runWriteGate(path.join(wt.body.worktree, 'revoked-worker-write.js'), REAL_SESSION);
    ok('revoked permit still denies claimed worker write', gateDeny.status === 2 && (gateDeny.stderr || '').includes('revoked'));
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
