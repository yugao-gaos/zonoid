#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withHookStub } = require('./support/hook-http-stub');
const hookkit = require('../hooks/lib/hookkit');
// Resolve the REAL MSYS2 bash rather than whatever PATH offers: on Windows, C:\WINDOWS\system32\bash.exe
// (the WSL relay) shadows it and fails with execvpe(/bin/bash). See test/helpers/bash.js.
const { bashExe } = require('./helpers/bash');

const REPO = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-policy-parity-'));
const WT = path.join(TMP, 'wt').replace(/\\/g, '/');
fs.mkdirSync(WT, { recursive: true });

const DIRECT_WRITE = [process.execPath, [path.join(REPO, 'hooks', 'orch-gate.js')]];
const SHELL_WRITE = [bashExe(), [path.join(REPO, 'hooks', 'orch-gate.sh')]];
const CURSOR_WRITE = [bashExe(), [path.join(REPO, 'adapters', 'cursor', 'orch-gate.sh')]];
const CODEX_WRITE = [bashExe(), [path.join(REPO, 'adapters', 'codex', 'hooks', 'orch-gate.sh')]];
const DIRECT_BASH = [process.execPath, [path.join(REPO, 'hooks', 'orch-gate-bash.js')]];
const SHELL_BASH = [bashExe(), [path.join(REPO, 'hooks', 'orch-gate-bash.sh')]];
const CURSOR_BASH = [bashExe(), [path.join(REPO, 'adapters', 'cursor', 'shell-gate.sh')]];
const CODEX_BASH = [bashExe(), [path.join(REPO, 'adapters', 'codex', 'hooks', 'orch-gate-bash.sh')]];

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
    executionPermits: [{
      id: 'permit-parity-task',
      session_id: 'parity-session',
      task_key: 'parity/task',
      worktree: WT,
      branch: 'orch/attempt/parity-task',
      scope: 'worktree',
      allowed_paths: [WT],
      status: 'active',
      issued_at: '2026-06-21T00:00:00.000Z',
      expires_at: '2099-01-01T00:00:00.000Z',
    }],
  };
}

function envFor(stub, extra = {}) {
  const env = {
    ...process.env,
    ...stub.env(),
    ZONOID_ROOT: REPO,
    CLAUDE_PLUGIN_DATA: TMP,
  };
  delete env.CODEX_THREAD_ID;
  return { ...env, ...extra };
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

function expectExit(label, runner, input, config, expectedStatus, extraEnv = {}) {
  withHookStub(config, (stub) => {
    const r = run(runner, input, envFor(stub, extraEnv));
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

function expectCodexAllow(label, runner, input, config, extraEnv = {}) {
  withHookStub(config, (stub) => {
    const r = run(runner, input, envFor(stub, extraEnv));
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

const touchBash = bashInput('/usr/bin/touch /Users/x/outside-touch.txt');
expectExit('direct Node bash gate denies shell touch', DIRECT_BASH, touchBash, blocked, 2);
expectExit('shell bash gate denies shell touch', SHELL_BASH, touchBash, blocked, 2);
expectExit('Cursor shell relay denies shell touch', CURSOR_BASH, touchBash, blocked, 2);
expectCodexDeny('Codex bash relay denies shell touch', CODEX_BASH, touchBash, blocked);

const mintWrite = writeInput('/Users/x/.claude/orchestrator/tasks/ws/codex/t1.json');
expectExit('direct Node write gate allows file-drop mint path', DIRECT_WRITE, mintWrite, blocked, 0);
expectExit('shell write gate allows file-drop mint path', SHELL_WRITE, mintWrite, blocked, 0);
expectExit('Cursor write relay allows file-drop mint path', CURSOR_WRITE, mintWrite, blocked, 0);
expectCodexAllow('Codex write relay allows file-drop mint path', CODEX_WRITE, mintWrite, blocked);

const zonoidMintWrite = writeInput('/Users/x/repo/.zonoid/tasks/ws/codex/t1.json');
expectExit('direct Node write gate allows .zonoid file-drop mint path', DIRECT_WRITE, zonoidMintWrite, blocked, 0);
expectExit('shell write gate allows .zonoid file-drop mint path', SHELL_WRITE, zonoidMintWrite, blocked, 0);
expectExit('Cursor write relay allows .zonoid file-drop mint path', CURSOR_WRITE, zonoidMintWrite, blocked, 0);
expectCodexAllow('Codex write relay allows .zonoid file-drop mint path', CODEX_WRITE, zonoidMintWrite, blocked);

const insideClaim = writeInput(`${WT}/src/main.js`);
expectExit('direct Node write gate allows claimed worktree path', DIRECT_WRITE, insideClaim, claimedConfig(), 0);
expectExit('shell write gate allows claimed worktree path', SHELL_WRITE, insideClaim, claimedConfig(), 0);
expectExit('Cursor write relay allows claimed worktree path', CURSOR_WRITE, insideClaim, claimedConfig(), 0);
expectCodexAllow('Codex write relay allows claimed worktree path', CODEX_WRITE, insideClaim, claimedConfig());

const insideTouch = bashInput(`touch ${WT}/inside-touch.txt`);
expectExit('direct Node bash gate allows claimed shell touch', DIRECT_BASH, insideTouch, claimedConfig(), 0);
expectExit('shell bash gate allows claimed shell touch', SHELL_BASH, insideTouch, claimedConfig(), 0);
expectExit('Cursor shell relay allows claimed shell touch', CURSOR_BASH, insideTouch, claimedConfig(), 0);
expectCodexAllow('Codex bash relay allows claimed shell touch', CODEX_BASH, insideTouch, claimedConfig());

const desktopParent = '01a05418-cf8c-7a00-adc2-0b13eee860ca';
const desktopChild = '01a05606-303e-7342-af86-80d33d596727';
const desktopWindow = '01a05606-303e-7342-af86-80ef3c3c6d7c';
const desktopTranscript = path.join(TMP, 'desktop-child.jsonl');
fs.writeFileSync(desktopTranscript, `${JSON.stringify({
  type: 'session_meta',
  payload: {
    id: desktopChild,
    session_id: desktopParent,
    parent_thread_id: desktopParent,
    context_window: { window_id: desktopWindow },
  },
})}\n`);
const desktopConfig = claimedConfig();
desktopConfig.executionPermits[0].session_id = desktopChild;
desktopConfig.executionPermits[0].agent_id = 'logical-worker';
const desktopEnv = { CODEX_THREAD_ID: desktopParent, CODEX_SESSION_ID: desktopParent };
const desktopWrite = {
  session_id: desktopWindow,
  agent_id: desktopChild,
  transcript_path: desktopTranscript,
  tool_name: 'Write',
  tool_input: { file_path: `${WT}/src/desktop.js`, new_string: 'x' },
};
expectExit('direct Node write gate allows proven Desktop child over parent env', DIRECT_WRITE, desktopWrite, desktopConfig, 0, desktopEnv);
expectExit('shell write gate allows proven Desktop child over parent env', SHELL_WRITE, desktopWrite, desktopConfig, 0, desktopEnv);
expectExit('Cursor write relay allows proven Desktop child over parent env', CURSOR_WRITE, desktopWrite, desktopConfig, 0, desktopEnv);
expectCodexAllow('Codex write relay allows proven Desktop child over parent env', CODEX_WRITE, desktopWrite, desktopConfig, desktopEnv);

const desktopBash = {
  session_id: desktopWindow,
  agent_id: desktopChild,
  transcript_path: desktopTranscript,
  tool_name: 'Bash',
  tool_input: { command: `touch ${WT}/desktop-child.txt` },
};
expectExit('direct Node bash gate allows proven Desktop child over parent env', DIRECT_BASH, desktopBash, desktopConfig, 0, desktopEnv);
expectExit('shell bash gate allows proven Desktop child over parent env', SHELL_BASH, desktopBash, desktopConfig, 0, desktopEnv);
expectExit('Cursor shell relay allows proven Desktop child over parent env', CURSOR_BASH, desktopBash, desktopConfig, 0, desktopEnv);
expectCodexAllow('Codex bash relay allows proven Desktop child over parent env', CODEX_BASH, desktopBash, desktopConfig, desktopEnv);

const desktopNoTranscriptWrite = {
  session_id: desktopParent,
  agent_id: desktopChild,
  tool_name: 'Write',
  tool_input: { file_path: `${WT}/src/desktop-no-transcript.js`, new_string: 'x' },
};
expectExit('direct Node write gate denies undocumented Desktop child without turn binding', DIRECT_WRITE, desktopNoTranscriptWrite, desktopConfig, 2, desktopEnv);
expectExit('shell write gate denies undocumented Desktop child without turn binding', SHELL_WRITE, desktopNoTranscriptWrite, desktopConfig, 2, desktopEnv);
expectExit('Cursor write relay denies undocumented Desktop child without turn binding', CURSOR_WRITE, desktopNoTranscriptWrite, desktopConfig, 2, desktopEnv);
withHookStub(desktopConfig, (stub) => {
  const r = run(CODEX_WRITE, desktopNoTranscriptWrite, envFor(stub, desktopEnv));
  ok('Codex write relay denies undocumented Desktop child without turn binding', denyJson(r.stdout));
});

const desktopTurn = 'desktop-parity-turn';
const previousOrchData = process.env.ORCH_DATA;
process.env.ORCH_DATA = TMP;
const desktopTurnBound = hookkit.bindTurnSession({
  session_id: desktopParent,
  turn_id: desktopTurn,
  tool_input: { session_id: desktopChild },
}, {
  id: 'permit-desktop-parity-turn',
  workspace: '/graph/parity',
  session_id: desktopChild,
  task_key: 'parity/task',
  agent_id: 'logical-worker',
  expires_at: '2099-01-01T00:00:00.000Z',
}, 'parity/task', 'logical-worker');
if (previousOrchData === undefined) delete process.env.ORCH_DATA;
else process.env.ORCH_DATA = previousOrchData;
ok('parity setup persists validated Desktop parent+turn binding', desktopTurnBound === true);
const desktopBoundWrite = {
  session_id: desktopParent,
  turn_id: desktopTurn,
  tool_name: 'Write',
  tool_input: { file_path: `${WT}/src/desktop-turn-bound.js`, new_string: 'x' },
};
expectExit('direct Node write gate allows validated Desktop turn binding', DIRECT_WRITE, desktopBoundWrite, desktopConfig, 0, desktopEnv);
expectExit('shell write gate allows validated Desktop turn binding', SHELL_WRITE, desktopBoundWrite, desktopConfig, 0, desktopEnv);
expectExit('Cursor write relay allows validated Desktop turn binding', CURSOR_WRITE, desktopBoundWrite, desktopConfig, 0, desktopEnv);
expectCodexAllow('Codex write relay allows validated Desktop turn binding', CODEX_WRITE, desktopBoundWrite, desktopConfig, desktopEnv);

const desktopNoTranscriptBash = {
  session_id: desktopParent,
  agent_id: desktopChild,
  tool_name: 'Bash',
  tool_input: { command: `touch ${WT}/desktop-no-transcript.txt` },
};
expectExit('direct Node bash gate denies undocumented Desktop child without turn binding', DIRECT_BASH, desktopNoTranscriptBash, desktopConfig, 2, desktopEnv);
expectExit('shell bash gate denies undocumented Desktop child without turn binding', SHELL_BASH, desktopNoTranscriptBash, desktopConfig, 2, desktopEnv);
expectExit('Cursor shell relay denies undocumented Desktop child without turn binding', CURSOR_BASH, desktopNoTranscriptBash, desktopConfig, 2, desktopEnv);
withHookStub(desktopConfig, (stub) => {
  const r = run(CODEX_BASH, desktopNoTranscriptBash, envFor(stub, desktopEnv));
  ok('Codex bash relay denies undocumented Desktop child without turn binding', denyJson(r.stdout));
});
const desktopBoundBash = {
  session_id: desktopParent,
  turn_id: desktopTurn,
  tool_name: 'Bash',
  tool_input: { command: `touch ${WT}/desktop-turn-bound.txt` },
};
expectExit('direct Node bash gate allows validated Desktop turn binding', DIRECT_BASH, desktopBoundBash, desktopConfig, 0, desktopEnv);
expectExit('shell bash gate allows validated Desktop turn binding', SHELL_BASH, desktopBoundBash, desktopConfig, 0, desktopEnv);
expectExit('Cursor shell relay allows validated Desktop turn binding', CURSOR_BASH, desktopBoundBash, desktopConfig, 0, desktopEnv);
expectCodexAllow('Codex bash relay allows validated Desktop turn binding', CODEX_BASH, desktopBoundBash, desktopConfig, desktopEnv);

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
