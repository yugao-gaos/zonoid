#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const claims = require('../lib/git-claims');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); fail++; }
};

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function initClone(root, name, bare) {
  const dir = path.join(root, name);
  execFileSync('git', ['clone', bare, dir], { stdio: 'ignore', windowsHide: true });
  git(dir, ['config', 'user.name', name]);
  git(dir, ['config', 'user.email', `${name}@example.test`]);
  return dir;
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-git-claims-')));
try {
  delete process.env.ORCH_CLAIM_MODE;
  ok('git claim mode is enabled by default', claims.claimModeEnabled({ config: {} }) === true);
  ok('local claim mode disables git claims', claims.claimModeEnabled({ config: { claim_mode: 'local' } }) === false);
  process.env.ORCH_CLAIM_MODE = 'local';
  ok('env can disable git claims', claims.claimModeEnabled({ config: { claim_mode: 'git' } }) === false);
  process.env.ORCH_CLAIM_MODE = 'git';
  ok('env can force git claims', claims.claimModeEnabled({ config: { claim_mode: 'local' } }) === true);
  delete process.env.ORCH_CLAIM_MODE;

  const bare = path.join(root, 'origin.git');
  execFileSync('git', ['init', '--bare', bare], { stdio: 'ignore', windowsHide: true });
  const seed = path.join(root, 'seed');
  execFileSync('git', ['clone', bare, seed], { stdio: 'ignore', windowsHide: true });
  git(seed, ['config', 'user.name', 'seed']);
  git(seed, ['config', 'user.email', 'seed@example.test']);
  fs.mkdirSync(path.join(seed, '.graph'), { recursive: true });
  fs.writeFileSync(path.join(seed, '.graph', '.keep'), '\n');
  git(seed, ['add', '.graph/.keep']);
  git(seed, ['commit', '-m', 'seed']);
  git(seed, ['push', '-u', 'origin', 'HEAD:main']);

  const a = initClone(root, 'alice', bare);
  const b = initClone(root, 'bob', bare);
  git(a, ['checkout', 'main']);
  git(b, ['checkout', 'main']);

  const task = 'shared-task/1';
  const ca = claims.acquire(a, task, { agentId: 'alice', sessionId: 'sess-a', workspace: a, branch: 'orch/attempt/shared-task-1', leaseMinutes: 30 });
  ok('first clone acquires and pushes claim', ca.ok && ca.pushed === true, JSON.stringify(ca));
  ok('claim file path is deterministic', claims.claimRelPath(task) === '.graph/claims/shared-task%2F1.json');

  const cb = claims.acquire(b, task, { agentId: 'bob', sessionId: 'sess-b', workspace: b, branch: 'orch/attempt/shared-task-1', leaseMinutes: 30 });
  ok('second clone is rejected by pushed git claim', cb.ok === false && cb.conflict === true, JSON.stringify(cb));
  ok('conflict identifies winning agent', cb.claim && cb.claim.agent_id === 'alice', JSON.stringify(cb.claim));

  const cbSame = claims.acquire(b, task, { agentId: 'alice', sessionId: 'sess-a', workspace: b, branch: 'orch/attempt/shared-task-1', leaseMinutes: 30 });
  ok('same agent can observe its own live remote claim', cbSame.ok === true && cbSame.already_claimed === true, JSON.stringify(cbSame));

  const noRemote = path.join(root, 'local-only');
  fs.mkdirSync(noRemote);
  execFileSync('git', ['init'], { cwd: noRemote, stdio: 'ignore', windowsHide: true });
  git(noRemote, ['config', 'user.name', 'local']);
  git(noRemote, ['config', 'user.email', 'local@example.test']);
  git(noRemote, ['commit', '--allow-empty', '-m', 'init']);
  const cr = claims.acquire(noRemote, task, { agentId: 'local' });
  ok('git claim mode fails closed without origin', cr.ok === false && /origin/.test(cr.error), JSON.stringify(cr));
  ok('default mode skips acquisition without origin', claims.shouldAcquire(noRemote, { config: {} }) === false);
  ok('explicit git mode requires acquisition without origin', claims.shouldAcquire(noRemote, { config: { claim_mode: 'git' } }) === true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
