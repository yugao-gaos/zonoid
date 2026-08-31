#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const lifecycle = require('../lib/graph-lifecycle');

let pass = 0;
let fail = 0;
const cleanup = [];

function ok(label, value, detail) {
  if (value) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ` (${detail})` : ''}`);
    fail++;
  }
}

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function gitFails(cwd, args) {
  try { git(cwd, args); return false; } catch { return true; }
}

function temp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function identity(repo) {
  git(repo, ['config', 'user.name', 'Graph Recovery Test']);
  git(repo, ['config', 'user.email', 'graph-recovery@example.test']);
}

function pausedEnv() {
  const dir = temp('graph-rebase-tuning-');
  const file = path.join(dir, 'tuning.json');
  write(file, JSON.stringify({ version: 1, tuning: { drain_max_iterations: -1 } }) + '\n');
  return { ORCH_TUNING_FILE: file, ZONOID_SKIP_LIVE: '1' };
}

function daemonFixture(repo, overrides = {}) {
  const pidFile = path.join(temp('graph-rebase-daemon-'), 'daemon.pid');
  const operatorRoot = path.join(temp('graph-rebase-operator-'), 'install');
  const lockFile = path.join(operatorRoot, '.orch-off');
  const graphLockFile = path.join(repo, '.orch-off');
  const pid = 41041;
  let state = 'running';
  let signals = 0;
  let restarts = 0;
  let flushes = 0;
  let lockObserved = false;
  const restartRequests = [];
  const flushRequests = [];
  fs.mkdirSync(operatorRoot, { recursive: true });
  write(pidFile, `${pid}\n`);
  const observation = () => state === 'running' ? {
    reachable: true,
    identified: true,
    ownershipProof: true,
    ready: true,
    pid,
    head: 'stable-fixture',
    build: 'git:stable-fixture',
  } : { reachable: false, identified: false, ownershipProof: false, ready: false };
  const options = {
    operatorRoot,
    pidFile,
    daemonShutdownTimeoutMs: 100,
    daemonPollMs: 1,
    probeDaemon: async () => observation(),
    isProcessAlive: (candidate) => candidate === pid && state === 'running',
    signalProcess: (candidate, signal) => {
      if (candidate !== pid || signal !== 'SIGTERM') throw new Error('unexpected daemon signal');
      lockObserved = fs.existsSync(lockFile) && !fs.existsSync(graphLockFile);
      signals++;
      state = 'stopped';
    },
    sleep: async () => {},
    flushGraph: async (targetRepo, request) => {
      flushRequests.push({ targetRepo, request });
      flushes++;
      const graphDir = path.join(targetRepo, '.graph');
      git(graphDir, ['add', '-A', '--', '.', ':(exclude)daemon.port']);
      if (gitFails(graphDir, ['diff', '--cached', '--quiet', '--exit-code'])) {
        git(graphDir, ['commit', '-m', 'fixture pushed recovery']);
      }
      return { status: 'pushed', commit: git(graphDir, ['rev-parse', 'HEAD']) };
    },
    restartDaemon: async (request) => {
      restartRequests.push(request);
      restarts++;
      state = 'running';
      return { ok: true, action: 'started', identity: observation() };
    },
    ...overrides,
  };
  return {
    options,
    operatorRoot,
    lockFile,
    graphLockFile,
    signals: () => signals,
    restarts: () => restarts,
    flushes: () => flushes,
    lockObserved: () => lockObserved,
    restartRequests: () => restartRequests,
    flushRequests: () => flushRequests,
    stop: () => { state = 'stopped'; },
  };
}

function createFixture() {
  const root = temp('graph-rebase-recovery-');
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const repo = path.join(root, 'repo');
  const remoteWriter = path.join(root, 'remote-writer');

  git(root, ['init', '--bare', '--initial-branch', 'main', remote]);
  git(root, ['init', '--initial-branch', 'main', seed]);
  identity(seed);
  write(path.join(seed, '.gitattributes'), '*.jsonl merge=union\n');
  write(path.join(seed, 'nodes', 'task.jsonl'), '{"event":"base"}\n');
  write(path.join(seed, 'live.txt'), 'base live\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-m', 'base graph']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);

  git(root, ['init', '--initial-branch', 'main', repo]);
  identity(repo);
  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', remote, '.graph']);
  git(repo, ['commit', '-m', 'attach graph']);
  const graphDir = path.join(repo, '.graph');
  identity(graphDir);

  write(path.join(graphDir, 'claims', 'one.json'), JSON.stringify({
    task_key: 'one', status: 'claimed', claimed_at: '2026-08-30T21:51:00.000Z',
  }, null, 2) + '\n');
  fs.rmSync(path.join(graphDir, 'nodes', 'task.jsonl'));
  git(graphDir, ['add', '-A']);
  git(graphDir, ['commit', '-m', 'local conflict one']);

  write(path.join(graphDir, 'claims', 'two.json'), JSON.stringify({
    task_key: 'two', status: 'claimed', claimed_at: '2026-08-30T21:52:00.000Z',
  }, null, 2) + '\n');
  git(graphDir, ['add', '-A']);
  git(graphDir, ['commit', '-m', 'local conflict two']);

  git(root, ['clone', remote, remoteWriter]);
  identity(remoteWriter);
  write(path.join(remoteWriter, 'claims', 'one.json'), JSON.stringify({
    task_key: 'one', status: 'done', claimed_at: '2026-08-30T21:51:00.000Z',
    completed_at: '2026-08-30T21:59:00.000Z',
  }, null, 2) + '\n');
  write(path.join(remoteWriter, 'claims', 'two.json'), JSON.stringify({
    task_key: 'two', status: 'tested', claimed_at: '2026-08-30T21:52:00.000Z',
    completed_at: '2026-08-30T22:00:00.000Z',
  }, null, 2) + '\n');
  fs.appendFileSync(path.join(remoteWriter, 'nodes', 'task.jsonl'), '{"event":"remote"}\n');
  git(remoteWriter, ['add', '-A']);
  git(remoteWriter, ['commit', '-m', 'remote terminal graph']);
  git(remoteWriter, ['push', 'origin', 'main']);

  git(graphDir, ['fetch', 'origin']);
  ok('fixture enters an interrupted rebase', gitFails(graphDir, ['rebase', 'origin/main']));
  write(path.join(graphDir, 'live.txt'), 'daemon event while rebase stopped\n');
  write(path.join(graphDir, 'untracked.jsonl'), '{"event":"untracked"}\n');
  return { repo, graphDir };
}

function createRetainedStashFixture(options = {}) {
  const root = temp('graph-retained-stash-');
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const repo = path.join(root, 'repo');
  git(root, ['init', '--bare', '--initial-branch', 'main', remote]);
  git(root, ['init', '--initial-branch', 'main', seed]);
  identity(seed);
  write(path.join(seed, 'claims', 'one.json'), JSON.stringify({
    task_key: 'one', status: 'claimed', claimed_at: '2026-08-30T21:51:00.000Z',
  }, null, 2) + '\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-m', 'base claim']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);

  git(root, ['init', '--initial-branch', 'main', repo]);
  identity(repo);
  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', remote, '.graph']);
  git(repo, ['commit', '-m', 'attach graph']);
  const graphDir = path.join(repo, '.graph');
  identity(graphDir);
  const claim = path.join(graphDir, 'claims', 'one.json');

  write(claim, JSON.stringify({
    task_key: 'one', status: 'done', claimed_at: '2026-08-30T21:51:00.000Z',
    completed_at: '2026-08-30T22:03:00.000Z',
  }, null, 2) + '\n');
  git(graphDir, ['stash', 'push', '--include-untracked', '--keep-index', '-m', 'zonoid graph rebase recovery fixture']);
  const stashOid = git(graphDir, ['rev-parse', 'refs/stash']);

  write(claim, JSON.stringify({
    task_key: 'one', status: 'tested', claimed_at: '2026-08-30T21:51:00.000Z',
    completed_at: '2026-08-30T22:02:00.000Z',
  }, null, 2) + '\n');
  git(graphDir, ['add', '-A']);
  git(graphDir, ['commit', '-m', 'newer graph head']);
  ok('retained stash fixture conflicts on apply', gitFails(graphDir, ['stash', 'apply', stashOid]));
  ok('retained stash fixture contains a known marker', fs.readFileSync(claim, 'utf8').includes('<<<<<<<'));
  if (options.commitMarker !== false) {
    git(graphDir, ['add', '--', 'claims/one.json']);
    git(graphDir, ['commit', '-m', 'committed interrupted stash marker']);
  }
  return { repo, graphDir, stashOid };
}

function createLockedRestartResumeFixture(options = {}) {
  const fixture = createRetainedStashFixture();
  const claim = path.join(fixture.graphDir, 'claims', 'one.json');
  write(claim, JSON.stringify({
    task_key: 'one', status: 'done', claimed_at: '2026-08-30T21:51:00.000Z',
    completed_at: '2026-08-30T22:03:00.000Z',
  }, null, 2) + '\n');
  git(fixture.graphDir, ['add', '--', 'claims/one.json']);
  git(fixture.graphDir, ['commit', '-m', 'resolved and pushed recovery']);
  const graphHead = git(fixture.graphDir, ['rev-parse', 'HEAD']);
  git(fixture.graphDir, ['push', 'origin', 'HEAD:main']);
  if (options.noStash === true) git(fixture.graphDir, ['stash', 'drop', 'stash@{0}']);
  write(path.join(fixture.graphDir, 'daemon.port'), '8787\n');

  const daemon = daemonFixture(fixture.repo, options.daemonOverrides || {});
  if (options.legacy !== true) daemon.stop();
  const identity = {
    head: 'stable-fixture',
    build: 'git:stable-fixture',
    version: null,
  };
  const lock = {
    kind: 'zonoid-graph-recovery',
    token: 'resume-fixture-token',
    created_at: '2026-08-30T22:10:00.000Z',
    daemon_pid: 41041,
    daemon_head: identity.head,
    daemon_build: identity.build,
    ...(options.legacy === true ? {} : {
      daemon_version: identity.version,
      phase: 'restart-pending',
      graph_dir: fs.realpathSync(fixture.graphDir),
      graph_head: graphHead,
      stash_oid: options.noStash === true ? null : fixture.stashOid,
    }),
  };
  write(daemon.lockFile, `${JSON.stringify(lock)}\n`);
  return {
    ...fixture,
    daemon,
    graphHead,
    identity,
    lock,
    options: {
      ...daemon.options,
      getDaemonIdentity: () => identity,
    },
  };
}

function rebaseActive(graphDir) {
  const marker = git(graphDir, ['rev-parse', '--git-path', 'rebase-merge']);
  return fs.existsSync(path.isAbsolute(marker) ? marker : path.resolve(graphDir, marker));
}

async function testFailureKeepsRecoveryStash() {
  const fixture = createFixture();
  const daemon = daemonFixture(fixture.repo);
  const result = await lifecycle.recoverRebase(fixture.repo, {
    ...daemon.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
    failHook(step) {
      if (step === 'after-stash') throw new Error('injected recovery failure');
    },
  });
  ok('mid-recovery failure returns a recoverable report', result.status === 'failed'
    && result.rebase === true && /injected recovery failure/.test(result.error)
    && Array.isArray(result.next_steps) && result.next_steps.length === 1);
  const stashList = git(fixture.graphDir, ['stash', 'list', '--format=%H']);
  ok('mid-recovery failure retains the exact graph event stash', result.stash
    && stashList.split('\n').includes(result.stash.oid));
  ok('mid-recovery failure leaves the recovery lock in place', fs.existsSync(daemon.lockFile)
    && daemon.signals() === 1 && daemon.restarts() === 0);
}

async function testKnownRecovery() {
  const fixture = createFixture();
  const daemon = daemonFixture(fixture.repo);
  const conflictsBefore = git(fixture.graphDir, ['diff', '--name-only', '--diff-filter=U']);
  const plan = await lifecycle.recoverRebase(fixture.repo, { dryRun: true });
  ok('dry run reports known conflicts without mutation', plan.status === 'dry-run'
    && plan.rebase === true && plan.recoverable === true && rebaseActive(fixture.graphDir));
  ok('dry run preserves the unmerged index', git(fixture.graphDir, ['diff', '--name-only', '--diff-filter=U']) === conflictsBefore);

  const refused = await lifecycle.recoverRebase(fixture.repo, { dryRun: false });
  ok('mutation requires explicit drains-paused confirmation', refused.status === 'refused'
    && /drains/i.test(refused.error) && rebaseActive(fixture.graphDir));

  const conflictState = git(fixture.graphDir, ['diff', '--name-only', '--diff-filter=U']);
  const notPersisted = await lifecycle.recoverRebase(fixture.repo, {
    dryRun: false,
    drainsPaused: true,
    env: { ZONOID_SKIP_LIVE: '1' },
  });
  ok('explicit flag alone refuses without a persisted drain pause', notPersisted.status === 'refused'
    && /persisted drain_max_iterations=-1/.test(notPersisted.error));
  ok('missing persisted pause refuses without mutating the interrupted rebase', rebaseActive(fixture.graphDir)
    && git(fixture.graphDir, ['diff', '--name-only', '--diff-filter=U']) === conflictState
    && fs.readFileSync(path.join(fixture.graphDir, 'live.txt'), 'utf8') === 'daemon event while rebase stopped\n'
    && fs.existsSync(path.join(fixture.graphDir, 'untracked.jsonl')));

  const recovered = await lifecycle.recoverRebase(fixture.repo, {
    ...daemon.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('known graph conflicts recover through every rebase step', recovered.status === 'recovered'
    && recovered.steps === 2 && !rebaseActive(fixture.graphDir), JSON.stringify(recovered));
  ok('terminal claim wins over an earlier active claim', JSON.parse(fs.readFileSync(path.join(fixture.graphDir, 'claims', 'one.json'))).status === 'done');
  ok('later terminal claim survives the second rebase conflict', JSON.parse(fs.readFileSync(path.join(fixture.graphDir, 'claims', 'two.json'))).status === 'tested');
  const events = fs.readFileSync(path.join(fixture.graphDir, 'nodes', 'task.jsonl'), 'utf8');
  ok('JSONL delete/modify resolution preserves the remote superset', events.includes('"base"') && events.includes('"remote"'));
  ok('unstaged daemon event is restored after rebase', fs.readFileSync(path.join(fixture.graphDir, 'live.txt'), 'utf8') === 'daemon event while rebase stopped\n');
  ok('untracked graph event is restored after rebase', fs.readFileSync(path.join(fixture.graphDir, 'untracked.jsonl'), 'utf8').includes('untracked'));
  ok('temporary recovery stash is dropped only after restoration', git(fixture.graphDir, ['stash', 'list']) === '');
  ok('successful recovery flushes before restarting and removes the lock', daemon.flushes() === 1
    && daemon.restarts() === 1 && !fs.existsSync(daemon.lockFile));
  const restartRequest = daemon.restartRequests()[0];
  ok('cross-project recovery locks and restarts only from the trusted operator root', daemon.lockObserved()
    && restartRequest && restartRequest.operatorRoot === daemon.operatorRoot
    && restartRequest.daemonPath === path.join(daemon.operatorRoot, 'daemon.js')
    && !fs.existsSync(daemon.graphLockFile)
    && daemon.flushRequests()[0].targetRepo === fixture.repo);
}

async function testRetainedStashAndCommittedMarkerRecovery() {
  const fixture = createRetainedStashFixture();
  const daemon = daemonFixture(fixture.repo);
  const plan = await lifecycle.recoverRebase(fixture.repo, { dryRun: true });
  ok('dry run discovers post-rebase retained stash recovery', plan.status === 'dry-run'
    && plan.rebase === false && plan.stashes && plan.stashes[0].oid === fixture.stashOid
    && plan.conflicts.some((item) => item.path === 'claims/one.json'));

  const result = await lifecycle.recoverRebase(fixture.repo, {
    ...daemon.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('post-rebase retained stash and committed marker recover together', result.status === 'recovered'
    && result.rebase === false, JSON.stringify(result));
  ok('known committed claim marker resolves toward terminal/newer candidate',
    JSON.parse(fs.readFileSync(path.join(fixture.graphDir, 'claims', 'one.json'), 'utf8')).status === 'done');
  ok('retained stash is dropped only after pushed flush', git(fixture.graphDir, ['stash', 'list']) === ''
    && daemon.flushes() === 1);
  ok('retained recovery restarts stable daemon after removing recovery lock', daemon.restarts() === 1
    && !fs.existsSync(daemon.lockFile));
}

async function testUnsafeDaemonAndFlushFailureStayFailClosed() {
  const unowned = createFixture();
  const daemon = daemonFixture(unowned.repo, {
    probeDaemon: async () => ({ reachable: true, identified: false, ownershipProof: false, ready: false, pid: 41041 }),
  });
  const refused = await lifecycle.recoverRebase(unowned.repo, {
    ...daemon.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('unsigned daemon listener is never signaled and recovery refuses before mutation', refused.status === 'refused'
    && /signed|identified|owned/i.test(refused.error) && daemon.signals() === 0
    && !fs.existsSync(daemon.lockFile) && rebaseActive(unowned.graphDir));

  const mismatched = createFixture();
  const mismatchedDaemon = daemonFixture(mismatched.repo);
  write(mismatchedDaemon.options.pidFile, '99999\n');
  const pidRefused = await lifecycle.recoverRebase(mismatched.repo, {
    ...mismatchedDaemon.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('daemon PID-file mismatch refuses before lock, signal, or mutation', pidRefused.status === 'refused'
    && /PID/i.test(pidRefused.error) && mismatchedDaemon.signals() === 0
    && !fs.existsSync(mismatchedDaemon.lockFile) && rebaseActive(mismatched.graphDir));

  const retained = createRetainedStashFixture();
  let restarts = 0;
  const failingDaemon = daemonFixture(retained.repo, {
    flushGraph: async () => ({ status: 'pending', commit: 'local-only', error: 'injected push failure' }),
    restartDaemon: async () => { restarts++; return { ok: true }; },
  });
  const failed = await lifecycle.recoverRebase(retained.repo, {
    ...failingDaemon.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('push failure retains stash and recovery lock with actionable report', failed.status === 'failed'
    && /push|pushed/i.test(failed.error) && fs.existsSync(failingDaemon.lockFile)
    && git(retained.graphDir, ['stash', 'list', '--format=%H']).includes(retained.stashOid)
    && Array.isArray(failed.next_steps) && failed.next_steps.some((step) => step.includes('.orch-off')));
  ok('push failure never restarts the daemon', restarts === 0);

  const wrongBuild = createRetainedStashFixture();
  const wrongBuildDaemon = daemonFixture(wrongBuild.repo, {
    restartDaemon: async () => ({
      ok: true,
      identity: {
        reachable: true,
        identified: true,
        ownershipProof: true,
        ready: true,
        pid: 41041,
        head: 'different-fixture',
        build: 'git:different-fixture',
      },
    }),
  });
  const wrongBuildResult = await lifecycle.recoverRebase(wrongBuild.repo, {
    ...wrongBuildDaemon.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('mismatched restart build fails closed and restores the recovery lock', wrongBuildResult.status === 'failed'
    && /restart/i.test(wrongBuildResult.error) && fs.existsSync(wrongBuildDaemon.lockFile)
    && git(wrongBuild.graphDir, ['stash', 'list', '--format=%H']).includes(wrongBuild.stashOid));
}

async function testNonRebaseAdmissionRequiresCommittedProof() {
  const uncommitted = createRetainedStashFixture();
  git(uncommitted.graphDir, ['stash', 'drop', 'stash@{0}']);
  git(uncommitted.graphDir, ['reset', '--mixed', 'HEAD^']);
  const uncommittedDaemon = daemonFixture(uncommitted.repo);
  const uncommittedStatus = git(uncommitted.graphDir, ['status', '--porcelain=v2']);
  const uncommittedClaim = fs.readFileSync(path.join(uncommitted.graphDir, 'claims', 'one.json'), 'utf8');
  const uncommittedResult = await lifecycle.recoverRebase(uncommitted.repo, {
    ...uncommittedDaemon.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('uncommitted working-tree marker is refused without authoritative stash and HEAD proof',
    uncommittedResult.status === 'refused' && /HEAD|committed|stash/i.test(uncommittedResult.error));
  ok('uncommitted marker refusal performs no lock, signal, stage, flush, restart, or mutation',
    uncommittedDaemon.signals() === 0 && uncommittedDaemon.flushes() === 0
    && uncommittedDaemon.restarts() === 0 && !fs.existsSync(uncommittedDaemon.lockFile)
    && git(uncommitted.graphDir, ['status', '--porcelain=v2']) === uncommittedStatus
    && fs.readFileSync(path.join(uncommitted.graphDir, 'claims', 'one.json'), 'utf8') === uncommittedClaim);

  const unmerged = createRetainedStashFixture({ commitMarker: false });
  const unmergedDaemon = daemonFixture(unmerged.repo);
  const unmergedIndex = git(unmerged.graphDir, ['ls-files', '-u']);
  const unmergedClaim = fs.readFileSync(path.join(unmerged.graphDir, 'claims', 'one.json'), 'utf8');
  const unmergedResult = await lifecycle.recoverRebase(unmerged.repo, {
    ...unmergedDaemon.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('non-rebase unmerged index is refused without a conflict marker committed in HEAD',
    unmergedResult.status === 'refused' && /HEAD|committed|unmerged/i.test(unmergedResult.error));
  ok('non-rebase unmerged refusal performs no lock, signal, stage, flush, restart, or mutation',
    unmergedDaemon.signals() === 0 && unmergedDaemon.flushes() === 0
    && unmergedDaemon.restarts() === 0 && !fs.existsSync(unmergedDaemon.lockFile)
    && git(unmerged.graphDir, ['ls-files', '-u']) === unmergedIndex
    && fs.readFileSync(path.join(unmerged.graphDir, 'claims', 'one.json'), 'utf8') === unmergedClaim);
}

async function testLockedPostPushRestartResume() {
  const fixture = createLockedRestartResumeFixture();
  const plan = await lifecycle.recoverRebase(fixture.repo, {
    ...fixture.options,
    dryRun: true,
  });
  ok('dry run recognizes the exact locked post-push restart resume state', plan.status === 'dry-run'
    && plan.resume === true && plan.recoverable === true && plan.graphHead === fixture.graphHead
    && plan.stashes.length === 1 && plan.stashes[0].oid === fixture.stashOid, JSON.stringify(plan));
  ok('resume dry run preserves the recovery lock, stash, graph, and stopped daemon',
    fs.existsSync(fixture.daemon.lockFile)
    && git(fixture.graphDir, ['stash', 'list', '--format=%H']).split('\n').includes(fixture.stashOid)
    && git(fixture.graphDir, ['rev-parse', 'HEAD']) === fixture.graphHead
    && fixture.daemon.restarts() === 0);

  const result = await lifecycle.recoverRebase(fixture.repo, {
    ...fixture.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('locked post-push recovery resumes only the same-build daemon restart', result.status === 'recovered'
    && result.resume === true && result.restart && result.restart.ok
    && fixture.daemon.restarts() === 1 && fixture.daemon.signals() === 0 && fixture.daemon.flushes() === 0,
  JSON.stringify(result));
  ok('successful resume removes the lock and exact stash only after readiness proof',
    !fs.existsSync(fixture.daemon.lockFile)
    && !git(fixture.graphDir, ['stash', 'list', '--format=%H']).split('\n').includes(fixture.stashOid)
    && fs.readFileSync(path.join(fixture.graphDir, 'daemon.port'), 'utf8') === '8787\n');
}

async function testLegacyLockedPostPushRestartResume() {
  const fixture = createLockedRestartResumeFixture({ legacy: true });
  fixture.options.getDaemonIdentity = () => ({ head: 'new-installed', build: 'git:new-installed' });
  const result = await lifecycle.recoverRebase(fixture.repo, {
    ...fixture.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('legacy recovery lock resumes only after reconstructing every missing binding', result.status === 'recovered'
    && result.resume === true && result.legacyLock === true && result.restart && result.restart.ok
    && fixture.daemon.signals() === 0 && fixture.daemon.restartRequests()[0].reuseOnly === true,
  JSON.stringify(result));
  ok('legacy resume removes the proven lock and exact sole stash', !fs.existsSync(fixture.daemon.lockFile)
    && !git(fixture.graphDir, ['stash', 'list', '--format=%H']).split('\n').includes(fixture.stashOid));

  const ambiguous = createLockedRestartResumeFixture({ legacy: true });
  write(path.join(ambiguous.graphDir, 'legacy-extra.txt'), 'ambiguous legacy recovery event\n');
  git(ambiguous.graphDir, ['stash', 'push', '--include-untracked', '-m', 'zonoid graph rebase recovery ambiguous legacy fixture']);
  const refused = await lifecycle.recoverRebase(ambiguous.repo, {
    ...ambiguous.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('ambiguous legacy lock state refuses before lock, stash, or daemon mutation', refused.status === 'refused'
    && /multiple|stash|ambiguous/i.test(refused.error)
    && fs.existsSync(ambiguous.daemon.lockFile) && ambiguous.daemon.restarts() === 0
    && git(ambiguous.graphDir, ['stash', 'list', '--format=%H']).split('\n').length === 2);
}

async function testLockedResumeRefusesAmbiguityAndStaleEvidence() {
  const ambiguous = createLockedRestartResumeFixture();
  write(path.join(ambiguous.graphDir, 'extra.txt'), 'extra recovery event\n');
  git(ambiguous.graphDir, ['stash', 'push', '--include-untracked', '-m', 'zonoid graph rebase recovery ambiguous fixture']);
  const ambiguousResult = await lifecycle.recoverRebase(ambiguous.repo, {
    ...ambiguous.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('multiple recognized recovery stashes refuse resume before mutation', ambiguousResult.status === 'refused'
    && /multiple|stash|ambiguous/i.test(ambiguousResult.error)
    && fs.existsSync(ambiguous.daemon.lockFile) && ambiguous.daemon.restarts() === 0
    && git(ambiguous.graphDir, ['stash', 'list', '--format=%H']).split('\n').length === 2);

  const stale = createLockedRestartResumeFixture();
  const staleLock = { ...stale.lock, graph_head: git(stale.graphDir, ['rev-parse', 'HEAD^']) };
  write(stale.daemon.lockFile, `${JSON.stringify(staleLock)}\n`);
  const staleResult = await lifecycle.recoverRebase(stale.repo, {
    ...stale.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('stale lock or stash binding refuses resume and preserves both', staleResult.status === 'refused'
    && /lock|HEAD|stash|stale|binding/i.test(staleResult.error)
    && fs.existsSync(stale.daemon.lockFile) && stale.daemon.restarts() === 0
    && git(stale.graphDir, ['stash', 'list', '--format=%H']).split('\n').includes(stale.stashOid));

  const wrongInstalledBuild = createLockedRestartResumeFixture();
  wrongInstalledBuild.options.getDaemonIdentity = () => ({ head: 'other', build: 'git:other' });
  const wrongBuildResult = await lifecycle.recoverRebase(wrongInstalledBuild.repo, {
    ...wrongInstalledBuild.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('metadata-bound resume refuses a changed installed daemon build before mutation', wrongBuildResult.status === 'refused'
    && /build|daemon/i.test(wrongBuildResult.error)
    && fs.existsSync(wrongInstalledBuild.daemon.lockFile) && wrongInstalledBuild.daemon.restarts() === 0
    && git(wrongInstalledBuild.graphDir, ['stash', 'list', '--format=%H']).split('\n').includes(wrongInstalledBuild.stashOid));

  const dirty = createLockedRestartResumeFixture();
  write(path.join(dirty.graphDir, 'unexpected.jsonl'), '{"event":"late"}\n');
  const dirtyResult = await lifecycle.recoverRebase(dirty.repo, {
    ...dirty.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('dirty post-push graph outside daemon.port refuses resume without mutation', dirtyResult.status === 'refused'
    && /clean|dirty|graph/i.test(dirtyResult.error)
    && fs.existsSync(dirty.daemon.lockFile) && dirty.daemon.restarts() === 0
    && fs.existsSync(path.join(dirty.graphDir, 'unexpected.jsonl'))
    && git(dirty.graphDir, ['stash', 'list', '--format=%H']).split('\n').includes(dirty.stashOid));

  const unpushed = createLockedRestartResumeFixture();
  write(path.join(unpushed.graphDir, 'local-only.txt'), 'not pushed\n');
  git(unpushed.graphDir, ['add', '--', 'local-only.txt']);
  git(unpushed.graphDir, ['commit', '-m', 'local unpushed recovery head']);
  const unpushedHead = git(unpushed.graphDir, ['rev-parse', 'HEAD']);
  write(unpushed.daemon.lockFile, `${JSON.stringify({ ...unpushed.lock, graph_head: unpushedHead })}\n`);
  const unpushedResult = await lifecycle.recoverRebase(unpushed.repo, {
    ...unpushed.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('locally clean but unpushed HEAD refuses resume and preserves lock and stash', unpushedResult.status === 'refused'
    && /remote|push|contain/i.test(unpushedResult.error)
    && fs.existsSync(unpushed.daemon.lockFile) && unpushed.daemon.restarts() === 0
    && git(unpushed.graphDir, ['stash', 'list', '--format=%H']).split('\n').includes(unpushed.stashOid));
}

async function testLockedResumeRestartFailurePreservesEvidence() {
  const fixture = createLockedRestartResumeFixture();
  const beforeLock = fs.readFileSync(fixture.daemon.lockFile, 'utf8');
  const result = await lifecycle.recoverRebase(fixture.repo, {
    ...fixture.options,
    restartDaemon: async () => ({ ok: false, reason: 'injected restart failure' }),
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('resume restart failure restores the exact trusted recovery lock', result.status === 'failed'
    && /restart/i.test(result.error) && fs.readFileSync(fixture.daemon.lockFile, 'utf8') === beforeLock);
  ok('resume restart failure preserves the exact retained stash and clean pushed HEAD',
    git(fixture.graphDir, ['stash', 'list', '--format=%H']).split('\n').includes(fixture.stashOid)
    && git(fixture.graphDir, ['rev-parse', 'HEAD']) === fixture.graphHead
    && git(fixture.graphDir, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.', ':(exclude)daemon.port']) === '');
}

async function testLockedNoStashResume() {
  const fixture = createFixture();
  fs.rmSync(path.join(fixture.graphDir, 'untracked.jsonl'));
  git(fixture.graphDir, ['checkout', '--', 'live.txt']);
  const daemon = daemonFixture(fixture.repo);
  const failed = await lifecycle.recoverRebase(fixture.repo, {
    ...daemon.options,
    flushGraph: async (targetRepo) => {
      const graphDir = path.join(targetRepo, '.graph');
      git(graphDir, ['add', '-A', '--', '.', ':(exclude)daemon.port']);
      if (gitFails(graphDir, ['diff', '--cached', '--quiet', '--exit-code'])) {
        git(graphDir, ['commit', '-m', 'fixture pushed no-stash recovery']);
      }
      git(graphDir, ['push', 'origin', 'HEAD:main']);
      return { status: 'pushed', commit: git(graphDir, ['rev-parse', 'HEAD']) };
    },
    restartDaemon: async () => ({ ok: false, reason: 'injected no-stash restart failure' }),
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  const beforeLock = fs.readFileSync(daemon.lockFile, 'utf8');
  ok('metadata-bound no-stash restart failure restores the exact trusted recovery lock',
    failed.status === 'failed' && failed.stash === null && /restart/i.test(failed.error)
    && JSON.parse(beforeLock).stash_oid === null
    && git(fixture.graphDir, ['stash', 'list', '--format=%H']) === '', JSON.stringify(failed));

  const resumed = await lifecycle.recoverRebase(fixture.repo, {
    ...daemon.options,
    getDaemonIdentity: () => ({ head: 'stable-fixture', build: 'git:stable-fixture', version: null }),
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('metadata-bound no-stash recovery resumes without dereferencing or dropping a stash',
    resumed.status === 'recovered' && resumed.resume === true && resumed.stash === null
    && resumed.restart && resumed.restart.ok && daemon.restarts() === 1
    && !fs.existsSync(daemon.lockFile)
    && git(fixture.graphDir, ['stash', 'list', '--format=%H']) === '', JSON.stringify(resumed));

  const ambiguous = createLockedRestartResumeFixture({ noStash: true });
  write(path.join(ambiguous.graphDir, 'unexpected-event.txt'), 'unexpected recovery event\n');
  git(ambiguous.graphDir, [
    'stash', 'push', '--include-untracked', '-m', 'zonoid graph rebase recovery unexpected no-stash fixture',
  ]);
  const ambiguousStash = git(ambiguous.graphDir, ['rev-parse', 'refs/stash']);
  const refused = await lifecycle.recoverRebase(ambiguous.repo, {
    ...ambiguous.options,
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('metadata-bound null stash refuses a newly appeared recognized recovery stash before mutation',
    refused.status === 'refused' && /stash|binding|zero/i.test(refused.error)
    && fs.existsSync(ambiguous.daemon.lockFile) && ambiguous.daemon.restarts() === 0
    && git(ambiguous.graphDir, ['rev-parse', 'refs/stash']) === ambiguousStash, JSON.stringify(refused));
}

async function testUnknownConflictRefusal() {
  const root = temp('graph-rebase-unknown-');
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const repo = path.join(root, 'repo');
  const writer = path.join(root, 'writer');
  git(root, ['init', '--bare', '--initial-branch', 'main', remote]);
  git(root, ['init', '--initial-branch', 'main', seed]);
  identity(seed);
  write(path.join(seed, 'seed.txt'), 'seed\n');
  git(seed, ['add', '-A']);
  git(seed, ['commit', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);
  git(root, ['init', '--initial-branch', 'main', repo]);
  identity(repo);
  git(repo, ['-c', 'protocol.file.allow=always', 'submodule', 'add', remote, '.graph']);
  git(repo, ['commit', '-m', 'attach graph']);
  const graphDir = path.join(repo, '.graph');
  identity(graphDir);
  write(path.join(graphDir, 'unknown.jsonl'), '{"event":"local"}\n');
  git(graphDir, ['add', '-A']);
  git(graphDir, ['commit', '-m', 'local unknown']);
  git(root, ['clone', remote, writer]);
  identity(writer);
  write(path.join(writer, 'unknown.jsonl'), '{"event":"remote"}\n');
  git(writer, ['add', '-A']);
  git(writer, ['commit', '-m', 'remote unknown']);
  git(writer, ['push', 'origin', 'main']);
  git(graphDir, ['fetch', 'origin']);
  ok('unknown fixture enters an interrupted rebase', gitFails(graphDir, ['rebase', 'origin/main']));

  const result = await lifecycle.recoverRebase(repo, {
    dryRun: false,
    drainsPaused: true,
    env: pausedEnv(),
  });
  ok('unknown conflict class fails closed before mutation', result.status === 'refused'
    && result.recoverable === false && rebaseActive(graphDir));
  ok('root JSONL conflict remains unmerged for manual recovery', git(graphDir, ['diff', '--name-only', '--diff-filter=U']) === 'unknown.jsonl');
}

async function main() {
  try {
    await testFailureKeepsRecoveryStash();
    await testKnownRecovery();
    await testRetainedStashAndCommittedMarkerRecovery();
    await testUnsafeDaemonAndFlushFailureStayFailClosed();
    await testNonRebaseAdmissionRequiresCommittedProof();
    await testLockedPostPushRestartResume();
    await testLegacyLockedPostPushRestartResume();
    await testLockedResumeRefusesAmbiguityAndStaleEvidence();
    await testLockedResumeRestartFailurePreservesEvidence();
    await testLockedNoStashResume();
    await testUnknownConflictRefusal();
  } finally {
    for (const dir of cleanup.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
