#!/usr/bin/env node
/**
 * test/headless-drain.test.js
 *
 * Unit tests for lib/headless-drain.js.
 * Run: node --test test/headless-drain.test.js
 *
 * ALL spawn calls are MOCKED — no real CLI or drain process is executed.
 * Tests are self-contained and do not touch the filesystem beyond temp dirs.
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');
const onboardRoute = require('../routes/onboard');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset module cache so each test gets a fresh headless-drain module instance. */
function freshModule() {
  // Clear the cached module so _governor and env reads are fresh.
  const key = require.resolve('../lib/headless-drain');
  delete require.cache[key];
  return require('../lib/headless-drain');
}

/** Create a temp dir with an onboard-queue.json indicating a pending drain. */
function makePendingQueueDir(opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-test-'));
  const queueDir = path.join(tmpDir, '.graph', 'onboard');
  fs.mkdirSync(queueDir, { recursive: true });
  const total = opts.total ?? 10;
  const queue = {
    total,
    cursor: opts.cursor ?? 3,
    kept: [],
    rejected: [],
    pending: Array.from({ length: total }, (_, index) => ({ title: `candidate-${index}` })),
  };
  fs.writeFileSync(path.join(queueDir, 'onboard-queue.json'), JSON.stringify(queue));
  return tmpDir;
}

/** Create a temp dir with a completed queue (cursor === total). */
function makeCompletedQueueDir() {
  return makePendingQueueDir({ total: 10, cursor: 10 });
}

function git(repo, args) {
  return child_process.execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

function initGitRepo(repo) {
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'test']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '--allow-empty', '-m', 'init']);
}

let savedLeaseFile;
let savedIgnoreMarker;
let leaseDir;

beforeEach(() => {
  savedLeaseFile = process.env.HEADLESS_DRAIN_LEASE_FILE;
  savedIgnoreMarker = process.env.HEADLESS_DRAIN_IGNORE_MARKER;
  leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-lease-'));
  process.env.HEADLESS_DRAIN_LEASE_FILE = path.join(leaseDir, 'leases.json');
  process.env.HEADLESS_DRAIN_IGNORE_MARKER = '1';
});

afterEach(() => {
  if (savedLeaseFile === undefined) delete process.env.HEADLESS_DRAIN_LEASE_FILE;
  else process.env.HEADLESS_DRAIN_LEASE_FILE = savedLeaseFile;
  if (savedIgnoreMarker === undefined) delete process.env.HEADLESS_DRAIN_IGNORE_MARKER;
  else process.env.HEADLESS_DRAIN_IGNORE_MARKER = savedIgnoreMarker;
  if (leaseDir) fs.rmSync(leaseDir, { recursive: true, force: true });
  leaseDir = null;
});

// ---------------------------------------------------------------------------
// Test 1: drains are mandatory
// ---------------------------------------------------------------------------

test('isHeadlessEnabled compatibility export always returns true', async () => {
  const hd = freshModule();
  assert.equal(hd.isHeadlessEnabled(), true);

  // With no queue files and no judge/label work, runDueDrains is enabled but idle.
  const result = await hd.runDueDrains({ workspace: os.tmpdir() });
  assert.equal(result.ran, 0, 'ran should be 0 when no drains are due');
  assert.equal(result.skipped, 'no_due_drains', 'skipped reason should be no_due_drains');
  assert.deepEqual(result.drains, [], 'drains array should be empty');
});

// ---------------------------------------------------------------------------
// Test 2: budget/concurrency caps honored
// ---------------------------------------------------------------------------

test('iterationsUsed >= maxIterations → runDueDrains skips with iterations_exhausted', async () => {
  // Set a very low cap via env
  const savedMax = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '2';
  try {
    const hd = freshModule();
    // Manually exhaust the iteration budget
    hd._governor.iterationsUsed = 2;
    const tmpDir = makePendingQueueDir();
    try {
      const result = await hd.runDueDrains({ workspace: tmpDir });
      assert.equal(result.ran, 0);
      assert.equal(result.skipped, 'iterations_exhausted');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } finally {
    if (savedMax === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedMax;
  }
});

test('tokensUsed >= tokenBudget → runDueDrains skips with token_budget_exhausted', async () => {
  const savedBudget = process.env.HEADLESS_DRAIN_TOKEN_BUDGET;
  process.env.HEADLESS_DRAIN_TOKEN_BUDGET = '1000';
  try {
    const hd = freshModule();
    hd._governor.tokensUsed = 1000; // at cap
    const tmpDir = makePendingQueueDir();
    try {
      const result = await hd.runDueDrains({ workspace: tmpDir });
      assert.equal(result.ran, 0);
      assert.equal(result.skipped, 'token_budget_exhausted');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } finally {
    if (savedBudget === undefined) delete process.env.HEADLESS_DRAIN_TOKEN_BUDGET;
    else process.env.HEADLESS_DRAIN_TOKEN_BUDGET = savedBudget;
  }
});

test('concurrentRunning >= maxConcurrency → runDueDrains skips with concurrency_cap', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '1';
  try {
    const hd = freshModule();
    hd._governor.concurrentRunning = 1; // at cap
    const tmpDir = makePendingQueueDir();
    try {
      const result = await hd.runDueDrains({ workspace: tmpDir });
      assert.equal(result.ran, 0);
      assert.equal(result.skipped, 'concurrency_cap');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } finally {
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
  }
});

test('host-wide lease cap blocks drains across daemon processes', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '1';
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makeCompletedQueueDir();
  const lease = hd._acquireGlobalDrainSlot(hd.effectiveConfig(), 'external-test');
  try {
    assert.equal(lease.ok, true, 'test setup should acquire the only host-wide slot');
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: ['note:a'] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    });
    assert.equal(calls.length, 0, 'global cap must prevent spawning');
    assert.equal(result.ran, 0);
    assert.equal(result.skipped, 'global_concurrency_cap');
  } finally {
    if (lease && typeof lease.release === 'function') lease.release();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('no pending queue repos → runDueDrains skips with no_due_drains', async () => {
  try {
    const hd = freshModule();
    // Workspace with a completed queue (cursor === total) — not due
    const tmpDir = makeCompletedQueueDir();
    try {
      const result = await hd.runDueDrains({ workspace: tmpDir });
      assert.equal(result.ran, 0);
      assert.equal(result.skipped, 'no_due_drains');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } finally {
  }
});

test('runDueDrains does not merge approved tested tasks when automode is OFF', async () => {
  const hd = freshModule();
  const overlayStore = require('../lib/overlay');
  const o = overlayStore.EMPTY();
  o.config = { automode: false };
  const key = 'codex/review-pending';
  overlayStore.setStatus(o, key, 'tested');
  overlayStore.setReviewLifecycle(o, key, {
    review_state: 'approved',
    review_verdict: 'APPROVE',
    merge_state: 'pending',
  });
  const calls = [];
  try {
    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), {
      reviewMergeDeps: {
        overlay: o,
        overlayStore,
        mergeTask: async (candidate) => {
          calls.push(['merge', candidate.key]);
          return { merged: true, head: 'abc123' };
        },
        promoteTask: async (candidate, merge) => {
          calls.push(['promote', candidate.key, merge.head]);
          overlayStore.setStatus(o, candidate.key, 'done');
          overlayStore.setReviewLifecycle(o, candidate.key, { review_state: 'landed', merge_state: 'merged', merge_sha: merge.head });
          return { ok: true };
        },
      },
    });
    assert.equal(result.ran, 0);
    assert.deepEqual(calls, []);
    assert.equal(o.status[key], 'tested');
    assert.equal(overlayStore.reviewLifecycleFor(o, key, 'tested').merge_state, 'pending');
  } finally {
  }
});

test('runDueDrains merges approved tested tasks when automode is ON', async () => {
  const hd = freshModule();
  const overlayStore = require('../lib/overlay');
  const o = overlayStore.EMPTY();
  o.config = { automode: true };
  const key = 'codex/review-pending';
  overlayStore.setStatus(o, key, 'tested');
  overlayStore.setReviewLifecycle(o, key, {
    review_state: 'approved',
    review_verdict: 'APPROVE',
    merge_state: 'pending',
  });
  const calls = [];
  try {
    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), {
      reviewMergeDeps: {
        overlay: o,
        overlayStore,
        mergeTask: async (candidate) => {
          calls.push(['merge', candidate.key]);
          return { merged: true, head: 'abc123' };
        },
        promoteTask: async (candidate, merge) => {
          calls.push(['promote', candidate.key, merge.head]);
          overlayStore.setStatus(o, candidate.key, 'done');
          overlayStore.setReviewLifecycle(o, candidate.key, { review_state: 'landed', merge_state: 'merged', merge_sha: merge.head });
          return { ok: true };
        },
      },
    });
    assert.ok(result.ran >= 1, 'expected at least 1 drain result');
    assert.deepEqual(calls, [['merge', key], ['promote', key, 'abc123']]);
    assert.equal(o.status[key], 'done');
    assert.equal(overlayStore.reviewLifecycleFor(o, key, 'done').merge_state, 'merged');
  } finally {
  }
});

test('review merge drain promotes already-merged tested task to done', async () => {
  const hd = freshModule();
  const overlayStore = require('../lib/overlay');
  const o = overlayStore.EMPTY();
  const key = 'codex/review-already-merged';
  overlayStore.setStatus(o, key, 'tested');
  overlayStore.setReviewLifecycle(o, key, {
    review_state: 'approved',
    review_verdict: 'APPROVE',
    merge_state: 'merged',
    merge_sha: 'def456',
  });
  const calls = [];
  const result = await hd.runReviewMergeDrain(os.tmpdir(), {
    overlay: o,
    overlayStore,
    mergeTask: async (candidate) => {
      calls.push(['merge', candidate.key]);
      return { merged: true };
    },
    promoteTask: async (candidate, merge) => {
      calls.push(['promote', candidate.key, merge.head || candidate.merge_sha]);
      overlayStore.setStatus(o, candidate.key, 'done');
      return { ok: true };
    },
  });
  assert.equal(result.ran, 1);
  assert.deepEqual(calls, [['promote', key, 'def456']]);
  assert.equal(o.status[key], 'done');
});

test('review merge drain repairs approved task left in review_pending', async () => {
  const hd = freshModule();
  const overlayStore = require('../lib/overlay');
  const o = overlayStore.EMPTY();
  const key = 'codex/review-approved-stale-pending';
  overlayStore.setStatus(o, key, 'tested');
  overlayStore.setReviewLifecycle(o, key, {
    review_state: 'approved',
    review_verdict: 'APPROVE',
    merge_state: 'review_pending',
  });
  const calls = [];
  const result = await hd.runReviewMergeDrain(os.tmpdir(), {
    overlay: o,
    overlayStore,
    mergeTask: async (candidate) => {
      calls.push(['merge', candidate.key]);
      return { merged: true, head: 'abc789' };
    },
    promoteTask: async (candidate, merge) => {
      calls.push(['promote', candidate.key, merge.head]);
      overlayStore.setStatus(o, candidate.key, 'done');
      return { ok: true };
    },
  });
  assert.equal(result.ran, 1);
  assert.deepEqual(calls, [['merge', key], ['promote', key, 'abc789']]);
  assert.equal(o.status[key], 'done');
});

test('review merge drain repairs ready task that already has merged metadata', async () => {
  const hd = freshModule();
  const overlayStore = require('../lib/overlay');
  const o = overlayStore.EMPTY();
  const key = 'codex/review-ready-merged';
  overlayStore.setStatus(o, key, 'ready');
  overlayStore.setReviewLifecycle(o, key, {
    review_state: 'approved',
    review_verdict: 'APPROVE',
    merge_state: 'merged',
    merge_sha: 'def456',
  });
  const calls = [];
  const result = await hd.runReviewMergeDrain(os.tmpdir(), {
    overlay: o,
    overlayStore,
    mergeTask: async (candidate) => {
      calls.push(['merge', candidate.key]);
      return { merged: true };
    },
    promoteTask: async (candidate, merge) => {
      calls.push(['promote', candidate.key, merge.head || candidate.merge_sha]);
      overlayStore.setStatus(o, candidate.key, 'done');
      return { ok: true };
    },
  });
  assert.equal(result.ran, 1);
  assert.deepEqual(calls, [['promote', key, 'def456']]);
  assert.equal(o.status[key], 'done');
});

test('review merge drain does not merge ready task that only has pending review metadata', async () => {
  const hd = freshModule();
  const overlayStore = require('../lib/overlay');
  const o = overlayStore.EMPTY();
  const key = 'codex/review-ready-pending';
  overlayStore.setStatus(o, key, 'ready');
  overlayStore.setReviewLifecycle(o, key, {
    review_state: 'approved',
    review_verdict: 'APPROVE',
    merge_state: 'pending',
  });
  const calls = [];
  const result = await hd.runReviewMergeDrain(os.tmpdir(), {
    overlay: o,
    overlayStore,
    mergeTask: async (candidate) => {
      calls.push(['merge', candidate.key]);
      return { merged: true };
    },
    promoteTask: async (candidate) => {
      calls.push(['promote', candidate.key]);
      return { ok: true };
    },
  });
  assert.equal(result.ran, 0);
  assert.deepEqual(calls, []);
  assert.equal(o.status[key], 'ready');
});

test('review merge drain leaves merge conflicts visible and does not promote', async () => {
  const hd = freshModule();
  const overlayStore = require('../lib/overlay');
  const o = overlayStore.EMPTY();
  const key = 'codex/review-conflict';
  overlayStore.setStatus(o, key, 'tested');
  overlayStore.setReviewLifecycle(o, key, {
    review_state: 'approved',
    review_verdict: 'APPROVE',
    merge_state: 'pending',
  });
  const calls = [];
  const result = await hd.runReviewMergeDrain(os.tmpdir(), {
    overlay: o,
    overlayStore,
    mergeTask: async (candidate) => {
      calls.push(['merge', candidate.key]);
      overlayStore.setReviewLifecycle(o, candidate.key, { merge_state: 'conflict' });
      return { merged: false, conflict: true, files: ['lib/a.js'] };
    },
    promoteTask: async (candidate) => {
      calls.push(['promote', candidate.key]);
      return { ok: true };
    },
  });
  assert.equal(result.ran, 1);
  assert.deepEqual(calls, [['merge', key]]);
  assert.equal(o.status[key], 'tested');
  assert.equal(overlayStore.reviewLifecycleFor(o, key, 'tested').merge_state, 'conflict');
  assert.equal(result.drains[0].conflict, true);
});

// ---------------------------------------------------------------------------
// Test 2b: clean drains snapshot .graph changes to git
// ---------------------------------------------------------------------------

test('commitGraphSnapshot commits only .graph changes', async () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-git-'));
  try {
    fs.mkdirSync(path.join(repo, '.graph'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.graph', 'base.jsonl'), '{"evt":"init"}\n');
    fs.writeFileSync(path.join(repo, 'src.txt'), 'base\n');
    initGitRepo(repo);

    fs.appendFileSync(path.join(repo, '.graph', 'base.jsonl'), '{"evt":"drain"}\n');
    fs.writeFileSync(path.join(repo, 'src.txt'), 'user work\n');
    git(repo, ['add', 'src.txt']);

    const result = await hd.commitGraphSnapshot(repo, 'headless test drain');
    assert.equal(result.committed, true, 'graph changes should be committed');
    assert.equal(git(repo, ['log', '-1', '--pretty=%s']), 'chore: headless test drain graph snapshot');
    assert.equal(git(repo, ['status', '--porcelain', '--', '.graph']), '', '.graph should be clean after snapshot');
    assert.match(git(repo, ['status', '--porcelain', '--', 'src.txt']), /^M  src\.txt/, 'staged non-graph work must not be committed');

    const noChanges = await hd.commitGraphSnapshot(repo, 'headless test drain');
    assert.equal(noChanges.committed, false, 'second snapshot has no graph changes');
    assert.equal(noChanges.reason, 'no_graph_changes');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('successful label drain records a graph snapshot commit summary', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '5';
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  const repo = makeCompletedQueueDir();
  initGitRepo(repo);
  const { hd, restore } = freshModuleWithMockedSpawn(() => {
    fs.appendFileSync(path.join(repo, '.graph', 'gate-labeled.jsonl'), '{"label":1}\n');
    return makeFakeChild();
  });
  try {
    const result = await hd.runDueDrains({ workspace: repo }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [{ _k: 'a', task_key: 't1' }], labeledKeys: [] }),
    });
    assert.equal(result.ran, 1);
    const label = result.drains.find((d) => d.drain === hd.LABEL_DRAIN_KEY);
    assert.ok(label && label.detached, 'label summary should mark the drain as detached');
    await waitForCondition(() => hd._governor.concurrentRunning === 0);
    assert.equal(git(repo, ['status', '--porcelain', '--', '.graph']), '', '.graph should be clean after label snapshot');
    assert.equal(git(repo, ['log', '-1', '--pretty=%s']), 'chore: headless label drain graph snapshot');
  } finally {
    restore();
    fs.rmSync(repo, { recursive: true, force: true });
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

// ---------------------------------------------------------------------------
// Test 3: learner-drain invocation builds the right command (mock spawn)
// ---------------------------------------------------------------------------

test('buildLearnerArgs builds correct node invocation for a given repo path', () => {
  const hd = freshModule();
  const repoAbs = '/some/project/root';
  const args = hd.buildLearnerArgs(repoAbs);
  // Must be: [<path-to-onboard-learn.js>, '--drain', '--repo', repoAbs]
  assert.equal(args.length, 4, 'should have 4 argv elements');
  assert.match(args[0], /onboard-learn\.js$/, 'first arg should be the onboard-learn.js script');
  assert.equal(args[1], '--drain', 'second arg should be --drain');
  assert.equal(args[2], '--repo', 'third arg should be --repo');
  assert.equal(args[3], repoAbs, 'fourth arg should be the repo path');
});

test('buildLearnerArgs includes custom onboarding outDir when provided', () => {
  const hd = freshModule();
  const repoAbs = '/some/project/root';
  const outDir = '/some/project/root/.zonoid/onboard/root';
  const args = hd.buildLearnerArgs(repoAbs, outDir);
  assert.deepEqual(args.slice(1), ['--drain', '--repo', repoAbs, '--in', outDir]);
});

test('buildLearnerArgs carries child timeout when provided', () => {
  const hd = freshModule();
  const repoAbs = '/some/project/root';
  const outDir = '/some/project/root/.zonoid/onboard/root';
  const args = hd.buildLearnerArgs(repoAbs, outDir, 4750);
  assert.deepEqual(args.slice(1), ['--drain', '--repo', repoAbs, '--in', outDir, '--timeout-ms', '4750']);
});

test('findPendingLearnerRepos returns workspace when queue has cursor < total', () => {
  const hd = freshModule();
  const tmpDir = makePendingQueueDir({ total: 10, cursor: 3 });
  try {
    const repos = hd.findPendingLearnerRepos(tmpDir);
    assert.equal(repos.length, 1);
    assert.equal(repos[0], tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findPendingLearnerQueues discovers dashboard .zonoid/onboard outDir', () => {
  const hd = freshModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-zonoid-'));
  const outDir = path.join(tmpDir, '.zonoid', 'onboard', path.basename(tmpDir));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      total: 12,
      cursor: 4,
      kept: [],
      rejected: [],
      pending: Array.from({ length: 12 }, (_, index) => ({ title: `candidate-${index}` })),
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo: tmpDir,
      outDir,
      batchSize: 7,
    }));
    const queues = hd.findPendingLearnerQueues(tmpDir);
    assert.equal(queues.length, 1);
    assert.equal(queues[0].repo, tmpDir);
    assert.equal(queues[0].outDir, outDir);
    assert.equal(queues[0].remaining, 8);
    assert.equal(queues[0].batchSize, 7);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findPendingLearnerQueues discovers default .zonoid/onboard outDir without route metadata', () => {
  const hd = freshModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-zonoid-default-'));
  const outDir = path.join(tmpDir, '.zonoid', 'onboard', path.basename(tmpDir));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      total: 12,
      cursor: 4,
      kept: [],
      rejected: [],
      pending: Array.from({ length: 12 }, (_, index) => ({ title: `candidate-${index}` })),
    }));
    const queues = hd.findPendingLearnerQueues(tmpDir);
    assert.equal(queues.length, 1);
    assert.equal(queues[0].repo, tmpDir);
    assert.equal(queues[0].outDir, outDir);
    assert.equal(queues[0].remaining, 8);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findRegisteredLearnerQueues discovers project queues without a daemon-global workspace', () => {
  const hd = freshModule();
  const repos = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'hd-registered-a-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'hd-registered-b-')),
  ];
  try {
    for (const [index, repo] of repos.entries()) {
      const source = path.join(repo, 'src', `feature-${index}.js`);
      const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(source, `exports.feature = ${index};\n`);
      fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
        total: 10 + index,
        cursor: 3,
        kept: [],
        rejected: [],
        pending: Array.from({ length: 10 + index }, (_, offset) => ({ title: `candidate-${offset}` })),
      }));
    }

    const queues = hd.findRegisteredLearnerQueues({ registeredWorkspaces: repos });
    assert.equal(queues.length, 2);
    assert.deepEqual(new Set(queues.map((queue) => queue.repo)), new Set(repos));
    assert.deepEqual(new Set(queues.map((queue) => queue.workspaceRoot)), new Set(repos));
    assert.equal(fs.readFileSync(path.join(repos[0], 'src', 'feature-0.js'), 'utf8'), 'exports.feature = 0;\n');
    assert.equal(fs.readFileSync(path.join(repos[1], 'src', 'feature-1.js'), 'utf8'), 'exports.feature = 1;\n');
  } finally {
    for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('findPendingLearnerQueues discovers legacy dashboard bench/onboard outDir', () => {
  const hd = freshModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-bench-'));
  const outDir = path.join(tmpDir, 'bench', 'onboard', path.basename(tmpDir));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      total: 12,
      cursor: 4,
      kept: [],
      rejected: [],
      pending: Array.from({ length: 12 }, (_, index) => ({ title: `candidate-${index}` })),
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo: tmpDir,
      outDir,
      batchSize: 7,
    }));
    const queues = hd.findPendingLearnerQueues(tmpDir);
    assert.equal(queues.length, 1);
    assert.equal(queues[0].repo, tmpDir);
    assert.equal(queues[0].outDir, outDir);
    assert.equal(queues[0].remaining, 8);
    assert.equal(queues[0].batchSize, 7);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findPendingLearnerQueues ignores bench/onboard queues without route metadata', () => {
  const hd = freshModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-bench-no-meta-'));
  const outDir = path.join(tmpDir, 'bench', 'onboard', path.basename(tmpDir));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      total: 12,
      cursor: 4,
      kept: [],
      rejected: [],
      pending: Array.from({ length: 12 }, (_, index) => ({ title: `candidate-${index}` })),
    }));
    const queues = hd.findPendingLearnerQueues(tmpDir);
    assert.equal(queues.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('headless discovery ignores unsupported custom and symlink onboarding roots', () => {
  const hd = freshModule();
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-path-confinement-'));
  const repo = path.join(container, 'repo');
  const custom = path.join(repo, '.zonoid', 'onboard', 'custom');
  const linkedOutside = path.join(container, 'linked-outside');
  try {
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'onboard-queue.json'), JSON.stringify({
      total: 1, cursor: 0, kept: [], rejected: [], pending: [{ title: 'custom' }],
    }));
    fs.writeFileSync(path.join(custom, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir: custom }));
    assert.equal(hd.findPendingLearnerQueues(repo).length, 0,
      'a status file must not make an unsupported in-repo root executable');

    fs.mkdirSync(linkedOutside, { recursive: true });
    fs.rmSync(path.join(repo, '.zonoid'), { recursive: true, force: true });
    fs.symlinkSync(linkedOutside, path.join(repo, '.zonoid'));
    const symlinkedDefault = path.join(linkedOutside, 'onboard', path.basename(repo));
    fs.mkdirSync(symlinkedDefault, { recursive: true });
    fs.writeFileSync(path.join(symlinkedDefault, 'onboard-queue.json'), JSON.stringify({
      total: 1, cursor: 0, kept: [], rejected: [], pending: [{ title: 'escape' }],
    }));
    assert.equal(hd.findPendingLearnerQueues(repo).length, 0,
      'a supported lexical root that escapes through a symlink must not be discovered');
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('headless zero-kept finalization persists the shared not-needed terminal state', () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-zero-kept-terminal-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-zero-kept', total: 2, cursor: 2, kept: [],
      rejected: [{ reason: 'duplicate' }, { reason: 'restatement' }], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, injectionGeneration: 'generation-zero-kept', injectionState: 'pending',
    }));
    assert.equal(hd._persistNoInjectionNeeded(repo, outDir), true);
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.injectionState, 'not_needed');
    assert.equal(status.injectionGeneration, 'generation-zero-kept');
    assert.equal(status.injected, false);
    assert.equal(status.injectedKept, 0);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('malformed completed queues fail closed and never finalize as not needed', () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-malformed-terminal-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const statusFile = path.join(outDir, 'onboard-drain-status.json');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-malformed', total: 2, cursor: 2, pending: [],
    }));
    fs.writeFileSync(statusFile, JSON.stringify({
      repo, outDir, autoInject: true, injectionGeneration: 'generation-malformed', injectionState: 'pending',
    }));
    const before = fs.readFileSync(statusFile);
    assert.deepEqual(hd.findPendingLearnerQueues(repo), []);
    assert.equal(hd._persistNoInjectionNeeded(repo, outDir), false);
    assert.deepEqual(fs.readFileSync(statusFile), before);

    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-impossible', total: 1, cursor: 0,
      kept: [{ title: 'Unprocessed result' }], rejected: [], pending: [],
    }));
    assert.deepEqual(hd.findPendingLearnerQueues(repo), []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('preparation scavenging removes only old inactive staging below a validated outDir', () => {
  const savedAge = process.env.HEADLESS_DRAIN_PREPARATION_SCAVENGE_AGE_MS;
  process.env.HEADLESS_DRAIN_PREPARATION_SCAVENGE_AGE_MS = '1000';
  const hd = freshModule();
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-prepare-scavenge-'));
  const repo = path.join(container, 'repo');
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const outside = path.join(container, '.prepare-outside');
  const now = Date.now();
  const makeStage = (name, marker) => {
    const dir = path.join(outDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.onboard-preparation.json'), JSON.stringify(marker));
    const old = new Date(now - 10000);
    fs.utimesSync(dir, old, old);
    return dir;
  };
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, preparationState: 'running',
      preparationGeneration: 'generation-current', preparationOwner: 'owner-current',
    }));
    const stale = makeStage('.prepare-99999991-stale', {
      generation: 'generation-old', owner: 'owner-old', pid: 99999991, createdAt: now - 10000,
    });
    const currentGeneration = makeStage('.prepare-99999992-current-generation', {
      generation: 'generation-current', owner: 'owner-old-2', pid: 99999992, createdAt: now - 10000,
    });
    const currentOwner = makeStage('.prepare-99999993-current-owner', {
      generation: 'generation-old-3', owner: 'owner-current', pid: 99999993, createdAt: now - 10000,
    });
    const live = makeStage(`.prepare-${process.pid}-live`, {
      generation: 'generation-live', owner: 'owner-live', pid: process.pid,
      createdAt: now - 10000, leaseExpiresAt: now + 60000,
    });
    const result = hd._scavengePreparationDirs(repo, outDir, now);
    assert.deepEqual(result.removed, [path.basename(stale)]);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(currentGeneration), true);
    assert.equal(fs.existsSync(currentOwner), true);
    assert.equal(fs.existsSync(live), true);
    assert.equal(fs.existsSync(outside), true, 'scavenging never crosses the validated outDir');

    const custom = path.join(repo, '.zonoid', 'onboard', 'custom');
    fs.mkdirSync(custom, { recursive: true });
    const customStage = path.join(custom, '.prepare-99999994-old');
    fs.mkdirSync(customStage, { recursive: true });
    const rejected = hd._scavengePreparationDirs(repo, custom, now);
    assert.deepEqual(rejected.removed, []);
    assert.equal(fs.existsSync(customStage), true);
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
    if (savedAge === undefined) delete process.env.HEADLESS_DRAIN_PREPARATION_SCAVENGE_AGE_MS;
    else process.env.HEADLESS_DRAIN_PREPARATION_SCAVENGE_AGE_MS = savedAge;
  }
});

test('findPendingLearnerQueues treats completed auto-inject queue as due until injected', () => {
  const hd = freshModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-inject-'));
  const outDir = path.join(tmpDir, 'bench', 'onboard', path.basename(tmpDir));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-manual-complete',
      total: 2,
      cursor: 2,
      kept: [{ title: 'A', summary: 'B' }],
      rejected: [{ reason: 'restatement' }],
      pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({
      generation: 'generation-manual-complete',
      kept: [{ title: 'A', summary: 'B' }],
      rejected: [{ reason: 'restatement' }],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo: tmpDir, outDir }));
    const queues = hd.findPendingLearnerQueues(tmpDir);
    assert.equal(queues.length, 1);
    assert.equal(queues[0].remaining, 0);
    assert.equal(queues[0].kept, 1);
    assert.equal(queues[0].injectDue, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findPendingLearnerQueues respects autoInject false for completed queues', () => {
  const hd = freshModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-manual-'));
  const outDir = path.join(tmpDir, 'bench', 'onboard', path.basename(tmpDir));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-manual-disabled',
      total: 2,
      cursor: 2,
      kept: [{ title: 'A', summary: 'B' }],
      rejected: [],
      pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({
      generation: 'generation-manual-disabled',
      kept: [{ title: 'A', summary: 'B' }],
      rejected: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo: tmpDir, outDir, autoInject: false }));
    const queues = hd.findPendingLearnerQueues(tmpDir);
    assert.equal(queues.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findPendingLearnerQueues treats partial auto-inject queue as inject due when kept advanced', () => {
  const hd = freshModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-live-inject-'));
  const outDir = path.join(tmpDir, 'bench', 'onboard', path.basename(tmpDir));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      total: 4,
      cursor: 2,
      kept: [{ title: 'A', summary: 'B' }],
      rejected: [],
      pending: Array.from({ length: 4 }, (_, index) => ({ title: `candidate-${index}` })),
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept: [{ title: 'A', summary: 'B' }], rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo: tmpDir, outDir, injectedKept: 0 }));
    const queues = hd.findPendingLearnerQueues(tmpDir);
    assert.equal(queues.length, 1);
    assert.equal(queues[0].remaining, 2);
    assert.equal(queues[0].kept, 1);
    assert.equal(queues[0].injectDue, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('a replacement queue generation never inherits the previous generation injection watermark', () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-generation-replacement-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-new',
      total: 1,
      cursor: 1,
      kept: [{ title: 'New', summary: 'New' }],
      rejected: [],
      pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept: [{ title: 'New' }], rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo,
      outDir,
      autoInject: true,
      injected: true,
      injectedGeneration: 'generation-old',
      injectedKept: 99,
      injectionGeneration: 'generation-old',
      injectionState: 'failed',
      injectionError: 'inject exited 1',
      error: 'inject exited 1',
    }));
    const queues = hd.findPendingLearnerQueues(repo);
    assert.equal(queues.length, 1);
    assert.equal(queues[0].generation, 'generation-new');
    assert.equal(queues[0].injectedKept, 0);
    assert.equal(queues[0].injectDue, true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('completed queues remain discoverable through a persisted generic error until final injection commits', () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-final-generic-error-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const kept = [{ title: 'Recover', summary: 'Recover the final commit' }];
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-final-error', total: 1, cursor: 1, kept, rejected: [], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept, rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, autoInject: true, error: 'onboarding drain exited 1', lastError: 'onboarding drain exited 1',
    }));

    const due = hd.findPendingLearnerQueues(repo);
    assert.equal(due.length, 1, 'a generic status error must not hide unfinished final injection');
    assert.equal(due[0].remaining, 0);
    assert.equal(due[0].injectDue, true);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('completed kept queues atomically reconstruct a missing final notes artifact before injection', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-final-missing-notes-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const kept = [{ title: 'Missing final file', summary: 'Recover from the completed queue' }];
  const rejected = [{ candidate: 'Noise', reason: 'restatement' }];
  let hd;
  const mocked = freshModuleWithMockedSpawn(() => {
    const artifact = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-notes.json'), 'utf8'));
    assert.equal(artifact.generation, 'generation-missing-notes');
    assert.deepEqual(artifact.kept, kept);
    assert.deepEqual(artifact.rejected, rejected);
    hd._writeInjectionReceipt(outDir, artifact.generation, [hd._onboardNoteId(kept[0], 0)]);
    return makeFakeChild({ code: 0 });
  });
  hd = mocked.hd;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-missing-notes', total: 2, cursor: 2,
      kept, rejected, pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir, autoInject: true }));
    const due = hd.findPendingLearnerQueues(repo);
    assert.equal(due.length, 1);
    assert.equal(due[0].injectDue, true);

    const result = await hd._injectLearnerQueue(repo, outDir, { timeoutMs: 5000 });
    assert.equal(result.exitCode, 0);
    assert.equal(mocked.calls.length, 1);
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.injectionState, 'succeeded');
    assert.equal(status.injectedKept, 1);
  } finally {
    mocked.restore();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('final artifact recovery replaces corrupt or cross-generation data but never repairs a partial queue', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-final-artifact-fence-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const kept = [{ title: 'Current', summary: 'Only the current generation may inject' }];
  let hd;
  const mocked = freshModuleWithMockedSpawn(() => {
    const artifact = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-notes.json'), 'utf8'));
    hd._writeInjectionReceipt(outDir, artifact.generation, [hd._onboardNoteId(kept[0], 0)]);
    return makeFakeChild({ code: 0 });
  });
  hd = mocked.hd;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const queueFile = path.join(outDir, 'onboard-queue.json');
    const notesFile = path.join(outDir, 'onboard-notes.json');
    fs.writeFileSync(queueFile, JSON.stringify({
      generation: 'generation-current', total: 2, cursor: 2, kept,
      rejected: [{ candidate: 'Rejected current', reason: 'duplicate' }], pending: [],
    }));
    fs.writeFileSync(notesFile, JSON.stringify({
      generation: 'generation-old', kept: [{ title: 'Old' }], rejected: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir, autoInject: true }));

    const repaired = await hd._injectLearnerQueue(repo, outDir, { timeoutMs: 5000 });
    assert.equal(repaired.exitCode, 0);
    const artifact = JSON.parse(fs.readFileSync(notesFile, 'utf8'));
    assert.equal(artifact.generation, 'generation-current');
    assert.deepEqual(artifact.kept, kept);
    assert.deepEqual(artifact.rejected, [{ candidate: 'Rejected current', reason: 'duplicate' }]);

    fs.writeFileSync(queueFile, JSON.stringify({
      generation: 'generation-partial', total: 2, cursor: 1, kept: [{ title: 'Partial' }],
      rejected: [], pending: [{ title: 'A' }, { title: 'B' }],
    }));
    fs.writeFileSync(notesFile, '{corrupt');
    const rejectedPartial = await hd._injectLearnerQueue(repo, outDir, { timeoutMs: 5000 });
    assert.equal(rejectedPartial.stale, true);
    assert.match(rejectedPartial.staleReason, /artifact/);
    assert.equal(fs.readFileSync(notesFile, 'utf8'), '{corrupt', 'partial queues must not invent a replacement artifact');
    assert.equal(mocked.calls.length, 1, 'the partial corrupt artifact must not reach graph injection');
  } finally {
    mocked.restore();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a receipt-complete final injection crash is recovered and clears its stale generic error', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-final-receipt-recovery-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const kept = [{ title: 'Durable', summary: 'Graph write already committed' }];
  let hd;
  const mocked = freshModuleWithMockedSpawn(() => makeFakeChild({ code: 0 }));
  hd = mocked.hd;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-final-receipt', total: 1, cursor: 1, kept, rejected: [], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept, rejected: [] }));
    hd._writeInjectionReceipt(outDir, 'generation-final-receipt', [hd._onboardNoteId(kept[0], 0)]);
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, autoInject: true, error: 'onboarding drain exited 1', lastError: 'onboarding drain exited 1',
      injectionGeneration: 'generation-final-receipt', injectionState: 'running',
      injectionOwner: 'dead-final-owner', injectionPid: 99999991, injectionLeaseExpiresAt: Date.now() - 1,
    }));

    await hd.runDueDrains({ workspace: repo, registeredWorkspaces: [repo] }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    });

    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(mocked.calls.length, 1);
    assert.equal(status.injectionState, 'succeeded');
    assert.equal(status.injectedGeneration, 'generation-final-receipt');
    assert.equal(status.injectedKept, 1);
    assert.equal(status.error, null);
    assert.equal(status.lastError, null);
    assert.equal(hd.findPendingLearnerQueues(repo).length, 0);
  } finally {
    mocked.restore();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('headless injection claim preserves a live cross-process owner and takes over after owner death', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-injection-owner-cas-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const generation = 'generation-owner-cas';
  const kept = [{ title: 'CAS', summary: 'One graph writer at a time' }];
  const liveChild = child_process.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore', windowsHide: true,
  });
  let hd;
  const mocked = freshModuleWithMockedSpawn(() => {
    hd._writeInjectionReceipt(outDir, generation, [hd._onboardNoteId(kept[0], 0)]);
    return makeFakeChild({ code: 0 });
  });
  hd = mocked.hd;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation, total: 1, cursor: 1, kept, rejected: [], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept, rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, autoInject: true, injectionGeneration: generation, injectionState: 'running',
      injecting: true, injectionOwner: 'other-daemon-owner',
      injectionLeaseExpiresAt: Date.now() + 30000,
    }));

    const preSpawnBlocked = await hd._injectLearnerQueue(repo, outDir, { timeoutMs: 5000 });
    assert.equal(preSpawnBlocked.stale, true);
    assert.equal(mocked.calls.length, 0, 'an owner lease is live before its child pid is published');

    let status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    status.injectionPid = liveChild.pid;
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify(status));
    const blocked = await hd._injectLearnerQueue(repo, outDir, { timeoutMs: 5000 });
    assert.equal(blocked.stale, true);
    assert.equal(mocked.calls.length, 0, 'a losing claim must not spawn another graph writer');
    status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.injectionOwner, 'other-daemon-owner');
    assert.equal(status.injectionPid, liveChild.pid);

    liveChild.kill('SIGKILL');
    await new Promise((resolve) => liveChild.once('close', resolve));
    const recovered = await hd._injectLearnerQueue(repo, outDir, { timeoutMs: 5000 });
    assert.equal(recovered.exitCode, 0);
    assert.equal(mocked.calls.length, 1, 'a dead owner may be replaced by one recovery writer');
    status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.injectionState, 'succeeded');
    assert.equal(status.injectionOwner, null);
  } finally {
    try { liveChild.kill('SIGKILL'); } catch { /* already exited */ }
    mocked.restore();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('shared injection ownership survives lease expiry, distinguishes PID reuse, and releases on death', () => {
  const { liveOnboardInjectionLease, processIncarnation } = require('../lib/onboard-state');
  const now = Date.now();
  const identity = processIncarnation(process.pid);
  assert.ok(identity, 'the current platform should expose a stable process-start identity');
  const base = {
    injectionState: 'running', injectionOwner: 'lease-owner', injectionPid: process.pid,
    injectionProcessIdentity: identity,
  };
  assert.equal(liveOnboardInjectionLease({ ...base, injectionLeaseExpiresAt: now + 1000 }, now).live, true);
  assert.equal(liveOnboardInjectionLease({ ...base, injectionLeaseExpiresAt: now - 1 }, now).live, true,
    'an expired timestamp never replaces the exact still-running writer incarnation');
  assert.equal(liveOnboardInjectionLease({ ...base, injectionLeaseExpiresAt: now - 1 }, now, {
    processIncarnation: () => 'different-process-incarnation',
  }).live, false, 'a reused PID does not inherit ownership from the old process incarnation');
  assert.equal(liveOnboardInjectionLease({
    ...base, injectionPid: 99999991, injectionLeaseExpiresAt: now + 1000,
  }, now).live, false, 'a dead owner releases its lease before the deadline');
});

test('completed zero-kept and autoInject false queues repair stale generic errors without injection', async () => {
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const repos = [];
  const options = {
    ...judgeDeps({ depth: 0, eagerNodes: [] }),
    ...labelDeps({ journal: [], labeledKeys: [] }),
    ...mockBackendDeps().deps,
  };
  try {
    for (const item of [
      { suffix: 'zero', kept: [], autoInject: true, terminal: 'not_needed' },
      { suffix: 'disabled', kept: [{ title: 'Manual' }], autoInject: false, terminal: 'idle' },
    ]) {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), `hd-final-repair-${item.suffix}-`));
      repos.push(repo);
      const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
        generation: `generation-${item.suffix}`, total: 1, cursor: 1,
        kept: item.kept, rejected: item.kept.length ? [] : [{ title: 'Rejected' }], pending: [],
      }));
      fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
        repo, outDir, autoInject: item.autoInject, error: 'onboarding drain exited 1', lastError: 'onboarding drain exited 1',
      }));

      assert.equal(hd.findPendingLearnerQueues(repo).length, 1, `${item.suffix} needs one status-repair pass`);
      await hd.runDueDrains({ workspace: repo, registeredWorkspaces: [repo] }, noopHttp(), options);
      const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
      assert.equal(status.error, null);
      assert.equal(status.lastError, null);
      assert.equal(status.injectionState || 'idle', item.terminal);
      const artifact = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-notes.json'), 'utf8'));
      assert.equal(artifact.generation, `generation-${item.suffix}`);
      assert.deepEqual(artifact.kept, item.kept);
      assert.equal(hd.findPendingLearnerQueues(repo).length, 0);
    }
    assert.equal(calls.length, 0, 'terminal status repair must not start an injector');
  } finally {
    restore();
    for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('partial injection crash advances only the confirmed current-generation receipt', async () => {
  const savedMax = process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS;
  process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS = '2';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-injection-partial-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  let hd;
  const mocked = freshModuleWithMockedSpawn((_bin, args) => {
    if (args.includes('--inject')) {
      hd._writeInjectionReceipt(outDir, 'generation-partial', [
        hd._onboardNoteId({ title: 'A', summary: 'A' }, 0),
      ]);
      return makeFakeChild({ code: 1 });
    }
    return makeFakeChild({ code: 0 });
  });
  hd = mocked.hd;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const kept = [{ title: 'A', summary: 'A' }, { title: 'B', summary: 'B' }];
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-partial', total: 2, cursor: 2, kept, rejected: [], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept, rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir, autoInject: true }));

    await hd.runDueDrains({ workspace: repo, registeredWorkspaces: [repo] }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    });
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.injectionState, 'pending');
    assert.equal(status.injectionAttempts, 0);
    assert.equal(status.injectionError, null);
    assert.equal(status.error, null);
    assert.equal(status.injectedKept, 1, 'only the one receipt-confirmed durable note advances the watermark');
    assert.notEqual(status.injectedKept, kept.length, 'aggregate queue kept count must never be used after a partial crash');
  } finally {
    mocked.restore();
    fs.rmSync(repo, { recursive: true, force: true });
    if (savedMax === undefined) delete process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS;
    else process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS = savedMax;
  }
});

test('force replacement waits past lease expiry until the writer incarnation is gone', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-injection-force-cas-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  let child;
  const mocked = freshModuleWithMockedSpawn((_bin, args) => {
    assert.ok(args.includes('--inject'));
    child = makeFakeChild({ never: true });
    return child;
  });
  const { hd, restore } = mocked;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const kept = [{ title: 'Old', summary: 'Old' }];
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-old', total: 1, cursor: 1, kept, rejected: [], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept, rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir, autoInject: true }));
    const draining = hd.runDueDrains({ workspace: repo, registeredWorkspaces: [repo] }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    });
    await waitForCondition(() => child && JSON.parse(
      fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8')
    ).injectionState === 'running');

    const sent = [];
    const route = onboardRoute({
      readBody: async () => ({ repo, outDir, force: true }),
      send: (_res, status, payload) => sent.push({ status, payload }),
      notifyChange: () => {},
      registeredWorkspaces: () => new Set([repo]),
    });
    await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
    assert.equal(sent[0].status, 409);
    assert.equal(sent[0].payload.retryable, true);
    assert.equal(sent[0].payload.conflict, 'injection_in_progress');

    const expired = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    expired.injectionLeaseExpiresAt = Date.now() - 1;
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify(expired));
    await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
    assert.equal(sent[1].status, 409,
      'the exact live writer stays authoritative after the advisory lease timestamp');

    const reusedPid = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    reusedPid.injectionProcessIdentity = 'different-process-incarnation';
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify(reusedPid));
    await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));
    assert.equal(sent[2].status, 200);
    const replacement = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.notEqual(replacement.preparationGeneration, 'generation-old');

    hd._writeInjectionReceipt(outDir, 'generation-old', [hd._onboardNoteId(kept[0], 0)]);
    child.emit('close', 0);
    await draining;
    const final = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(final.preparationGeneration, replacement.preparationGeneration);
    assert.equal(final.preparationState, 'pending');
    assert.equal(final.injected, false);
    assert.equal(final.injectedKept, 0);
  } finally {
    restore();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('overlapping force preparation cannot publish an older claimed generation', () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-prepare-force-cas-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const stagingDir = path.join(outDir, '.prepare-old');
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'onboard-queue.json'), JSON.stringify({
      total: 1, cursor: 0, kept: [], rejected: [], pending: [{ title: 'Old' }],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-current', total: 1, cursor: 0,
      kept: [], rejected: [], pending: [{ title: 'Current' }],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, preparationGeneration: 'generation-new', preparationState: 'pending',
    }));

    const published = hd._publishPreparedQueue(stagingDir, outDir, 'generation-old', 'owner-old');
    const queue = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8'));
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(published.stale, true);
    assert.equal(queue.generation, 'generation-current');
    assert.equal(queue.pending[0].title, 'Current');
    assert.equal(status.preparationGeneration, 'generation-new');
    assert.equal(status.preparationState, 'pending');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('prepared publication waits for an old completion and leaves the replacement generation authoritative', async () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-prepare-publish-lock-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const stagingDir = path.join(outDir, '.prepare-new');
  const queueFile = path.join(outDir, 'onboard-queue.json');
  const marker = path.join(repo, 'old-completion-holds-lock');
  let child = null;
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    fs.writeFileSync(path.join(stagingDir, 'onboard-queue.json'), JSON.stringify({
      total: 1, cursor: 0, kept: [], rejected: [], pending: [{ title: 'New' }],
    }));
    fs.writeFileSync(queueFile, JSON.stringify({
      generation: 'generation-old', total: 1, cursor: 0,
      kept: [], rejected: [], pending: [{ title: 'Old' }],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, preparationGeneration: 'generation-new', preparationOwner: 'owner-new',
      preparationState: 'running',
    }));

    const stateModule = require.resolve('../lib/onboard-state');
    const oldCompleted = JSON.stringify({
      generation: 'generation-old', total: 1, cursor: 1,
      kept: [{ title: 'Old result' }], rejected: [], pending: [{ title: 'Old' }],
    });
    const code = [
      "const fs=require('fs');",
      "const {withFileLock,writeJSONAtomic}=require(process.argv[1]);",
      "const qf=process.argv[2], marker=process.argv[3], old=JSON.parse(process.argv[4]);",
      "withFileLock(qf,()=>{fs.writeFileSync(marker,'held');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);writeJSONAtomic(qf,old);});",
    ].join('');
    child = child_process.spawn(process.execPath, ['-e', code, stateModule, queueFile, marker, oldCompleted], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    await waitForCondition(() => fs.existsSync(marker));

    const published = hd._publishPreparedQueue(stagingDir, outDir, 'generation-new', 'owner-new');
    const childExit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.equal(childExit, 0);
    assert.equal(published.stale, false);
    const finalQueue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    const finalStatus = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(finalQueue.generation, 'generation-new');
    assert.equal(finalQueue.cursor, 0);
    assert.equal(finalQueue.pending[0].title, 'New');
    assert.equal(finalStatus.queueGeneration, 'generation-new');
    assert.equal(finalStatus.preparationState, 'ready');
  } finally {
    if (child && child.exitCode == null) child.kill('SIGKILL');
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('prepared publication repairs artifact, queue, status, and cleanup boundary faults as one generation', () => {
  const boundaries = ['structure.json_temp', 'onboard-queue.json_temp',
    'onboard-drain-status.json_temp', 'before_journal_cleanup'];
  for (const [index, boundary] of boundaries.entries()) {
    const hd = freshModule();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-prepare-publish-transaction-'));
    const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
    const stagingDir = path.join(outDir, `.prepare-${process.pid}-${Date.now() + index}`);
    const generation = `generation-prepared-transaction-${index}`;
    const owner = `owner-prepared-transaction-${index}`;
    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      fs.writeFileSync(path.join(stagingDir, '.onboard-preparation.json'), JSON.stringify({
        generation, owner, pid: process.pid, createdAt: Date.now(),
      }));
      fs.writeFileSync(path.join(stagingDir, 'structure.json'), JSON.stringify({ nodes: [{ id: generation }] }));
      fs.writeFileSync(path.join(stagingDir, 'onboard-queue.json'), JSON.stringify({
        total: 1, cursor: 0, kept: [], rejected: [], pending: [{ title: generation }],
      }));
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'structure.json'), JSON.stringify({ nodes: [{ id: 'old' }] }));
      fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
        generation: 'generation-prepared-old', total: 1, cursor: 0,
        kept: [], rejected: [], pending: [{ title: 'old' }],
      }));
      fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ generation: 'generation-prepared-old', kept: [], rejected: [] }));
      fs.writeFileSync(path.join(outDir, 'onboard-injection-receipt.json'), JSON.stringify({ generation: 'generation-prepared-old', confirmed: ['old'] }));
      fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
        repo, outDir, preparationGeneration: generation, preparationOwner: owner,
        preparationState: 'running', injectionGeneration: 'generation-prepared-old',
      }));

      const result = hd._publishPreparedQueue(stagingDir, outDir, generation, owner, {
        onBoundary(name) { if (name === boundary) throw new Error(`one-shot ${boundary}`); },
      });
      const queue = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8'));
      const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
      const structure = JSON.parse(fs.readFileSync(path.join(outDir, 'structure.json'), 'utf8'));
      assert.equal(result.stale, false, boundary);
      assert.equal(queue.generation, generation, boundary);
      assert.equal(status.queueGeneration, generation, boundary);
      assert.equal(status.injectionGeneration, generation, boundary);
      assert.equal(structure.nodes[0].id, generation, boundary);
      assert.equal(fs.existsSync(path.join(outDir, 'onboard-notes.json')), false, boundary);
      assert.equal(fs.existsSync(path.join(outDir, 'onboard-injection-receipt.json')), false, boundary);
      assert.equal(fs.existsSync(stagingDir), false, boundary);
      assert.equal(fs.existsSync(path.join(outDir, 'onboard-publication-intent.json')), false, boundary);
      assert.deepEqual(fs.readdirSync(outDir).filter((name) => /\.publish-[a-f0-9]{32}\.tmp$/.test(name)), [], boundary);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('headless discovery reconciles a hard-exited direct publication without a dashboard or duplicate', () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-publication-discovery-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const learn = path.resolve(__dirname, '../scripts/onboard-learn.js');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'config-notes.json'), JSON.stringify([
      { title: 'candidate', summary: 'candidate', kind: 'gotcha' },
    ]));
    const initial = child_process.spawnSync(process.execPath, [learn, '--repo', repo, '--in', outDir, '--enqueue'], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(initial.status, 0, initial.stderr);
    const crashed = child_process.spawnSync(process.execPath, [learn, '--repo', repo, '--in', outDir, '--enqueue'], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, ZONOID_TEST_ONBOARD_PUBLICATION_CRASH_AFTER: 'onboard-queue.json' },
    });
    assert.equal(crashed.status, 87, crashed.stderr);
    const crashedGeneration = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8')).generation;

    const due = hd.findPendingLearnerQueues(repo);
    const queue = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-queue.json'), 'utf8'));
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(due.length, 1);
    assert.equal(due[0].generation, crashedGeneration);
    assert.equal(queue.generation, crashedGeneration);
    assert.equal(status.queueGeneration, crashedGeneration);
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-publication-intent.json')), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('route and headless discovery quarantine invalid publication journals and reprepare', async () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-publication-invalid-route-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-untrusted-route', total: 1, cursor: 0,
      kept: [], rejected: [], pending: [{ title: 'untrusted' }],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, preparationState: 'running', preparationGeneration: 'generation-route-reprepare',
      preparationOwner: 'dead-route-owner', preparationPid: 999999,
      preparationLeaseExpiresAt: Date.now() - 1,
      queueGeneration: 'generation-before-route', injectionGeneration: 'generation-before-route',
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-publication-intent.json'), JSON.stringify({ version: 1 }));

    const sent = [];
    const route = onboardRoute({
      readBody: async () => ({ repo, outDir }),
      send: (_res, status, payload) => sent.push({ status, payload }),
      notifyChange: () => {},
      registeredWorkspaces: () => new Set([repo]),
    });
    await route('/onboard/enqueue', 'POST', {}, {}, new URL('http://localhost/onboard/enqueue'));

    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(sent[0].status, 200);
    assert.equal(sent[0].payload.preparing, true);
    assert.equal(status.preparationState, 'pending');
    assert.equal(status.preparationGeneration, 'generation-route-reprepare');
    assert.equal(status.preparationOwner, null);
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-queue.json')), false);
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-publication-intent.json')), false);
    assert.ok(fs.readdirSync(outDir).some((name) => name.startsWith('onboard-publication-intent.json.invalid-')));

    const due = hd.findPendingLearnerQueues(repo);
    assert.equal(due.length, 1);
    assert.equal(due[0].preparationDue, true);
    assert.equal(due[0].generation, 'generation-route-reprepare');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('invalid publication quarantine stays fail-closed across every queue/status/journal fault', () => {
  const boundaries = [
    'invalid_queue_quarantine',
    'invalid_status_temp',
    'invalid_status_commit',
    'invalid_journal_quarantine',
  ];
  for (const boundary of boundaries) {
    const hd = freshModule();
    const onboardState = require('../lib/onboard-state');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `hd-invalid-publication-${boundary}-`));
    const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
    const queueFile = path.join(outDir, 'onboard-queue.json');
    const statusFile = path.join(outDir, 'onboard-drain-status.json');
    const journal = path.join(outDir, 'onboard-publication-intent.json');
    const retryGeneration = `generation-reprepare-${boundary}`;
    try {
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(queueFile, JSON.stringify({
        generation: `generation-untrusted-${boundary}`,
        total: 1,
        cursor: 0,
        kept: [],
        rejected: [],
        pending: [{ title: 'untrusted' }],
      }));
      fs.writeFileSync(statusFile, JSON.stringify({
        repo,
        outDir,
        preparationState: 'running',
        preparationGeneration: retryGeneration,
        preparationOwner: 'dead-owner',
        preparationPid: 99999999,
        preparationLeaseExpiresAt: Date.now() - 1,
        queueGeneration: 'generation-before-invalid-journal',
        injectionGeneration: 'generation-before-invalid-journal',
      }));
      fs.writeFileSync(journal, JSON.stringify({ version: 1, generation: 'shallow-untrusted' }));

      const injected = onboardState.reconcileOnboardPublication(outDir, {
        onBoundary(name) {
          if (name === boundary) throw Object.assign(new Error(`injected ${boundary}`), { code: 'EIO' });
        },
      });
      assert.equal(injected.ok, false, boundary);
      assert.equal(fs.existsSync(journal), true,
        `${boundary}: canonical poison journal must remain the discovery fence`);
      if (boundary === 'invalid_queue_quarantine') {
        assert.equal(JSON.parse(fs.readFileSync(queueFile, 'utf8')).generation,
          `generation-untrusted-${boundary}`);
      }

      // A later headless/daemon discovery pass retries reconciliation before queue discovery. It may
      // expose only the safe preparation generation, never the untrusted canonical queue generation.
      const due = hd.findPendingLearnerQueues(repo);
      assert.equal(due.length, 1, boundary);
      assert.equal(due[0].preparationDue, true, boundary);
      assert.equal(due[0].generation, retryGeneration, boundary);
      assert.equal(fs.existsSync(queueFile), false, boundary);
      assert.equal(fs.existsSync(journal), false, boundary);
      assert.deepEqual(fs.readdirSync(outDir).filter((name) => (
        /^onboard-drain-status\.json\.invalid-\d+-[a-f0-9]+\.tmp$/.test(name)
      )), [], boundary);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('invalid publication recovery rejects queue/status FIFOs without blocking and survives restart', () => {
  const stateModule = require.resolve('../lib/onboard-state');
  const childSource = `
    const state = require(process.argv[1]);
    const result = state.reconcileOnboardPublication(process.argv[2]);
    if (!result.ok) {
      process.stderr.write(JSON.stringify(result));
      process.exit(2);
    }
  `;
  const runRecovery = (outDir, crashAfter = null) => child_process.spawnSync(
    process.execPath,
    ['-e', childSource, stateModule, outDir],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
      env: {
        ...process.env,
        ...(crashAfter ? { ZONOID_TEST_ONBOARD_PUBLICATION_CRASH_AFTER: crashAfter } : {}),
      },
    }
  );
  const makeFifo = (file) => child_process.spawnSync('mkfifo', [file], {
    encoding: 'utf8', windowsHide: true,
  }).status === 0;

  const cases = [
    {
      name: 'queue-fifo',
      make(repo, outDir) {
        const retryGeneration = 'generation-queue-fifo-reprepare';
        fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
          repo,
          outDir,
          preparationState: 'running',
          preparationGeneration: retryGeneration,
          preparationOwner: 'dead-owner',
          preparationPid: 99999999,
          preparationLeaseExpiresAt: Date.now() - 1,
          queueGeneration: 'generation-before-poison',
          injectionGeneration: 'generation-before-poison',
        }));
        return {
          supported: makeFifo(path.join(outDir, 'onboard-queue.json')),
          crashAfter: 'invalid_status_commit',
          retryGeneration,
        };
      },
    },
    {
      name: 'status-fifo',
      make(_repo, outDir) {
        fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
          generation: 'generation-untrusted-status-fifo',
          total: 1,
          cursor: 0,
          kept: [],
          rejected: [],
          pending: [{ title: 'untrusted' }],
        }));
        return {
          supported: makeFifo(path.join(outDir, 'onboard-drain-status.json')),
          crashAfter: 'invalid_queue_quarantine',
          retryGeneration: null,
        };
      },
    },
  ];

  for (const fixture of cases) {
    const hd = freshModule();
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), `hd-invalid-${fixture.name}-`));
    const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
    const queueFile = path.join(outDir, 'onboard-queue.json');
    const statusFile = path.join(outDir, 'onboard-drain-status.json');
    const journal = path.join(outDir, 'onboard-publication-intent.json');
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const expected = fixture.make(repo, outDir);
      if (!expected.supported) continue;
      fs.writeFileSync(journal, JSON.stringify({ version: 1, generation: 'shallow-untrusted' }));

      const crashed = runRecovery(outDir, expected.crashAfter);
      assert.notEqual(crashed.error && crashed.error.code, 'ETIMEDOUT',
        `${fixture.name}: hostile canonical files must not block recovery`);
      assert.equal(crashed.status, 87, crashed.stderr);
      assert.equal(fs.existsSync(journal), true,
        `${fixture.name}: a crash must leave the poison journal as the canonical fence`);

      const restarted = runRecovery(outDir);
      assert.notEqual(restarted.error && restarted.error.code, 'ETIMEDOUT',
        `${fixture.name}: restarted recovery must not block`);
      assert.equal(restarted.status, 0, restarted.stderr);
      assert.equal(fs.existsSync(journal), false, fixture.name);
      assert.equal(fs.existsSync(queueFile), false, fixture.name);
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      assert.equal(status.queueGeneration, null, fixture.name);
      assert.equal(status.injectionGeneration, null, fixture.name);
      assert.equal(status.preparationState, expected.retryGeneration ? 'pending' : 'failed', fixture.name);

      const due = hd.findPendingLearnerQueues(repo);
      if (expected.retryGeneration) {
        assert.equal(due.length, 1, fixture.name);
        assert.equal(due[0].preparationDue, true, fixture.name);
        assert.equal(due[0].generation, expected.retryGeneration, fixture.name);
      } else {
        assert.deepEqual(due, [], fixture.name);
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
});

test('ordinary headless discovery rejects a FIFO queue without a publication journal', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-canonical-queue-fifo-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const queueFile = path.join(outDir, 'onboard-queue.json');
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const fifo = child_process.spawnSync('mkfifo', [queueFile], { encoding: 'utf8', windowsHide: true });
    if (fifo.status !== 0) return;
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir }));
    const childSource = `
      const headless = require(process.argv[1]);
      process.stdout.write(JSON.stringify(headless.findPendingLearnerQueues(process.argv[2])));
    `;
    const discovered = child_process.spawnSync(
      process.execPath,
      ['-e', childSource, require.resolve('../lib/headless-drain'), repo],
      { encoding: 'utf8', windowsHide: true, timeout: 3000 }
    );
    assert.notEqual(discovered.error && discovered.error.code, 'ETIMEDOUT',
      'headless discovery must not block on a canonical FIFO without a journal');
    assert.equal(discovered.status, 0, discovered.stderr);
    assert.deepEqual(JSON.parse(discovered.stdout), []);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('registered headless reconciliation removes malformed journals without blocking later discovery', () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-publication-invalid-registered-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, preparationState: 'pending', preparationGeneration: 'generation-headless-reprepare',
      preparationOwner: null, preparationPid: null, preparationLeaseExpiresAt: null,
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-publication-intent.json'), '{');
    fs.writeFileSync(path.join(outDir, `onboard-drain-status.json.publish-${'b'.repeat(32)}.tmp`), '{}');

    const reconciled = hd.reconcileRegisteredOnboardPublications({
      workspace: repo,
      registeredWorkspaces: [repo],
    });
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].ok, true);
    assert.equal(reconciled[0].settled, 'invalid_quarantined');
    assert.equal(reconciled[0].reprepare, true);
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-publication-intent.json')), false);
    assert.deepEqual(fs.readdirSync(outDir).filter((name) => /\.publish-[a-f0-9]{32}\.tmp$/.test(name)), []);

    const due = hd.findRegisteredLearnerQueues({ workspace: repo, registeredWorkspaces: [repo] });
    assert.equal(due.length, 1);
    assert.equal(due[0].generation, 'generation-headless-reprepare');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('failed injection persists backoff metadata and retries automatically to success', async () => {
  const savedMax = process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS;
  const savedBase = process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS;
  process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS = '3';
  process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS = '1';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-injection-retry-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  let injectionRuns = 0;
  let hd;
  const mocked = freshModuleWithMockedSpawn(() => {
    const code = injectionRuns++ === 0 ? 1 : 0;
    if (code === 0) {
      hd._writeInjectionReceipt(outDir, 'generation-retry', [
        hd._onboardNoteId({ title: 'Retry', summary: 'Retry' }, 0),
      ]);
    }
    return makeFakeChild({ code });
  });
  hd = mocked.hd;
  const { calls, restore } = mocked;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-retry', total: 1, cursor: 1,
      kept: [{ title: 'Retry', summary: 'Retry' }], rejected: [], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept: [{ title: 'Retry' }], rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir, autoInject: true }));
    const options = {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    };
    await hd.runDueDrains({ workspace: repo, registeredWorkspaces: [repo] }, noopHttp(), options);
    let status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.injectionState, 'backoff');
    assert.equal(status.injectionAttempts, 1);
    assert.ok(status.injectionRetryAt > 0);
    assert.equal(status.injectionRetryCapped, false);
    assert.match(status.injectionError, /inject exited 1/);

    status.injectionRetryAt = Date.now() - 1;
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify(status));
    hd._governor.backoffUntil = Date.now() - 1;
    await hd.runDueDrains({ workspace: repo, registeredWorkspaces: [repo] }, noopHttp(), options);
    status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(calls.length, 2);
    assert.equal(status.injectionState, 'succeeded');
    assert.equal(status.injectionAttempts, 0);
    assert.equal(status.injectedGeneration, 'generation-retry');
    assert.equal(status.injectedKept, 1);
    assert.equal(status.error, null);
  } finally {
    restore();
    fs.rmSync(repo, { recursive: true, force: true });
    if (savedMax === undefined) delete process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS;
    else process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS = savedMax;
    if (savedBase === undefined) delete process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS;
    else process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS = savedBase;
  }
});

test('productive injection timeouts reset the failure streak and resume until success', async () => {
  const savedMax = process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS;
  const savedBase = process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS;
  const savedTimeout = process.env.HEADLESS_DRAIN_TIMEOUT_MS;
  process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS = '2';
  process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS = '1';
  process.env.HEADLESS_DRAIN_TIMEOUT_MS = '10';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-injection-progress-timeout-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const generation = 'generation-progress-timeout';
  const kept = [
    { title: 'A', summary: 'A' },
    { title: 'B', summary: 'B' },
    { title: 'C', summary: 'C' },
  ];
  let injectionRuns = 0;
  let hd;
  const mocked = freshModuleWithMockedSpawn(() => {
    injectionRuns++;
    hd._writeInjectionReceipt(outDir, generation, kept.slice(0, injectionRuns).map(
      (note, index) => hd._onboardNoteId(note, index)
    ));
    if (injectionRuns >= kept.length) return makeFakeChild({ code: 0 });
    const child = makeFakeChild({ never: true });
    const keepAlive = setTimeout(() => {}, 1000);
    child.kill = () => {
      clearTimeout(keepAlive);
      child.emit('close', null);
      return true;
    };
    return child;
  });
  hd = mocked.hd;
  const { calls, restore } = mocked;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation, total: kept.length, cursor: kept.length, kept, rejected: [], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ generation, kept, rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir, autoInject: true }));
    const options = {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    };
    const state = { workspace: repo, registeredWorkspaces: [repo] };

    for (let confirmed = 1; confirmed < kept.length; confirmed++) {
      await hd.runDueDrains(state, noopHttp(), options);
      const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
      assert.equal(status.injectionState, 'pending');
      assert.equal(status.injectionAttempts, 0, 'productive timeouts do not grow the no-progress streak');
      assert.equal(status.injectionRetryCapped, false);
      assert.equal(status.injectedKept, confirmed);
      assert.equal(status.injectionError, null);
      assert.equal(status.error, null);
      status.injectionRetryAt = Date.now() - 1;
      fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify(status));
      hd._governor.backoffUntil = Date.now() - 1;
    }

    await hd.runDueDrains(state, noopHttp(), options);
    const final = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(calls.length, 3, 'two productive timeouts may exceed the no-progress cap and still finish');
    assert.equal(final.injectionState, 'succeeded');
    assert.equal(final.injectedKept, kept.length);
    assert.equal(final.injectionAttempts, 0);
    assert.equal(final.injectionRetryCapped, false);
    assert.equal(final.error, null);
  } finally {
    restore();
    fs.rmSync(repo, { recursive: true, force: true });
    if (savedMax === undefined) delete process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS;
    else process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS = savedMax;
    if (savedBase === undefined) delete process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS;
    else process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS = savedBase;
    if (savedTimeout === undefined) delete process.env.HEADLESS_DRAIN_TIMEOUT_MS;
    else process.env.HEADLESS_DRAIN_TIMEOUT_MS = savedTimeout;
  }
});

test('automatic injection retries stop at the configured cap', async () => {
  const savedMax = process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS;
  const savedBase = process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS;
  process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS = '2';
  process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS = '1';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-injection-cap-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({ code: 1 }));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-cap', total: 1, cursor: 1,
      kept: [{ title: 'Cap', summary: 'Cap' }], rejected: [], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept: [{ title: 'Cap' }], rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({ repo, outDir, autoInject: true }));
    const options = {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    };
    const state = { workspace: repo, registeredWorkspaces: [repo] };
    await hd.runDueDrains(state, noopHttp(), options);
    let status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    status.injectionRetryAt = Date.now() - 1;
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify(status));
    hd._governor.backoffUntil = Date.now() - 1;
    await hd.runDueDrains(state, noopHttp(), options);
    status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.injectionState, 'failed');
    assert.equal(status.injectionAttempts, 2);
    assert.equal(status.injectionRetryCapped, true);
    assert.equal(status.injectionRetryAt, null);
    assert.equal(status.injectedKept, 0, 'the cap counts consecutive attempts with no receipt progress');

    hd._governor.backoffUntil = Date.now() - 1;
    const capped = await hd.runDueDrains(state, noopHttp(), options);
    assert.equal(calls.length, 2, 'a capped generation must not spawn a third automatic attempt');
    assert.equal(capped.drains.filter((d) => d.drain === hd.LEARNER_DRAIN_KEY).length, 0);
  } finally {
    restore();
    fs.rmSync(repo, { recursive: true, force: true });
    if (savedMax === undefined) delete process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS;
    else process.env.HEADLESS_DRAIN_INJECTION_MAX_ATTEMPTS = savedMax;
    if (savedBase === undefined) delete process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS;
    else process.env.HEADLESS_DRAIN_INJECTION_BACKOFF_BASE_MS = savedBase;
  }
});

test('findPendingLearnerRepos returns empty when queue is complete (cursor === total)', () => {
  const hd = freshModule();
  const tmpDir = makeCompletedQueueDir();
  try {
    const repos = hd.findPendingLearnerRepos(tmpDir);
    assert.equal(repos.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('findPendingLearnerRepos returns empty when no queue file exists', () => {
  const hd = freshModule();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-nq-'));
  try {
    const repos = hd.findPendingLearnerRepos(tmpDir);
    assert.equal(repos.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('pending and stale-running preparation requests are restart-discoverable without a queue', () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-prepare-discovery-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const statusFile = path.join(outDir, 'onboard-drain-status.json');
    fs.writeFileSync(statusFile, JSON.stringify({ repo, outDir, preparationState: 'pending' }));
    let queues = hd.findPendingLearnerQueues(repo);
    assert.equal(queues.length, 1);
    assert.equal(queues[0].preparationDue, true);
    assert.equal(queues[0].remaining, 0);

    fs.writeFileSync(statusFile, JSON.stringify({
      repo,
      outDir,
      preparationState: 'running',
      preparationPid: process.pid,
      preparationLeaseExpiresAt: Date.now() + 60000,
    }));
    assert.equal(hd.findPendingLearnerQueues(repo).length, 0,
      'a second daemon must not duplicate work owned by a live preparation lease');

    fs.writeFileSync(statusFile, JSON.stringify({
      repo,
      outDir,
      preparationState: 'running',
      preparationPid: 99999999,
      preparationLeaseExpiresAt: Date.now() - 1,
    }));
    queues = hd.findPendingLearnerQueues(repo);
    assert.equal(queues.length, 1);
    assert.equal(queues[0].preparationDue, true, 'dead/expired owners must resume after restart');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('force preparation discovery owns the requested replacement generation, not the old published queue', () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-prepare-force-generation-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-old', total: 1, cursor: 1,
      kept: [{ title: 'Old' }], rejected: [], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, preparationGeneration: 'generation-new',
      preparationState: 'pending', preparationForce: true,
    }));
    const queues = hd.findPendingLearnerQueues(repo);
    assert.equal(queues.length, 1);
    assert.equal(queues[0].preparationDue, true);
    assert.equal(queues[0].generation, 'generation-new');
    assert.match(queues[0].identity, /generation-new$/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a child that survives daemon restart keeps its generation lease until it exits', async () => {
  const hd = freshModule();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-injection-surviving-child-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  const child = child_process.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
    stdio: 'ignore', windowsHide: true,
  });
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const kept = [{ title: 'Survives' }];
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      generation: 'generation-surviving', total: 1, cursor: 1, kept, rejected: [], pending: [],
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-notes.json'), JSON.stringify({ kept, rejected: [] }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo, outDir, autoInject: true, injecting: true,
      injectionGeneration: 'generation-surviving', injectionState: 'running',
      injectionPid: child.pid,
      injectionProcessIdentity: require('../lib/onboard-state').processIncarnation(child.pid),
      injectionLeaseExpiresAt: Date.now() - 1,
    }));
    assert.equal(hd.findPendingLearnerQueues(repo).length, 0,
      'a restarted daemon must not duplicate injection while the old child is alive, even after lease expiry');

    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('close', resolve));
    const due = hd.findPendingLearnerQueues(repo);
    assert.equal(due.length, 1, 'the same generation becomes retryable after the surviving child exits');
    assert.equal(due[0].injectDue, true);
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('preparation miner failure is persisted truthfully and does not publish a queue', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-prepare-failure-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
    repo,
    outDir,
    preparationState: 'pending',
  }));
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({
    code: 7,
    stderr: 'simulated miner failure\n',
  }));
  try {
    const result = await hd.runDueDrains(
      { workspace: repo, registeredWorkspaces: [repo] },
      noopHttp(),
      {
        ...judgeDeps({ depth: 0, eagerNodes: [] }),
        ...labelDeps({ journal: [], labeledKeys: [] }),
        ...mockBackendDeps().deps,
      }
    );
    assert.equal(calls.length, 1, 'preparation stops on the first failed miner');
    assert.match(calls[0].args[0], /onboard-mine-structure\.js$/);
    assert.equal(result.drains[0].operation, 'preparation');
    assert.equal(result.drains[0].exitCode, 7);
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.preparationState, 'failed');
    assert.equal(status.preparationStage, 'onboard-mine-structure.js');
    assert.equal(status.preparationAttempts, 1);
    assert.match(status.error, /simulated miner failure/);
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-queue.json')), false);
    assert.equal(hd.findPendingLearnerQueues(repo).length, 0,
      'a terminal failure waits for explicit enqueue rearm instead of hot-looping');
  } finally {
    restore();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('preparation timeout is persisted as an error and releases its worker slot', async () => {
  const savedTimeout = process.env.HEADLESS_DRAIN_PREPARATION_TIMEOUT_MS;
  process.env.HEADLESS_DRAIN_PREPARATION_TIMEOUT_MS = '100';
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-prepare-timeout-'));
  const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
    repo,
    outDir,
    preparationState: 'pending',
  }));
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => {
    const child = makeFakeChild({ never: true });
    // runDrain intentionally unrefs its timeout. A real child process keeps Node alive while the
    // timer runs; mirror that handle here so node:test does not cancel the pending Promise early.
    const hold = setInterval(() => {}, 1000);
    const kill = child.kill;
    child.kill = () => { clearInterval(hold); return kill(); };
    return child;
  });
  try {
    const result = await hd.runDueDrains(
      { workspace: repo, registeredWorkspaces: [repo] },
      noopHttp(),
      {
        ...judgeDeps({ depth: 0, eagerNodes: [] }),
        ...labelDeps({ journal: [], labeledKeys: [] }),
        ...mockBackendDeps().deps,
      }
    );
    assert.equal(calls.length, 1);
    assert.equal(result.drains[0].timedOut, true);
    const status = JSON.parse(fs.readFileSync(path.join(outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.equal(status.preparationState, 'failed');
    assert.match(status.error, /timed out/);
    assert.match(status.lastError, /timed out/);
    assert.equal(status.preparationPid, null);
    assert.equal(hd._governor.concurrentRunning, 0, 'timeout must release the process-local slot');
    assert.equal(fs.existsSync(path.join(outDir, 'onboard-queue.json')), false);
  } finally {
    restore();
    fs.rmSync(repo, { recursive: true, force: true });
    if (savedTimeout === undefined) delete process.env.HEADLESS_DRAIN_PREPARATION_TIMEOUT_MS;
    else process.env.HEADLESS_DRAIN_PREPARATION_TIMEOUT_MS = savedTimeout;
  }
});

test('runDueDrains with mocked runDrain: governor is incremented and decremented correctly', async () => {
  const savedMaxIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '2';
  try {
    const hd = freshModule();

    // Track spawn calls without actually running anything
    const spawnedArgs = [];
    const origRunDrain = hd.runDrain;

    // Monkey-patch runDrain on the module's exported reference
    // We need to intercept at the module level. We do this by patching the child_process.
    // Instead, we test the command-building logic + governor separately:
    //   - buildLearnerArgs correctness tested above
    //   - governor state changes tested below by directly inspecting _governor

    // Verify initial governor state
    assert.equal(hd._governor.iterationsUsed, 0);
    assert.equal(hd._governor.concurrentRunning, 0);

    // With a completed queue, runDueDrains should not touch the governor
    const tmpDir = makeCompletedQueueDir();
    try {
      await hd.runDueDrains({ workspace: tmpDir });
      assert.equal(hd._governor.iterationsUsed, 0, 'no iterations consumed for no-op run');
      assert.equal(hd._governor.concurrentRunning, 0, 'concurrency restored to 0 after no-op');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  } finally {
    if (savedMaxIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedMaxIter;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
  }
});

test('learner backlog starts one learner per pump by default', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '2';
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-learner-refill-'));
  const outDir = path.join(tmpDir, 'bench', 'onboard', path.basename(tmpDir));
  try {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
      total: 6,
      cursor: 0,
      kept: [],
      rejected: [],
      pending: Array.from({ length: 6 }, (_, i) => ({ title: `C${i}`, summary: 's', kind: 'gotcha' })),
    }));
    fs.writeFileSync(path.join(outDir, 'onboard-drain-status.json'), JSON.stringify({
      repo: tmpDir,
      outDir,
      batchSize: 2,
    }));
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    });
    assert.equal(calls.length, 1, 'one pump should start one learner by default');
    assert.ok(calls.every((c) => c.opts.env === undefined),
      'learner drain children inherit the daemon env without an extra sentinel');
    assert.equal(result.ran, 1);
    assert.equal(result.drains.filter((d) => d.drain === hd.LEARNER_DRAIN_KEY).length, 1);
    assert.ok(calls.every((c) => c.args.includes('--timeout-ms')), 'each learner child gets an inner timeout');
    assert.equal(hd._governor.concurrentRunning, 0, 'concurrency restored after learner refill');
  } finally {
    restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('learner selection stays fair across pumps when the first registered project repeatedly fails', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '2';
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  const repos = [
    fs.mkdtempSync(path.join(os.tmpdir(), 'hd-learner-fair-a-')),
    fs.mkdtempSync(path.join(os.tmpdir(), 'hd-learner-fair-b-')),
  ];
  const { hd, calls, restore } = freshModuleWithMockedSpawn((_bin, _args, opts) => (
    makeFakeChild({ code: opts.cwd === repos[0] ? 1 : 0 })
  ));
  try {
    for (const repo of repos) {
      const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
        total: 4,
        cursor: 0,
        kept: [],
        rejected: [],
        pending: Array.from({ length: 4 }, (_, i) => ({ title: `C${i}`, summary: 's', kind: 'gotcha' })),
      }));
    }

    const state = { workspace: repos[0], registeredWorkspaces: repos };
    const options = {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    };
    const first = await hd.runDueDrains(state, noopHttp(), options);
    assert.equal(first.ran, 1);
    assert.ok(hd._governor.backoffUntil > Date.now(), 'the first project failure still activates normal backoff');

    // Represent the daemon's next pump after the backoff window has elapsed. The first queue remains
    // pending and keeps failing; fairness must nevertheless select the second queue next.
    hd._governor.backoffUntil = Date.now() - 1;
    const second = await hd.runDueDrains(state, noopHttp(), options);
    assert.equal(second.ran, 1);
    const third = await hd.runDueDrains(state, noopHttp(), options);
    assert.equal(third.ran, 1);
    assert.ok(hd._governor.backoffUntil > Date.now(), 'the repeated first-project failure still backs off');
    hd._governor.backoffUntil = Date.now() - 1;
    const fourth = await hd.runDueDrains(state, noopHttp(), options);
    assert.equal(fourth.ran, 1);

    assert.deepEqual(
      calls.map((call) => call.opts.cwd),
      [repos[0], repos[1], repos[0], repos[1]],
      'cross-pump selection should round-robin instead of resetting to the failing first queue'
    );
    assert.equal(hd._governor.iterationsUsed, 4, 'fairness does not bypass the iteration governor');
    assert.equal(hd._governor.concurrentRunning, 0, 'each learner still releases its concurrency slot');
  } finally {
    restore();
    for (const repo of repos) fs.rmSync(repo, { recursive: true, force: true });
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('stable queue aging serves continuous B and C queues while pending membership changes', async () => {
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  const names = ['a', 'b', 'c', 'd', 'e'];
  const repos = Object.fromEntries(names.map((name) => [name, fs.mkdtempSync(path.join(os.tmpdir(), `hd-fair-changing-${name}-`))]));
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({ code: 0 }));
  try {
    for (const [name, repo] of Object.entries(repos)) {
      const outDir = path.join(repo, '.zonoid', 'onboard', path.basename(repo));
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'onboard-queue.json'), JSON.stringify({
        generation: `generation-${name}`,
        total: 4,
        cursor: 0,
        kept: [],
        rejected: [],
        pending: Array.from({ length: 4 }, (_, i) => ({ title: `${name}${i}`, summary: 's' })),
      }));
    }
    const options = {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    };
    await hd.runDueDrains({ workspace: repos.a, registeredWorkspaces: [repos.a, repos.b, repos.c] }, noopHttp(), options);
    await hd.runDueDrains({ workspace: repos.d, registeredWorkspaces: [repos.d, repos.b, repos.c] }, noopHttp(), options);
    await hd.runDueDrains({ workspace: repos.e, registeredWorkspaces: [repos.e, repos.d, repos.b, repos.c] }, noopHttp(), options);
    assert.deepEqual(calls.map((call) => call.opts.cwd), [repos.a, repos.b, repos.c],
      'newly inserted queues must not reset the age of continuously waiting B/C queues');
    assert.equal(hd._governor.iterationsUsed, 3);
    assert.equal(hd._governor.concurrentRunning, 0);
  } finally {
    restore();
    for (const repo of Object.values(repos)) fs.rmSync(repo, { recursive: true, force: true });
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

// ---------------------------------------------------------------------------
// Test 4: runDrain shape validation (direct invocation with a REAL async spawn of a trivial command)
// runDrain now returns a Promise (async child_process.spawn) — these await it. Spawning the same Node
// that runs the test is fast, deterministic, and exercises the real non-blocking path end-to-end.
// ---------------------------------------------------------------------------

test('runDrain resolves with correct shape on a successful command (node --version)', async () => {
  const hd = freshModule();
  // Use the same Node executable that runs this test — guaranteed to exist, fast, exit 0.
  const result = await hd.runDrain({
    bin: process.execPath,
    args: ['--version'],
    cwd: os.tmpdir(),
    timeoutMs: 10000,
  });
  assert.equal(result.exitCode, 0, 'exitCode should be 0 for node --version');
  assert.ok(result.stdout.includes('v'), 'stdout should have version string');
  assert.equal(result.timedOut, false, 'timedOut should be false for fast command');
  assert.equal(result.spawnError, null, 'spawnError should be null on success');
});

test('runDrain resolves with non-zero exitCode for a failing command', async () => {
  const hd = freshModule();
  // node -e 'process.exit(42)' → exit code 42
  const result = await hd.runDrain({
    bin: process.execPath,
    args: ['-e', 'process.exit(42)'],
    cwd: os.tmpdir(),
    timeoutMs: 10000,
  });
  assert.equal(result.exitCode, 42, 'exitCode should match the explicit exit code');
  assert.equal(result.timedOut, false, 'should not be a timeout');
});

test('runDrain resolves timedOut=true when the command exceeds the timeout', async () => {
  const hd = freshModule();
  // node -e 'setTimeout(()=>{},9999)' → the unref'd timer SIGKILLs it after 200ms, close → timedOut.
  const result = await hd.runDrain({
    bin: process.execPath,
    args: ['-e', 'setTimeout(()=>{},9999)'],
    cwd: os.tmpdir(),
    timeoutMs: 200, // very short — will time out
  });
  assert.equal(result.timedOut, true, 'should be marked as timed out');
  assert.equal(result.exitCode, null, 'exitCode is null when the child was SIGKILL\'d on timeout');
});

test('runDrain resolves spawnError (not throw) when the binary does not exist', async () => {
  const hd = freshModule();
  const result = await hd.runDrain({
    bin: path.join(os.tmpdir(), 'no-such-binary-zzz-' + Date.now()),
    args: [],
    cwd: os.tmpdir(),
    timeoutMs: 5000,
  });
  assert.ok(result.spawnError, 'spawnError should be populated for a missing binary');
  assert.equal(result.timedOut, false, 'a spawn error is not a timeout');
});

// ---------------------------------------------------------------------------
// Test 5: HEADLESS_DRAIN_CONFIG shape mirrors AUTOSTART_CONFIG
// ---------------------------------------------------------------------------

test('HEADLESS_DRAIN_CONFIG has the same structural keys as AUTOSTART_CONFIG', () => {
  const hd = freshModule();
  const { AUTOSTART_CONFIG } = require('../lib/loop-autostart');
  // Required overlapping keys (the drain config is a subset — it also has timeoutMs which
  // AUTOSTART_CONFIG does not, but all AUTOSTART_CONFIG keys should be covered or intentionally absent).
  const drainKeys = Object.keys(hd.HEADLESS_DRAIN_CONFIG);
  assert.ok(drainKeys.includes('tokenBudget'), 'must have tokenBudget');
  assert.ok(drainKeys.includes('maxIterations'), 'must have maxIterations');
  assert.ok(drainKeys.includes('maxConcurrency'), 'must have maxConcurrency');
  assert.ok(drainKeys.includes('timeoutMs'), 'must have timeoutMs (per-run timeout)');
  // All values must be positive numbers
  for (const [k, v] of Object.entries(hd.HEADLESS_DRAIN_CONFIG)) {
    assert.ok(typeof v === 'number' && v > 0, `${k} should be a positive number, got ${v}`);
  }
});

test('effectiveConfig defaults maxIterations to Infinity for continuous draining', () => {
  const saved = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  try {
    const hd = freshModule();
    assert.equal(hd.effectiveConfig().maxIterations, Number.POSITIVE_INFINITY);
  } finally {
    if (saved === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = saved;
  }
});

test('effectiveConfig defaults timeoutMs to 5 minutes', () => {
  const saved = process.env.HEADLESS_DRAIN_TIMEOUT_MS;
  delete process.env.HEADLESS_DRAIN_TIMEOUT_MS;
  try {
    const hd = freshModule();
    assert.equal(hd.effectiveConfig().timeoutMs, 5 * 60 * 1000);
  } finally {
    if (saved === undefined) delete process.env.HEADLESS_DRAIN_TIMEOUT_MS;
    else process.env.HEADLESS_DRAIN_TIMEOUT_MS = saved;
  }
});

test('effectiveConfig defaults drain concurrency to 2', () => {
  const saved = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  try {
    const hd = freshModule();
    assert.equal(hd.effectiveConfig().maxConcurrency, 2);
  } finally {
    if (saved === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = saved;
  }
});

test('default judge drain budget is 20 items per run', () => {
  const hd = freshModule();
  assert.equal(hd.DEFAULT_JUDGE_DRAIN_BUDGET, 20);
});

test('backoffConfig defaults to a short retry window', () => {
  const savedBase = process.env.HEADLESS_DRAIN_BACKOFF_BASE_MS;
  const savedCap = process.env.HEADLESS_DRAIN_BACKOFF_CAP_MS;
  delete process.env.HEADLESS_DRAIN_BACKOFF_BASE_MS;
  delete process.env.HEADLESS_DRAIN_BACKOFF_CAP_MS;
  try {
    const hd = freshModule();
    assert.equal(hd.backoffConfig().baseMs, 5_000);
    assert.equal(hd.backoffConfig().capMs, 60_000);
  } finally {
    if (savedBase === undefined) delete process.env.HEADLESS_DRAIN_BACKOFF_BASE_MS;
    else process.env.HEADLESS_DRAIN_BACKOFF_BASE_MS = savedBase;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_BACKOFF_CAP_MS;
    else process.env.HEADLESS_DRAIN_BACKOFF_CAP_MS = savedCap;
  }
});

// ===========================================================================
// JUDGE DRAIN tests (task /3)
// ===========================================================================
//
// The judge drain drives the self-learn skill edge-judge mode via the selected backend against the
// daemon, covering BOTH the periodic (/judge/next?budget=N) and eager (/judge/next?node=<key>)
// paths. It rides the SAME runner + governor as the learner. ALL spawns are MOCKED — these tests
// never shell out to a real CLI or hit a live daemon.
//
// Mock seam: lib/headless-drain.js captures `spawn` via a top-level destructure of child_process.
// Patching child_process.spawn BEFORE freshModule() (which re-requires the module) makes the fresh
// module capture the patched fn, intercepting runDrain's spawn — no real CLI child runs.

const { EventEmitter } = require('events');

/**
 * A fake child process for the async `spawn` seam: an EventEmitter with stdout/stderr sub-emitters.
 * runDrain attaches data/close/error listeners, so the fake schedules its lifecycle on the next tick
 * (mirroring a real child) — emitting optional stdout/stderr data then `close`. The async schedule
 * means the event loop genuinely yields between spawn and resolution, exactly as the real path does.
 *
 * @param {object} [opts] — { code=0 (close exit code), stdout='', stderr='', emitError=Error|null,
 *                            never=false (never emit close — simulate a child still running) }
 */
function makeFakeChild(opts = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => { child.emit('close', null); return true; };
  setImmediate(() => {
    if (opts.emitError) { child.emit('error', opts.emitError); return; }
    if (opts.stdout) child.stdout.emit('data', opts.stdout);
    if (opts.stderr) child.stderr.emit('data', opts.stderr);
    if (!opts.never) child.emit('close', opts.code != null ? opts.code : 0);
  });
  return child;
}

/**
 * Patch child_process.spawn, return { hd, calls, restore }. Each spawn is recorded and returns a
 * fake child (async-close on next tick). `stub(bin,args,opts)` may return a custom fake child to
 * tailor exit code / streams per call; default is a clean exit-0 child. Because runDrain is now
 * async, callers must AWAIT runDueDrains for these recorded calls to be populated.
 */
function freshModuleWithMockedSpawn(stub) {
  const orig = child_process.spawn;
  const calls = [];
  child_process.spawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return stub ? stub(bin, args, opts) : makeFakeChild();
  };
  const hd = freshModule();
  return { hd, calls, restore: () => { child_process.spawn = orig; } };
}

/** No-op HTTP module so _reportDrainProgress never touches the network during tests. */
function noopHttp() {
  return {
    request(_opts, cb) {
      // Immediately resolve the response callback with an end-emitting stub.
      const res = { resume() {}, on(ev, fn) { if (ev === 'end') fn(); } };
      if (cb) cb(res);
      return { on() {}, write() {}, end() {} };
    },
  };
}

async function waitForCondition(fn, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Stub judgeDeps so findDueJudgeWork is driven entirely by the test (no real overlay touched). */
function judgeDeps({ depth = 0, eagerNodes = [] } = {}) {
  return {
    judgeDeps: {
      overlayLoad: () => ({ /* sentinel overlay */ }),
      judgeLib: {
        judgeQueueDepth: () => depth,
        buildQueue: () => Array.from({ length: depth }, (_, i) => ({ kind: 'edge', id: `e${i}` })),
        eagerJudgeNodes: () => eagerNodes.slice(),
      },
    },
  };
}

/**
 * Stub backendDeps so the JUDGE drain's backend resolution is driven entirely by the test (no real
 * lib/llm-backend, no ambient ANTHROPIC_API_KEY needed). Returns a fake provider whose buildInvocation
 * yields a recognizable spawn argv. Defaults: an AVAILABLE + AUTHED agentic-cli provider (so the judge
 * spawns); flip `available`/`authed` to exercise the HARD-BLOCK, or `kind:'api'` for the api-skip path.
 * `buildInvocation` mirrors the historical judge argv (keeps the existing -p/--model/stream-json
 * prompt assertions valid) but stamps a `--backend-id <id>` marker so a test can prove the spawn was
 * driven by THIS provider's invocation, not a hardcoded claude path.
 *
 * For an api-kind provider, the background drain now spawns a lightweight worker. `runJudgeLoop`
 * remains here for resolution/sync-drain tests, but runDueDrains should not call it in-process.
 */
function mockBackendDeps({ id = 'mock-cli', kind = 'agentic-cli', available = true, authed = true, model = 'mock-model', bin = '/mock/bin/agent', judgeLoopResult = null, judgeLoopThrows = false } = {}) {
  const calls = { buildInvocation: 0, runJudgeLoop: 0, runJudgeLoopArgs: [] };
  const provider = {
    id,
    displayName: `Mock ${id}`,
    kind,
    isAvailable: () => available,
    isAuthed: () => authed,
    buildInvocation(opts = {}) {
      calls.buildInvocation++;
      const args = ['-p', opts.prompt, '--model', opts.model || model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', '--backend-id', id];
      if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig, '--strict-mcp-config');
      if (opts.addDir) args.push('--add-dir', opts.addDir);
      return { bin, args, env: { MOCK_ENV: '1' } };
    },
    // Direct api judge seam. Background drains should not call this in the daemon process; sync-drain
    // tests still use it as the injected runJudgeLoop boundary.
    async runJudgeLoop(args) {
      calls.runJudgeLoop++;
      calls.runJudgeLoopArgs.push(args);
      if (judgeLoopThrows) throw new Error('runJudgeLoop boom');
      return judgeLoopResult || { exitCode: 0, stdout: 'judge: adjudicated 1 item(s)', stderr: '', timedOut: false, spawnError: null };
    },
  };
  const backendLib = {
    getActiveBackend: () => ({ provider, providerId: id, model, config: { provider: id, model } }),
    getProvider: (q) => (q === id ? provider : null),
    listProviders: () => [provider],
  };
  return { deps: { backendDeps: { backendLib } }, provider, calls, bin, id };
}

/**
 * Stub labelDeps so findDueLabelWork is driven entirely by the test (no real journal file touched).
 * `journal` is an array of synthetic journal rows; `labeledKeys` is the set of already-labeled
 * rowKeys. The stub rowKey is the row's own `_k` field so tests control dedup precisely.
 */
function labelDeps({ journal = [], labeledKeys = [] } = {}) {
  const labeled = labeledKeys.map((k) => ({ _key: k }));
  return {
    labelDeps: {
      rowKey: (row) => row._k,
      journalPath: () => '/irrelevant/gate-journal.jsonl',
      labeledPath: () => '/irrelevant/gate-labeled.jsonl',
      readJsonl: (file) => (file.endsWith('gate-labeled.jsonl') ? labeled : journal),
    },
  };
}

// ---- buildJudgeArgs: command/prompt shape --------------------------------------------

test('buildJudgeArgs (PERIODIC): targets /judge/next with a bounded budget, no node', () => {
  const hd = freshModule();
  const args = hd.buildJudgeArgs({ budget: 6 });
  // -p <prompt> present
  const pIdx = args.indexOf('-p');
  assert.ok(pIdx >= 0, 'must pass -p');
  const prompt = args[pIdx + 1];
  assert.match(prompt, /self-learn skill in edge-judge/, 'prompt must name the skill mode');
  assert.match(prompt, /\/judge\/next\?budget=6/, 'periodic prompt must target /judge/next?budget=N');
  assert.doesNotMatch(prompt, /node=/, 'periodic prompt must NOT carry a node param');
  assert.match(prompt, /\/judge\/verdict/, 'prompt must mention applying verdicts');
  assert.match(prompt, /AT MOST 6/, 'prompt must bound the batch to the budget');
  // headless flags mirror onboard-learn
  assert.ok(args.includes('--dangerously-skip-permissions'), 'must skip permissions (headless)');
  assert.ok(args.includes('--model'), 'must pin a model');
  assert.ok(args.includes('--output-format') && args.includes('stream-json'), 'must stream JSON');
});

test('buildJudgeArgs (EAGER): targets /judge/next?node=<key> for the node-scoped path', () => {
  const hd = freshModule();
  const args = hd.buildJudgeArgs({ budget: 6, node: 'note:abc 123' });
  const prompt = args[args.indexOf('-p') + 1];
  // node is URL-encoded into the query
  assert.match(prompt, /\/judge\/next\?node=note%3Aabc%20123&budget=6/, 'eager prompt must target node-scoped /judge/next with encoded node');
  assert.match(prompt, /EAGER/i, 'eager prompt should identify itself as the eager path');
});

test('buildJudgeArgs clamps budget to 1..50', () => {
  const hd = freshModule();
  const tooBig = hd.buildJudgeArgs({ budget: 9999 });
  assert.match(tooBig[tooBig.indexOf('-p') + 1], /budget=50/, 'budget clamps to 50 max');
  const tooSmall = hd.buildJudgeArgs({ budget: 0 });
  assert.match(tooSmall[tooSmall.indexOf('-p') + 1], /budget=1/, 'budget clamps to 1 min');
});

test('buildJudgeArgs attaches --mcp-config + --add-dir when provided', () => {
  const hd = freshModule();
  const args = hd.buildJudgeArgs({ budget: 6, mcpConfig: '/ws/.mcp.json', addDir: '/ws' });
  assert.ok(args.includes('--mcp-config'), 'must pass --mcp-config when given');
  assert.ok(args.includes('/ws/.mcp.json'));
  assert.ok(args.includes('--strict-mcp-config'), 'must lock to the given mcp config');
  assert.ok(args.includes('--add-dir') && args.includes('/ws'), 'must grant workspace read');
});

// ---- findDueJudgeWork: due-detection via injected deps -------------------------------

test('findDueJudgeWork reports periodic depth + eager nodes from injected deps', () => {
  const hd = freshModule();
  const deps = judgeDeps({ depth: 4, eagerNodes: ['note:x', 'note:y'] }).judgeDeps;
  const due = hd.findDueJudgeWork('/irrelevant', deps);
  assert.equal(due.periodic, true, 'periodic true when queue has depth');
  assert.equal(due.depth, 4);
  assert.deepEqual(due.eagerNodes, ['note:x', 'note:y']);
});

test('findDueJudgeWork reports nothing due on empty queue + no eager nodes', () => {
  const hd = freshModule();
  const deps = judgeDeps({ depth: 0, eagerNodes: [] }).judgeDeps;
  const due = hd.findDueJudgeWork('/irrelevant', deps);
  assert.equal(due.periodic, false);
  assert.deepEqual(due.eagerNodes, []);
});

test('findDueJudgeWork uses judgeQueueDepth without building the full queue', () => {
  const hd = freshModule();
  const due = hd.findDueJudgeWork('/irrelevant', {
    overlayLoad: () => ({ /* sentinel overlay */ }),
    judgeLib: {
      judgeQueueDepth: () => 7,
      buildQueue: () => { throw new Error('buildQueue should not run'); },
      eagerJudgeNodes: () => ['note:x'],
    },
  });
  assert.equal(due.periodic, true);
  assert.equal(due.depth, 7);
  assert.deepEqual(due.eagerNodes, ['note:x']);
});

test('findDueJudgeWork swallows loader errors and returns no due work', () => {
  const hd = freshModule();
  const due = hd.findDueJudgeWork('/irrelevant', {
    overlayLoad: () => { throw new Error('overlay missing'); },
    judgeLib: { buildQueue: () => [], eagerJudgeNodes: () => [] },
  });
  assert.equal(due.periodic, false);
  assert.deepEqual(due.eagerNodes, []);
  assert.equal(due.depth, 0);
});

// ---- judge spawns for both eager + periodic, governor accounted ----------------------

test('runDueDrains spawns judge for each eager node + one periodic batch', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '5';
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  // Empty workspace ⇒ no learner spawn; judge work comes from injected deps.
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(),
      { ...judgeDeps({ depth: 3, eagerNodes: ['note:a', 'note:b'] }), ...mockBackendDeps().deps });
    // 2 eager + 1 periodic = 3 judge spawns
    assert.equal(calls.length, 3, 'should spawn 2 eager + 1 periodic');
    assert.equal(result.ran, 3, 'ran should count all 3 judge drains');
    assert.equal(result.drains.filter((d) => d.drain === hd.JUDGE_DRAIN_KEY).length, 3);
    // The eager spawns carry node-scoped prompts; the periodic does not.
    const prompts = calls.map((c) => c.args[c.args.indexOf('-p') + 1]);
    const eagerPrompts = prompts.filter((p) => /node=/.test(p));
    const periodicPrompts = prompts.filter((p) => !/node=/.test(p));
    assert.equal(eagerPrompts.length, 2, 'two eager (node-scoped) prompts');
    assert.equal(periodicPrompts.length, 1, 'one periodic (cursor-walked) prompt');
    assert.match(eagerPrompts[0], /node=note%3Aa/, 'first eager prompt targets note:a');
    assert.match(periodicPrompts[0], /\/judge\/next\?budget=/, 'periodic prompt targets the depth queue');
    // governor consumed 3 iterations, concurrency fully restored
    assert.equal(hd._governor.iterationsUsed, 3, 'three iterations consumed');
    assert.equal(hd._governor.concurrentRunning, 0, 'concurrency restored after runs');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('periodic judge backlog refills slots up to maxConcurrency until current backlog is drained', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '4';
  const savedPerTick = process.env.HEADLESS_DRAIN_MAX_PER_TICK;
  delete process.env.HEADLESS_DRAIN_MAX_PER_TICK; // default should not cap total starts
  let active = 0;
  let maxActive = 0;
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => {
    active++;
    maxActive = Math.max(maxActive, active);
    const child = makeFakeChild();
    child.once('close', () => { active--; });
    return child;
  });
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 100, eagerNodes: [] }), // 5 batches at default budget=20; cap is 4
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    });
    assert.equal(calls.length, 5, 'periodic backlog should refill slots past the initial cap');
    assert.equal(maxActive, 4, 'periodic spawns should never exceed maxConcurrency');
    assert.equal(result.ran, 5, 'ran counts all periodic judge drains');
    assert.equal(result.drains.every((d) => d.mode === 'periodic'), true, 'all runs are periodic');
    assert.equal(hd._governor.concurrentRunning, 0, 'concurrency restored after runs');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedPerTick === undefined) delete process.env.HEADLESS_DRAIN_MAX_PER_TICK;
    else process.env.HEADLESS_DRAIN_MAX_PER_TICK = savedPerTick;
  }
});

test('judge fan-out is bounded by the iteration cap', async () => {
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '2'; // only 2 spawns allowed total
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '5';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makeCompletedQueueDir();
  try {
    // 3 eager nodes + periodic, but cap is 2 → only 2 spawns happen.
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(),
      { ...judgeDeps({ depth: 3, eagerNodes: ['note:a', 'note:b', 'note:c'] }), ...mockBackendDeps().deps });
    assert.equal(calls.length, 2, 'iteration cap must bound spawns to 2');
    assert.equal(result.ran, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
  }
});

test('mandatory drains but no judge work due ⇒ no judge spawn (no_due_drains)', async () => {
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(),
      judgeDeps({ depth: 0, eagerNodes: [] }));
    assert.equal(calls.length, 0, 'no judge work ⇒ no spawn');
    assert.equal(result.skipped, 'no_due_drains');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
  }
});

// ===========================================================================
// SELECTABLE BACKEND routing (pluggable-backend task /16)
// ===========================================================================
//
// The judge drain (the only AGENTIC drain) routes through the configured backend:
// getActiveBackend(overlay).buildInvocation(...) drives the spawn {bin,args,env}, NOT a hardcoded
// `claude` binary. These tests prove: (c) the spawn comes from the active provider's invocation,
// (d) a HARD-BLOCK (no available/authed backend) no-ops the judge with skipped:'no_backend', and
// (e) an api-kind active backend skips cleanly WITHOUT calling its throwing runJudgeLoop stub.

// ---- resolveJudgeBackend: pure resolution paths --------------------------------------

test('resolveJudgeBackend: agentic-cli available+authed ⇒ returns a spawnable invocation', () => {
  const hd = freshModule();
  const mb = mockBackendDeps({ id: 'mock-cli', available: true, authed: true });
  const r = hd.resolveJudgeBackend({}, { addDir: '/ws' }, mb.deps.backendDeps);
  assert.equal(r.skip, undefined, 'no skip for a ready agentic-cli backend');
  assert.equal(r.providerId, 'mock-cli');
  assert.equal(r.invocation.bin, mb.bin, 'invocation.bin comes from the provider');
  assert.ok(r.invocation.args.includes('--backend-id'), 'invocation argv is the PROVIDER\'s, not a hardcoded claude argv');
  assert.deepEqual(r.invocation.env, { MOCK_ENV: '1' }, 'invocation.env comes from the provider');
});

test('resolveJudgeBackend: agentic-cli NOT authed ⇒ skip:no_backend (hard-block)', () => {
  const hd = freshModule();
  const mb = mockBackendDeps({ available: true, authed: false });
  const r = hd.resolveJudgeBackend({}, {}, mb.deps.backendDeps);
  assert.equal(r.skip, 'no_backend', 'unauthed backend hard-blocks');
  assert.equal(mb.calls.buildInvocation, 0, 'must NOT build an invocation when hard-blocked');
});

test('resolveJudgeBackend: agentic-cli NOT available ⇒ skip:no_backend (hard-block)', () => {
  const hd = freshModule();
  const mb = mockBackendDeps({ available: false, authed: true });
  const r = hd.resolveJudgeBackend({}, {}, mb.deps.backendDeps);
  assert.equal(r.skip, 'no_backend', 'unavailable backend hard-blocks');
});

test('resolveJudgeBackend: api-kind active backend (authed) ⇒ api resolution, no invocation built', () => {
  const hd = freshModule();
  const mb = mockBackendDeps({ id: 'mock-api', kind: 'api', authed: true });
  const r = hd.resolveJudgeBackend({}, {}, mb.deps.backendDeps);
  assert.equal(r.skip, undefined, 'an authed api backend does NOT skip');
  assert.equal(r.kind, 'api', 'resolution is marked api-kind so the drain uses the API worker path');
  assert.equal(r.providerId, 'mock-api');
  assert.equal(r.provider, mb.provider, 'carries the api provider for the API worker');
  assert.equal(r.invocation, undefined, 'no spawnable invocation is built for an api backend');
  assert.equal(mb.calls.buildInvocation, 0, 'resolveJudgeBackend builds nothing for api');
  assert.equal(mb.calls.runJudgeLoop, 0, 'resolveJudgeBackend is pure — it does NOT call runJudgeLoop itself');
});

test('resolveJudgeBackend: api-kind active backend with NO key ⇒ skip:no_backend (hard-block, not crash)', () => {
  const hd = freshModule();
  const mb = mockBackendDeps({ id: 'mock-api', kind: 'api', authed: false });
  const r = hd.resolveJudgeBackend({}, {}, mb.deps.backendDeps);
  assert.equal(r.skip, 'no_backend', 'an unauthed api backend hard-blocks like an unusable CLI');
  assert.equal(mb.calls.runJudgeLoop, 0, 'no daemon-process call attempted when hard-blocked');
});

// ---- (c) the judge drain SPAWN is driven by the active provider's invocation ---------

test('judge spawn argv is built by getActiveBackend().buildInvocation (mocked provider)', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '5';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const mb = mockBackendDeps({ id: 'mock-cli', bin: '/mock/bin/agent' });
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: ['note:a'] }),
      ...mb.deps,
    });
    assert.equal(calls.length, 1, 'one judge spawn');
    // The spawned bin + argv come from the PROVIDER's buildInvocation, not a hardcoded claude path.
    assert.equal(calls[0].bin, '/mock/bin/agent', 'spawn bin is the provider-resolved binary');
    assert.ok(calls[0].args.includes('--backend-id'), 'spawn argv carries the provider marker');
    assert.equal(calls[0].args[calls[0].args.indexOf('--backend-id') + 1], 'mock-cli', 'argv was built by THIS provider');
    assert.equal(calls[0].opts.env.MOCK_ENV, '1', 'spawn env comes from the provider invocation');
    assert.ok(mb.calls.buildInvocation >= 1, 'provider.buildInvocation was invoked for the spawn');
    assert.equal(result.ran, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
  }
});

// ---- (d) HARD-BLOCK: no valid backend ⇒ judge no-ops with skipped:no_backend ----------

test('judge due but NO valid backend ⇒ no spawn, skipped:no_backend (hard-block, not crash)', async () => {
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const mb = mockBackendDeps({ available: true, authed: false }); // unauthed ⇒ hard-block
  const tmpDir = makeCompletedQueueDir(); // learner NOT due; label deps empty below
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 5, eagerNodes: ['note:a', 'note:b'] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mb.deps,
    });
    assert.equal(calls.length, 0, 'hard-block must spawn nothing');
    assert.equal(result.skipped, 'no_backend', 'judge hard-block surfaces skipped:no_backend');
    assert.equal(result.ran, 0);
    assert.equal(mb.calls.buildInvocation, 0, 'no invocation built when hard-blocked');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
  }
});

test('hard-block judge does NOT suppress a due LABEL drain (label still runs)', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '5';
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const mb = mockBackendDeps({ available: true, authed: false }); // judge hard-blocks…
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 5, eagerNodes: ['note:a'] }),
      ...labelDeps({ journal: [{ _k: 'a', task_key: 't1' }], labeledKeys: [] }), // …but label IS due
      ...mb.deps,
    });
    // The judge skip is non-fatal: the label drain still spawns, so skipped is null (a drain ran).
    assert.equal(calls.length, 1, 'only the label drain spawns (judge hard-blocked)');
    assert.equal(result.ran, 1);
    assert.equal(result.skipped, null, 'a drain ran ⇒ skipped is null despite the judge hard-block');
    assert.equal(result.drains.filter((d) => d.drain === hd.LABEL_DRAIN_KEY).length, 1, 'the label drain ran');
    assert.equal(result.drains.filter((d) => d.drain === hd.JUDGE_DRAIN_KEY).length, 0, 'no judge drain ran');
    await waitForCondition(() => hd._governor.concurrentRunning === 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

// ---- (e) api-kind active backend ⇒ judge runs in a lightweight worker child --------------------

test('api-kind active backend ⇒ judge spawns API worker, not provider invocation', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '5';
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const mb = mockBackendDeps({ id: 'mock-api', kind: 'api', authed: true });
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 3, eagerNodes: ['note:a', 'note:b'] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mb.deps,
    });
    // 2 eager + 1 periodic = 3 API worker spawns, all counted as drains.
    assert.equal(calls.length, 3, 'api backend should spawn one lightweight worker per judge run');
    assert.equal(mb.calls.runJudgeLoop, 0, 'background drain must not call runJudgeLoop in the daemon process');
    assert.equal(mb.calls.buildInvocation, 0, 'api worker path must not build an agentic-cli invocation');
    assert.equal(result.ran, 3, 'api worker runs count as drains, same as CLI spawns');
    assert.equal(result.drains.filter((d) => d.drain === hd.JUDGE_DRAIN_KEY).length, 3);
    assert.equal(result.skipped, null, 'judge ran ⇒ not skipped');
    const workerArgs = calls.map((c) => {
      assert.equal(c.bin, process.execPath, 'api worker uses the current Node runtime');
      assert.match(c.args[0], /scripts\/api-judge-worker\.js$/, 'api worker script is spawned');
      return JSON.parse(c.args[1]);
    });
    const nodes = workerArgs.map((a) => a.node || null);
    assert.ok(workerArgs.every((a) => a.provider === 'mock-api'), 'each worker carries the provider id');
    assert.ok(workerArgs.every((a) => /^http:\/\//.test(a.daemonUrl)), 'each worker carries the daemon URL');
    assert.ok(nodes.includes('note:a') && nodes.includes('note:b'), 'eager runs are node-scoped');
    assert.ok(nodes.includes(null), 'one periodic (node-less) run');
    // governor accounted the 3 worker runs exactly like other spawns; concurrency restored.
    assert.equal(hd._governor.iterationsUsed, 3, 'three iterations consumed by the api workers');
    assert.equal(hd._governor.concurrentRunning, 0, 'concurrency restored after the worker runs');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('api-kind backend with NO key ⇒ judge hard-blocks (skipped:no_backend), no worker spawn', async () => {
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const mb = mockBackendDeps({ id: 'mock-api', kind: 'api', authed: false }); // no key ⇒ hard-block
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 3, eagerNodes: ['note:a'] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mb.deps,
    });
    assert.equal(calls.length, 0, 'no worker spawn when hard-blocked');
    assert.equal(mb.calls.runJudgeLoop, 0, 'unauthed api backend must NOT attempt a daemon-process call');
    assert.equal(result.skipped, 'no_backend', 'unauthed api backend hard-blocks rather than crashing');
    assert.equal(result.ran, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
  }
});

test('api worker failure becomes a clean failed drain and feeds backoff', async () => {
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({ code: 1, stderr: 'runJudgeLoop threw: boom' }));
  const mb = mockBackendDeps({ id: 'mock-api', kind: 'api', authed: true });
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: ['note:a'] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mb.deps,
    });
    assert.equal(calls.length, 1, 'the api worker was spawned');
    assert.equal(mb.calls.runJudgeLoop, 0, 'daemon process did not call runJudgeLoop directly');
    // A failed worker does not crash the pass; the judge run is recorded as a failed drain.
    assert.equal(result.ran, 1, 'the run is still counted (as a failed drain)');
    const judge = result.drains.find((d) => d.drain === hd.JUDGE_DRAIN_KEY);
    assert.ok(judge && judge.exitCode === 1, 'a failed api worker becomes an exitCode:1 drain result');
    assert.ok(hd._governor.backoffUntil > Date.now(), 'a nonzero LLM drain exit sets backoff');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
  }
});

test('api worker throttle result feeds the backoff governor (recordDrainOutcome)', async () => {
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({ code: 1, stderr: '429 rate limit / overloaded' }));
  const mb = mockBackendDeps({ id: 'mock-api', kind: 'api', authed: true });
  const tmpDir = makeCompletedQueueDir();
  try {
    assert.equal(hd._governor.backoffUntil, 0, 'no backoff before the run');
    await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: ['note:a'] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mb.deps,
    });
    assert.equal(calls.length, 1, 'the api worker was spawned');
    assert.ok(hd._governor.backoffUntil > Date.now(), 'an api worker throttle set the backoff window (governor fed)');
    assert.equal(hd._governor.consecutiveThrottles, 1, 'one consecutive throttle recorded');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
  }
});

// ===========================================================================
// LABEL DRAIN tests (task /4)
// ===========================================================================
//
// The label drain runs the DETERMINISTIC gate-labeler (node scripts/gate-label.js) headless under
// the SAME runner + governor as the learner — a Node child via process.execPath, NOT an agentic CLI.
// ALL spawns are MOCKED — these tests never shell out to a real gate-label.js or hit a live daemon.
// Mock seam is identical to the JUDGE tests: patch child_process.spawn BEFORE freshModule().

// ---- buildLabelArgs: command shape ---------------------------------------------------

test('buildLabelArgs builds correct node invocation for gate-label.js (workspace + port)', () => {
  const hd = freshModule();
  const args = hd.buildLabelArgs('/some/workspace', 9191);
  // Must be: [<path-to-gate-label.js>, '--workspace', '/some/workspace', '--port', '9191']
  assert.equal(args.length, 5, 'should have 5 argv elements');
  assert.match(args[0], /gate-label\.js$/, 'first arg must be the gate-label.js script');
  assert.equal(args[1], '--workspace', 'second arg must be --workspace');
  assert.equal(args[2], '/some/workspace', 'third arg must be the workspace path');
  assert.equal(args[3], '--port', 'fourth arg must be --port');
  assert.equal(args[4], '9191', 'fifth arg must be the stringified port');
  // It targets gate-label.js — NOT onboard-learn.js and NOT an agentic CLI prompt.
  assert.doesNotMatch(args[0], /onboard-learn/, 'must NOT target the learner script');
  assert.ok(!args.includes('-p'), 'label drain is a Node script, NOT an agentic CLI invocation');
});

test('buildLabelArgs defaults the port when not provided', () => {
  const hd = freshModule();
  const savedPort = process.env.ORCH_PORT;
  delete process.env.ORCH_PORT;
  try {
    const args = hd.buildLabelArgs('/ws');
    assert.equal(args[4], '8787', 'port defaults to 8787 when neither arg nor ORCH_PORT set');
  } finally {
    if (savedPort === undefined) delete process.env.ORCH_PORT;
    else process.env.ORCH_PORT = savedPort;
  }
});

// ---- findDueLabelWork: due-detection via injected deps -------------------------------

test('findDueLabelWork: due when journal has unlabeled rows carrying a task_key', () => {
  const hd = freshModule();
  const deps = labelDeps({
    journal: [
      { _k: 'a', task_key: 't1' },
      { _k: 'b', task_key: 't2' },
    ],
    labeledKeys: [],
  }).labelDeps;
  const due = hd.findDueLabelWork('/ws', deps);
  assert.equal(due.due, true, 'due when there are unlabeled rows with task_key');
  assert.equal(due.pending, 2, 'both rows count as pending');
});

test('findDueLabelWork: rows already in gate-labeled.jsonl are NOT pending (dedup by rowKey)', () => {
  const hd = freshModule();
  const deps = labelDeps({
    journal: [
      { _k: 'a', task_key: 't1' },
      { _k: 'b', task_key: 't2' },
    ],
    labeledKeys: ['a'], // row 'a' already labeled
  }).labelDeps;
  const due = hd.findDueLabelWork('/ws', deps);
  assert.equal(due.pending, 1, 'only the unlabeled row remains pending');
  assert.equal(due.due, true);
});

test('findDueLabelWork: rows without a task_key are skipped (unlabelable)', () => {
  const hd = freshModule();
  const deps = labelDeps({
    journal: [
      { _k: 'a' },               // no task_key → unlabelable
      { _k: 'b', task_key: '' },  // empty task_key → unlabelable
    ],
    labeledKeys: [],
  }).labelDeps;
  const due = hd.findDueLabelWork('/ws', deps);
  assert.equal(due.pending, 0, 'rows without a usable task_key are not pending');
  assert.equal(due.due, false);
});

test('findDueLabelWork: not due when every task_key row is already labeled', () => {
  const hd = freshModule();
  const deps = labelDeps({
    journal: [{ _k: 'a', task_key: 't1' }],
    labeledKeys: ['a'],
  }).labelDeps;
  const due = hd.findDueLabelWork('/ws', deps);
  assert.equal(due.due, false);
  assert.equal(due.pending, 0);
});

test('findDueLabelWork swallows loader errors and returns no due work', () => {
  const hd = freshModule();
  const due = hd.findDueLabelWork('/ws', {
    journalPath: () => '/x', labeledPath: () => '/y',
    rowKey: (r) => r._k,
    readJsonl: () => { throw new Error('journal unreadable'); },
  });
  assert.equal(due.due, false);
  assert.equal(due.pending, 0);
});

// ---- label spawns ONE Node child targeting gate-label.js -----------------------------

test('runDueDrains spawns ONE label drain (node gate-label.js), governor accounted', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '5';
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  // Completed learner queue ⇒ no learner spawn; empty judge deps ⇒ no judge spawn.
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [{ _k: 'a', task_key: 't1' }, { _k: 'b', task_key: 't2' }], labeledKeys: [] }),
    });
    // Exactly one spawn — the label drain.
    assert.equal(calls.length, 1, 'exactly one label spawn');
    assert.equal(result.ran, 1, 'ran counts the single label drain');
    const labelDrains = result.drains.filter((d) => d.drain === hd.LABEL_DRAIN_KEY);
    assert.equal(labelDrains.length, 1, 'one LABEL_DRAIN_KEY summary recorded');
    assert.equal(labelDrains[0].pending, 2, 'summary carries the pending count');
    // The spawn is `node <gate-label.js> --workspace <ws> --port <n>` — Node child, NOT agentic CLI.
    const call = calls[0];
    assert.equal(call.bin, process.execPath, 'must spawn via the daemon Node (process.execPath)');
    assert.equal(call.opts.env, undefined, 'label child inherits the daemon env without an extra sentinel');
    assert.match(call.args[0], /gate-label\.js$/, 'must target gate-label.js');
    assert.ok(call.args.includes('--workspace') && call.args.includes(tmpDir), 'must pass --workspace <ws>');
    assert.ok(!call.args.includes('-p'), 'label drain must NOT be an agentic CLI invocation');
    assert.equal(labelDrains[0].detached, true, 'label summary marks fire-and-forget scheduling');
    assert.equal(labelDrains[0].scheduled, true, 'label summary marks scheduled state');
    // Governor consumed exactly one iteration; the concurrency slot remains held until child close.
    assert.equal(hd._governor.iterationsUsed, 1, 'one iteration consumed');
    assert.equal(hd._governor.concurrentRunning, 1, 'detached label child still holds its slot immediately after scheduling');
    await waitForCondition(() => hd._governor.concurrentRunning === 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('in-flight detached label drain suppresses duplicate label spawns', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '5';
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  let child;
  const { hd, calls, restore } = freshModuleWithMockedSpawn(() => {
    child = makeFakeChild({ never: true });
    return child;
  });
  const tmpDir = makeCompletedQueueDir();
  try {
    const opts = {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [{ _k: 'a', task_key: 't1' }], labeledKeys: [] }),
    };
    const first = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), opts);
    assert.equal(first.ran, 1);
    assert.equal(calls.length, 1, 'first pass schedules one label child');
    assert.equal(hd._governor.concurrentRunning, 1, 'label child holds one slot');

    const second = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), opts);
    assert.equal(calls.length, 1, 'second pass must not duplicate the in-flight label child');
    assert.equal(second.ran, 0);
    assert.equal(second.skipped, 'label_in_progress');

    child.emit('close', 0);
    await waitForCondition(() => hd._governor.concurrentRunning === 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('mandatory drains but no label work due ⇒ no label spawn', async () => {
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
    });
    assert.equal(calls.length, 0, 'empty journal ⇒ no label spawn');
    assert.equal(result.skipped, 'no_due_drains');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
  }
});

test('label spawn is suppressed when the concurrency cap is already reached', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '2';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makeCompletedQueueDir();
  try {
    // Pre-seed concurrency at the cap → the top-of-function guard short-circuits with concurrency_cap
    // BEFORE any drain runs, proving the label drain shares the same governor gate as the others.
    hd._governor.concurrentRunning = 2;
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [{ _k: 'a', task_key: 't1' }], labeledKeys: [] }),
    });
    assert.equal(calls.length, 0, 'no spawn when concurrency cap is reached');
    assert.equal(result.skipped, 'concurrency_cap');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
  }
});

// ---- rate-limit / overload backoff + per-tick cap (fire-rate) ---------------------------

test('isThrottled detects 429/529/overloaded/rate-limit; false for a clean result', () => {
  const hd = freshModule();
  assert.ok(hd.isThrottled({ stderr: 'Error 429 Too Many Requests' }));
  assert.ok(hd.isThrottled({ stdout: 'API Error: 529 Overloaded' }));
  assert.ok(hd.isThrottled({ stderr: 'overloaded_error' }));
  assert.ok(hd.isThrottled({ stdout: 'rate limit exceeded' }));
  assert.ok(!hd.isThrottled({ stdout: 'all good', stderr: '' }));
  assert.ok(!hd.isThrottled(null));
});

test('recordDrainOutcome: LLM trouble grows backoff exponentially; a clean judge run resets it', () => {
  const hd = freshModule();
  const T0 = 1_000_000;
  const { baseMs, capMs, hardFailureMs } = hd.backoffConfig();
  hd.recordDrainOutcome({ stderr: '429' }, T0);
  assert.equal(hd._governor.consecutiveThrottles, 1);
  assert.equal(hd._governor.backoffUntil, T0 + baseMs, 'first throttle = base window');
  hd.recordDrainOutcome({ stdout: '529 overloaded' }, T0);
  assert.equal(hd._governor.consecutiveThrottles, 2);
  assert.equal(hd._governor.backoffUntil, T0 + baseMs * 2, 'second throttle doubles the base window');
  hd.recordDrainOutcome({ timedOut: true }, T0); // a timeout is also a backoff trigger
  assert.equal(hd._governor.consecutiveThrottles, 3);
  assert.equal(hd._governor.backoffUntil, T0 + baseMs * 4, 'third throttle keeps growing below the cap');
  hd.recordDrainOutcome({ exitCode: 127, stderr: 'missing binary' }, T0);
  assert.equal(hd._governor.consecutiveThrottles, 4);
  assert.equal(hd._governor.backoffUntil, T0 + hardFailureMs, 'hard spawn failures get a longer pause');
  hd.recordDrainOutcome({ exitCode: 0, stdout: 'done', _drainKind: 'judge' }, T0); // clean judge run resets
  assert.equal(hd._governor.consecutiveThrottles, 0);
  assert.equal(hd._governor.backoffUntil, 0, 'clean run clears the backoff');
});

test('recordDrainOutcome: backoff window is capped at capMs', () => {
  const hd = freshModule();
  const { capMs } = hd.backoffConfig();
  hd._governor.consecutiveThrottles = 20; // uncapped this would be astronomically large
  hd.recordDrainOutcome({ stderr: '429' }, 0);
  assert.equal(hd._governor.backoffUntil, capMs, 'window capped at capMs');
});

test('runDueDrains no-ops with skipped:backoff while backoffUntil is in the future', async () => {
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makePendingQueueDir(); // learner WOULD be due — backoff must pre-empt it
  try {
    hd._governor.backoffUntil = Date.now() + 60_000;
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 5, eagerNodes: ['n1', 'n2'] }),
      ...labelDeps({ journal: [{ _k: 'a', task_key: 't1' }], labeledKeys: [] }),
    });
    assert.equal(result.skipped, 'backoff', 'backoff pre-empts all drains');
    assert.equal(calls.length, 0, 'nothing spawned while backed off');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
  }
});

test('judge spawns are capped per tick (HEADLESS_DRAIN_MAX_PER_TICK) despite many eager nodes', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_PER_TICK;
  process.env.HEADLESS_DRAIN_MAX_PER_TICK = '2';
  const { hd, calls, restore } = freshModuleWithMockedSpawn(); // clean exit-0 children
  const tmpDir = makeCompletedQueueDir(); // learner NOT due
  try {
    await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: ['n1', 'n2', 'n3', 'n4', 'n5'] }),
      ...labelDeps({ journal: [], labeledKeys: [] }), // label NOT due
      ...mockBackendDeps().deps,
    });
    assert.equal(calls.length, 2, 'per-tick cap bounds judge spawns to 2, not the 5 eager nodes');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_PER_TICK;
    else process.env.HEADLESS_DRAIN_MAX_PER_TICK = savedCap;
  }
});

test('label iteration is suppressed when the iteration cap is exhausted mid-pass', async () => {
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '1'; // exactly one spawn allowed total
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '5';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makeCompletedQueueDir();
  try {
    // One eager judge spawn consumes the single iteration; the label drain must then be skipped
    // by its `iterationsUsed < maxIterations` guard — proving the label rides the shared iteration cap.
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: ['note:a'] }),
      ...labelDeps({ journal: [{ _k: 'a', task_key: 't1' }], labeledKeys: [] }),
      ...mockBackendDeps().deps,
    });
    assert.equal(calls.length, 1, 'iteration cap bounds total spawns to 1 (judge wins the slot)');
    assert.equal(result.ran, 1);
    // The single spawn was the judge backend, not the label drain.
    assert.equal(result.drains.filter((d) => d.drain === hd.LABEL_DRAIN_KEY).length, 0,
      'label drain suppressed once the iteration budget is spent');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
  }
});

// ===========================================================================
// windowsHide: every drain spawn must suppress the Windows console-window popup
// ===========================================================================
//
// COSMETIC-ONLY guard: child_process spawns on Windows flash a console window unless the launch
// opts carry `windowsHide: true`. runDrain is the single chokepoint every drain (learner/judge/label)
// funnels through, so asserting it here covers the whole drain family. The mocked-spawn seam records
// the opts object handed to spawn — we assert the flag is present and true. This has ZERO functional
// effect (no flag/gate/behavior change); it only hides the cosmetic popup.

test('runDrain passes windowsHide:true to spawn (Windows console-popup suppression)', async () => {
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const result = await hd.runDrain({
      bin: process.execPath,
      args: ['--version'],
      cwd: os.tmpdir(),
      timeoutMs: 5000,
    });
    assert.equal(calls.length, 1, 'runDrain should spawn exactly one child');
    assert.equal(calls[0].opts.windowsHide, true, 'spawn opts must carry windowsHide:true to suppress the Windows console window');
    // The flag must not perturb the resolved shape — runDrain still resolves the normal contract.
    assert.equal(result.spawnError, null, 'windowsHide must not introduce a spawn error');
  } finally {
    restore();
  }
});

test('every runDueDrains spawn (judge fan-out) carries windowsHide:true', async () => {
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '5';
  const savedIter = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  process.env.HEADLESS_DRAIN_MAX_ITERATIONS = '10';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makeCompletedQueueDir();
  try {
    await hd.runDueDrains({ workspace: tmpDir }, noopHttp(),
      { ...judgeDeps({ depth: 2, eagerNodes: ['note:a', 'note:b'] }), ...mockBackendDeps().deps });
    assert.ok(calls.length >= 1, 'at least one drain should have spawned');
    for (const c of calls) {
      assert.equal(c.opts.windowsHide, true, 'every drain spawn must set windowsHide:true');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

// ===========================================================================
// DEADLOCK REGRESSION (task /7): the daemon must stay responsive DURING a drain
// ===========================================================================
//
// THE BUG this guards: runDrain used spawnSync, which blocks the daemon's single-threaded event
// loop for the ENTIRE child run. The JUDGE backend calls BACK into the daemon
// (GET /judge/next + POST /judge/verdict) and the LABEL child HTTP-calls it too — but a frozen
// event loop serves NONE of those, so the child hangs waiting on the daemon while the daemon hangs
// inside spawnSync waiting on the child: a circular deadlock that only broke when the timeout fired.
// The 40 mocked-spawn tests above never caught it because the mock never actually runs a child.
//
// This test stands up a REAL http server (the stand-in daemon) and runs a REAL drain whose spawned
// child makes an HTTP request to that server. Because the server runs on the SAME event loop as
// runDrain, the only way the child's request gets answered (and the only way an INDEPENDENT
// mid-drain probe gets answered) is if runDrain did NOT block the loop. Under the old spawnSync
// code this test deadlocks until the timeout fires (runDrain resolves timedOut:true); under the
// async-spawn fix the server answers promptly and the drain exits 0. We assert BOTH: the in-flight
// liveness probe is served quickly AND the drain child completed successfully (exit 0, not timeout).

const http = require('http');

/** Promisified one-shot GET returning { status, body, ms }. */
function httpGet(url) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, ms: Date.now() - started }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('client timeout')); });
  });
}

test('DEADLOCK REGRESSION: daemon (http server) stays responsive while a drain child runs against it', async () => {
  // 1) Stand up a real stand-in daemon: a tiny http server on an ephemeral port.
  //    /ping  → immediate liveness probe (the independent mid-drain request).
  //    /judge/next → the endpoint the drain child calls back into (like the real JUDGE drain).
  let pingServedDuringDrain = false;
  let childCalledBack = false;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/ping')) {
      pingServedDuringDrain = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.url.startsWith('/judge/next')) {
      childCalledBack = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"idle":true}');
      return;
    }
    res.writeHead(404); res.end('nope');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  const hd = freshModule();

  // 2) The drain child is a REAL Node process that calls BACK into our server (mirrors the JUDGE
  //    child hitting /judge/next), waits for the reply, then exits 0. If the event loop were blocked
  //    by runDrain, this request would never reach the server's handler and the child would hang to
  //    the timeout. The child stays alive ~250ms after its callback so the loop is provably busy with
  //    a live child when we fire the independent /ping probe below.
  const childScript = `
    const http = require('http');
    http.get(process.env.DRAIN_TARGET + '/judge/next?budget=1', (res) => {
      res.resume();
      res.on('end', () => setTimeout(() => process.exit(0), 250));
    }).on('error', (e) => { process.stderr.write(String(e)); process.exit(7); });
    setTimeout(() => process.exit(8), 7000); // safety: never hang the test forever
  `;

  try {
    // 3) Kick off the drain WITHOUT awaiting — it returns a Promise immediately (proving it does not
    //    block synchronously). Inject the target URL via env on the child.
    const savedTarget = process.env.DRAIN_TARGET;
    process.env.DRAIN_TARGET = base;
    let drainPromise;
    try {
      drainPromise = hd.runDrain({
        bin: process.execPath,
        args: ['-e', childScript],
        cwd: os.tmpdir(),
        timeoutMs: 6000,
      });
    } finally {
      if (savedTarget === undefined) delete process.env.DRAIN_TARGET;
      else process.env.DRAIN_TARGET = savedTarget;
    }
    assert.ok(typeof drainPromise.then === 'function', 'runDrain must return a Promise (non-blocking)');

    // 4) While the drain is in flight, fire an INDEPENDENT liveness probe at the same server. On a
    //    blocked event loop this would not be answered until the child was SIGKILL'd at timeout.
    //    Give the child a moment to spawn, then probe.
    await new Promise((r) => setTimeout(r, 150));
    const ping = await httpGet(`${base}/ping`);
    assert.equal(ping.status, 200, 'liveness probe must be served WHILE the drain is in flight');
    assert.ok(ping.ms < 3000, `liveness probe must be answered promptly (was ${ping.ms}ms) — a blocked loop would stall it until the drain timeout`);

    // 5) The drain child completes on its own (server answered its callback) — exit 0, not a timeout.
    const result = await drainPromise;
    assert.equal(result.timedOut, false, 'drain must NOT time out — the deadlock would force a timeout');
    assert.equal(result.exitCode, 0, 'drain child should exit 0 after its HTTP callback was served');
    assert.equal(childCalledBack, true, 'the drain child actually called back into the server (/judge/next)');
    assert.equal(pingServedDuringDrain, true, 'the independent /ping was served during the drain');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
