#!/usr/bin/env node
// Tests for hooks/orch-gate-bash.sh pattern-detection and allowlist logic.
// Run: node test/orch-gate-bash.test.js  — exits non-zero on any failed assertion.
//
// Strategy: pipe synthetic PreToolUse JSON into the hook and check exit codes.
//   - ORCH_PORT=1 makes curl time out immediately → daemon unreachable → fail-open (exit 0)
//     for anything that reaches the claim check.
//   - A stub `curl` on PATH returns a "subagent, no claim" response to drive exit-2 paths.
//   - ORCH_GATE_OFF=1 must short-circuit to exit 0 before any curl.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'orch-gate-bash.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-test-'));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
}

// Build synthetic hook input JSON
function mkInput(command, sessionId) {
  return JSON.stringify({ tool_input: { command }, session_id: sessionId || 'test-session-x' });
}

// Run the hook with a given input and env overrides, returns { status, stderr }
function runHook(input, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  const r = spawnSync('bash', [HOOK], {
    input,
    encoding: 'utf8',
    env,
  });
  return { status: r.status, stderr: r.stderr || '' };
}

// ── Stub curl dir: returns a subagent-no-claim response so the gate blocks ──
// We prepend a dir containing a `curl` stub to PATH.
const stubDir = path.join(TMP, 'stub-blocked');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(
  path.join(stubDir, 'curl'),
  '#!/bin/bash\n# URL is $@ — extract the path to decide what to return\nU="${@: -1}"\nif [[ "$U" == *"/active-claim"* ]]; then\n  echo \'{"claimed":false}\'\nelif [[ "$U" == *"/session-info"* ]]; then\n  echo \'{"is_subagent":"true"}\'\nfi\nexit 0\n',
  { mode: 0o755 },
);

// Stub curl that returns a claimed session
const stubDirClaimed = path.join(TMP, 'stub-claimed');
fs.mkdirSync(stubDirClaimed, { recursive: true });
fs.writeFileSync(
  path.join(stubDirClaimed, 'curl'),
  '#!/bin/bash\nU="${@: -1}"\nif [[ "$U" == *"/active-claim"* ]]; then\n  echo \'{"claimed":true,"claims":[{"key":"42"}]}\'\nelif [[ "$U" == *"/task/detail"* ]]; then\n  echo \'{"task":{"metric":null}}\'\nfi\nexit 0\n',
  { mode: 0o755 },
);

// ── Helper: run with stub-blocked curl (subagent, no claim → exit 2 if write detected) ──
function runBlocked(cmd, extra) {
  return runHook(mkInput(cmd), { PATH: stubDir + ':' + process.env.PATH, ...extra });
}
function runClaimed(cmd, extra) {
  return runHook(mkInput(cmd), { PATH: stubDirClaimed + ':' + process.env.PATH, ...extra });
}
// Run with daemon unreachable (ORCH_PORT=1, no stub override) → fail-open = exit 0
function runFailOpen(cmd, extra) {
  return runHook(mkInput(cmd), { ORCH_PORT: '1', ...extra });
}

// Stub curl: main session with no claim
const stubDirMain = path.join(TMP, 'stub-main');
fs.mkdirSync(stubDirMain, { recursive: true });
fs.writeFileSync(
  path.join(stubDirMain, 'curl'),
  '#!/bin/bash\nU="${@: -1}"\nif [[ "$U" == *"/active-claim"* ]]; then\n  echo \'{"claimed":false}\'\nelif [[ "$U" == *"/session-info"* ]]; then\n  echo \'{"is_subagent":false}\'\nfi\nexit 0\n',
  { mode: 0o755 },
);

function runMainBlocked(cmd, extra) {
  return runHook(mkInput(cmd), { PATH: stubDirMain + ':' + process.env.PATH, ...extra });
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
  const stubDirTrivial = path.join(TMP, 'stub-main-trivial');
  fs.mkdirSync(stubDirTrivial, { recursive: true });
  fs.writeFileSync(path.join(stubDirTrivial, 'curl'), "#!/bin/bash\nU=\"${@: -1}\"\nif [[ \"$U\" == *\"/active-claim\"* ]]; then\n  echo '{\"claimed\":false}'\nelif [[ \"$U\" == *\"/session-info\"* ]]; then\n  echo '{\"is_subagent\":false}'\nelif [[ \"$U\" == *\"/dispatcher/children\"* ]]; then\n  echo '{\"children\":[{\"task_key\":\"local/w1\",\"label\":\"worker\",\"agent_id\":\"w1\",\"worker_session\":\"ws1\"}],\"attribution\":\"local/w1\",\"needs_focus\":false}'\nfi\nexit 0\n", { mode: 0o755 });
  const r = runHook(
    mkInput('cp /tmp/x.js /Users/x/proj/lib.js', 'main-disp'),
    { PATH: stubDirTrivial + ':' + process.env.PATH, CLAUDE_PLUGIN_DATA: TMP },
  );
  ok('main trivial cp with workers → exit 0', r.status === 0);
}

// Main session trivial budget exhausted for bash
{
  const stubDirTrivial = path.join(TMP, 'stub-main-budget');
  fs.mkdirSync(stubDirTrivial, { recursive: true });
  fs.writeFileSync(path.join(stubDirTrivial, 'curl'), "#!/bin/bash\nU=\"${@: -1}\"\nif [[ \"$U\" == *\"/active-claim\"* ]]; then\n  echo '{\"claimed\":false}'\nelif [[ \"$U\" == *\"/session-info\"* ]]; then\n  echo '{\"is_subagent\":false}'\nelif [[ \"$U\" == *\"/dispatcher/children\"* ]]; then\n  echo '{\"children\":[{\"task_key\":\"local/w1\",\"label\":\"worker\",\"agent_id\":\"w1\",\"worker_session\":\"ws1\"}],\"attribution\":\"local/w1\",\"needs_focus\":false}'\nfi\nexit 0\n", { mode: 0o755 });
  const env = { PATH: stubDirTrivial + ':' + process.env.PATH, CLAUDE_PLUGIN_DATA: TMP };
  const cmd = 'cp /tmp/x.js /Users/x/proj/lib.js';
  const first = runHook(mkInput(cmd, 'main-bash-budget'), env);
  const second = runHook(mkInput(cmd, 'main-bash-budget'), env);
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

// 2. Redirect to /tmp → exempt target → exit 0
{
  const r = runBlocked('echo hi > /tmp/scratch.txt');
  ok('redirect to /tmp → exempt → exit 0', r.status === 0);
}

// 3. Redirect to /private/tmp → exempt → exit 0
{
  const r = runBlocked('echo hi > /private/tmp/scratch.txt');
  ok('redirect to /private/tmp → exempt → exit 0', r.status === 0);
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

// 7. cp to /tmp destination → exempt → exit 0
{
  const r = runBlocked('cp source.js /tmp/dest.js');
  ok('cp to /tmp dest → exempt → exit 0', r.status === 0);
}

// 8. mv to relative path → write detected, not exempt → exit 2
{
  const r = runBlocked('mv old.js new.js');
  ok('mv old.js new.js (relative) → write detected, not exempt → exit 2', r.status === 2);
}

// 9. ORCH_GATE_OFF=1 with a write command → exit 0 (short-circuit)
{
  // Use the blocked stub — it would return exit 2 if reached, but ORCH_GATE_OFF must short-circuit
  const r = runHook(
    mkInput('cp /tmp/evil.js /Users/x/proj/main.js'),
    { PATH: stubDir + ':' + process.env.PATH, ORCH_GATE_OFF: '1' },
  );
  ok('ORCH_GATE_OFF=1 with cp write → exit 0 (short-circuit)', r.status === 0);
}

// 10. ORCH_GATE_OFF=1 with redirect write → exit 0
{
  const r = runHook(
    mkInput('echo x > /Users/x/proj/main.js'),
    { PATH: stubDir + ':' + process.env.PATH, ORCH_GATE_OFF: '1' },
  );
  ok('ORCH_GATE_OFF=1 with redirect write → exit 0', r.status === 0);
}

// 11. Claimed session → exit 0 (task claimed, no metric)
{
  const r = runClaimed('cp /tmp/x.js /Users/x/proj/main.js');
  ok('claimed session with cp → exit 0', r.status === 0);
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

// ── Bypass regression tests (all should be allowed: exit 0) ─────────────────

// 26. Both source and dest in /tmp
{
  const r = runBlocked('cp /tmp/x.js /tmp/out.js');
  ok('cp /tmp → /tmp: both exempt → exit 0', r.status === 0);
}

// 27. Dest in /private/tmp
{
  const r = runBlocked('cp /tmp/x.js /private/tmp/out.js');
  ok('cp /tmp → /private/tmp: exempt → exit 0', r.status === 0);
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
}

// 30. cp to native Claude task path → exempt → exit 0
{
  const home = process.env.HOME || '/Users/x';
  const r = runBlocked(`cp /tmp/t.json ${home}/.claude/tasks/abc-uuid-123/1.json`);
  ok('cp to native task path → exempt → exit 0', r.status === 0);
}

// 31. Claimed non-metric task WITH registered worktree branch → must be on orch/attempt/* branch
//     Simulates: branch_task was called, task has git.branch set, but session is writing on main.
{
  const stubWorktreeEnforce = path.join(TMP, 'stub-worktree-enforce');
  fs.mkdirSync(stubWorktreeEnforce, { recursive: true });
  // Return a task with git.branch set (worktree registered), no metric
  fs.writeFileSync(
    path.join(stubWorktreeEnforce, 'curl'),
    '#!/bin/bash\nU="${@: -1}"\nif [[ "$U" == *"/active-claim"* ]]; then\n  echo \'{"claimed":true,"claims":[{"key":"local/test-task"}]}\'\nelif [[ "$U" == *"/task/detail"* ]]; then\n  echo \'{"task":{"metric":null,"git":{"branch":"orch/attempt/local-test-task","worktree":"/some/path"}}}\'\nfi\nexit 0\n',
    { mode: 0o755 },
  );
  // git stub that returns a non-worktree branch (main)
  const stubGit = path.join(stubWorktreeEnforce, 'git');
  fs.writeFileSync(stubGit, '#!/bin/bash\necho "main"\n', { mode: 0o755 });
  const r = runHook(
    mkInput('cp /tmp/x.js /Users/x/proj/main.js'),
    { PATH: stubWorktreeEnforce + ':' + process.env.PATH },
  );
  ok('claimed non-metric task with worktree branch on main → exit 2', r.status === 2);
  ok('worktree branch error message mentions task branch', r.stderr.includes('orch/attempt/local-test-task'));
}

// 32. Claimed non-metric task WITHOUT registered worktree branch → exit 0 (no isolation required)
//     Simulates: branch_task was NOT called, task.git is null.
{
  const stubNoWorktree = path.join(TMP, 'stub-no-worktree');
  fs.mkdirSync(stubNoWorktree, { recursive: true });
  fs.writeFileSync(
    path.join(stubNoWorktree, 'curl'),
    '#!/bin/bash\nU="${@: -1}"\nif [[ "$U" == *"/active-claim"* ]]; then\n  echo \'{"claimed":true,"claims":[{"key":"local/test-task"}]}\'\nelif [[ "$U" == *"/task/detail"* ]]; then\n  echo \'{"task":{"metric":null,"git":null}}\'\nfi\nexit 0\n',
    { mode: 0o755 },
  );
  const r = runHook(
    mkInput('cp /tmp/x.js /Users/x/proj/main.js'),
    { PATH: stubNoWorktree + ':' + process.env.PATH },
  );
  ok('claimed task without worktree branch → exit 0 (no isolation enforced)', r.status === 0);
}

// ── Multi-claim gate tests ───────────────────────────────────────────────────
// Two synthetic worktree paths under TMP. The bash gate does a string prefix
// check on the extracted write target — these directories need not be real git repos.
const WT_A = path.join(TMP, 'wt-a');
const WT_B = path.join(TMP, 'wt-b');
fs.mkdirSync(WT_A, { recursive: true });
fs.mkdirSync(WT_B, { recursive: true });

// Builds a curl stub that returns two claims with configurable worktrees.
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

// 33. Multi-claim: cp dest inside FIRST claim's worktree → allowed
{
  const stubMultiA = path.join(TMP, 'stub-multi-claim-a');
  makeMultiClaimStub(stubMultiA);
  const destInA = path.join(WT_A, 'src.js');
  const r = runHook(
    mkInput(`cp /tmp/src.js ${destInA}`),
    { PATH: stubMultiA + ':' + process.env.PATH },
  );
  ok('multi-claim: cp dest in first claim worktree → exit 0', r.status === 0);
}

// 34. Multi-claim: cp dest inside SECOND claim's worktree → allowed (fixed bug)
{
  const stubMultiB = path.join(TMP, 'stub-multi-claim-b');
  makeMultiClaimStub(stubMultiB);
  const destInB = path.join(WT_B, 'lib.js');
  const r = runHook(
    mkInput(`cp /tmp/lib.js ${destInB}`),
    { PATH: stubMultiB + ':' + process.env.PATH },
  );
  ok('multi-claim: cp dest in second claim worktree → exit 0 (fixed bug)', r.status === 0);
}

// 35. Multi-claim: cp dest outside BOTH worktrees → denied
{
  const stubMultiOut = path.join(TMP, 'stub-multi-claim-out');
  makeMultiClaimStub(stubMultiOut);
  const r = runHook(
    mkInput('cp /tmp/x.js /Users/x/other-project/main.js'),
    { PATH: stubMultiOut + ':' + process.env.PATH },
  );
  ok('multi-claim: cp dest outside both worktrees → exit 2', r.status === 2);
  ok('multi-claim: cp dest outside both worktrees → worktree path message', r.stderr.includes('worktree path'));
}

// 36. Multi-claim: first claim has NO worktree, second does → cp to second's worktree → allowed
{
  const stubFirstNoWt = path.join(TMP, 'stub-multi-first-no-wt');
  makeMultiClaimStub(stubFirstNoWt, { noWtA: true });
  const destInB = path.join(WT_B, 'index.js');
  const r = runHook(
    mkInput(`cp /tmp/index.js ${destInB}`),
    { PATH: stubFirstNoWt + ':' + process.env.PATH },
  );
  ok('multi-claim: first claim no worktree, second has worktree, cp to second → exit 0', r.status === 0);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
