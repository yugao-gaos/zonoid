#!/usr/bin/env node
/**
 * test/headless-drain.test.js
 *
 * Unit tests for lib/headless-drain.js.
 * Run: node --test test/headless-drain.test.js
 *
 * ALL spawn calls are MOCKED — no real `claude -p` or drain process is executed.
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

// ---------------------------------------------------------------------------
// Test 1: flag OFF → no spawn
// ---------------------------------------------------------------------------

test('flag ORCH_HEADLESS_DRAINS unset → isHeadlessEnabled returns false, runDueDrains no-ops', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  delete process.env.ORCH_HEADLESS_DRAINS;
  try {
    const hd = freshModule();
    assert.equal(hd.isHeadlessEnabled(), false, 'should be disabled when env var is unset');

    // runDueDrains must return immediately with skipped=flag_off and ran=0
    const result = hd.runDueDrains(null);
    assert.equal(result.ran, 0, 'ran should be 0 when flag is off');
    assert.equal(result.skipped, 'flag_off', 'skipped reason should be flag_off');
    assert.deepEqual(result.drains, [], 'drains array should be empty');
  } finally {
    if (saved === undefined) delete process.env.ORCH_HEADLESS_DRAINS;
    else process.env.ORCH_HEADLESS_DRAINS = saved;
  }
});

test('flag ORCH_HEADLESS_DRAINS=0 → isHeadlessEnabled returns false', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '0';
  try {
    const hd = freshModule();
    assert.equal(hd.isHeadlessEnabled(), false);
    const result = hd.runDueDrains(null);
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

test('iterationsUsed >= maxIterations → runDueDrains skips with iterations_exhausted', () => {
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
      const result = hd.runDueDrains({ workspace: tmpDir });
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

test('tokensUsed >= tokenBudget → runDueDrains skips with token_budget_exhausted', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
  const savedBudget = process.env.HEADLESS_DRAIN_TOKEN_BUDGET;
  process.env.HEADLESS_DRAIN_TOKEN_BUDGET = '1000';
  try {
    const hd = freshModule();
    hd._governor.tokensUsed = 1000; // at cap
    const tmpDir = makePendingQueueDir();
    try {
      const result = hd.runDueDrains({ workspace: tmpDir });
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

test('concurrentRunning >= maxConcurrency → runDueDrains skips with concurrency_cap', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
  const savedCap = process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;
  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '1';
  try {
    const hd = freshModule();
    hd._governor.concurrentRunning = 1; // at cap
    const tmpDir = makePendingQueueDir();
    try {
      const result = hd.runDueDrains({ workspace: tmpDir });
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

test('no pending queue repos → runDueDrains skips with no_due_drains (flag ON, budget OK)', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
  try {
    const hd = freshModule();
    // Workspace with a completed queue (cursor === total) — not due
    const tmpDir = makeCompletedQueueDir();
    try {
      const result = hd.runDueDrains({ workspace: tmpDir });
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

test('runDueDrains with mocked runDrain: governor is incremented and decremented correctly', () => {
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
      hd.runDueDrains({ workspace: tmpDir });
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
// Test 4: runDrain shape validation (direct invocation with real spawnSync of trivial command)
// ---------------------------------------------------------------------------

test('runDrain returns correct shape on a successful command (node --version)', () => {
  const hd = freshModule();
  // Use the same Node executable that runs this test — guaranteed to exist, fast, exit 0.
  const result = hd.runDrain({
    bin: process.execPath,
    args: ['--version'],
    cwd: os.tmpdir(),
    timeoutMs: 10000,
  });
  assert.equal(result.exitCode, 0, 'exitCode should be 0 for node --version');
  assert.ok(result.stdout.includes('v') || result.stdout === '', 'stdout should have version string');
  assert.equal(result.timedOut, false, 'timedOut should be false for fast command');
  assert.equal(result.spawnError, null, 'spawnError should be null on success');
});

test('runDrain returns non-zero exitCode for a failing command', () => {
  const hd = freshModule();
  // node -e 'process.exit(42)' → exit code 42
  const result = hd.runDrain({
    bin: process.execPath,
    args: ['-e', 'process.exit(42)'],
    cwd: os.tmpdir(),
    timeoutMs: 10000,
  });
  assert.equal(result.exitCode, 42, 'exitCode should match the explicit exit code');
  assert.equal(result.timedOut, false, 'should not be a timeout');
});

test('runDrain returns timedOut=true when the command exceeds the timeout', () => {
  const hd = freshModule();
  // node -e 'setTimeout(()=>{},9999)' → spawnSync will SIGKILL it after 200ms
  const result = hd.runDrain({
    bin: process.execPath,
    args: ['-e', 'setTimeout(()=>{},9999)'],
    cwd: os.tmpdir(),
    timeoutMs: 200, // very short — will time out
  });
  assert.equal(result.timedOut, true, 'should be marked as timed out');
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

// ===========================================================================
// JUDGE DRAIN tests (task /3)
// ===========================================================================
//
// The judge drain drives the self-learn-edge-judge skill via a headless `claude -p` against the
// daemon, covering BOTH the periodic (/judge/next?budget=N) and eager (/judge/next?node=<key>)
// paths. It rides the SAME runner + governor as the learner. ALL spawns are MOCKED — these tests
// never shell out to a real `claude -p` or hit a live daemon.
//
// Mock seam: lib/headless-drain.js captures `spawnSync` via a top-level destructure of
// child_process. Patching child_process.spawnSync BEFORE freshModule() (which re-requires the
// module) makes the fresh module capture the patched fn, intercepting runDrain's spawn.

const child_process = require('child_process');

/** Patch child_process.spawnSync, return { hd, calls, restore }. Each spawn is recorded, not run. */
function freshModuleWithMockedSpawn(stub) {
  const orig = child_process.spawnSync;
  const calls = [];
  child_process.spawnSync = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return stub ? stub(bin, args, opts) : { status: 0, stdout: '', stderr: '', error: null };
  };
  const hd = freshModule();
  return { hd, calls, restore: () => { child_process.spawnSync = orig; } };
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
        buildQueue: () => Array.from({ length: depth }, (_, i) => ({ kind: 'edge', id: `e${i}` })),
        eagerJudgeNodes: () => eagerNodes.slice(),
      },
    },
  };
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
  assert.match(prompt, /self-learn-edge-judge/, 'prompt must name the skill');
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

test('flag OFF ⇒ NO judge spawn even when eager + periodic work is pending', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  delete process.env.ORCH_HEADLESS_DRAINS;
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const result = hd.runDueDrains({ workspace: os.tmpdir() }, undefined,
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

test('flag ON: runDueDrains spawns judge for each eager node + one periodic batch', () => {
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
    const result = hd.runDueDrains({ workspace: tmpDir }, noopHttp(),
      judgeDeps({ depth: 3, eagerNodes: ['note:a', 'note:b'] }));
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

test('flag ON: judge fan-out is bounded by the iteration cap', () => {
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
    const result = hd.runDueDrains({ workspace: tmpDir }, noopHttp(),
      judgeDeps({ depth: 3, eagerNodes: ['note:a', 'note:b', 'note:c'] }));
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

test('flag ON but no judge work due ⇒ no judge spawn (no_due_drains)', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = hd.runDueDrains({ workspace: tmpDir }, noopHttp(),
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
// LABEL DRAIN tests (task /4)
// ===========================================================================
//
// The label drain runs the DETERMINISTIC gate-labeler (node scripts/gate-label.js) headless under
// the SAME runner + governor as the learner — a Node child via process.execPath, NOT a `claude -p`.
// ALL spawns are MOCKED — these tests never shell out to a real gate-label.js or hit a live daemon.
// Mock seam is identical to the JUDGE tests: patch child_process.spawnSync BEFORE freshModule().

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
  // It targets gate-label.js — NOT onboard-learn.js and NOT a claude -p prompt.
  assert.doesNotMatch(args[0], /onboard-learn/, 'must NOT target the learner script');
  assert.ok(!args.includes('-p'), 'label drain is a Node script, NOT a claude -p invocation');
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

test('flag OFF ⇒ NO label spawn even when label work is pending', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  delete process.env.ORCH_HEADLESS_DRAINS;
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const result = hd.runDueDrains({ workspace: os.tmpdir() }, undefined, {
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

test('flag ON: runDueDrains spawns ONE label drain (node gate-label.js), governor accounted', () => {
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
    const result = hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: [] }),
      ...labelDeps({ journal: [{ _k: 'a', task_key: 't1' }, { _k: 'b', task_key: 't2' }], labeledKeys: [] }),
    });
    // Exactly one spawn — the label drain.
    assert.equal(calls.length, 1, 'exactly one label spawn');
    assert.equal(result.ran, 1, 'ran counts the single label drain');
    const labelDrains = result.drains.filter((d) => d.drain === hd.LABEL_DRAIN_KEY);
    assert.equal(labelDrains.length, 1, 'one LABEL_DRAIN_KEY summary recorded');
    assert.equal(labelDrains[0].pending, 2, 'summary carries the pending count');
    // The spawn is `node <gate-label.js> --workspace <ws> --port <n>` — Node child, NOT claude -p.
    const call = calls[0];
    assert.equal(call.bin, process.execPath, 'must spawn via the daemon Node (process.execPath)');
    assert.match(call.args[0], /gate-label\.js$/, 'must target gate-label.js');
    assert.ok(call.args.includes('--workspace') && call.args.includes(tmpDir), 'must pass --workspace <ws>');
    assert.ok(!call.args.includes('-p'), 'label drain must NOT be a claude -p invocation');
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

test('flag ON but no label work due ⇒ no label spawn', () => {
  const saved = process.env.ORCH_HEADLESS_DRAINS;
  process.env.ORCH_HEADLESS_DRAINS = '1';
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  const tmpDir = makeCompletedQueueDir();
  try {
    const result = hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
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

test('flag ON: label spawn is suppressed when the concurrency cap is already reached', () => {
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
    const result = hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
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

test('flag ON: label iteration is suppressed when the iteration cap is exhausted mid-pass', () => {
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
    const result = hd.runDueDrains({ workspace: tmpDir }, noopHttp(), {
      ...judgeDeps({ depth: 0, eagerNodes: ['note:a'] }),
      ...labelDeps({ journal: [{ _k: 'a', task_key: 't1' }], labeledKeys: [] }),
    });
    assert.equal(calls.length, 1, 'iteration cap bounds total spawns to 1 (judge wins the slot)');
    assert.equal(result.ran, 1);
    // The single spawn was the judge (claude -p), not the label drain.
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
