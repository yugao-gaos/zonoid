#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { gateWriteTool } = require('../packages/opencode-plugin/lib/gate');
const { withHookStub } = require('./support/hook-http-stub');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gate-test-'));
const WT = path.join(TMP, 'wt').replace(/\\/g, '/');
fs.mkdirSync(WT, { recursive: true });

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

function executionPermit(overrides = {}) {
  return {
    id: 'permit-opencode-task',
    session_id: 'opencode-session',
    task_key: 'opencode/task',
    worktree: WT,
    branch: 'orch/attempt/opencode-task',
    scope: 'worktree',
    allowed_paths: [WT],
    status: 'active',
    issued_at: '2026-06-21T00:00:00.000Z',
    expires_at: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function claimedConfig(permit = executionPermit()) {
  return {
    activeClaim: { claimed: true, claims: [{ key: 'opencode/task' }] },
    taskDetails: {
      'opencode/task': {
        task: { metric: null, git: { branch: 'orch/attempt/opencode-task', worktree: WT } },
      },
    },
    executionPermits: permit ? [permit] : [],
  };
}

async function runWithConfig(config, fn) {
  return withHookStub(config, async (stub) => {
    const oldPort = process.env.ORCH_PORT;
    process.env.ORCH_PORT = stub.env().ORCH_PORT;
    try {
      return await fn();
    } finally {
      if (oldPort == null) delete process.env.ORCH_PORT;
      else process.env.ORCH_PORT = oldPort;
    }
  });
}

async function expectAllow(label, config, tool, args, options) {
  await runWithConfig(config, async () => {
    try {
      await gateWriteTool('opencode-session', tool, args, options);
      ok(label, true);
    } catch (e) {
      ok(label, false, e.message);
    }
  });
}

async function expectDeny(label, config, tool, args, messagePart, options) {
  await runWithConfig(config, async () => {
    try {
      await gateWriteTool('opencode-session', tool, args, options);
      ok(label, false, 'allowed');
    } catch (e) {
      ok(label, true);
      if (messagePart) ok(`${label} message`, String(e.message).includes(messagePart), e.message);
    }
  });
}

(async () => {
  const blocked = { activeClaim: { claimed: false }, sessionInfo: { is_subagent: true } };

  await expectDeny('source write without claim denied', blocked, 'write', { filePath: '/Users/x/proj/src.js' }, 'no task claimed');
  await expectDeny('/tmp write without claim denied', blocked, 'write', { filePath: '/tmp/src.js' }, 'no task claimed');
  await expectDeny('missing write path without claim denied', blocked, 'write', { content: 'x' }, 'no task claimed');
  await expectDeny('.log outside logs dir is not exempt', blocked, 'write', { filePath: '/Users/x/proj/app.log' }, 'no task claimed');
  await expectAllow('file-drop task path remains exempt', blocked, 'write', {
    filePath: '/Users/x/.claude/orchestrator/tasks/ws/opencode/t1.json',
  });

  await expectAllow('claimed relative path inside worktree allowed', claimedConfig(), 'edit', {
    filePath: 'src/main.js',
  });
  await expectAllow('claimed absolute path inside worktree allowed', claimedConfig(), 'write', {
    filePath: `${WT}/src/main.js`,
  });
  await expectDeny('claimed worktree without permit denied', claimedConfig(null), 'write', {
    filePath: `${WT}/src/no-permit.js`,
  }, 'Subconscious execution permit');
  await expectDeny('claimed worktree with wrong session permit denied', claimedConfig(executionPermit({ session_id: 'other-session' })), 'write', {
    filePath: `${WT}/src/wrong-session.js`,
  }, 'Subconscious execution permit');
  await expectDeny('claimed worktree with expired permit denied', claimedConfig(executionPermit({ expires_at: '2000-01-01T00:00:00.000Z' })), 'write', {
    filePath: `${WT}/src/expired.js`,
  }, 'expired');
  await expectDeny('claimed worktree outside permit path scope denied', claimedConfig(executionPermit({ scope: 'paths', allowed_paths: [`${WT}/allowed`] })), 'write', {
    filePath: `${WT}/src/outside-scope.js`,
  }, 'permit scope');
  await expectAllow('trusted OpenCode agent id satisfies agent-bound permit', claimedConfig(executionPermit({ agent_id: 'real-opencode-agent' })), 'write', {
    filePath: `${WT}/src/agent-bound.js`,
    agent_id: 'spoofed-tool-arg',
  }, { agentId: 'real-opencode-agent' });
  await expectDeny('tool args cannot spoof trusted OpenCode agent id', claimedConfig(executionPermit({ agent_id: 'real-opencode-agent' })), 'write', {
    filePath: `${WT}/src/spoofed-agent.js`,
    agent_id: 'real-opencode-agent',
  }, 'agent mismatch', { agentId: 'different-opencode-agent' });
  await expectDeny('claimed absolute path outside worktree denied', claimedConfig(), 'write', {
    filePath: '/Users/x/other/src.js',
  }, 'registered worktree');
  await expectDeny('apply_patch path outside worktree denied', claimedConfig(), 'apply_patch', {
    input: [
      '*** Begin Patch',
      '*** Update File: /Users/x/other/src.js',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n'),
  }, 'registered worktree');

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.error(e);
  process.exit(1);
});
