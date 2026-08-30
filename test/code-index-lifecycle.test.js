'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { EventEmitter } = require('events');
const overlayStore = require('../lib/overlay');
const lifecycle = require('../lib/code-extract/lifecycle');

function git(repo, args) {
  return childProcess.execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function completedRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-lifecycle-'));
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'index.js'), 'exports.ready = true;\n');
  git(repo, ['add', 'index.js']);
  git(repo, ['commit', '-m', 'init']);
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
    generation: 'onboard-test', total: 1, cursor: 1, kept: [], rejected: [], pending: [],
  }));
  fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
    repo, outDir, preparationState: 'ready', injectionState: 'not_needed',
  }));
  return { repo, outDir, head: git(repo, ['rev-parse', 'HEAD']) };
}

function setSucceededSyncStatus(fixture, head, from = fixture.head) {
  const statusFile = path.join(fixture.outDir, 'onboard-drain-status.json');
  const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
  fs.writeFileSync(statusFile, JSON.stringify({
    ...status,
    codeIndexState: 'succeeded',
    codeIndexMode: 'sync',
    codeIndexFrom: from,
    codeIndexHead: head,
  }));
}

test('completed onboarding without a watermark is discovered once and success stores counts', () => {
  const fixture = completedRepo();
  try {
    const jobs = lifecycle.findDueFullIndexJobs({ registeredWorkspaces: [fixture.repo] });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].head, fixture.head);

    const owner = 'test-owner';
    const claimed = lifecycle.claimFullIndex(jobs[0], {
      owner, timeoutMs: 60_000, now: 1_000, pid: process.pid,
    });
    assert.equal(claimed.applied, true);
    let status = JSON.parse(fs.readFileSync(path.join(fixture.outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.codeIndexState, 'running');
    assert.equal(status.codeIndexAttempts, 1);

    const completed = lifecycle.completeFullIndex(jobs[0], owner, {
      head: fixture.head, symbols: 7, created: 7, edges: 3, edges_added: 3, batches: 1,
    }, 2_000);
    assert.equal(completed.applied, true);
    status = JSON.parse(fs.readFileSync(path.join(fixture.outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.codeIndexState, 'succeeded');
    assert.deepEqual(status.codeIndexCounts, { symbols: 7, created: 7, edges: 3, edges_added: 3, batches: 1 });

    const overlay = overlayStore.load(fixture.repo);
    overlayStore.setLastIndexedCommit(overlay, fixture.repo, fixture.head);
    overlayStore.save(fixture.repo, overlay);
    assert.equal(lifecycle.findDueFullIndexJobs({ registeredWorkspaces: [fixture.repo] }).length, 0,
      'the durable overlay watermark prevents a second full index');
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('failed indexing preserves the KB queue and becomes retryable after backoff', () => {
  const fixture = completedRepo();
  try {
    const queueFile = path.join(fixture.outDir, 'onboard-queue.json');
    const queueBefore = fs.readFileSync(queueFile);
    const job = lifecycle.findDueFullIndexJobs({ registeredWorkspaces: [fixture.repo] })[0];
    lifecycle.claimFullIndex(job, { owner: 'failure-owner', timeoutMs: 60_000, now: 10_000, pid: process.pid });
    lifecycle.failFullIndex(job, 'failure-owner', 'parser crashed', 20_000);

    const status = JSON.parse(fs.readFileSync(path.join(fixture.outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.codeIndexState, 'failed');
    assert.match(status.codeIndexError, /parser crashed/);
    assert.ok(status.codeIndexRetryAt > 20_000);
    assert.deepEqual(fs.readFileSync(queueFile), queueBefore, 'AST failure must not rewrite or discard KB work');
    assert.equal(lifecycle.findDueFullIndexJobs({ registeredWorkspaces: [fixture.repo] }, {
      now: status.codeIndexRetryAt - 1,
    }).length, 0);
    assert.equal(lifecycle.findDueFullIndexJobs({ registeredWorkspaces: [fixture.repo] }, {
      now: status.codeIndexRetryAt + 1,
    }).length, 1);
    assert.equal(lifecycle.publicCodeIndexStatus(fixture.repo).retryable, true);
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('an expired running lease is recovered after daemon restart', () => {
  const fixture = completedRepo();
  try {
    const statusFile = path.join(fixture.outDir, 'onboard-drain-status.json');
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    fs.writeFileSync(statusFile, JSON.stringify({
      ...status,
      codeIndexState: 'running',
      codeIndexHead: fixture.head,
      codeIndexOwner: 'dead-daemon',
      codeIndexPid: 99999999,
      codeIndexLeaseExpiresAt: 5_000,
    }));
    assert.equal(lifecycle.findDueFullIndexJobs({ registeredWorkspaces: [fixture.repo] }, {
      now: 6_000, pidAlive: () => false,
    }).length, 1);
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('a watermark committed before parent exit repairs stale running status on restart', () => {
  const fixture = completedRepo();
  try {
    const statusFile = path.join(fixture.outDir, 'onboard-drain-status.json');
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    fs.writeFileSync(statusFile, JSON.stringify({
      ...status,
      codeIndexState: 'running', codeIndexHead: fixture.head,
      codeIndexOwner: 'exited-parent', codeIndexPid: 99999999, codeIndexLeaseExpiresAt: 1,
    }));
    const overlay = overlayStore.load(fixture.repo);
    overlayStore.setLastIndexedCommit(overlay, fixture.repo, fixture.head);
    overlayStore.save(fixture.repo, overlay);

    assert.equal(lifecycle.findDueFullIndexJobs({ registeredWorkspaces: [fixture.repo] }, {
      now: 10_000, pidAlive: () => false,
    }).length, 0);
    const repaired = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    assert.equal(repaired.codeIndexState, 'succeeded');
    assert.equal(repaired.codeIndexOwner, null);
    assert.equal(repaired.codeIndexHead, fixture.head);
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('a succeeded full index restores a lost watermark and does not rerun at the same HEAD', () => {
  const fixture = completedRepo();
  try {
    const statusFile = path.join(fixture.outDir, 'onboard-drain-status.json');
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    fs.writeFileSync(statusFile, JSON.stringify({
      ...status,
      codeIndexState: 'succeeded',
      codeIndexMode: 'full',
      codeIndexHead: fixture.head,
      codeIndexCounts: { symbols: 7, edges: 3 },
    }));

    assert.equal(lifecycle.findDueFullIndexJobs({ registeredWorkspaces: [fixture.repo] }).length, 0);
    const restored = overlayStore.load(fixture.repo);
    assert.equal(overlayStore.getLastIndexedCommit(restored, fixture.repo), fixture.head,
      'the succeeded full-index status is a durable recovery source');
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('a succeeded incremental sync restores a missing watermark before discovery', () => {
  const fixture = completedRepo();
  try {
    fs.writeFileSync(path.join(fixture.repo, 'index.js'), 'exports.ready = false;\n');
    git(fixture.repo, ['add', 'index.js']);
    git(fixture.repo, ['commit', '-m', 'sync change']);
    const nextHead = git(fixture.repo, ['rev-parse', 'HEAD']);
    setSucceededSyncStatus(fixture, nextHead);

    assert.equal(lifecycle.findDueIncrementalIndexJobs({ registeredWorkspaces: [fixture.repo] }).length, 0);
    const restored = overlayStore.load(fixture.repo);
    assert.equal(overlayStore.getLastIndexedCommit(restored, fixture.repo), nextHead,
      'the succeeded sync status should repopulate a missing watermark');
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('a succeeded incremental sync overwrites a stale watermark before discovery', () => {
  const fixture = completedRepo();
  try {
    fs.writeFileSync(path.join(fixture.repo, 'index.js'), 'exports.ready = false;\n');
    git(fixture.repo, ['add', 'index.js']);
    git(fixture.repo, ['commit', '-m', 'sync change']);
    const nextHead = git(fixture.repo, ['rev-parse', 'HEAD']);
    setSucceededSyncStatus(fixture, nextHead);

    const overlay = overlayStore.load(fixture.repo);
    overlayStore.setLastIndexedCommit(overlay, fixture.repo, fixture.head);
    overlayStore.save(fixture.repo, overlay);

    assert.equal(lifecycle.findDueIncrementalIndexJobs({ registeredWorkspaces: [fixture.repo] }).length, 0);
    const restored = overlayStore.load(fixture.repo);
    assert.equal(overlayStore.getLastIndexedCommit(restored, fixture.repo), nextHead,
      'the succeeded sync status should overwrite a stale watermark');
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('a newer HEAD incrementally syncs from a watermark recovered from full-index status', () => {
  const fixture = completedRepo();
  try {
    const statusFile = path.join(fixture.outDir, 'onboard-drain-status.json');
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    fs.writeFileSync(statusFile, JSON.stringify({
      ...status,
      codeIndexState: 'succeeded',
      codeIndexMode: 'full',
      codeIndexHead: fixture.head,
    }));
    fs.writeFileSync(path.join(fixture.repo, 'index.js'), 'exports.ready = false;\n');
    git(fixture.repo, ['add', 'index.js']);
    git(fixture.repo, ['commit', '-m', 'change after full index']);
    const nextHead = git(fixture.repo, ['rev-parse', 'HEAD']);

    assert.equal(lifecycle.findDueFullIndexJobs({ registeredWorkspaces: [fixture.repo] }).length, 0);
    const jobs = lifecycle.findDueIncrementalIndexJobs({ registeredWorkspaces: [fixture.repo] });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].from, fixture.head);
    assert.equal(jobs[0].head, nextHead);
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('a changed canonical HEAD schedules one serialized incremental sync and persists counts', () => {
  const fixture = completedRepo();
  try {
    const overlay = overlayStore.load(fixture.repo);
    overlayStore.setLastIndexedCommit(overlay, fixture.repo, fixture.head);
    overlayStore.save(fixture.repo, overlay);
    fs.writeFileSync(path.join(fixture.repo, 'index.js'), 'exports.ready = false;\n');
    git(fixture.repo, ['add', 'index.js']);
    git(fixture.repo, ['commit', '-m', 'change']);
    const nextHead = git(fixture.repo, ['rev-parse', 'HEAD']);

    const job = lifecycle.findDueIncrementalIndexJobs({ registeredWorkspaces: [fixture.repo] })[0];
    assert.equal(job.from, fixture.head);
    assert.equal(job.head, nextHead);
    const owner = 'sync-owner';
    assert.equal(lifecycle.claimIncrementalIndex(job, {
      owner, timeoutMs: 60_000, pid: process.pid,
    }).applied, true);
    assert.equal(lifecycle.findDueIncrementalIndexJobs({ registeredWorkspaces: [fixture.repo] }).length, 0,
      'the shared live lease coalesces repeated maintenance ticks');

    lifecycle.completeIncrementalIndex(job, owner, {
      from: fixture.head, head: nextHead, changed_files: ['index.js'], upserted: 2,
      files_replaced: 1, edges_replaced: 1,
    });
    const status = JSON.parse(fs.readFileSync(path.join(fixture.outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.codeIndexState, 'succeeded');
    assert.equal(status.codeIndexMode, 'sync');
    assert.equal(status.codeIndexFrom, fixture.head);
    assert.equal(status.codeIndexHead, nextHead);
    assert.deepEqual(status.codeIndexCounts, {
      changed_files: 1, upserted: 2, deleted: 0, files_replaced: 1,
      files_deleted: 0, edges_replaced: 1, edges_deleted: 0,
    });
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('incremental failure backs off for the same HEAD but a newer HEAD is immediately eligible', () => {
  const fixture = completedRepo();
  try {
    const overlay = overlayStore.load(fixture.repo);
    overlayStore.setLastIndexedCommit(overlay, fixture.repo, fixture.head);
    overlayStore.save(fixture.repo, overlay);
    fs.writeFileSync(path.join(fixture.repo, 'index.js'), 'exports.ready = 2;\n');
    git(fixture.repo, ['add', 'index.js']);
    git(fixture.repo, ['commit', '-m', 'change one']);
    const firstHead = git(fixture.repo, ['rev-parse', 'HEAD']);
    const job = lifecycle.findDueIncrementalIndexJobs({ registeredWorkspaces: [fixture.repo] })[0];
    lifecycle.claimIncrementalIndex(job, {
      owner: 'failed-sync', timeoutMs: 60_000, now: 10_000, pid: process.pid,
    });
    lifecycle.failIncrementalIndex(job, 'failed-sync', 'daemon unavailable', 20_000);
    const failed = JSON.parse(fs.readFileSync(path.join(fixture.outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(lifecycle.findDueIncrementalIndexJobs({ registeredWorkspaces: [fixture.repo] }, {
      now: failed.codeIndexRetryAt - 1,
    }).length, 0);

    fs.writeFileSync(path.join(fixture.repo, 'index.js'), 'exports.ready = 3;\n');
    git(fixture.repo, ['add', 'index.js']);
    git(fixture.repo, ['commit', '-m', 'change two']);
    const newer = lifecycle.findDueIncrementalIndexJobs({ registeredWorkspaces: [fixture.repo] }, {
      now: failed.codeIndexRetryAt - 1,
    });
    assert.equal(newer.length, 1);
    assert.equal(newer[0].from, fixture.head);
    assert.notEqual(newer[0].head, firstHead);
  } finally {
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('linked attempt worktrees resolve to the canonical checkout instead of a second index identity', () => {
  const fixture = completedRepo();
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-linked-'));
  fs.rmSync(worktree, { recursive: true, force: true });
  try {
    git(fixture.repo, ['worktree', 'add', '--detach', worktree, fixture.head]);
    assert.deepEqual(lifecycle.registeredRepos({ registeredWorkspaces: [worktree] }), [fs.realpathSync(fixture.repo)]);
  } finally {
    try { git(fixture.repo, ['worktree', 'remove', '--force', worktree]); } catch { /* cleanup below */ }
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(fixture.repo, { recursive: true, force: true });
  }
});

test('headless maintenance pump invokes the existing multi-language onboarder', async () => {
  const originalSpawn = childProcess.spawn;
  const originalLease = process.env.HEADLESS_DRAIN_LEASE_FILE;
  const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-index-lease-'));
  process.env.HEADLESS_DRAIN_LEASE_FILE = path.join(leaseDir, 'leases.json');
  const calls = [];
  childProcess.spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.kill = () => { child.emit('close', null); return true; };
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({
        mode: 'full', head: 'abc123', watermark_recorded: true,
        symbols: 4, created: 4, edges: 2, edges_added: 2, batches: 1,
      }) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
  delete require.cache[require.resolve('../lib/headless-drain')];
  const headless = require('../lib/headless-drain');
  const completed = [];
  const fakeLifecycle = {
    findDueFullIndexJobs: () => [{ repo: os.tmpdir(), workspace: os.tmpdir(), outDir: os.tmpdir(), head: 'abc123', status: {} }],
    claimFullIndex: () => ({ applied: true }),
    buildFullIndexArgs: lifecycle.buildFullIndexArgs,
    parseIndexResult: lifecycle.parseIndexResult,
    completeFullIndex: (_job, _owner, result) => { completed.push(result); return { applied: true }; },
    failFullIndex: () => { throw new Error('unexpected failure'); },
  };
  try {
    const result = await headless.runDueDrains({ workspace: os.tmpdir() }, null, {
      codeIndexDeps: { lifecycle: fakeLifecycle, daemonUrl: 'http://127.0.0.1:9876' },
      judgeDeps: {
        overlayLoad: () => ({}),
        judgeLib: { judgeQueueDepth: () => 0, buildQueue: () => [], eagerJudgeNodes: () => [] },
      },
      labelDeps: {
        rowKey: () => '', journalPath: () => '/none', labeledPath: () => '/none', readJsonl: () => [],
      },
    });
    assert.equal(result.drains.some((entry) => entry.drain === headless.CODE_INDEX_DRAIN_KEY), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, process.execPath);
    assert.ok(calls[0].args.includes('--async'));
    assert.ok(calls[0].args.includes('--thin'));
    assert.ok(calls[0].args.includes('--json'));
    assert.equal(calls[0].args[calls[0].args.indexOf('--expected-head') + 1], 'abc123');
    assert.deepEqual(completed[0], {
      mode: 'full', head: 'abc123', watermark_recorded: true,
      symbols: 4, created: 4, edges: 2, edges_added: 2, batches: 1,
    });
    assert.equal(headless._governor.concurrentRunning, 0);
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalLease === undefined) delete process.env.HEADLESS_DRAIN_LEASE_FILE;
    else process.env.HEADLESS_DRAIN_LEASE_FILE = originalLease;
    fs.rmSync(leaseDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/headless-drain')];
  }
});

test('headless maintenance pump automatically invokes incremental sync after HEAD changes', async () => {
  const originalSpawn = childProcess.spawn;
  const originalLease = process.env.HEADLESS_DRAIN_LEASE_FILE;
  const leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-sync-lease-'));
  process.env.HEADLESS_DRAIN_LEASE_FILE = path.join(leaseDir, 'leases.json');
  const calls = [];
  childProcess.spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stdout.setEncoding = () => {};
    child.stderr = new EventEmitter(); child.stderr.setEncoding = () => {};
    child.kill = () => { child.emit('close', null); return true; };
    setImmediate(() => {
      child.stdout.emit('data', JSON.stringify({
        mode: 'sync', from: 'old', head: 'new', watermark_recorded: true,
        changed_files: ['index.js'], upserted: 2, deleted: 0,
        files_replaced: 1, files_deleted: 0, edges_replaced: 1, edges_deleted: 0,
      }) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
  delete require.cache[require.resolve('../lib/headless-drain')];
  const headless = require('../lib/headless-drain');
  const completed = [];
  const fakeLifecycle = {
    findDueFullIndexJobs: () => [],
    findDueIncrementalIndexJobs: () => [{
      repo: os.tmpdir(), workspace: os.tmpdir(), outDir: os.tmpdir(), from: 'old', head: 'new', status: {},
    }],
    claimIncrementalIndex: () => ({ applied: true }),
    buildIncrementalIndexArgs: lifecycle.buildIncrementalIndexArgs,
    parseSyncResult: lifecycle.parseSyncResult,
    completeIncrementalIndex: (_job, _owner, result) => { completed.push(result); return { applied: true }; },
    failIncrementalIndex: () => { throw new Error('unexpected failure'); },
  };
  try {
    const result = await headless.runDueDrains({ workspace: os.tmpdir() }, null, {
      codeIndexDeps: { lifecycle: fakeLifecycle, daemonUrl: 'http://127.0.0.1:9876' },
      judgeDeps: {
        overlayLoad: () => ({}),
        judgeLib: { judgeQueueDepth: () => 0, buildQueue: () => [], eagerJudgeNodes: () => [] },
      },
      labelDeps: {
        rowKey: () => '', journalPath: () => '/none', labeledPath: () => '/none', readJsonl: () => [],
      },
    });
    assert.equal(result.drains.some((entry) => entry.mode === 'sync'), true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes('--sync'));
    assert.ok(calls[0].args.includes('--async'));
    assert.equal(calls[0].args.includes('--thin'), false);
    assert.equal(calls[0].args[calls[0].args.indexOf('--expected-head') + 1], 'new');
    assert.equal(completed[0].watermark_recorded, true);
    assert.equal(headless._governor.concurrentRunning, 0);
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalLease === undefined) delete process.env.HEADLESS_DRAIN_LEASE_FILE;
    else process.env.HEADLESS_DRAIN_LEASE_FILE = originalLease;
    fs.rmSync(leaseDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../lib/headless-drain')];
  }
});

test('headless maintenance pump shares one authoritative overlay across code-index discovery', async () => {
  delete require.cache[require.resolve('../lib/headless-drain')];
  const headless = require('../lib/headless-drain');
  const workspace = os.tmpdir();
  const authoritative = { config: {}, code_nodes: { sentinel: { kind: 'function' } } };
  let overlayLoads = 0;
  const seen = [];
  const saveOverlay = () => {};
  const inspectDeps = (deps) => {
    seen.push(deps.loadOverlay(workspace));
    assert.equal(deps.saveOverlay, saveOverlay);
    return [];
  };
  const fakeLifecycle = {
    findDueFullIndexJobs: (_state, deps) => inspectDeps(deps),
    findDueIncrementalIndexJobs: (_state, deps) => inspectDeps(deps),
  };
  const options = {
    overlayLoad: () => { overlayLoads++; return authoritative; },
    overlaySave: saveOverlay,
    codeIndexDeps: { lifecycle: fakeLifecycle },
    judgeDeps: {
      judgeLib: { judgeQueueDepth: () => 0, buildQueue: () => [], eagerJudgeNodes: () => [] },
    },
    labelDeps: {
      rowKey: () => '', journalPath: () => '/none', labeledPath: () => '/none', readJsonl: () => [],
    },
  };

  try {
    await headless.runDueDrains({ workspace }, null, options);
    assert.equal(overlayLoads, 1, 'full and incremental discovery share one load per pump');

    options.overlay = authoritative;
    await headless.runDueDrains({ workspace }, null, options);
    assert.equal(overlayLoads, 1, 'explicit daemon overlay bypasses the external loader');
    assert.equal(seen.length, 4, 'both discovery paths ran on both pumps');
    assert.equal(seen.every((overlay) => overlay === authoritative), true);
  } finally {
    delete require.cache[require.resolve('../lib/headless-drain')];
  }
});
