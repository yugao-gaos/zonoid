#!/usr/bin/env node
// Tests for hooks/orch-gate-bash.sh pattern-detection and allowlist logic.
// Run: node test/orch-gate-bash.test.js  — exits non-zero on any failed assertion.
//
// Strategy: pipe synthetic PreToolUse JSON into the hook and check exit codes.
//   - ORCH_PORT=1 makes the daemon unreachable → fail-open (exit 0)
//     for anything that reaches the claim check.
//   - A child-process HTTP stub returns daemon-shaped responses to drive exit-2 paths.
//   - ORCH_GATE_OFF=1 must short-circuit to exit 0 before daemon lookup.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHookStub } = require('./support/hook-http-stub');
const policy = require('../hooks/lib/gate-policy');
const hookkit = require('../hooks/lib/hookkit');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'orch-gate-bash.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-test-'));
const CLAIM_WT = path.join(TMP, 'claimed-wt').replace(/\\/g, '/');
fs.mkdirSync(CLAIM_WT, { recursive: true });

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
}

// Build synthetic hook input JSON
function mkInput(command, sessionId, cwd, agentId) {
  const input = { tool_input: { command }, session_id: sessionId || 'test-session-x' };
  if (cwd) input.cwd = cwd;
  if (agentId) input.agent_id = agentId;
  return JSON.stringify(input);
}

// Run the hook with a given input and env overrides, returns { status, stderr }
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

function bindTurn(parentSession, turnId, childSession) {
  const previous = process.env.ORCH_DATA;
  process.env.ORCH_DATA = TMP;
  try {
    return hookkit.bindTurnSession({
      session_id: parentSession,
      turn_id: turnId,
      tool_input: { session_id: childSession },
    }, {
      id: `permit-${turnId}`,
      workspace: '/graph/test',
      session_id: childSession,
      task_key: 'task-a',
      agent_id: 'logical-worker',
      expires_at: '2099-01-01T00:00:00.000Z',
    }, 'task-a', 'logical-worker');
  } finally {
    if (previous === undefined) delete process.env.ORCH_DATA;
    else process.env.ORCH_DATA = previous;
  }
}

const BLOCKED = { activeClaim: { claimed: false }, sessionInfo: { is_subagent: true } };
const CLAIMED = {
  activeClaim: { claimed: true, claims: [{ key: '42' }] },
  defaultTaskDetail: { task: { metric: null, git: { branch: 'orch/attempt/42', worktree: CLAIM_WT } } },
  executionPermits: [executionPermit('42', CLAIM_WT, 'orch/attempt/42')],
};
const MAIN_BLOCKED = { activeClaim: { claimed: false }, sessionInfo: { is_subagent: false } };

// ── Helper: run with daemon-shaped responses (subagent, no claim → exit 2 if write detected) ──
function runWithConfig(input, config, extra) {
  return withHookStub(config, (stub) => runHook(input, { ...stub.env(), ...extra }));
}
function runBlocked(cmd, extra) {
  return runWithConfig(mkInput(cmd), BLOCKED, extra);
}
function runClaimed(cmd, extra) {
  return runWithConfig(mkInput(cmd), CLAIMED, extra);
}
// Run with daemon unreachable (ORCH_PORT=1, no stub override) → fail-open = exit 0
function runFailOpen(cmd, extra) {
  return runHook(mkInput(cmd), { ORCH_PORT: '1', ...extra });
}

function runMainBlocked(cmd, extra) {
  return runWithConfig(mkInput(cmd), MAIN_BLOCKED, extra);
}

// ────────────────────────────────────────────────────────────────────────────
// Test cases

// Main session: cp write with no in-flight workers → exit 2
{
  const r = runMainBlocked('cp /tmp/x.js /Users/x/proj/lib.js');
  ok('cp write main no workers → exit 2', r.status === 2);
  ok('cp write main no workers message', r.stderr.includes('no in-flight workers'));
}

// Main session trivial bash write with workers → exit 0
{
  const r = runWithConfig(
    mkInput('cp /tmp/x.js /Users/x/proj/lib.js', 'main-disp'),
    {
      activeClaim: { claimed: false },
      sessionInfo: { is_subagent: false },
      dispatcherChildren: { children: [{ task_key: 'local/w1', label: 'worker', agent_id: 'w1', worker_session: 'ws1' }], attribution: 'local/w1', needs_focus: false },
    },
    { CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('main trivial cp with workers → exit 0', r.status === 0);
}

// Main session trivial budget exhausted for bash
{
  const config = {
    activeClaim: { claimed: false },
    sessionInfo: { is_subagent: false },
    dispatcherChildren: { children: [{ task_key: 'local/w1', label: 'worker', agent_id: 'w1', worker_session: 'ws1' }], attribution: 'local/w1', needs_focus: false },
  };
  const cmd = 'cp /tmp/x.js /Users/x/proj/lib.js';
  const [first, second] = withHookStub(config, (stub) => {
    const env = { ...stub.env(), CLAUDE_PLUGIN_DATA: TMP };
    return [runHook(mkInput(cmd, 'main-bash-budget'), env), runHook(mkInput(cmd, 'main-bash-budget'), env)];
  });
  ok('bash first trivial write allowed', first.status === 0);
  ok('bash second trivial write blocked', second.status === 2);
  ok('bash budget exhausted message', second.stderr.includes('trivial patch budget exhausted'));
}

// ────────────────────────────────────────────────────────────────────────────

// 1. No write pattern — pure read
{
  const r = runBlocked('cat foo.js');
  ok('cat foo.js → no write pattern → exit 0', r.status === 0);
}

// 2. Redirect to /tmp → not exempt → exit 2
{
  const r = runBlocked('echo hi > /tmp/scratch.txt');
  ok('redirect to /tmp → blocked for unclaimed subagent → exit 2', r.status === 2);
}

// 3. Redirect to /private/tmp → not exempt → exit 2
{
  const r = runBlocked('echo hi > /private/tmp/scratch.txt');
  ok('redirect to /private/tmp → blocked for unclaimed subagent → exit 2', r.status === 2);
}

// 4. Redirect to non-exempt path → write detected, not exempt → subagent blocked → exit 2
{
  const r = runBlocked('echo hi > /Users/x/proj/main.js');
  ok('redirect to /Users path → blocked for unclaimed subagent → exit 2', r.status === 2);
}

// 5. DEFECT-1 FIX: cp with /tmp SOURCE but non-exempt DEST must be blocked
{
  const r = runBlocked('cp /tmp/evil.js /Users/x/proj/main.js');
  ok('cp /tmp/evil.js /Users/x/proj/main.js → DEST not exempt → exit 2', r.status === 2);
}

// 6. DEFECT-2 FIX: cp with relative destination — write detected, not exempt → exit 2
{
  const r = runBlocked('cp /tmp/x.js file.js');
  ok('cp /tmp/x.js file.js (relative dest) → write detected, not exempt → exit 2', r.status === 2);
}

// 7. cp to /tmp destination → not exempt → exit 2
{
  const r = runBlocked('cp source.js /tmp/dest.js');
  ok('cp to /tmp dest → blocked for unclaimed subagent → exit 2', r.status === 2);
}

// 8. mv to relative path → write detected, not exempt → exit 2
{
  const r = runBlocked('mv old.js new.js');
  ok('mv old.js new.js (relative) → write detected, not exempt → exit 2', r.status === 2);
}

// 9. ORCH_GATE_OFF=1 with a write command → exit 0 (short-circuit)
{
  const r = runHook(
    mkInput('cp /tmp/evil.js /Users/x/proj/main.js'),
    { ORCH_GATE_OFF: '1' },
  );
  ok('ORCH_GATE_OFF=1 with cp write → exit 0 (short-circuit)', r.status === 0);
}

// 10. ORCH_GATE_OFF=1 with redirect write → exit 0
{
  const r = runHook(
    mkInput('echo x > /Users/x/proj/main.js'),
    { ORCH_GATE_OFF: '1' },
  );
  ok('ORCH_GATE_OFF=1 with redirect write → exit 0', r.status === 0);
}

// 11. Claimed session → exit 0 (task claimed, no metric)
{
  const r = runClaimed(`cp /tmp/x.js ${CLAIM_WT}/main.js`);
  ok('claimed session with permit and cp inside worktree → exit 0', r.status === 0);
}

// 12. Fail-open: daemon unreachable → exit 0 even for a write
{
  const r = runFailOpen('cp /tmp/evil.js /Users/x/proj/main.js');
  ok('daemon unreachable (ORCH_PORT=1) → fail-open → exit 0', r.status === 0);
}

// 13. rsync to non-exempt path → blocked
{
  const r = runBlocked('rsync -a /tmp/out/ /Users/x/proj/dist/');
  ok('rsync to /Users path → write detected, not exempt → exit 2', r.status === 2);
}

// 14. sed -i → write detected → blocked for subagent
{
  const r = runBlocked("sed -i '' 's/foo/bar/' lib/main.js");
  ok("sed -i → write detected → exit 2 for unclaimed subagent", r.status === 2);
}

// 15. tee to non-exempt path → blocked
{
  const r = runBlocked('cat foo | tee /Users/x/out.txt');
  ok('tee to non-exempt path → write detected → exit 2 for unclaimed subagent', r.status === 2);
}

// ── Bypass regression tests (all should be blocked: exit 2) ─────────────────

// 16. Redirect token shadows cp dest
{
  const r = runBlocked('cp /tmp/a.js /proj/lib/main.js >/tmp/out.log');
  ok('cp with redirect: cp dest non-exempt even though redir is /tmp → exit 2', r.status === 2);
}

// 17. .log suffix in non-log dir must NOT be exempt
{
  const r = runBlocked('cp /tmp/x.js /proj/lib/main.log');
  ok('cp to .log file outside /tmp or logs/ → exit 2', r.status === 2);
}

// 18. Path traversal via logs/
{
  const r = runBlocked('cp /tmp/x.js /proj/logs/../lib/main.js');
  ok('cp with logs/../ traversal → normalized non-exempt path → exit 2', r.status === 2);
}

// 19. Trailing comment becomes LAST_TOKEN in old logic
{
  const r = runBlocked('cp src.js /proj/lib/evil.js # /tmp/log');
  ok('cp with trailing comment # /tmp/log → comment stripped → exit 2', r.status === 2);
}

// 20. mv + redirect to /tmp should not exempt non-tmp mv dest
{
  const r = runBlocked('mv /tmp/x /proj/lib/main.js >/tmp/ok');
  ok('mv with /tmp redirect but non-exempt mv dest → exit 2', r.status === 2);
}

// 21. stderr redir to /dev/null should not exempt non-exempt cp dest
{
  const r = runBlocked('cp /tmp/x /proj/lib/main.js 2>/dev/null');
  ok('cp with 2>/dev/null stderr redir → cp dest non-exempt → exit 2', r.status === 2);
}

// 22. pathlib Path.write_text bypass regression
{
  const r = runBlocked(
    'python3 -c "from pathlib import Path; Path(\'/Users/x/proj/main.js\').write_text(\'x\')"',
  );
  ok('pathlib write_text → write detected → exit 2 for unclaimed subagent', r.status === 2);
}

// 23. pathlib Path.write_bytes bypass regression
{
  const r = runBlocked(
    'python3 -c "from pathlib import Path; Path(\'/Users/x/out.bin\').write_bytes(b\'x\')"',
  );
  ok('pathlib write_bytes → write detected → exit 2 for unclaimed subagent', r.status === 2);
}

// 24. open().write() still detected (existing .write( coverage)
{
  const r = runBlocked(
    'python3 -c "open(\'/Users/x/proj/main.js\',\'w\').write(\'x\')"',
  );
  ok('open().write() → write detected → exit 2 for unclaimed subagent', r.status === 2);
}

// 25. pathlib Path.touch creates a file
{
  const r = runBlocked(
    'python3 -c "from pathlib import Path; Path(\'/Users/x/proj/touch.js\').touch()"',
  );
  ok('pathlib touch → write detected → exit 2 for unclaimed subagent', r.status === 2);
}

// 25b. shell touch creates a file
{
  const r = runBlocked('touch /Users/x/proj/touch.js');
  ok('shell touch → write detected → exit 2 for unclaimed subagent', r.status === 2);
}

// ── Bypass regression tests for allowed and denied extracted targets ─────────

// 26. Both source and dest in /tmp still require a claim
{
  const r = runBlocked('cp /tmp/x.js /tmp/out.js');
  ok('cp /tmp → /tmp: blocked for unclaimed subagent → exit 2', r.status === 2);
}

// 27. Dest in /private/tmp still requires a claim
{
  const r = runBlocked('cp /tmp/x.js /private/tmp/out.js');
  ok('cp /tmp → /private/tmp: blocked for unclaimed subagent → exit 2', r.status === 2);
}

// 28. .log file under logs/
{
  const r = runBlocked('cp report.txt /proj/logs/report.log');
  ok('cp to logs/*.log: exempt → exit 0', r.status === 0);
}

// 29. cp to filedrop task mint path → exempt → exit 0
{
  const home = process.env.HOME || '/Users/x';
  const r = runBlocked(`cp /tmp/t.json ${home}/.claude/orchestrator/tasks/ws-abc/cursor/t1.json`);
  ok('cp to filedrop task path → exempt → exit 0', r.status === 0);
  const r2 = runBlocked(`cp /tmp/t.json ${home}/repo/.zonoid/tasks/ws-abc/cursor/t1.json`);
  ok('cp to .zonoid filedrop task path → exempt → exit 0', r2.status === 0);
}

// 30. cp to native Claude task path → exempt → exit 0
{
  const home = process.env.HOME || '/Users/x';
  const r = runBlocked(`cp /tmp/t.json ${home}/.claude/tasks/abc-uuid-123/1.json`);
  ok('cp to native task path → exempt → exit 0', r.status === 0);
}

// 31. Claimed non-metric task WITH registered worktree branch → writes must land in the worktree.
{
  const r = runWithConfig(
    mkInput('cp /tmp/x.js /Users/x/proj/main.js'),
    {
      activeClaim: { claimed: true, claims: [{ key: 'local/test-task' }] },
      taskDetails: {
        'local/test-task': { task: { metric: null, git: { branch: 'orch/attempt/local-test-task', worktree: '/some/path' } } },
      },
      executionPermits: [executionPermit('local/test-task', '/some/path', 'orch/attempt/local-test-task')],
    },
  );
  ok('claimed non-metric task with worktree branch outside worktree → exit 2', r.status === 2);
  ok('worktree branch error message mentions task branch', r.stderr.includes('orch/attempt/local-test-task'));
}

// 32. Claimed non-metric task WITHOUT registered worktree branch → exit 2 (permit needs worktree substrate)
//     Simulates: branch_task was NOT called, task.git is null.
{
  const r = runWithConfig(
    mkInput('cp /tmp/x.js /Users/x/proj/main.js'),
    {
      activeClaim: { claimed: true, claims: [{ key: 'local/test-task' }] },
      taskDetails: { 'local/test-task': { task: { metric: null, git: null } } },
    },
  );
  ok('claimed task without worktree branch → exit 2', r.status === 2);
  ok('claimed task without worktree branch → permit/worktree message', r.stderr.includes('registered worktree'));
}

// 32b. Large graph reads can exceed the old 600ms budget; both authoritative lookups must finish
//      before a claimed shell write is allowed.
{
  const worktree = '/some/path';
  const r = runWithConfig(
    mkInput(`cp /tmp/x.js ${worktree}/main.js`),
    {
      activeClaim: { claimed: true, claims: [{ key: 'local/slow-task' }] },
      taskDetails: {
        'local/slow-task': { task: { metric: null, git: { branch: 'orch/attempt/local-slow-task', worktree } } },
      },
      executionPermits: [executionPermit('local/slow-task', worktree, 'orch/attempt/local-slow-task')],
      taskDetailDelayMs: 750,
      executionPermitDelayMs: 750,
    },
  );
  ok('transiently slow task detail and permit preserve fail-closed Bash allow → exit 0', r.status === 0);
}

// ── Multi-claim gate tests ───────────────────────────────────────────────────
// Two synthetic worktree paths under TMP. The bash gate does a string prefix
// check on the extracted write target — these directories need not be real git repos.
// Forward-slash paths mirror what the daemon stores for git worktrees.
const WT_A = path.join(TMP, 'wt-a').replace(/\\/g, '/');
const WT_B = path.join(TMP, 'wt-b').replace(/\\/g, '/');
fs.mkdirSync(WT_A, { recursive: true });
fs.mkdirSync(WT_B, { recursive: true });

// Builds a daemon-stub config that returns two claims with configurable worktrees.
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

// 33. Multi-claim: cp dest inside FIRST claim's worktree → allowed
{
  const destInA = `${WT_A}/src.js`;
  const r = runWithConfig(
    mkInput(`cp /tmp/src.js ${destInA}`),
    makeMultiClaimConfig(),
  );
  ok('multi-claim: cp dest in first claim worktree → exit 0', r.status === 0);
}

// 34. Multi-claim: cp dest inside SECOND claim's worktree → allowed (fixed bug)
{
  const destInB = `${WT_B}/lib.js`;
  const r = runWithConfig(
    mkInput(`cp /tmp/lib.js ${destInB}`),
    makeMultiClaimConfig(),
  );
  ok('multi-claim: cp dest in second claim worktree → exit 0 (fixed bug)', r.status === 0);
}

// 35. Multi-claim: relative cp dest resolves against a claimed worktree → allowed
{
  const r = runWithConfig(
    mkInput('cp /tmp/src.js src.js'),
    makeMultiClaimConfig(),
  );
  ok('multi-claim: relative cp dest resolves inside a worktree → exit 0', r.status === 0);
}

// 36. Multi-claim: cp dest outside BOTH worktrees → denied
{
  const r = runWithConfig(
    mkInput('cp /tmp/x.js /Users/x/other-project/main.js'),
    makeMultiClaimConfig(),
  );
  ok('multi-claim: cp dest outside both worktrees → exit 2', r.status === 2);
  ok('multi-claim: cp dest outside both worktrees → worktree path message', r.stderr.includes('worktree path'));
}

// 37. Multi-claim: first claim has NO worktree, second does → cp to second's worktree → allowed
{
  const destInB = `${WT_B}/index.js`;
  const r = runWithConfig(
    mkInput(`cp /tmp/index.js ${destInB}`),
    makeMultiClaimConfig({ noWtA: true }),
  );
  ok('multi-claim: first claim no worktree, second has worktree, cp to second → exit 0', r.status === 0);
}

// 38. Multi-target: one redirect inside a claimed worktree and one outside → denied
{
  const r = runWithConfig(
    mkInput(`echo ok > ${WT_A}/inside.txt > /Users/x/outside.txt`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: mixed inside/outside redirect targets → exit 2', r.status === 2);
  ok('claimed session: mixed target message names outside path', r.stderr.includes('/Users/x/outside.txt'));
}

// 39. Multi-target: every redirect target is inside a claimed worktree → allowed
{
  const r = runWithConfig(
    mkInput(`echo ok > ${WT_A}/inside-a.txt > ${WT_B}/inside-b.txt`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: every redirect target inside claimed worktrees → exit 0', r.status === 0);
}

// 40. Claimed session: tee target outside every worktree → denied
{
  const r = runWithConfig(
    mkInput('printf ok | tee /Users/x/outside-tee.txt'),
    makeMultiClaimConfig(),
  );
  ok('claimed session: tee outside worktree → exit 2', r.status === 2);
  ok('claimed session: tee message names outside path', r.stderr.includes('/Users/x/outside-tee.txt'));
}

// 41. Claimed session: tee target inside a worktree → allowed
{
  const r = runWithConfig(
    mkInput(`printf ok | tee ${WT_A}/inside-tee.txt`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: tee inside worktree → exit 0', r.status === 0);
}

// 42. Claimed session: no permit for claimed worktree → denied
{
  const config = makeMultiClaimConfig();
  delete config.executionPermits;
  const r = runWithConfig(
    mkInput(`cp /tmp/src.js ${WT_A}/needs-permit.js`),
    config,
  );
  ok('claimed session: inside worktree without permit → exit 2', r.status === 2);
  ok('claimed session: inside worktree without permit message', r.stderr.includes('Subconscious execution permit'));
}

// 43. Claimed session: permit path scope narrower than worktree → denied
{
  const r = runWithConfig(
    mkInput(`cp /tmp/src.js ${WT_A}/outside-scope.js`),
    {
      activeClaim: { claimed: true, claims: [{ key: 'task-a' }] },
      taskDetails: {
        'task-a': { task: { metric: null, git: { branch: 'orch/attempt/task-a', worktree: WT_A } } },
      },
      executionPermit: {
        ok: true,
        execution_permit: executionPermit('task-a', WT_A, 'orch/attempt/task-a', { scope: 'paths', allowed_paths: [`${WT_A}/allowed`] }),
      },
    },
  );
  ok('claimed session: target outside permit path scope → exit 2', r.status === 2);
  ok('claimed session: target outside permit path scope message', r.stderr.includes('permit scope'));
}

// 44. Claimed session: mixed targets need permits for each target/worktree → denied with only one permit
{
  const config = makeMultiClaimConfig();
  config.executionPermits = [executionPermit('task-a', WT_A, 'orch/attempt/task-a')];
  const r = runWithConfig(
    mkInput(`echo ok > ${WT_A}/inside-a.txt > ${WT_B}/inside-b.txt`),
    config,
  );
  ok('claimed session: mixed worktree targets with missing second permit → exit 2', r.status === 2);
}

// 45. Claimed session: pathlib write_text outside every worktree → denied
{
  const r = runWithConfig(
    mkInput('python3 -c "from pathlib import Path; Path(\'/Users/x/outside-python.txt\').write_text(\'x\')"'),
    makeMultiClaimConfig(),
  );
  ok('claimed session: pathlib write_text outside worktree → exit 2', r.status === 2);
  ok('claimed session: pathlib message names outside path', r.stderr.includes('/Users/x/outside-python.txt'));
}

// 46. Claimed session: pathlib write_text inside a worktree → allowed
{
  const r = runWithConfig(
    mkInput(`python3 -c "from pathlib import Path; Path('${WT_A}/inside-python.txt').write_text('x')"`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: pathlib write_text inside worktree → exit 0', r.status === 0);
}

// 46b. Claimed session: shell touch outside every worktree → denied
{
  const r = runWithConfig(
    mkInput('touch /Users/x/outside-touch.txt'),
    makeMultiClaimConfig(),
  );
  ok('claimed session: shell touch outside worktree → exit 2', r.status === 2);
  ok('claimed session: shell touch message names outside path', r.stderr.includes('/Users/x/outside-touch.txt'));
}

// 46c. Claimed session: shell touch inside a worktree → allowed
{
  const r = runWithConfig(
    mkInput(`touch ${WT_A}/inside-touch.txt`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: shell touch inside worktree → exit 0', r.status === 0);
}

// 46d. Claimed session: every shell touch target must stay inside a permitted worktree
{
  const r = runWithConfig(
    mkInput(`touch ${WT_A}/inside-touch.txt /Users/x/outside-touch.txt`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: shell touch mixed targets → exit 2', r.status === 2);
  ok('claimed session: shell touch mixed target message names outside path', r.stderr.includes('/Users/x/outside-touch.txt'));
}

// 47. Claimed session: open(..., "w") outside every worktree → denied
{
  const r = runWithConfig(
    mkInput('python3 -c "open(\'/Users/x/outside-open.txt\', \'w\').write(\'x\')"'),
    makeMultiClaimConfig(),
  );
  ok('claimed session: open write outside worktree → exit 2', r.status === 2);
}

// 47b. SCOPE-ESCAPE REGRESSION: claimed session, inline write to a COMPUTED path (no literal
//      target the gate can extract) must fail CLOSED — previously line 91 allowed any
//      target-less write once a valid permit existed, letting a worker escape its worktree.
{
  const r = runWithConfig(
    mkInput('python3 -c "import os; open(os.environ[\'OUT\'],\'w\').write(\'x\')"'),
    makeMultiClaimConfig(),
  );
  ok('claimed session: computed-path write (no extractable target) → exit 2', r.status === 2);
  ok('claimed session: unverifiable-target message', r.stderr.includes('could not extract a concrete target path'));
}

// NOTE: a write whose target IS extractable but is an UNEXPANDED shell variable (e.g.
// `dd of=$DEST`, `echo x > "$OUT"`) is a SEPARATE escape class — the gate extracts the literal
// token `$DEST`, resolves it under the worktree, and deems it inside. That variable-expansion gap
// is NOT closed by this change (closing it without over-blocking legitimate relative `$VAR` writes
// needs more design) and is tracked separately.

// 47d. Guard: the fix must NOT over-block — a literal-path inline write inside a worktree still allowed
{
  const r = runWithConfig(
    mkInput(`python3 -c "open('${WT_A}/literal-inside.txt','w').write('x')"`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: literal-path inline write inside worktree still → exit 0', r.status === 0);
}

// 48. Claimed session: sed -i target outside every worktree → denied
{
  const r = runWithConfig(
    mkInput("sed -i '' 's/foo/bar/' /Users/x/outside-sed.txt"),
    makeMultiClaimConfig(),
  );
  ok('claimed session: sed -i outside worktree → exit 2', r.status === 2);
  ok('claimed session: sed message names outside path', r.stderr.includes('/Users/x/outside-sed.txt'));
}

// 49. Claimed session: sed -i target inside a worktree → allowed
{
  const r = runWithConfig(
    mkInput(`sed -i '' 's/foo/bar/' ${WT_A}/inside-sed.txt`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: sed -i inside worktree → exit 0', r.status === 0);
}

// 50. Read-only search containing "install" must not trip the install write detector
{
  const r = runBlocked('rg -n "install" bin/install.js');
  ok('read-only rg install query → no write pattern → exit 0', r.status === 0);
}

// ── PowerShell write-pattern regression tests ───────────────────────────────

// 48. PowerShell Set-Content → blocked for unclaimed subagent
{
  const r = runBlocked('Set-Content -Path /Users/x/proj/main.txt -Value hi');
  ok('PowerShell Set-Content to non-exempt path → exit 2', r.status === 2);
}

// 49. PowerShell Add-Content alias → blocked for unclaimed subagent
{
  const r = runBlocked('ac /Users/x/proj/main.txt hi');
  ok('PowerShell ac alias to non-exempt path → exit 2', r.status === 2);
}

// 50. PowerShell Out-File positional target → blocked for unclaimed subagent
{
  const r = runBlocked("'hi' | Out-File /Users/x/proj/out.txt");
  ok('PowerShell Out-File positional target → exit 2', r.status === 2);
}

// 51. PowerShell New-Item → blocked for unclaimed subagent
{
  const r = runBlocked('New-Item -Path /Users/x/proj/new.txt -ItemType File');
  ok('PowerShell New-Item to non-exempt path → exit 2', r.status === 2);
}

// 52. PowerShell Copy-Item destination → blocked for unclaimed subagent
{
  const r = runBlocked('Copy-Item /tmp/src.txt /Users/x/proj/dest.txt');
  ok('PowerShell Copy-Item destination → exit 2', r.status === 2);
}

// 53. PowerShell Move-Item -Destination → blocked for unclaimed subagent
{
  const r = runBlocked('Move-Item -Path /tmp/src.txt -Destination /Users/x/proj/dest.txt');
  ok('PowerShell Move-Item -Destination → exit 2', r.status === 2);
}

// 54. PowerShell Remove-Item alias with switches → blocked for unclaimed subagent
{
  const r = runBlocked('rm -Recurse -Force /Users/x/proj/dead');
  ok('PowerShell rm alias with switches → exit 2', r.status === 2);
}

// 55. PowerShell Set-Content inside a claimed worktree → allowed
{
  const r = runWithConfig(
    mkInput(`Set-Content -Path ${WT_A}/ps.txt -Value ok`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: PowerShell Set-Content inside worktree → exit 0', r.status === 0);
}

// 56. PowerShell mixed inside/outside targets separated by semicolon → denied
{
  const r = runWithConfig(
    mkInput(`Set-Content -Path ${WT_A}/inside.txt -Value ok; Add-Content -Path /Users/x/outside.txt -Value no`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: PowerShell semicolon mixed targets → exit 2', r.status === 2);
  ok('claimed session: PowerShell semicolon message names outside path', r.stderr.includes('/Users/x/outside.txt'));
}

// 57. PowerShell mixed inside/outside targets separated by && → denied
{
  const r = runWithConfig(
    mkInput(`Set-Content ${WT_A}/inside.txt ok && Add-Content /Users/x/outside-and.txt no`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: PowerShell && mixed targets → exit 2', r.status === 2);
  ok('claimed session: PowerShell && message names outside path', r.stderr.includes('/Users/x/outside-and.txt'));
}

// 58. PowerShell mixed inside/outside targets separated by || → denied
{
  const r = runWithConfig(
    mkInput(`Set-Content ${WT_A}/inside.txt ok || Add-Content /Users/x/outside-or.txt no`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: PowerShell || mixed targets → exit 2', r.status === 2);
  ok('claimed session: PowerShell || message names outside path', r.stderr.includes('/Users/x/outside-or.txt'));
}

// 59. PowerShell mixed inside/outside targets separated by single & → denied
{
  const r = runWithConfig(
    mkInput(`Set-Content ${WT_A}/inside.txt ok & Add-Content /Users/x/outside-amp.txt no`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: PowerShell single & mixed targets → exit 2', r.status === 2);
  ok('claimed session: PowerShell single & message names outside path', r.stderr.includes('/Users/x/outside-amp.txt'));
}

// 60. PowerShell Copy-Item compound command keeps each destination across && → denied
{
  const r = runWithConfig(
    mkInput(`Copy-Item /tmp/a.txt /Users/x/outside-copy.txt && Copy-Item /tmp/b.txt ${WT_A}/inside.txt`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: PowerShell Copy-Item && mixed destinations → exit 2', r.status === 2);
  ok('claimed session: PowerShell Copy-Item && message names outside path', r.stderr.includes('/Users/x/outside-copy.txt'));
}

// 61. PowerShell all-stream redirect target → blocked for unclaimed subagent
{
  const r = runBlocked('Write-Output hi *> /Users/x/proj/ps-redirect.txt');
  ok('PowerShell *> redirect to non-exempt path → exit 2', r.status === 2);
}

// 62. PowerShell redirect inside a claimed worktree → allowed
{
  const r = runWithConfig(
    mkInput(`Write-Output ok *> ${WT_A}/ps-redirect.txt`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: PowerShell redirect inside worktree → exit 0', r.status === 0);
}

// 63. PowerShell pipe boundary keeps mixed targets separate → denied
{
  const r = runWithConfig(
    mkInput(`Set-Content ${WT_A}/inside.txt ok | Add-Content /Users/x/outside-pipe.txt no`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: PowerShell pipe mixed targets → exit 2', r.status === 2);
  ok('claimed session: PowerShell pipe message names outside path', r.stderr.includes('/Users/x/outside-pipe.txt'));
}

// 64. Quoted Bash redirect target outside every worktree → denied
{
  const r = runWithConfig(
    mkInput('echo ok > "/Users/x/outside-quoted.txt"'),
    makeMultiClaimConfig(),
  );
  ok('claimed session: quoted Bash redirect outside worktree → exit 2', r.status === 2);
  ok('claimed session: quoted Bash redirect message names outside path', r.stderr.includes('/Users/x/outside-quoted.txt'));
}

// 65. Quoted Bash redirect target inside a claimed worktree → allowed
{
  const r = runWithConfig(
    mkInput(`echo ok > "${WT_A}/inside-quoted.txt"`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: quoted Bash redirect inside worktree → exit 0', r.status === 0);
}

// 66. Standalone read-only git command remains exempt
{
  const r = runBlocked('git status --short');
  ok('standalone git status read → exit 0', r.status === 0);
}

// 66a. Standalone git submodule status is read-only, including safe flags/pathspecs
{
  const plain = runBlocked('git submodule status');
  const flagged = runBlocked('git -C . submodule --quiet status --cached --recursive -- libs/example');
  ok('standalone git submodule status → exit 0', plain.status === 0);
  ok('git submodule status with safe flags/pathspec → exit 0', flagged.status === 0);
}

// 66b. Other git submodule operations remain gated mutators
{
  const mutators = [
    'git submodule update --init',
    'git submodule foreach git status',
    'git submodule add https://example.com/repo.git libs/example',
    'git submodule deinit libs/example',
    'git submodule sync',
    'git submodule set-branch --branch main libs/example',
    'git submodule set-url libs/example https://example.com/repo.git',
    'git submodule unrecognized-operation',
  ];
  for (const command of mutators) {
    const r = runBlocked(command);
    ok(`${command} without claim → exit 2`, r.status === 2);
  }
}

// 66c. Redirected or compound git submodule status falls through to write detection
{
  const redirected = runBlocked('git submodule status > /Users/x/submodule-status.txt');
  const compound = runBlocked('git submodule status && echo hi > /Users/x/submodule-compound.txt');
  ok('redirected git submodule status without claim → exit 2', redirected.status === 2);
  ok('compound git submodule status plus shell write without claim → exit 2', compound.status === 2);
}

// 67. Mutating git commands require a claim/permit path
{
  const add = runBlocked('git add src/main.js');
  const commit = runBlocked('git commit -m "x"');
  const worktree = runBlocked('git worktree add /tmp/wt HEAD');
  ok('git add without claim → exit 2', add.status === 2);
  ok('git commit without claim → exit 2', commit.status === 2);
  ok('git worktree add without claim → exit 2', worktree.status === 2);
}

// 68. Main-session trivial allowance does not cover git mutators
{
  const r = runWithConfig(
    mkInput('git add src/main.js', 'main-git-mutator'),
    {
      activeClaim: { claimed: false },
      sessionInfo: { is_subagent: false },
      dispatcherChildren: { children: [{ task_key: 'local/w1', label: 'worker', agent_id: 'w1', worker_session: 'ws1' }], attribution: 'local/w1', needs_focus: false },
    },
    { CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('main git add with workers still requires claim → exit 2', r.status === 2);
  ok('main git add with workers message', r.stderr.includes('git mutators require an active Subconscious assignment'));
}

// 69. Compound read-only git plus shell write is not exempt
{
  const r = runBlocked('git status && echo hi > /Users/x/git-compound.txt');
  ok('git status && redirect write without claim → exit 2', r.status === 2);
}

// 70. Read-only git with shell redirect is still a shell write
{
  const r = runBlocked('git diff > "/Users/x/diff.patch"');
  ok('git diff redirected to quoted absolute path without claim → exit 2', r.status === 2);
}

// 71. Claimed session blocks git mutator aimed outside the permit worktree with -C
{
  const r = runWithConfig(
    mkInput('git -C /Users/x/outside-repo add file.js'),
    makeMultiClaimConfig(),
  );
  ok('claimed session: git -C outside worktree add → exit 2', r.status === 2);
  ok('claimed session: git -C outside message names repo path', r.stderr.includes('/Users/x/outside-repo'));
}

// 72. Claimed session allows git mutator aimed at a permitted worktree with -C
{
  const r = runWithConfig(
    mkInput(`git -C ${WT_A} add file.js`),
    makeMultiClaimConfig(),
  );
  ok('claimed session: git -C inside permitted worktree add → exit 0', r.status === 0);
}

// 73. Claimed session blocks targetless git mutator when hook cwd is outside the worktree
{
  const r = runWithConfig(
    mkInput('git add file.js', 'test-session-x', '/Users/x/outside-cwd-repo'),
    makeMultiClaimConfig(),
  );
  ok('claimed session: targetless git add with outside cwd → exit 2', r.status === 2);
  ok('claimed session: targetless git add outside cwd message', r.stderr.includes('/Users/x/outside-cwd-repo'));
}

// 74. Claimed session allows targetless git mutator when hook cwd is a permitted worktree
{
  const r = runWithConfig(
    mkInput('git add file.js', 'test-session-x', WT_A),
    makeMultiClaimConfig(),
  );
  ok('claimed session: targetless git add with inside cwd → exit 0', r.status === 0);
}

// 75. Claimed session blocks relative git -C resolved from an outside hook cwd
{
  const outsideCwd = '/Users/x/outside-cwd';
  const r = runWithConfig(
    mkInput('git -C rel-outside add file.js', 'test-session-x', outsideCwd),
    makeMultiClaimConfig(),
  );
  ok('claimed session: relative git -C outside cwd → exit 2', r.status === 2);
  ok('claimed session: relative git -C outside cwd message', r.stderr.includes('/Users/x/outside-cwd/rel-outside'));
}

// 76. Git mutator target collection resolves relative git path options against effective cwd
{
  const outsideCwd = '/Users/x/outside-cwd';
  const cTargets = policy.collectGitMutatorTargets('git -C rel-outside add file.js', outsideCwd);
  const workTreeTargets = policy.collectGitMutatorTargets('git --work-tree rel-worktree add file.js', outsideCwd);
  const gitDirTargets = policy.collectGitMutatorTargets('git --git-dir rel-git add file.js', outsideCwd);
  const effectiveCwdTargets = policy.collectGitMutatorTargets(
    'git -C rel-base --work-tree rel-worktree --git-dir rel-git add file.js',
    outsideCwd,
  );
  ok('policy: relative git -C target resolves against hook cwd', cTargets.includes('/Users/x/outside-cwd/rel-outside'));
  ok('policy: relative --work-tree target resolves against hook cwd', workTreeTargets.includes('/Users/x/outside-cwd/rel-worktree'));
  ok('policy: relative --git-dir target resolves against hook cwd', gitDirTargets.includes('/Users/x/outside-cwd/rel-git'));
  ok('policy: --work-tree after relative -C resolves against effective git cwd', effectiveCwdTargets.includes('/Users/x/outside-cwd/rel-base/rel-worktree'));
  ok('policy: --git-dir after relative -C resolves against effective git cwd', effectiveCwdTargets.includes('/Users/x/outside-cwd/rel-base/rel-git'));
}

// 77. Codex Desktop collaboration child identity overrides the parent payload/session env.
{
  const childSession = 'codex-bash-child-thread';
  const config = makeMultiClaimConfig();
  config.executionPermits = [
    executionPermit('task-a', WT_A, 'orch/attempt/task-a', { session_id: childSession }),
    executionPermit('task-b', WT_B, 'orch/attempt/task-b', { session_id: childSession }),
  ];
  const r = runWithConfig(
    mkInput(`printf child > ${WT_A}/child-session.txt`, 'codex-parent-payload', WT_A),
    config,
    { CODEX_THREAD_ID: childSession, CODEX_SESSION_ID: 'codex-parent-runtime' },
  );
  ok('CODEX_THREAD_ID child permit overrides parent payload for Bash gate → exit 0', r.status === 0);
}

// 78. A Codex hook transport UUID is not the logical permit assignee.
{
  const transportSession = '01a05606-303e-7342-af86-80d33d596727';
  const config = makeMultiClaimConfig();
  config.executionPermits = [
    executionPermit('task-a', WT_A, 'orch/attempt/task-a', {
      session_id: transportSession,
      agent_id: 'logical-worker',
    }),
  ];
  const transport = runWithConfig(
    mkInput(
      `printf child > ${WT_A}/transport-agent.txt`,
      'test-session-x',
      WT_A,
      transportSession,
    ),
    config,
  );
  const wrongLogical = runWithConfig(
    mkInput(`printf denied > ${WT_A}/wrong-logical.txt`, 'test-session-x', WT_A, 'different-logical-worker'),
    config,
  );
  ok('Bash transport UUID uses its matching session/task/worktree permit → exit 0', transport.status === 0);
  ok('Bash different logical non-UUID agent remains denied → exit 2', wrongLogical.status === 2);
}

// 79. Desktop transcript metadata and the matching top-level transport agent prove that a child
//     may override the parent CODEX_THREAD_ID for Bash too.
{
  const parentSession = '01a05418-cf8c-7a00-adc2-0b13eee860ca';
  const childSession = '01a05606-303e-7342-af86-80d33d596727';
  const windowId = '01a05606-303e-7342-af86-80ef3c3c6d7c';
  const transcriptPath = path.join(TMP, 'desktop-bash-child.jsonl');
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
  const config = makeMultiClaimConfig();
  config.executionPermits = [
    executionPermit('task-a', WT_A, 'orch/attempt/task-a', {
      session_id: childSession,
      agent_id: 'logical-worker',
    }),
  ];
  const input = {
    session_id: windowId,
    agent_id: childSession,
    transcript_path: transcriptPath,
    cwd: WT_A,
    tool_input: { command: `printf child > ${WT_A}/desktop-transcript.txt` },
  };
  const desktopEnv = { CODEX_THREAD_ID: parentSession, CODEX_SESSION_ID: parentSession, ORCH_DATA: TMP };
  const r = runWithConfig(JSON.stringify(input), config, desktopEnv);
  ok('Bash Desktop proven child overrides parent CODEX_THREAD_ID → exit 0', r.status === 0);

  const noTranscript = {
    session_id: parentSession,
    agent_id: childSession,
    cwd: WT_A,
    tool_input: { command: `printf child > ${WT_A}/desktop-no-transcript.txt` },
  };
  ok('Bash undocumented host UUID cannot override parent CODEX_THREAD_ID without a turn binding → exit 2',
    runWithConfig(JSON.stringify(noTranscript), config, desktopEnv).status === 2);
  const boundTurn = 'desktop-bash-turn';
  ok('Bash validated test setup persists parent+turn child binding', bindTurn(parentSession, boundTurn, childSession) === true);
  const boundInput = {
    session_id: parentSession,
    turn_id: boundTurn,
    cwd: WT_A,
    tool_input: { command: `printf child > ${WT_A}/desktop-bound-turn.txt` },
  };
  ok('Bash documented parent+turn binding allows the child permit → exit 0',
    runWithConfig(JSON.stringify(boundInput), config, desktopEnv).status === 0);
  ok('Bash different turn cannot borrow the child permit → exit 2',
    runWithConfig(JSON.stringify({ ...boundInput, turn_id: 'desktop-bash-other-turn' }), config, desktopEnv).status === 2);
  ok('Bash different parent cannot borrow the child permit → exit 2',
    runWithConfig(JSON.stringify({ ...boundInput, session_id: 'desktop-bash-other-parent' }), config, desktopEnv).status === 2);
  ok('Bash tool_input UUID cannot override parent CODEX_THREAD_ID without a transcript → exit 2',
    runWithConfig(JSON.stringify({
      ...noTranscript,
      agent_id: undefined,
      tool_input: { ...noTranscript.tool_input, agent_id: childSession },
    }), config, desktopEnv).status === 2);
  ok('Bash arbitrary tool_input session_id cannot establish a child turn binding → exit 2',
    runWithConfig(JSON.stringify({
      session_id: parentSession,
      turn_id: 'desktop-bash-unbound-input',
      cwd: WT_A,
      tool_input: { command: `printf denied > ${WT_A}/desktop-tool-input-session.txt`, session_id: childSession },
    }), config, desktopEnv).status === 2);
  ok('Bash non-UUID top-level logical agent cannot become the hook session → exit 2',
    runWithConfig(JSON.stringify({ ...noTranscript, agent_id: 'logical-worker' }), config, desktopEnv).status === 2);
  ok('Bash absent top-level agent retains parent CODEX_THREAD_ID → exit 2',
    runWithConfig(JSON.stringify({ ...noTranscript, agent_id: undefined }), config, desktopEnv).status === 2);
  const parentConfig = makeMultiClaimConfig();
  parentConfig.executionPermits = [
    executionPermit('task-a', WT_A, 'orch/attempt/task-a', {
      session_id: parentSession,
      agent_id: 'logical-worker',
    }),
  ];
  ok('Bash top-level agent equal to CODEX_THREAD_ID keeps the parent session unchanged → exit 0',
    runWithConfig(JSON.stringify({ ...noTranscript, agent_id: parentSession }), parentConfig, desktopEnv).status === 0);
  const wrongSessionConfig = makeMultiClaimConfig();
  wrongSessionConfig.executionPermits = [
    executionPermit('task-a', WT_A, 'orch/attempt/task-a', {
      session_id: '01a05606-303e-7342-af86-999999999999',
      agent_id: 'logical-worker',
    }),
  ];
  ok('Bash Desktop host UUID still requires a matching permit session → exit 2',
    runWithConfig(JSON.stringify(noTranscript), wrongSessionConfig, desktopEnv).status === 2);
  const malformedTranscript = path.join(TMP, 'desktop-bash-malformed.jsonl');
  fs.writeFileSync(malformedTranscript, '{not-json\n');
  ok('Bash malformed transcript remains fail-closed instead of falling back to the host UUID → exit 2',
    runWithConfig(JSON.stringify({ ...noTranscript, transcript_path: malformedTranscript }), config, desktopEnv).status === 2);

  ok('Bash tool_input agent_id cannot authorize the Desktop child override → exit 2',
    runWithConfig(JSON.stringify({
      ...input,
      agent_id: undefined,
      tool_input: { ...input.tool_input, agent_id: childSession },
    }), config, desktopEnv).status === 2);
  ok('Bash different top-level transport session does not borrow the child permit → exit 2',
    runWithConfig(JSON.stringify({ ...input, agent_id: '01a05606-303e-7342-af86-111111111111' }), config, desktopEnv).status === 2);

  const maliciousWindow = '01a05606-303e-7342-af86-222222222222';
  const maliciousTranscript = path.join(TMP, 'desktop-bash-wrong-parent.jsonl');
  fs.writeFileSync(maliciousTranscript, `${JSON.stringify({
    type: 'session_meta',
    payload: {
      id: childSession,
      session_id: '01a05418-cf8c-7a00-adc2-333333333333',
      parent_thread_id: '01a05418-cf8c-7a00-adc2-333333333333',
      context_window: { window_id: maliciousWindow },
    },
  })}\n`);
  ok('Bash transcript window bound to a different parent cannot override CODEX_THREAD_ID → exit 2',
    runWithConfig(JSON.stringify({
      ...input,
      session_id: maliciousWindow,
      transcript_path: maliciousTranscript,
    }), config, desktopEnv).status === 2);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
