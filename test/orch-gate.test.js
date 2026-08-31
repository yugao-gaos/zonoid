#!/usr/bin/env node
// Tests for hooks/orch-gate.sh path allowlist and claim-check logic.
// Run: node test/orch-gate.test.js  — exits non-zero on any failed assertion.
//
// Strategy: pipe synthetic PreToolUse JSON into the hook and check exit codes.
//   - A child-process HTTP stub returns daemon-shaped responses to drive exit-2 paths.
//   - Task mint paths (~/.claude/tasks/*, ~/.claude/orchestrator/tasks/*) must exit 0
//     even when the stub reports no claim.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHookStub } = require('./support/hook-http-stub');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'orch-gate.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-test-'));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
}

function mkInput(filePath, sessionId, agentId) {
  const input = {
    tool_input: { file_path: filePath, new_string: 'x' },
    session_id: sessionId || 'test-session-x',
  };
  if (agentId) input.agent_id = agentId;
  return JSON.stringify(input);
}

function runHook(input, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  delete env.CODEX_THREAD_ID;
  if (extraEnv && Object.prototype.hasOwnProperty.call(extraEnv, 'CODEX_THREAD_ID')) {
    env.CODEX_THREAD_ID = extraEnv.CODEX_THREAD_ID;
  }
  const r = spawnSync('bash', [HOOK], {
    input,
    encoding: 'utf8',
    env,
  });
  return { status: r.status, stderr: r.stderr || '' };
}

const BLOCKED = { activeClaim: { claimed: false }, sessionInfo: { is_subagent: true } };
const MAIN_BLOCKED = { activeClaim: { claimed: false }, sessionInfo: { is_subagent: false } };

function runWithConfig(input, config, extra) {
  return withHookStub(config, (stub) => runHook(input, { ...stub.env(), ...extra }));
}
function runBlocked(filePath, extra) {
  return runWithConfig(mkInput(filePath), BLOCKED, extra);
}

function runMainBlocked(filePath, extra) {
  return runWithConfig(mkInput(filePath), MAIN_BLOCKED, extra);
}

function executionPermit(taskKey, worktree, branch, overrides = {}) {
  return {
    id: `permit-${taskKey}`,
    session_id: 'test-session-x',
    task_key: taskKey,
    worktree,
    branch,
    scope: 'worktree',
    allowed_paths: [worktree],
    status: 'active',
    issued_at: '2026-06-21T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── Test cases ──────────────────────────────────────────────────────────────

// 1. Native Claude TaskCreate path → exempt → exit 0
{
  const home = process.env.HOME || '/Users/x';
  const r = runBlocked(`${home}/.claude/tasks/abc-uuid-123/1.json`);
  ok('native task path ~/.claude/tasks/<uuid>/1.json → exit 0', r.status === 0);
}

// 2. File-drop task mint path → exempt → exit 0
{
  const home = process.env.HOME || '/Users/x';
  const r = runBlocked(`${home}/.claude/orchestrator/tasks/ws-abc/cursor/t1.json`);
  ok('filedrop task path ~/.claude/orchestrator/tasks/ws-abc/cursor/t1.json → exit 0', r.status === 0);
  const r2 = runBlocked(`${home}/repo/.zonoid/tasks/ws-abc/cursor/t1.json`);
  ok('filedrop task path .zonoid/tasks/ws-abc/cursor/t1.json → exit 0', r2.status === 0);
}

// 3. Regular source file → not exempt → subagent blocked → exit 2
{
  const r = runBlocked('/Users/x/proj/src.js');
  ok('regular source /Users/x/proj/src.js → exit 2 for unclaimed subagent', r.status === 2);
}


// 4. Main session, no workers → exit 2 with no-workers message
{
  const r = runMainBlocked('/Users/x/proj/src.js');
  ok('main session no workers → exit 2', r.status === 2);
  ok('main session no workers → message', r.stderr.includes('no in-flight workers'));
}

// 5. Main session with in-flight worker + small patch → exit 0 (trivial allowance)
{
  const r = runWithConfig(
    JSON.stringify({ tool_input: { file_path: '/Users/x/proj/src.js', new_string: 'x=1\n' }, session_id: 'main-disp' }),
    {
      activeClaim: { claimed: false },
      sessionInfo: { is_subagent: false },
      dispatcherChildren: { children: [{ task_key: 'local/w1', label: 'worker', agent_id: 'w1', worker_session: 'ws1' }], attribution: 'local/w1', needs_focus: false },
    },
    { CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('main session trivial patch with workers → exit 0', r.status === 0);
}

// 6. Main session trivial budget exhausted → exit 2
{
  const sid = 'main-budget';
  const input = JSON.stringify({ tool_input: { file_path: '/Users/x/proj/a.js', new_string: 'a\n' }, session_id: sid });
  const config = {
    activeClaim: { claimed: false },
    sessionInfo: { is_subagent: false },
    dispatcherChildren: { children: [{ task_key: 'local/w1', label: 'worker', agent_id: 'w1', worker_session: 'ws1' }], attribution: 'local/w1', needs_focus: false },
  };
  const [first, second] = withHookStub(config, (stub) => {
    const env = { ...stub.env(), CLAUDE_PLUGIN_DATA: TMP };
    return [runHook(input, env), runHook(input, env)];
  });
  ok('first trivial patch allowed', first.status === 0);
  ok('second trivial patch blocked', second.status === 2);
  ok('budget exhausted message', second.stderr.includes('trivial patch budget exhausted'));
}

// 7. Main session patch too large → exit 2 with dispatch message
{
  const big = 'line\n'.repeat(25);
  const r = runWithConfig(
    JSON.stringify({ tool_input: { file_path: '/Users/x/proj/big.js', new_string: big }, session_id: 'main-big' }),
    {
      activeClaim: { claimed: false },
      sessionInfo: { is_subagent: false },
      dispatcherChildren: { children: [{ task_key: 'local/w1', label: 'worker', agent_id: 'w1', worker_session: 'ws1' }], attribution: 'local/w1', needs_focus: false },
    },
    { CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('oversized patch blocked', r.status === 2);
  ok('oversized patch dispatch message', r.stderr.includes('subconscious_assignment action:"prepare"'));
}


// 8. Multiple workers without focus → exit 2
{
  const r = runWithConfig(
    JSON.stringify({ tool_input: { file_path: '/Users/x/proj/src.js', new_string: 'x=1\n' }, session_id: 'main-multi' }),
    {
      activeClaim: { claimed: false },
      sessionInfo: { is_subagent: false },
      dispatcherChildren: { children: [{ task_key: 'local/w1' }, { task_key: 'local/w2' }], needs_focus: true, attribution: null },
    },
    { CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('multi-worker without focus blocked', r.status === 2);
  ok('focus message', r.stderr.includes('dispatcher focus'));
}

// 9. Trivial allow posts dispatcher-edit
{
  const marker = path.join(TMP, 'dispatcher-edit-called').replace(/\\/g, '/');
  try { fs.unlinkSync(marker); } catch { /* */ }
  const r = runWithConfig(
    JSON.stringify({ tool_input: { file_path: '/Users/x/proj/src.js', new_string: 'x=1\n' }, session_id: 'main-report' }),
    {
      activeClaim: { claimed: false },
      sessionInfo: { is_subagent: false },
      dispatcherChildren: { children: [{ task_key: 'local/w1', label: 'worker', agent_id: 'w1', worker_session: 'ws1' }], attribution: 'local/w1', needs_focus: false },
      dispatcherEditMarker: marker,
    },
    { CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('trivial patch with attribution exits 0', r.status === 0);
  ok('dispatcher-edit POST fired', fs.existsSync(marker));
}
// ── Multi-claim gate tests ───────────────────────────────────────────────────
// Two synthetic worktree paths under TMP. These directories do NOT need to be
// real git repos — the new gate logic does a string prefix check (is FP inside
// worktree path?), not a `git rev-parse` call.
// Forward-slash paths mirror what the daemon stores for git worktrees.
const WT_A = path.join(TMP, 'wt-a').replace(/\\/g, '/');
const WT_B = path.join(TMP, 'wt-b').replace(/\\/g, '/');
fs.mkdirSync(WT_A, { recursive: true });
fs.mkdirSync(WT_B, { recursive: true });

// Builds a daemon-stub config that:
//  - /active-claim → claimed with two keys
//  - /task/detail?key=task-a → worktree WT_A
//  - /task/detail?key=task-b → worktree WT_B (or no worktree if noWtB=true)
function makeMultiClaimConfig({ noWtA = false, noWtB = false } = {}) {
  const detailA = noWtA
    ? { task: { metric: null, git: null } }
    : { task: { metric: null, git: { branch: 'orch/attempt/task-a', worktree: WT_A } } };
  const detailB = noWtB
    ? { task: { metric: null, git: null } }
    : { task: { metric: null, git: { branch: 'orch/attempt/task-b', worktree: WT_B } } };
  return {
    activeClaim: { claimed: true, claims: [{ key: 'task-a' }, { key: 'task-b' }] },
    taskDetails: { 'task-a': detailA, 'task-b': detailB },
    executionPermits: [
      ...(noWtA ? [] : [executionPermit('task-a', WT_A, 'orch/attempt/task-a')]),
      ...(noWtB ? [] : [executionPermit('task-b', WT_B, 'orch/attempt/task-b')]),
    ],
  };
}

function makeSingleClaimConfig(permit = executionPermit('task-a', WT_A, 'orch/attempt/task-a')) {
  return {
    activeClaim: { claimed: true, claims: [{ key: 'task-a' }] },
    taskDetails: {
      'task-a': { task: { metric: null, git: { branch: 'orch/attempt/task-a', worktree: WT_A } } },
    },
    executionPermit: { ok: true, execution_permit: permit },
  };
}

// 10. Claimed worktree without a Subconscious permit → denied
{
  const targetInA = `${WT_A}/src.js`;
  const config = {
    activeClaim: { claimed: true, claims: [{ key: 'task-a' }] },
    taskDetails: {
      'task-a': { task: { metric: null, git: { branch: 'orch/attempt/task-a', worktree: WT_A } } },
    },
  };
  const r = runWithConfig(mkInput(targetInA), config);
  ok('claimed worktree without Subconscious permit → exit 2', r.status === 2);
  ok('claimed worktree without Subconscious permit → permit message', r.stderr.includes('Subconscious execution permit'));
}

// 11. Multi-claim: write to FIRST claim's worktree with permit → allowed
{
  const targetInA = `${WT_A}/src.js`;
  const r = runWithConfig(mkInput(targetInA), makeMultiClaimConfig());
  ok('multi-claim: write to first claim worktree with permit → exit 0', r.status === 0);
}

// 12. Multi-claim: write to SECOND claim's worktree with permit → allowed
{
  const targetInB = `${WT_B}/lib.js`;
  const r = runWithConfig(mkInput(targetInB), makeMultiClaimConfig());
  ok('multi-claim: write to second claim worktree with permit → exit 0', r.status === 0);
}

// 13. Multi-claim: write outside BOTH worktrees → denied
{
  const targetOutside = '/Users/x/other-project/main.js';
  const r = runWithConfig(mkInput(targetOutside), makeMultiClaimConfig());
  ok('multi-claim: write outside both worktrees → exit 2', r.status === 2);
  ok('multi-claim: write outside both worktrees → worktree path message', r.stderr.includes('worktree path'));
}

// 14. Multi-claim: first claim has NO worktree, second does → write to second's permitted worktree → allowed
{
  const targetInB = `${WT_B}/index.js`;
  const r = runWithConfig(mkInput(targetInB), makeMultiClaimConfig({ noWtA: true }));
  ok('multi-claim: first claim no worktree, second has worktree, write to second → exit 0', r.status === 0);
}

// 15. Wrong session in permit → denied
{
  const config = makeSingleClaimConfig(executionPermit('task-a', WT_A, 'orch/attempt/task-a', { session_id: 'other-session' }));
  const r = runWithConfig(mkInput(`${WT_A}/wrong-session.js`), config);
  ok('permit with wrong session → exit 2', r.status === 2);
  ok('permit with wrong session → message', r.stderr.includes('session mismatch'));
}

// 16. Wrong task in permit → denied
{
  const config = makeSingleClaimConfig(executionPermit('other-task', WT_A, 'orch/attempt/task-a'));
  const r = runWithConfig(mkInput(`${WT_A}/wrong-task.js`), config);
  ok('permit with wrong task → exit 2', r.status === 2);
  ok('permit with wrong task → message', r.stderr.includes('task mismatch'));
}

// 17. Expired permit → denied
{
  const config = makeSingleClaimConfig(executionPermit('task-a', WT_A, 'orch/attempt/task-a', { expires_at: '2000-01-01T00:00:00.000Z' }));
  const r = runWithConfig(mkInput(`${WT_A}/expired.js`), config);
  ok('expired permit → exit 2', r.status === 2);
  ok('expired permit → message', r.stderr.includes('expired'));
}

// 18. Revoked permit → denied
{
  const config = makeSingleClaimConfig(executionPermit('task-a', WT_A, 'orch/attempt/task-a', { status: 'revoked', revoked_at: '2026-06-21T00:10:00.000Z' }));
  const r = runWithConfig(mkInput(`${WT_A}/revoked.js`), config);
  ok('revoked permit → exit 2', r.status === 2);
  ok('revoked permit → message', r.stderr.includes('revoked'));
}

// 19. Permit allowed_paths narrower than worktree → outside scope denied
{
  const config = makeSingleClaimConfig(executionPermit('task-a', WT_A, 'orch/attempt/task-a', { scope: 'paths', allowed_paths: [`${WT_A}/allowed`] }));
  const r = runWithConfig(mkInput(`${WT_A}/outside-scope.js`), config);
  ok('permit path scope mismatch → exit 2', r.status === 2);
  ok('permit path scope mismatch → message', r.stderr.includes('permit scope'));
}

// 20. Codex Desktop collaboration child identity overrides the parent payload/session env.
{
  const childSession = 'codex-child-thread';
  const config = makeSingleClaimConfig(executionPermit('task-a', WT_A, 'orch/attempt/task-a', {
    session_id: childSession,
  }));
  const r = runWithConfig(
    mkInput(`${WT_A}/child-session.js`, 'codex-parent-payload'),
    config,
    { CODEX_THREAD_ID: childSession, CODEX_SESSION_ID: 'codex-parent-runtime' },
  );
  ok('CODEX_THREAD_ID child permit overrides parent payload for Write/Edit gate → exit 0', r.status === 0);
}

// 21. Large graph reads can exceed the old 600ms budget; a claimed worker still validates both
//     authoritative detail and permit before it is allowed.
{
  const config = {
    ...makeSingleClaimConfig(),
    taskDetailDelayMs: 750,
    executionPermitDelayMs: 750,
  };
  const r = runWithConfig(mkInput(`${WT_A}/slow-claim.js`), config);
  ok('transiently slow task detail and permit preserve fail-closed claimed allow → exit 0', r.status === 0);
}

// 22. Codex Desktop reports the transport thread UUID as hook agent_id, not the logical assignee.
{
  const transportSession = '01a05606-303e-7342-af86-80d33d596727';
  const permit = executionPermit('task-a', WT_A, 'orch/attempt/task-a', {
    session_id: transportSession,
    agent_id: 'logical-worker',
  });
  const config = makeSingleClaimConfig(permit);
  const transport = runWithConfig(
    mkInput(`${WT_A}/transport-agent.js`, 'test-session-x', transportSession),
    config,
  );
  const wrongLogical = runWithConfig(
    mkInput(`${WT_A}/wrong-logical-agent.js`, 'test-session-x', 'different-logical-worker'),
    config,
  );
  ok('Codex transport UUID uses its matching session/task/worktree permit → exit 0', transport.status === 0);
  ok('different logical non-UUID agent remains denied → exit 2', wrongLogical.status === 2);
}

// 23. Desktop transcript metadata and the matching top-level transport agent prove that a child
//     may override the parent CODEX_THREAD_ID. Unproven variants retain the parent identity.
{
  const parentSession = '01a05418-cf8c-7a00-adc2-0b13eee860ca';
  const childSession = '01a05606-303e-7342-af86-80d33d596727';
  const windowId = '01a05606-303e-7342-af86-80ef3c3c6d7c';
  const transcriptPath = path.join(TMP, 'desktop-child.jsonl');
  fs.writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: childSession,
      session_id: parentSession,
      parent_thread_id: parentSession,
      context_window: { window_id: windowId },
      source: { subagent: { thread_spawn: { parent_thread_id: parentSession } } },
    },
  })}\n`);
  const config = makeSingleClaimConfig(executionPermit('task-a', WT_A, 'orch/attempt/task-a', {
    session_id: childSession,
    agent_id: 'logical-worker',
  }));
  const input = {
    session_id: windowId,
    agent_id: childSession,
    transcript_path: transcriptPath,
    tool_input: { file_path: `${WT_A}/desktop-transcript.js`, new_string: 'x' },
  };
  const desktopEnv = { CODEX_THREAD_ID: parentSession, CODEX_SESSION_ID: parentSession };
  const r = runWithConfig(JSON.stringify(input), config, desktopEnv);
  ok('Desktop proven child overrides parent CODEX_THREAD_ID for Write/Edit → exit 0', r.status === 0);
  ok('Desktop transcript child remains available when CODEX_THREAD_ID is absent → exit 0',
    runWithConfig(JSON.stringify(input), config, { CODEX_SESSION_ID: parentSession }).status === 0);

  const noTranscript = {
    session_id: parentSession,
    agent_id: childSession,
    tool_input: { file_path: `${WT_A}/desktop-no-transcript.js`, new_string: 'x' },
  };
  ok('Desktop host UUID overrides parent CODEX_THREAD_ID without a transcript for Write/Edit → exit 0',
    runWithConfig(JSON.stringify(noTranscript), config, desktopEnv).status === 0);
  ok('tool_input UUID cannot override parent CODEX_THREAD_ID without a transcript → exit 2',
    runWithConfig(JSON.stringify({
      ...noTranscript,
      agent_id: undefined,
      tool_input: { ...noTranscript.tool_input, agent_id: childSession },
    }), config, desktopEnv).status === 2);
  ok('non-UUID top-level logical agent cannot become the hook session → exit 2',
    runWithConfig(JSON.stringify({ ...noTranscript, agent_id: 'logical-worker' }), config, desktopEnv).status === 2);
  ok('absent top-level agent retains parent CODEX_THREAD_ID → exit 2',
    runWithConfig(JSON.stringify({ ...noTranscript, agent_id: undefined }), config, desktopEnv).status === 2);

  const parentConfig = makeSingleClaimConfig(executionPermit('task-a', WT_A, 'orch/attempt/task-a', {
    session_id: parentSession,
    agent_id: 'logical-worker',
  }));
  ok('top-level agent equal to CODEX_THREAD_ID keeps the parent session unchanged → exit 0',
    runWithConfig(JSON.stringify({ ...noTranscript, agent_id: parentSession }), parentConfig, desktopEnv).status === 0);

  const wrongSessionConfig = makeSingleClaimConfig(executionPermit('task-a', WT_A, 'orch/attempt/task-a', {
    session_id: '01a05606-303e-7342-af86-999999999999',
    agent_id: 'logical-worker',
  }));
  ok('Desktop host UUID still requires a matching permit session → exit 2',
    runWithConfig(JSON.stringify(noTranscript), wrongSessionConfig, desktopEnv).status === 2);

  const malformedTranscript = path.join(TMP, 'desktop-child-malformed.jsonl');
  fs.writeFileSync(malformedTranscript, '{not-json\n');
  ok('malformed transcript remains fail-closed instead of falling back to the host UUID → exit 2',
    runWithConfig(JSON.stringify({ ...noTranscript, transcript_path: malformedTranscript }), config, desktopEnv).status === 2);

  const toolInputOnly = {
    ...input,
    agent_id: undefined,
    tool_input: { ...input.tool_input, agent_id: childSession },
  };
  ok('tool_input agent_id cannot authorize the Desktop child override → exit 2',
    runWithConfig(JSON.stringify(toolInputOnly), config, desktopEnv).status === 2);
  ok('missing top-level transport agent retains parent CODEX_THREAD_ID → exit 2',
    runWithConfig(JSON.stringify({ ...input, agent_id: undefined }), config, desktopEnv).status === 2);
  ok('different top-level transport session does not borrow the child permit → exit 2',
    runWithConfig(JSON.stringify({ ...input, agent_id: '01a05606-303e-7342-af86-111111111111' }), config, desktopEnv).status === 2);

  const maliciousWindow = '01a05606-303e-7342-af86-222222222222';
  const maliciousTranscript = path.join(TMP, 'desktop-child-wrong-parent.jsonl');
  fs.writeFileSync(maliciousTranscript, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: childSession,
      session_id: '01a05418-cf8c-7a00-adc2-333333333333',
      parent_thread_id: '01a05418-cf8c-7a00-adc2-333333333333',
      context_window: { window_id: maliciousWindow },
    },
  })}\n`);
  ok('transcript window bound to a different parent cannot override CODEX_THREAD_ID → exit 2',
    runWithConfig(JSON.stringify({
      ...input,
      session_id: maliciousWindow,
      transcript_path: maliciousTranscript,
    }), config, desktopEnv).status === 2);

  const topLevelTranscript = path.join(TMP, 'desktop-not-child.jsonl');
  fs.writeFileSync(topLevelTranscript, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: parentSession,
      session_id: parentSession,
      parent_thread_id: parentSession,
      context_window: { window_id: windowId },
    },
  })}\n`);
  ok('top-level transcript metadata is not treated as a child override → exit 2',
    runWithConfig(JSON.stringify({
      ...input,
      agent_id: parentSession,
      transcript_path: topLevelTranscript,
    }), config, desktopEnv).status === 2);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
