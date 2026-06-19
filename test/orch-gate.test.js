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

function mkInput(filePath, sessionId) {
  return JSON.stringify({
    tool_input: { file_path: filePath, new_string: 'x' },
    session_id: sessionId || 'test-session-x',
  });
}

function runHook(input, extraEnv) {
  const env = { ...process.env, ...extraEnv };
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
  ok('oversized patch dispatch message', r.stderr.includes('spawn a background subagent'));
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
  };
}

// 10. Multi-claim: write to FIRST claim's worktree → allowed
{
  const targetInA = `${WT_A}/src.js`;
  const r = runWithConfig(mkInput(targetInA), makeMultiClaimConfig());
  ok('multi-claim: write to first claim worktree → exit 0', r.status === 0);
}

// 11. Multi-claim: write to SECOND claim's worktree → allowed (this was the fixed bug)
{
  const targetInB = `${WT_B}/lib.js`;
  const r = runWithConfig(mkInput(targetInB), makeMultiClaimConfig());
  ok('multi-claim: write to second claim worktree → exit 0 (fixed bug)', r.status === 0);
}

// 12. Multi-claim: write outside BOTH worktrees → denied
{
  const targetOutside = '/Users/x/other-project/main.js';
  const r = runWithConfig(mkInput(targetOutside), makeMultiClaimConfig());
  ok('multi-claim: write outside both worktrees → exit 2', r.status === 2);
  ok('multi-claim: write outside both worktrees → worktree path message', r.stderr.includes('worktree path'));
}

// 13. Multi-claim: first claim has NO worktree, second does → write to second's worktree → allowed
{
  const targetInB = `${WT_B}/index.js`;
  const r = runWithConfig(mkInput(targetInB), makeMultiClaimConfig({ noWtA: true }));
  ok('multi-claim: first claim no worktree, second has worktree, write to second → exit 0', r.status === 0);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
