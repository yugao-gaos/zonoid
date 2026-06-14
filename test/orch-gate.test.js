#!/usr/bin/env node
// Tests for hooks/orch-gate.sh path allowlist and claim-check logic.
// Run: node test/orch-gate.test.js  — exits non-zero on any failed assertion.
//
// Strategy: pipe synthetic PreToolUse JSON into the hook and check exit codes.
//   - A stub `curl` on PATH returns a "subagent, no claim" response to drive exit-2 paths.
//   - Task mint paths (~/.claude/tasks/*, ~/.claude/orchestrator/tasks/*) must exit 0
//     even when the stub reports no claim.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// Stub curl: subagent with no claim → would block non-exempt paths
const stubDir = path.join(TMP, 'stub-blocked');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(
  path.join(stubDir, 'curl'),
  '#!/bin/bash\nU="${@: -1}"\nif [[ "$U" == *"/active-claim"* ]]; then\n  echo \'{"claimed":false}\'\nelif [[ "$U" == *"/session-info"* ]]; then\n  echo \'{"is_subagent":"true"}\'\nfi\nexit 0\n',
  { mode: 0o755 },
);

function runBlocked(filePath, extra) {
  return runHook(mkInput(filePath), { PATH: stubDir + ':' + process.env.PATH, ...extra });
}

// Stub curl: main session with no claim → blocks non-exempt paths
const stubDirMain = path.join(TMP, 'stub-main');
fs.mkdirSync(stubDirMain, { recursive: true });
fs.writeFileSync(
  path.join(stubDirMain, 'curl'),
  '#!/bin/bash\nU="${@: -1}"\nif [[ "$U" == *"/active-claim"* ]]; then\n  echo \'{"claimed":false}\'\nelif [[ "$U" == *"/session-info"* ]]; then\n  echo \'{"is_subagent":false}\'\nfi\nexit 0\n',
  { mode: 0o755 },
);

function runMainBlocked(filePath, extra) {
  return runHook(mkInput(filePath), { PATH: stubDirMain + ':' + process.env.PATH, ...extra });
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
  const stubDirTrivial = path.join(TMP, 'stub-main-trivial');
  fs.mkdirSync(stubDirTrivial, { recursive: true });
  fs.writeFileSync(path.join(stubDirTrivial, 'curl'), "#!/bin/bash\nU=\"${@: -1}\"\nif [[ \"$U\" == *\"/active-claim\"* ]]; then\n  echo '{\"claimed\":false}'\nelif [[ \"$U\" == *\"/session-info\"* ]]; then\n  echo '{\"is_subagent\":false}'\nelif [[ \"$U\" == *\"/dispatcher/children\"* ]]; then\n  echo '{\"children\":[{\"task_key\":\"local/w1\",\"label\":\"worker\",\"agent_id\":\"w1\",\"worker_session\":\"ws1\"}],\"attribution\":\"local/w1\",\"needs_focus\":false}'\nfi\nexit 0\n", { mode: 0o755 });
  const r = runHook(
    JSON.stringify({ tool_input: { file_path: '/Users/x/proj/src.js', new_string: 'x=1\n' }, session_id: 'main-disp' }),
    { PATH: stubDirTrivial + ':' + process.env.PATH, CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('main session trivial patch with workers → exit 0', r.status === 0);
}

// 6. Main session trivial budget exhausted → exit 2
{
  const stubDirTrivial = path.join(TMP, 'stub-main-budget');
  fs.mkdirSync(stubDirTrivial, { recursive: true });
  fs.writeFileSync(path.join(stubDirTrivial, 'curl'), "#!/bin/bash\nU=\"${@: -1}\"\nif [[ \"$U\" == *\"/active-claim\"* ]]; then\n  echo '{\"claimed\":false}'\nelif [[ \"$U\" == *\"/session-info\"* ]]; then\n  echo '{\"is_subagent\":false}'\nelif [[ \"$U\" == *\"/dispatcher/children\"* ]]; then\n  echo '{\"children\":[{\"task_key\":\"local/w1\",\"label\":\"worker\",\"agent_id\":\"w1\",\"worker_session\":\"ws1\"}],\"attribution\":\"local/w1\",\"needs_focus\":false}'\nfi\nexit 0\n", { mode: 0o755 });
  const env = { PATH: stubDirTrivial + ':' + process.env.PATH, CLAUDE_PLUGIN_DATA: TMP };
  const sid = 'main-budget';
  const input = JSON.stringify({ tool_input: { file_path: '/Users/x/proj/a.js', new_string: 'a\n' }, session_id: sid });
  const first = runHook(input, env);
  const second = runHook(input, env);
  ok('first trivial patch allowed', first.status === 0);
  ok('second trivial patch blocked', second.status === 2);
  ok('budget exhausted message', second.stderr.includes('trivial patch budget exhausted'));
}

// 7. Main session patch too large → exit 2 with dispatch message
{
  const stubDirTrivial = path.join(TMP, 'stub-main-big');
  fs.mkdirSync(stubDirTrivial, { recursive: true });
  fs.writeFileSync(path.join(stubDirTrivial, 'curl'), "#!/bin/bash\nU=\"${@: -1}\"\nif [[ \"$U\" == *\"/active-claim\"* ]]; then\n  echo '{\"claimed\":false}'\nelif [[ \"$U\" == *\"/session-info\"* ]]; then\n  echo '{\"is_subagent\":false}'\nelif [[ \"$U\" == *\"/dispatcher/children\"* ]]; then\n  echo '{\"children\":[{\"task_key\":\"local/w1\",\"label\":\"worker\",\"agent_id\":\"w1\",\"worker_session\":\"ws1\"}],\"attribution\":\"local/w1\",\"needs_focus\":false}'\nfi\nexit 0\n", { mode: 0o755 });
  const big = 'line\n'.repeat(25);
  const r = runHook(
    JSON.stringify({ tool_input: { file_path: '/Users/x/proj/big.js', new_string: big }, session_id: 'main-big' }),
    { PATH: stubDirTrivial + ':' + process.env.PATH, CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('oversized patch blocked', r.status === 2);
  ok('oversized patch dispatch message', r.stderr.includes('dispatch a subagent'));
}


// 8. Multiple workers without focus → exit 2
{
  const stubDirMulti = path.join(TMP, 'stub-main-multi');
  fs.mkdirSync(stubDirMulti, { recursive: true });
  fs.writeFileSync(path.join(stubDirMulti, 'curl'), [
    '#!/bin/bash',
    'U="${@: -1}"',
    'if [[ "$U" == *"/active-claim"* ]]; then echo \'{"claimed":false}\'',
    'elif [[ "$U" == *"/session-info"* ]]; then echo \'{"is_subagent":false}\'',
    'elif [[ "$U" == *"/dispatcher/children"* ]]; then echo \'{"children":[{"task_key":"local/w1"},{"task_key":"local/w2"}],"needs_focus":true,"attribution":null}\'',
    'fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
  const r = runHook(
    JSON.stringify({ tool_input: { file_path: '/Users/x/proj/src.js', new_string: 'x=1\n' }, session_id: 'main-multi' }),
    { PATH: stubDirMulti + ':' + process.env.PATH, CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('multi-worker without focus blocked', r.status === 2);
  ok('focus message', r.stderr.includes('dispatcher focus'));
}

// 9. Trivial allow posts dispatcher-edit
{
  const stubDirReport = path.join(TMP, 'stub-main-report');
  const marker = path.join(TMP, 'dispatcher-edit-called');
  try { fs.unlinkSync(marker); } catch { /* */ }
  fs.mkdirSync(stubDirReport, { recursive: true });
  const curlStub = [
    '#!/bin/bash',
    'if [[ "$*" == *"/active-claim"* ]]; then echo \'{"claimed":false}\'',
    'elif [[ "$*" == *"/session-info"* ]]; then echo \'{"is_subagent":false}\'',
    'elif [[ "$*" == *"/dispatcher/children"* ]]; then echo \'{"children":[{"task_key":"local/w1","label":"worker","agent_id":"w1","worker_session":"ws1"}],"attribution":"local/w1","needs_focus":false}\'',
    'elif [[ "$*" == *"/usage/dispatcher-edit"* ]]; then touch DISPATCHER_EDIT_MARKER; echo \'{"ok":true}\'',
    'fi',
    'exit 0',
    '',
  ].join('\n').replace('DISPATCHER_EDIT_MARKER', marker);
  fs.writeFileSync(path.join(stubDirReport, 'curl'), curlStub, { mode: 0o755 });
  const r = runHook(
    JSON.stringify({ tool_input: { file_path: '/Users/x/proj/src.js', new_string: 'x=1\n' }, session_id: 'main-report' }),
    { PATH: stubDirReport + ':' + process.env.PATH, CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('trivial patch with attribution exits 0', r.status === 0);
  ok('dispatcher-edit POST fired', fs.existsSync(marker));
}
// ── Multi-claim gate tests ───────────────────────────────────────────────────
// Two synthetic worktree paths under TMP. These directories do NOT need to be
// real git repos — the new gate logic does a string prefix check (is FP inside
// worktree path?), not a `git rev-parse` call.
const WT_A = path.join(TMP, 'wt-a');
const WT_B = path.join(TMP, 'wt-b');
fs.mkdirSync(WT_A, { recursive: true });
fs.mkdirSync(WT_B, { recursive: true });

// Builds a curl stub that:
//  - /active-claim → claimed with two keys
//  - /task/detail?key=task-a → worktree WT_A
//  - /task/detail?key=task-b → worktree WT_B (or no worktree if noWtB=true)
function makeMultiClaimStub(dir, { noWtA = false, noWtB = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const detailA = noWtA
    ? '{"task":{"metric":null,"git":null}}'
    : `{"task":{"metric":null,"git":{"branch":"orch/attempt/task-a","worktree":"${WT_A}"}}}`;
  const detailB = noWtB
    ? '{"task":{"metric":null,"git":null}}'
    : `{"task":{"metric":null,"git":{"branch":"orch/attempt/task-b","worktree":"${WT_B}"}}}`;
  const script = [
    '#!/bin/bash',
    'U="${@: -1}"',
    'if [[ "$U" == *"/active-claim"* ]]; then',
    '  echo \'{"claimed":true,"claims":[{"key":"task-a"},{"key":"task-b"}]}\'',
    'elif [[ "$U" == *"key=task-a"* ]]; then',
    `  echo '${detailA}'`,
    'elif [[ "$U" == *"key=task-b"* ]]; then',
    `  echo '${detailB}'`,
    'fi',
    'exit 0',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'curl'), script, { mode: 0o755 });
}

// 10. Multi-claim: write to FIRST claim's worktree → allowed
{
  const stubMultiA = path.join(TMP, 'stub-multi-claim-a');
  makeMultiClaimStub(stubMultiA);
  const targetInA = path.join(WT_A, 'src.js');
  const r = runHook(mkInput(targetInA), { PATH: stubMultiA + ':' + process.env.PATH });
  ok('multi-claim: write to first claim worktree → exit 0', r.status === 0);
}

// 11. Multi-claim: write to SECOND claim's worktree → allowed (this was the fixed bug)
{
  const stubMultiB = path.join(TMP, 'stub-multi-claim-b');
  makeMultiClaimStub(stubMultiB);
  const targetInB = path.join(WT_B, 'lib.js');
  const r = runHook(mkInput(targetInB), { PATH: stubMultiB + ':' + process.env.PATH });
  ok('multi-claim: write to second claim worktree → exit 0 (fixed bug)', r.status === 0);
}

// 12. Multi-claim: write outside BOTH worktrees → denied
{
  const stubMultiOut = path.join(TMP, 'stub-multi-claim-out');
  makeMultiClaimStub(stubMultiOut);
  const targetOutside = '/Users/x/other-project/main.js';
  const r = runHook(mkInput(targetOutside), { PATH: stubMultiOut + ':' + process.env.PATH });
  ok('multi-claim: write outside both worktrees → exit 2', r.status === 2);
  ok('multi-claim: write outside both worktrees → worktree path message', r.stderr.includes('worktree path'));
}

// 13. Multi-claim: first claim has NO worktree, second does → write to second's worktree → allowed
{
  const stubMultiFirstNoWt = path.join(TMP, 'stub-multi-first-no-wt');
  makeMultiClaimStub(stubMultiFirstNoWt, { noWtA: true });
  const targetInB = path.join(WT_B, 'index.js');
  const r = runHook(mkInput(targetInB), { PATH: stubMultiFirstNoWt + ':' + process.env.PATH });
  ok('multi-claim: first claim no worktree, second has worktree, write to second → exit 0', r.status === 0);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
