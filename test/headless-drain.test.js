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
  const queue = {
    total: opts.total ?? 10,
    cursor: opts.cursor ?? 3,
    kept: [],
    rejected: [],
    pending: [],
  };
  fs.writeFileSync(path.join(queueDir, 'onboard-queue.json'), JSON.stringify(queue));
  return tmpDir;
}

/** Create a temp dir with a completed queue (cursor === total). */
function makeCompletedQueueDir() {
  return makePendingQueueDir({ total: 10, cursor: 10 });
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
// Test 1: default ON; explicit opt-out → no spawn
// ---------------------------------------------------------------------------

test('flag ORCH_HEADLESS_DRAINS unset → isHeadlessEnabled returns true', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  delete process.env.ORCH_HEADLESS_DRAINS;
  try {
    const hd = freshModule();
    assert.equal(hd.isHeadlessEnabled(), true, 'should be enabled when env var is unset');

    // With no queue files and no judge/label work, runDueDrains is enabled but idle.
    const result = await hd.runDueDrains({ workspace: os.tmpdir() });
    assert.equal(result.ran, 0, 'ran should be 0 when no drains are due');
    assert.equal(result.skipped, 'no_due_drains', 'skipped reason should be no_due_drains');
    assert.deepEqual(result.drains, [], 'drains array should be empty');
  } finally {
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

test('flag ORCH_HEADLESS_DRAINS=0 → isHeadlessEnabled returns false', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '0';
  try {
    const hd = freshModule();
    assert.equal(hd.isHeadlessEnabled(), false);
    const result = await hd.runDueDrains(null);
    assert.equal(result.skipped, 'flag_off');
  } finally {
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

test('flag ORCH_HEADLESS_DRAINS=false → isHeadlessEnabled returns false', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = 'false';
  try {
    const hd = freshModule();
    assert.equal(hd.isHeadlessEnabled(), false);
  } finally {
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

test('flag ORCH_HEADLESS_DRAINS=no → isHeadlessEnabled returns false', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = 'no';
  try {
    const hd = freshModule();
    assert.equal(hd.isHeadlessEnabled(), false);
  } finally {
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

test('flag ORCH_HEADLESS_DRAINS=1 → isHeadlessEnabled returns true', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
  try {
    const hd = freshModule();
    assert.equal(hd.isHeadlessEnabled(), true);
  } finally {
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

// ---------------------------------------------------------------------------
// Test 2: budget/concurrency caps honored
// ---------------------------------------------------------------------------

test('iterationsUsed >= maxIterations → runDueDrains skips with iterations_exhausted', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedMax === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedMax;
  }
});

test('tokensUsed >= tokenBudget → runDueDrains skips with token_budget_exhausted', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedBudget === undefined) delete process.env.HEADLESS_DRAIN_TOKEN_BUDGET;
    else process.env.HEADLESS_DRAIN_TOKEN_BUDGET = savedBudget;
  }
});

test('concurrentRunning >= maxConcurrency → runDueDrains skips with concurrency_cap', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
  }
});

test('host-wide lease cap blocks drains across daemon processes', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('no pending queue repos → runDueDrains skips with no_due_drains (flag ON, budget OK)', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
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

test('runDueDrains with mocked runDrain: governor is incremented and decremented correctly', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedMaxIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedMaxIter;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
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

test('effectiveConfig defaults drain concurrency to 12', () => {
  const saved = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  try {
    const hd = freshModule();
    assert.equal(hd.effectiveConfig().maxConcurrency, 12);
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
    assert.equal(hd.backoffConfig().capMs, 5_000);
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

const child_process = require('child_process');
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
 * For an api-kind provider, `runJudgeLoop` is the IN-PROCESS judge seam: by default it records each
 * call (with the args it received) and resolves a clean drain-result shape (exit 0) WITHOUT spawning —
 * so a test can assert the drain used runJudgeLoop, not spawn. Pass `judgeLoopResult` to tailor the
 * resolved result (e.g. a throttle), or `judgeLoopThrows` to make it throw (proving the drain degrades
 * a misbehaving adapter to a clean failure rather than crashing).
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
    // api-kind IN-PROCESS judge seam. Records the call (proving NO spawn was used) and resolves a
    // drain-result-shaped object the drain consumes exactly like a spawn result.
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

// ---- flag OFF: no judge spawn even when judge work is pending ------------------------

test('explicit flag OFF ⇒ NO judge spawn even when eager + periodic work is pending', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '0';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, undefined,
      judgeDeps({ depth: 5, eagerNodes: ['note:x'] }));
    assert.equal(result.skipped, 'flag_off');
    assert.equal(calls.length, 0, 'flag off must spawn nothing');
  } finally {
    restore();
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

// ---- flag ON: judge spawns for both eager + periodic, governor accounted -------------

test('flag ON: runDueDrains spawns judge for each eager node + one periodic batch', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('flag ON: periodic judge backlog refills slots up to maxConcurrency until current backlog is drained', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedPerTick === undefined) delete process.env.HEADLESS_DRAIN_MAX_PER_TICK;
    else process.env.HEADLESS_DRAIN_MAX_PER_TICK = savedPerTick;
  }
});

test('flag ON: judge fan-out is bounded by the iteration cap', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
  }
});

test('flag ON but no judge work due ⇒ no judge spawn (no_due_drains)', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
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

test('resolveJudgeBackend: api-kind active backend (authed) ⇒ in-process api resolution, no invocation built', () => {
  const hd = freshModule();
  const mb = mockBackendDeps({ id: 'mock-api', kind: 'api', authed: true });
  const r = hd.resolveJudgeBackend({}, {}, mb.deps.backendDeps);
  assert.equal(r.skip, undefined, 'an authed api backend does NOT skip — it runs in-process');
  assert.equal(r.kind, 'api', 'resolution is marked api-kind so the drain calls runJudgeLoop, not spawn');
  assert.equal(r.providerId, 'mock-api');
  assert.equal(r.provider, mb.provider, 'carries the api provider for the in-process call');
  assert.equal(r.invocation, undefined, 'no spawnable invocation is built for an api backend');
  assert.equal(mb.calls.buildInvocation, 0, 'resolveJudgeBackend builds nothing for api');
  assert.equal(mb.calls.runJudgeLoop, 0, 'resolveJudgeBackend is pure — it does NOT call runJudgeLoop itself');
});

test('resolveJudgeBackend: api-kind active backend with NO key ⇒ skip:no_backend (hard-block, not crash)', () => {
  const hd = freshModule();
  const mb = mockBackendDeps({ id: 'mock-api', kind: 'api', authed: false });
  const r = hd.resolveJudgeBackend({}, {}, mb.deps.backendDeps);
  assert.equal(r.skip, 'no_backend', 'an unauthed api backend hard-blocks like an unusable CLI');
  assert.equal(mb.calls.runJudgeLoop, 0, 'no in-process call attempted when hard-blocked');
});

// ---- (c) the judge drain SPAWN is driven by the active provider's invocation ---------

test('flag ON: judge spawn argv is built by getActiveBackend().buildInvocation (mocked provider)', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    assert.equal(calls[0].opts.env.ZONOID_HEADLESS_DRAIN, '1', 'headless judge children suppress daemon autostart hooks');
    assert.ok(mb.calls.buildInvocation >= 1, 'provider.buildInvocation was invoked for the spawn');
    assert.equal(result.ran, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
  }
});

// ---- (d) HARD-BLOCK: no valid backend ⇒ judge no-ops with skipped:no_backend ----------

test('flag ON: judge due but NO valid backend ⇒ no spawn, skipped:no_backend (hard-block, not crash)', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

test('flag ON: hard-block judge does NOT suppress a due LABEL drain (label still runs)', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

// ---- (e) api-kind active backend ⇒ judge runs IN-PROCESS via runJudgeLoop, NO child process ----

test('flag ON: api-kind active backend ⇒ judge runs IN-PROCESS via runJudgeLoop, NO spawn', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    // THE NO-SPAWN GUARANTEE: spawn is never called for the api path. The judge ran IN-PROCESS.
    assert.equal(calls.length, 0, 'api backend must spawn NO child process (AV-clean path)');
    // 2 eager + 1 periodic = 3 in-process runJudgeLoop calls, all counted as drains.
    assert.equal(mb.calls.runJudgeLoop, 3, 'runJudgeLoop drove all 3 judge runs in-process');
    assert.equal(mb.calls.buildInvocation, 0, 'no spawnable invocation built for an api backend');
    assert.equal(result.ran, 3, 'in-process judge runs count as drains, same as spawns');
    assert.equal(result.drains.filter((d) => d.drain === hd.JUDGE_DRAIN_KEY).length, 3);
    assert.equal(result.skipped, null, 'judge ran ⇒ not skipped');
    // runJudgeLoop received the daemonUrl + the per-run node (eager) / null (periodic).
    const nodes = mb.calls.runJudgeLoopArgs.map((a) => a.node || null);
    assert.ok(mb.calls.runJudgeLoopArgs.every((a) => /^http:\/\//.test(a.daemonUrl)), 'each call carries the daemon URL');
    assert.ok(nodes.includes('note:a') && nodes.includes('note:b'), 'eager runs are node-scoped');
    assert.ok(nodes.includes(null), 'one periodic (node-less) run');
    // governor accounted the 3 in-process runs exactly like spawns; concurrency restored.
    assert.equal(hd._governor.iterationsUsed, 3, 'three iterations consumed by the in-process judge');
    assert.equal(hd._governor.concurrentRunning, 0, 'concurrency restored after the in-process runs');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('flag ON: api-kind backend with NO key ⇒ judge hard-blocks (skipped:no_backend), no spawn, no in-process call', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const mb = mockBackendDeps({ id: 'mock-api', kind: 'api', authed: false }); // no key ⇒ hard-block
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 3, eagerNodes: ['note:a'] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mb.deps,
    });
    assert.equal(calls.length, 0, 'no spawn (api path never spawns anyway)');
    assert.equal(mb.calls.runJudgeLoop, 0, 'unauthed api backend must NOT attempt the in-process call');
    assert.equal(result.skipped, 'no_backend', 'unauthed api backend hard-blocks rather than crashing');
    assert.equal(result.ran, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

test('flag ON: api runJudgeLoop that THROWS degrades to a clean failure drain (no crash), feeds backoff', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const mb = mockBackendDeps({ id: 'mock-api', kind: 'api', authed: true, judgeLoopThrows: true });
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: ['note:a'] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mb.deps,
    });
    assert.equal(calls.length, 0, 'still no spawn');
    assert.equal(mb.calls.runJudgeLoop, 1, 'the in-process call was attempted');
    // A throwing adapter does not crash the pass; the judge run is recorded as a failed drain.
    assert.equal(result.ran, 1, 'the run is still counted (as a failed drain)');
    const judge = result.drains.find((d) => d.drain === hd.JUDGE_DRAIN_KEY);
    assert.ok(judge && judge.exitCode === 1, 'a throwing runJudgeLoop becomes an exitCode:1 drain result');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

test('flag ON: api runJudgeLoop returning a throttle result feeds the backoff governor (recordDrainOutcome)', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  // runJudgeLoop resolves a throttle-shaped failure (stderr carries 429) — the SAME signal a spawned
  // child would print. recordDrainOutcome must fold it into the backoff window just like the spawn path.
  const mb = mockBackendDeps({
    id: 'mock-api', kind: 'api', authed: true,
    judgeLoopResult: { exitCode: 1, stdout: '', stderr: '429 rate limit / overloaded', timedOut: false, spawnError: null },
  });
  const tmpDir = makeCompletedQueueDir();
  try {
    assert.equal(hd._governor.backoffUntil, 0, 'no backoff before the run');
    await hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: ['note:a'] }),
      ...labelDeps({ journal: [], labeledKeys: [] }),
      ...mb.deps,
    });
    assert.equal(calls.length, 0, 'no spawn on the api path');
    assert.ok(hd._governor.backoffUntil > Date.now(), 'an api throttle set the backoff window (governor fed)');
    assert.equal(hd._governor.consecutiveThrottles, 1, 'one consecutive throttle recorded');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
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

// ---- flag OFF: no label spawn even when label work is pending ------------------------

test('explicit flag OFF ⇒ NO label spawn even when label work is pending', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '0';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, undefined, {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [{ _k: 'a', task_key: 't1' }], labeledKeys: [] }),
    });
    assert.equal(result.skipped, 'flag_off');
    assert.equal(calls.length, 0, 'flag off must spawn nothing (label included)');
  } finally {
    restore();
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

// ---- flag ON: label spawns ONE Node child targeting gate-label.js --------------------

test('flag ON: runDueDrains spawns ONE label drain (node gate-label.js), governor accounted', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    assert.match(call.args[0], /gate-label\.js$/, 'must target gate-label.js');
    assert.ok(call.args.includes('--workspace') && call.args.includes(tmpDir), 'must pass --workspace <ws>');
    assert.ok(!call.args.includes('-p'), 'label drain must NOT be an agentic CLI invocation');
    // governor consumed exactly one iteration, concurrency fully restored.
    assert.equal(hd._governor.iterationsUsed, 1, 'one iteration consumed');
    assert.equal(hd._governor.concurrentRunning, 0, 'concurrency restored after run');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    restore();
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
    else process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = savedCap;
    if (savedIter === undefined) delete process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
    else process.env.HEADLESS_DRAIN_MAX_ITERATIONS = savedIter;
  }
});

test('flag ON but no label work due ⇒ no label spawn', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

test('flag ON: label spawn is suppressed when the concurrency cap is already reached', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
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

test('recordDrainOutcome: a throttle sets a short fixed backoff; a clean run resets it', () => {
  const hd = freshModule();
  const T0 = 1_000_000;
  const { baseMs, capMs } = hd.backoffConfig();
  hd.recordDrainOutcome({ stderr: '429' }, T0);
  assert.equal(hd._governor.consecutiveThrottles, 1);
  assert.equal(hd._governor.backoffUntil, T0 + baseMs, 'first throttle = base window');
  hd.recordDrainOutcome({ stdout: '529 overloaded' }, T0);
  assert.equal(hd._governor.consecutiveThrottles, 2);
  assert.equal(hd._governor.backoffUntil, T0 + capMs, 'second throttle stays capped');
  hd.recordDrainOutcome({ timedOut: true }, T0); // a timeout is also a backoff trigger
  assert.equal(hd._governor.consecutiveThrottles, 3);
  assert.equal(hd._governor.backoffUntil, T0 + capMs);
  hd.recordDrainOutcome({ exitCode: 0, stdout: 'done' }, T0); // clean run resets
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

test('flag ON: runDueDrains no-ops with skipped:backoff while backoffUntil is in the future', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

test('flag ON: judge spawns are capped per tick (HEADLESS_DRAIN_MAX_PER_TICK) despite many eager nodes', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
    if (savedCap === undefined) delete process.env.HEADLESS_DRAIN_MAX_PER_TICK;
    else process.env.HEADLESS_DRAIN_MAX_PER_TICK = savedCap;
  }
});

test('flag ON: label iteration is suppressed when the iteration cap is exhausted mid-pass', async () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
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
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
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
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
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
// inside spawnSync waiting on the child: a circular deadlock that only broke at the 10-min timeout.
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
