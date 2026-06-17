#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHookStub } = require('./support/hook-http-stub');

const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-policy-parity-'));
const WT = path.join(TMP, 'wt').replace(/\\/g, '/');
fs.mkdirSync(WT, { recursive: true });

const DIRECT_WRITE = [process.execPath, [path.join(REPO, 'hooks', 'orch-gate.js')]];
const SHELL_WRITE = ['bash', [path.join(REPO, 'hooks', 'orch-gate.sh')]];
const CURSOR_WRITE = ['bash', [path.join(REPO, 'adapters', 'cursor', 'orch-gate.sh')]];
const CODEX_WRITE = ['bash', [path.join(REPO, 'adapters', 'codex', 'hooks', 'orch-gate.sh')]];
const DIRECT_BASH = [process.execPath, [path.join(REPO, 'hooks', 'orch-gate-bash.js')]];
const SHELL_BASH = ['bash', [path.join(REPO, 'hooks', 'orch-gate-bash.sh')]];
const CURSOR_BASH = ['bash', [path.join(REPO, 'adapters', 'cursor', 'shell-gate.sh')]];
const CODEX_BASH = ['bash', [path.join(REPO, 'adapters', 'codex', 'hooks', 'orch-gate-bash.sh')]];

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
    fail++;
  }
}

function run(runner, input, env) {
  const [cmd, args] = runner;
  const result = spawnSync(cmd, args, {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function writeInput(filePath) {
  return {
    session_id: 'parity-session',
    tool_name: 'Write',
    tool_input: { file_path: filePath, new_string: 'x' },
  };
}

function patchInput(patch) {
  return {
    session_id: 'parity-session',
    tool_name: 'apply_patch',
    tool_input: { input: patch },
  };
}

function bashInput(command) {
  return {
    session_id: 'parity-session',
    tool_name: 'Bash',
    tool_input: { command },
  };
}

function claimedConfig() {
  return {
    activeClaim: { claimed: true, claims: [{ key: 'parity/task' }] },
    taskDetails: {
      'parity/task': {
        task: { metric: null, git: { branch: 'orch/attempt/parity-task', worktree: WT } },
      },
    },
  };
}

function envFor(stub) {
  return {
    ...process.env,
    ...stub.env(),
    ZONOID_ROOT: REPO,
    CLAUDE_PLUGIN_DATA: TMP,
  };
}

function denyJson(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return parsed &&
      parsed.hookSpecificOutput &&
      parsed.hookSpecificOutput.permissionDecision === 'deny';
  } catch {
    return false;
  }
}

function expectExit(label, runner, input, config, expectedStatus) {
  withHookStub(config, (stub) => {
    const r = run(runner, input, envFor(stub));
    ok(label, r.status === expectedStatus, `status=${r.status} stderr=${r.stderr.trim()}`);
  });
}

function expectCodexDeny(label, runner, input, config) {
  withHookStub(config, (stub) => {
    const r = run(runner, input, envFor(stub));
    ok(`${label} exits 0`, r.status === 0, `status=${r.status} stderr=${r.stderr.trim()}`);
    ok(`${label} emits deny JSON`, denyJson(r.stdout), JSON.stringify(r.stdout.trim()));
  });
}

function expectCodexAllow(label, runner, input, config) {
  withHookStub(config, (stub) => {
    const r = run(runner, input, envFor(stub));
    ok(label, r.status === 0 && !denyJson(r.stdout), `status=${r.status} stdout=${r.stdout.trim()} stderr=${r.stderr.trim()}`);
  });
}

const blocked = { activeClaim: { claimed: false }, sessionInfo: { is_subagent: true } };
const sourceWrite = writeInput('/Users/x/proj/src.js');

expectExit('direct Node write gate denies no-claim source write', DIRECT_WRITE, sourceWrite, blocked, 2);
expectExit('shell write gate denies no-claim source write', SHELL_WRITE, sourceWrite, blocked, 2);
expectExit('Cursor write relay denies no-claim source write', CURSOR_WRITE, sourceWrite, blocked, 2);
expectCodexDeny('Codex write relay denies no-claim source write', CODEX_WRITE, sourceWrite, blocked);

const tmpBash = bashInput('echo hi > /tmp/parity.txt');
expectExit('direct Node bash gate denies /tmp write', DIRECT_BASH, tmpBash, blocked, 2);
expectExit('shell bash gate denies /tmp write', SHELL_BASH, tmpBash, blocked, 2);
expectExit('Cursor shell relay denies /tmp write', CURSOR_BASH, tmpBash, blocked, 2);
expectCodexDeny('Codex bash relay denies /tmp write', CODEX_BASH, tmpBash, blocked);

const mintWrite = writeInput('/Users/x/.claude/orchestrator/tasks/ws/codex/t1.json');
expectExit('direct Node write gate allows file-drop mint path', DIRECT_WRITE, mintWrite, blocked, 0);
expectExit('shell write gate allows file-drop mint path', SHELL_WRITE, mintWrite, blocked, 0);
expectExit('Cursor write relay allows file-drop mint path', CURSOR_WRITE, mintWrite, blocked, 0);
expectCodexAllow('Codex write relay allows file-drop mint path', CODEX_WRITE, mintWrite, blocked);

const insideClaim = writeInput(`${WT}/src/main.js`);
expectExit('direct Node write gate allows claimed worktree path', DIRECT_WRITE, insideClaim, claimedConfig(), 0);
expectExit('shell write gate allows claimed worktree path', SHELL_WRITE, insideClaim, claimedConfig(), 0);
expectExit('Cursor write relay allows claimed worktree path', CURSOR_WRITE, insideClaim, claimedConfig(), 0);
expectCodexAllow('Codex write relay allows claimed worktree path', CODEX_WRITE, insideClaim, claimedConfig());

const outsideClaim = writeInput('/Users/x/other/main.js');
expectExit('direct Node write gate denies claimed out-of-worktree path', DIRECT_WRITE, outsideClaim, claimedConfig(), 2);
expectExit('shell write gate denies claimed out-of-worktree path', SHELL_WRITE, outsideClaim, claimedConfig(), 2);
expectExit('Cursor write relay denies claimed out-of-worktree path', CURSOR_WRITE, outsideClaim, claimedConfig(), 2);
expectCodexDeny('Codex write relay denies claimed out-of-worktree path', CODEX_WRITE, outsideClaim, claimedConfig());

const outsidePatch = patchInput([
  '*** Begin Patch',
  '*** Update File: /Users/x/other/main.js',
  '@@',
  '-old',
  '+new',
  '*** End Patch',
].join('\n'));
expectExit('direct Node write gate denies apply_patch out-of-worktree path', DIRECT_WRITE, outsidePatch, claimedConfig(), 2);
expectExit('shell write gate denies apply_patch out-of-worktree path', SHELL_WRITE, outsidePatch, claimedConfig(), 2);
expectExit('Cursor write relay denies apply_patch out-of-worktree path', CURSOR_WRITE, outsidePatch, claimedConfig(), 2);
expectCodexDeny('Codex write relay denies apply_patch out-of-worktree path', CODEX_WRITE, outsidePatch, claimedConfig());

fs.rmSync(TMP, { recursive: true, force: true });
console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
