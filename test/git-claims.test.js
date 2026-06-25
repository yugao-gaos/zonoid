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

function writeClaim(repo, task, claim, message) {
  const rel = claims.claimRelPath(task);
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(claim, null, 2) + '\n');
  git(repo, ['add', '--', rel]);
  git(repo, ['commit', '-m', message, '--', rel]);
  git(repo, ['push']);
}

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-git-claims-')));
try {
  delete process.env.ORCH_CLAIM_MODE;
  ok('git claim mode is enabled by default', claims.claimModeEnabled({ config: {} }) === true);
  ok('default git claim mode is advisory', claims.claimMode({ config: {} }).enabled === true && claims.claimModeStrict({ config: {} }) === false && claims.claimMode({ config: {} }).explicit === false);
  ok('local claim mode disables git claims', claims.claimModeEnabled({ config: { claim_mode: 'local' } }) === false);
  ok('strict aliases normalize to strict git mode', claims.normalizeClaimMode('strict').mode === 'git-strict' && claims.normalizeClaimMode('git-strict').strict === true);
  process.env.ORCH_CLAIM_MODE = 'local';
  ok('env can disable git claims', claims.claimModeEnabled({ config: { claim_mode: 'git' } }) === false);
  process.env.ORCH_CLAIM_MODE = 'git';
  ok('env can force git claims', claims.claimModeEnabled({ config: { claim_mode: 'local' } }) === true);
  process.env.ORCH_CLAIM_MODE = 'git-strict';
  ok('env can force strict git claims', claims.claimModeStrict({ config: { claim_mode: 'local' } }) === true);
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
  const c = initClone(root, 'alice2', bare);
  git(c, ['config', 'user.name', 'alice']);
  git(c, ['config', 'user.email', 'alice@example.test']);
  const d = initClone(root, 'noidentity', bare);
  git(d, ['config', 'user.name', '']);
  git(d, ['config', 'user.email', '']);
  git(a, ['checkout', 'main']);
  git(b, ['checkout', 'main']);
  git(c, ['checkout', 'main']);
  git(d, ['checkout', 'main']);

  const task = 'shared-task/1';
  const ca = claims.acquire(a, task, { agentId: 'local-agent-a', sessionId: 'sess-a', workspace: a, branch: 'orch/attempt/shared-task-1', leaseMinutes: 30 });
  ok('first clone acquires and pushes claim', ca.ok && ca.pushed === true, JSON.stringify(ca));
  ok('claim file path is deterministic', claims.claimRelPath(task) === '.graph/claims/shared-task%2F1.json');
  const written = JSON.parse(fs.readFileSync(path.join(a, claims.claimRelPath(task)), 'utf8'));
  ok('git claim file records git user lock identity', written.git_user === 'alice <alice@example.test>', JSON.stringify(written));
  ok('git claim file records session lock identity', written.session_id === 'sess-a', JSON.stringify(written));
  ok('git claim file omits local agent_id', !Object.prototype.hasOwnProperty.call(written, 'agent_id'), JSON.stringify(written));
  ok('git claim file omits local workspace', !Object.prototype.hasOwnProperty.call(written, 'workspace'), JSON.stringify(written));

  const cb = claims.acquire(b, task, { agentId: 'bob', sessionId: 'sess-b', workspace: b, branch: 'orch/attempt/shared-task-1', leaseMinutes: 30 });
  ok('different git user is rejected by pushed git claim', cb.ok === false && cb.conflict === true, JSON.stringify(cb));
  ok('conflict identifies winning lock identity', cb.claim && cb.claim.git_user === 'alice <alice@example.test>' && cb.claim.session_id === 'sess-a', JSON.stringify(cb.claim));
  ok('default mode treats conflicts as advisory to the caller', cb.conflict === true && claims.claimModeStrict({ config: {} }) === false);

  const ccDiffSession = claims.acquire(c, task, { agentId: 'local-agent-c', sessionId: 'sess-c', workspace: c, branch: 'orch/attempt/shared-task-1', leaseMinutes: 30 });
  ok('same git user with a different session conflicts while live', ccDiffSession.ok === false && ccDiffSession.conflict === true, JSON.stringify(ccDiffSession));
  const fsMissing = claims.finalize(b, task, { status: 'tested', strict: true });
  ok('strict finalize without session rejects live remote claim', fsMissing.ok === false && fsMissing.conflict === true && fsMissing.claim && fsMissing.claim.git_user === 'alice <alice@example.test>', JSON.stringify(fsMissing));
  const fsNoGitUser = claims.finalize(d, task, { sessionId: 'sess-a', status: 'tested', strict: true });
  ok('strict finalize without git user rejects live remote claim', fsNoGitUser.ok === false && fsNoGitUser.conflict === true && fsNoGitUser.claim && fsNoGitUser.claim.session_id === 'sess-a', JSON.stringify(fsNoGitUser));
  const stillClaimed = JSON.parse(git(b, ['show', `origin/main:${claims.claimRelPath(task)}`]));
  ok('strict finalize without owner preserves remote live claim', stillClaimed.status === 'claimed' && stillClaimed.git_user === 'alice <alice@example.test>' && stillClaimed.session_id === 'sess-a', JSON.stringify(stillClaimed));

  const cbSame = claims.acquire(c, task, { agentId: 'different-local-agent', sessionId: 'sess-a', workspace: c, branch: 'orch/attempt/shared-task-1', leaseMinutes: 30 });
  ok('same git user and same session can observe its own live remote claim', cbSame.ok === true && cbSame.already_claimed === true, JSON.stringify(cbSame));
  const missingAcquire = claims.acquire(a, 'missing-identity/1', { agentId: 'local-agent-a', branch: 'orch/attempt/missing-identity-1', leaseMinutes: 30 });
  ok('acquire without session fails closed before writing a claim', missingAcquire.ok === false && missingAcquire.conflict === true && /session_id/.test(missingAcquire.error), JSON.stringify(missingAcquire));
  const prePushHook = path.join(a, '.git', 'hooks', 'pre-push');
  fs.writeFileSync(prePushHook, '#!/bin/sh\necho pre-push should be bypassed >&2\nexit 42\n');
  fs.chmodSync(prePushHook, 0o755);
  const fa = claims.finalize(a, task, { agentId: 'different-local-agent', sessionId: 'sess-a', status: 'tested' });
  fs.rmSync(prePushHook, { force: true });
  ok('finalize releases and pushes claim audit while bypassing pre-push hooks', fa.ok === true && fa.pushed === true, JSON.stringify(fa));
  const released = JSON.parse(fs.readFileSync(path.join(a, claims.claimRelPath(task)), 'utf8'));
  ok('released git claim file keeps session lock identity', released.session_id === 'sess-a', JSON.stringify(released));
  ok('released git claim file keeps git user lock identity', released.git_user === 'alice <alice@example.test>', JSON.stringify(released));
  ok('released git claim file still omits local agent_id', !Object.prototype.hasOwnProperty.call(released, 'agent_id'), JSON.stringify(released));
  ok('released git claim file still omits local workspace', !Object.prototype.hasOwnProperty.call(released, 'workspace'), JSON.stringify(released));

  const legacyTask = 'legacy-task/1';
  writeClaim(a, legacyTask, {
    task_key: legacyTask,
    agent_id: 'legacy-agent',
    status: 'claimed',
    claimed_at: new Date().toISOString(),
    lease_until: new Date(Date.now() + 30 * 60000).toISOString(),
  }, 'seed legacy claim');
  const legacyAcquire = claims.acquire(c, legacyTask, { agentId: 'legacy-agent', sessionId: 'sess-a', workspace: c, branch: 'orch/attempt/legacy-task-1', leaseMinutes: 30 });
  ok('live legacy claim missing tuple identity conflicts even when agent id matches', legacyAcquire.ok === false && legacyAcquire.conflict === true, JSON.stringify(legacyAcquire));
  const legacyFinalize = claims.finalize(c, legacyTask, { agentId: 'legacy-agent', sessionId: 'sess-a', status: 'tested', strict: true });
  ok('strict finalize refuses live legacy claim missing tuple identity', legacyFinalize.ok === false && legacyFinalize.conflict === true, JSON.stringify(legacyFinalize));
  const legacyStill = JSON.parse(git(c, ['show', `origin/main:${claims.claimRelPath(legacyTask)}`]));
  ok('strict finalize preserves live legacy claim', legacyStill.status === 'claimed' && legacyStill.agent_id === 'legacy-agent', JSON.stringify(legacyStill));

  const noRemote = path.join(root, 'local-only');
  fs.mkdirSync(noRemote);
  execFileSync('git', ['init'], { cwd: noRemote, stdio: 'ignore', windowsHide: true });
  git(noRemote, ['config', 'user.name', 'local']);
  git(noRemote, ['config', 'user.email', 'local@example.test']);
  git(noRemote, ['commit', '--allow-empty', '-m', 'init']);
  const cr = claims.acquire(noRemote, task, { agentId: 'local' });
  ok('direct git claim acquire reports missing origin', cr.ok === false && /origin/.test(cr.error), JSON.stringify(cr));
  ok('default mode skips acquisition without origin', claims.shouldAcquire(noRemote, { config: {} }) === false);
  ok('explicit git mode attempts advisory acquisition without origin', claims.shouldAcquire(noRemote, { config: { claim_mode: 'git' } }) === true && claims.claimModeStrict({ config: { claim_mode: 'git' } }) === false);
  ok('strict git mode requires acquisition without origin', claims.shouldAcquire(noRemote, { config: { claim_mode: 'git-strict' } }) === true && claims.claimModeStrict({ config: { claim_mode: 'git-strict' } }) === true);
  const frAdvisory = claims.finalize(noRemote, task, { agentId: 'local' });
  ok('advisory finalize skips without origin', frAdvisory.ok === true && frAdvisory.skipped === true, JSON.stringify(frAdvisory));
  const frStrict = claims.finalize(noRemote, task, { agentId: 'local', strict: true });
  ok('strict finalize fails closed without origin', frStrict.ok === false && /origin/.test(frStrict.error), JSON.stringify(frStrict));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
