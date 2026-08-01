#!/usr/bin/env node
/**
 * test/headless-drain-review-verdict.test.js
 *
 * Unit tests for the REVIEW-VERDICT drain in lib/headless-drain.js — the daemon-owned headless
 * code reviewer for tested attempts awaiting same-node review — plus the api review worker's
 * pure helpers (scripts/api-review-worker.js).
 * Run: node --test test/headless-drain-review-verdict.test.js
 *
 * ALL spawn calls are MOCKED — no real CLI, API, or drain process is executed. Mirrors the
 * review-merge/judge drain patterns in test/headless-drain.test.js.
 */
'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const child_process = require('child_process');

// ---------------------------------------------------------------------------
// Helpers (mirroring test/headless-drain.test.js)
// ---------------------------------------------------------------------------

/** Reset module cache so each test gets a fresh headless-drain module instance. */
function freshModule() {
  const key = require.resolve('../lib/headless-drain');
  delete require.cache[key];
  return require('../lib/headless-drain');
}

/** Fake spawn child that closes cleanly (or per opts) on the next tick. */
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

/** Patch child_process.spawn, return { hd, calls, restore }. */
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
      const res = { resume() {}, on(ev, fn) { if (ev === 'end') fn(); } };
      if (cb) cb(res);
      return { on() {}, write() {}, end() {} };
    },
  };
}

/** Stub judgeDeps so the judge drain sees no due work (keeps these tests review-only). */
function idleJudgeDeps() {
  return {
    judgeDeps: {
      overlayLoad: () => ({}),
      judgeLib: {
        judgeQueueDepth: () => 0,
        buildQueue: () => [],
        eagerJudgeNodes: () => [],
      },
    },
  };
}

/** Stub labelDeps so the label drain sees no due work. */
function idleLabelDeps() {
  return {
    labelDeps: {
      rowKey: (row) => row._k,
      journalPath: () => '/irrelevant/gate-journal.jsonl',
      labeledPath: () => '/irrelevant/gate-labeled.jsonl',
      readJsonl: () => [],
    },
  };
}

/** Mock backend provider (same shape as test/headless-drain.test.js mockBackendDeps). */
function mockBackendDeps({ id = 'mock-cli', kind = 'agentic-cli', available = true, authed = true, model = 'mock-model', bin = '/mock/bin/agent' } = {}) {
  const calls = { buildInvocation: 0 };
  const provider = {
    id,
    displayName: `Mock ${id}`,
    kind,
    isAvailable: () => available,
    isAuthed: () => authed,
    buildInvocation(opts = {}) {
      calls.buildInvocation++;
      const args = ['-p', opts.prompt, '--model', opts.model || model, '--backend-id', id];
      if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig);
      if (opts.addDir) args.push('--add-dir', opts.addDir);
      return { bin, args, env: { MOCK_ENV: '1' } };
    },
    callApi: async () => ({ text: '{"verdict":"APPROVE","reason":"n/a"}' }),
  };
  const backendLib = {
    getActiveBackend: () => ({ provider, providerId: id, model, config: { provider: id, model } }),
    getProvider: (q) => (q === id ? provider : null),
    listProviders: () => [provider],
  };
  return { deps: { backendDeps: { backendLib } }, provider, calls, bin, id };
}

/** Build an overlay holding ONE tested task awaiting same-node review (requested/review_pending). */
function pendingReviewOverlay(key, config = {}) {
  const overlayStore = require('../lib/overlay');
  const o = overlayStore.EMPTY();
  o.config = config;
  overlayStore.setStatus(o, key, 'tested');
  overlayStore.setReviewLifecycle(o, key, {
    review_state: 'requested',
    merge_state: 'review_pending',
    review_requested_by: 'dispatcher',
  });
  return { o, overlayStore };
}

/** runDueDrains options wiring one review-verdict overlay + idle everything else. */
function reviewRunOptions(o, overlayStore, backend) {
  return {
    ...idleJudgeDeps(),
    ...idleLabelDeps(),
    ...backend.deps,
    reviewVerdictDeps: { overlay: o, overlayStore, overlaySave: () => {} },
    reviewMergeDeps: { overlay: overlayStore.EMPTY(), overlayStore },
  };
}

let savedLeaseFile;
let leaseDir;

beforeEach(() => {
  savedLeaseFile = process.env.HEADLESS_DRAIN_LEASE_FILE;
  leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-rv-lease-'));
  process.env.HEADLESS_DRAIN_LEASE_FILE = path.join(leaseDir, 'leases.json');
});

afterEach(() => {
  if (savedLeaseFile === undefined) delete process.env.HEADLESS_DRAIN_LEASE_FILE;
  else process.env.HEADLESS_DRAIN_LEASE_FILE = savedLeaseFile;
  if (leaseDir) fs.rmSync(leaseDir, { recursive: true, force: true });
  leaseDir = null;
});

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

test('findReviewVerdictCandidates selects tested tasks with requested/pending review', () => {
  const hd = freshModule();
  const { o, overlayStore } = pendingReviewOverlay('t/requested');
  overlayStore.setStatus(o, 't/pending', 'tested');
  overlayStore.setReviewLifecycle(o, 't/pending', { review_state: 'pending', merge_state: 'review_pending' });
  o.repos = { 't/requested': '/repo/a' };
  const candidates = hd.findReviewVerdictCandidates('/irrelevant', { overlay: o, overlayStore });
  assert.deepEqual(candidates.map((c) => c.key).sort(), ['t/pending', 't/requested']);
  assert.equal(candidates.find((c) => c.key === 't/requested').repo_path, '/repo/a');
});

test('findReviewVerdictCandidates skips approved, landed, conflicted, and non-tested tasks', () => {
  const hd = freshModule();
  const overlayStore = require('../lib/overlay');
  const o = overlayStore.EMPTY();
  // Approved + pending merge — the review-merge drain's candidate, NOT ours.
  overlayStore.setStatus(o, 't/approved', 'tested');
  overlayStore.setReviewLifecycle(o, 't/approved', { review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending' });
  // Already merged/landed.
  overlayStore.setStatus(o, 't/landed', 'tested');
  overlayStore.setReviewLifecycle(o, 't/landed', { review_state: 'landed', review_verdict: 'APPROVE', merge_state: 'merged' });
  // Conflict — needs conflict resolution, not a verdict.
  overlayStore.setStatus(o, 't/conflict', 'tested');
  overlayStore.setReviewLifecycle(o, 't/conflict', { review_state: 'requested', merge_state: 'conflict' });
  // Review requested but the task is not tested yet (worker still running).
  overlayStore.setStatus(o, 't/in-progress', 'in_progress');
  overlayStore.setReviewLifecycle(o, 't/in-progress', { review_state: 'requested', merge_state: 'review_pending' });
  const candidates = hd.findReviewVerdictCandidates('/irrelevant', { overlay: o, overlayStore });
  assert.deepEqual(candidates, []);
});

// ---------------------------------------------------------------------------
// Lease exclusivity
// ---------------------------------------------------------------------------

test('review-verdict lease is exclusive until expiry and re-acquirable after', () => {
  const hd = freshModule();
  const overlayStore = require('../lib/overlay');
  const o = overlayStore.EMPTY();
  assert.equal(hd._acquireReviewVerdictLease(o, 't/x', 'owner-1', 60000), true, 'first acquire wins');
  assert.equal(hd._acquireReviewVerdictLease(o, 't/x', 'owner-2', 60000), false, 'live lease blocks a second owner');
  assert.equal(hd._hasLiveReviewVerdictLease(o, 't/x'), true);
  // Force-expire, then a new owner can take it.
  o.reviewVerdictLease['t/x'].leaseExpiry = Date.now() - 1;
  assert.equal(hd._hasLiveReviewVerdictLease(o, 't/x'), false);
  assert.equal(hd._acquireReviewVerdictLease(o, 't/x', 'owner-2', 60000), true, 'expired lease is re-acquirable');
  assert.equal(hd._clearReviewVerdictLease(o, 't/x'), true);
  assert.equal(hd._hasLiveReviewVerdictLease(o, 't/x'), false);
});

test('findReviewVerdictCandidates skips tasks with a live review lease', () => {
  const hd = freshModule();
  const { o, overlayStore } = pendingReviewOverlay('t/leased');
  hd._acquireReviewVerdictLease(o, 't/leased', 'other-drain', 60000);
  assert.deepEqual(hd.findReviewVerdictCandidates('/irrelevant', { overlay: o, overlayStore }), []);
});

test('claimReviewVerdictWork leases candidates so a second claim gets nothing', () => {
  const hd = freshModule();
  const { o, overlayStore } = pendingReviewOverlay('t/claim');
  const deps = { overlay: o, overlayStore, overlaySave: () => {} };
  const first = hd.claimReviewVerdictWork('/irrelevant', deps, { leaseOwner: 'pass-1', leaseTtlMs: 60000 });
  assert.deepEqual(first.map((c) => c.key), ['t/claim']);
  const second = hd.claimReviewVerdictWork('/irrelevant', deps, { leaseOwner: 'pass-2', leaseTtlMs: 60000 });
  assert.deepEqual(second, [], 'concurrent pass must not double-review the leased task');
});

test('claimReviewVerdictWork honors maxCandidates', () => {
  const hd = freshModule();
  const { o, overlayStore } = pendingReviewOverlay('t/a');
  overlayStore.setStatus(o, 't/b', 'tested');
  overlayStore.setReviewLifecycle(o, 't/b', { review_state: 'requested', merge_state: 'review_pending' });
  const claimed = hd.claimReviewVerdictWork('/irrelevant', { overlay: o, overlayStore, overlaySave: () => {} }, { maxCandidates: 1 });
  assert.equal(claimed.length, 1, 'only one candidate may be claimed');
});

// ---------------------------------------------------------------------------
// Reviewer prompt shape
// ---------------------------------------------------------------------------

test('buildReviewVerdictPrompt carries diff endpoints, rubric, verdict bodies, and the never-merge rule', () => {
  const hd = freshModule();
  const { prompt } = hd.buildReviewVerdictPrompt({ key: 'feat/x 1', workspace: '/ws root', repoPath: '/repo/x' });
  assert.match(prompt, /\/task\/detail\?key=feat%2Fx%201/, 'must fetch task detail (encoded key)');
  assert.match(prompt, /\/attempt\/diff\?key=feat%2Fx%201/, 'must fetch the attempt diff');
  assert.match(prompt, /repo_path=%2Frepo%2Fx/, 'must forward the task repo to the diff route');
  assert.match(prompt, /correctness/, 'rubric: correctness');
  assert.match(prompt, /scope discipline/, 'rubric: scope discipline');
  assert.match(prompt, /dead\/redundant code/, 'rubric: dead/redundant code');
  assert.match(prompt, /test presence\/quality/, 'rubric: tests');
  assert.match(prompt, /style/, 'rubric: style');
  assert.match(prompt, /POST(ing)? JSON to .*\/overlay\/status/, 'verdict goes through the submit_verdict HTTP path');
  assert.match(prompt, /"review_verdict":"APPROVE"/, 'APPROVE body present');
  assert.match(prompt, /"merge_state":"pending"/, 'APPROVE records pending merge (review-merge drain lands it)');
  assert.match(prompt, /"review_verdict":"KICK_BACK"/, 'KICK_BACK body present');
  assert.match(prompt, /"status":"failed"/, 'KICK_BACK fails the implementation task');
  assert.match(prompt, /NEVER merge/, 'reviewer must never merge');
});

// ---------------------------------------------------------------------------
// Config gate (default OFF; automode OR headless_driver turns it on)
// ---------------------------------------------------------------------------

test('review-verdict drain does NOT run when automode and headless_driver are off', async () => {
  const backend = mockBackendDeps();
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const { o, overlayStore } = pendingReviewOverlay('t/gated', { automode: false });
    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), reviewRunOptions(o, overlayStore, backend));
    assert.equal(result.ran, 0, 'gate off ⇒ nothing runs');
    assert.equal(calls.length, 0, 'gate off ⇒ no reviewer spawned');
    assert.equal(o.reviewVerdictLease, undefined, 'gate off ⇒ no lease taken');
  } finally {
    restore();
  }
});

test('review-verdict drain runs under automode and spawns the cli reviewer', async () => {
  const backend = mockBackendDeps();
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const { o, overlayStore } = pendingReviewOverlay('t/auto', { automode: true });
    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), reviewRunOptions(o, overlayStore, backend));
    const reviews = result.drains.filter((d) => d.drain === hd.REVIEW_VERDICT_DRAIN_KEY);
    assert.equal(reviews.length, 1, 'one review-verdict run recorded');
    assert.equal(reviews[0].task, 't/auto');
    assert.equal(reviews[0].exitCode, 0);
    assert.equal(calls.length, 1, 'one reviewer child spawned');
    assert.equal(calls[0].bin, backend.bin, 'spawn is driven by the provider invocation');
    const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1];
    assert.match(prompt, /t\/auto/, 'prompt targets the candidate task');
    assert.match(prompt, /\/attempt\/diff/, 'prompt fetches the attempt diff');
    assert.match(prompt, /NEVER merge/, 'prompt forbids merging');
    assert.ok(calls[0].args.includes('--backend-id'), 'provider-owned argv, not a hardcoded claude path');
    assert.ok(o.reviewVerdictLease && o.reviewVerdictLease['t/auto'], 'candidate was leased before spawning');
  } finally {
    restore();
  }
});

test('review-verdict drain runs under headless_driver without automode', async () => {
  const backend = mockBackendDeps();
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const { o, overlayStore } = pendingReviewOverlay('t/driver', { automode: false, headless_driver: true });
    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), reviewRunOptions(o, overlayStore, backend));
    assert.equal(result.drains.filter((d) => d.drain === hd.REVIEW_VERDICT_DRAIN_KEY).length, 1);
    assert.equal(calls.length, 1);
  } finally {
    restore();
  }
});

test('review-verdict drain skips cleanly with no_backend when the backend is unusable', async () => {
  const backend = mockBackendDeps({ available: false });
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const { o, overlayStore } = pendingReviewOverlay('t/nobackend', { automode: true });
    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), reviewRunOptions(o, overlayStore, backend));
    assert.equal(result.ran, 0);
    assert.equal(result.skipped, 'no_backend', 'clean pause, not a crash');
    assert.equal(calls.length, 0, 'no spawn on a hard-blocked backend');
    assert.equal(o.reviewVerdictLease, undefined, 'no lease burned when nothing can run');
  } finally {
    restore();
  }
});

test('review-verdict drain routes an api backend through the api-review-worker child', async () => {
  const backend = mockBackendDeps({ id: 'mock-api', kind: 'api' });
  const { hd, calls, restore } = freshModuleWithMockedSpawn();
  try {
    const { o, overlayStore } = pendingReviewOverlay('t/api', { automode: true });
    o.repos = { 't/api': '/repo/api' };
    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), reviewRunOptions(o, overlayStore, backend));
    assert.equal(result.drains.filter((d) => d.drain === hd.REVIEW_VERDICT_DRAIN_KEY).length, 1);
    assert.equal(calls.length, 1, 'api kind spawns exactly one worker child');
    assert.equal(calls[0].bin, process.execPath, 'worker runs on the daemon\'s own node');
    assert.match(String(calls[0].args[0]), /api-review-worker\.js$/, 'worker script is the api review worker');
    const workerArgs = JSON.parse(calls[0].args[1]);
    assert.equal(workerArgs.provider, 'mock-api');
    assert.equal(workerArgs.key, 't/api');
    assert.equal(workerArgs.repo_path, '/repo/api');
    assert.match(String(workerArgs.rubric), /scope discipline/, 'the shared rubric rides the worker argv');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// api-review-worker pure helpers
// ---------------------------------------------------------------------------

test('api-review-worker parseVerdict prefers JSON verdicts and never invents one', () => {
  const worker = require('../scripts/api-review-worker');
  assert.deepEqual(
    worker.parseVerdict('noise {"verdict":"APPROVE","reason":"solid tests"} noise'),
    { verdict: 'APPROVE', reason: 'solid tests' }
  );
  assert.equal(worker.parseVerdict('I would KICK_BACK this change.').verdict, 'KICK_BACK');
  assert.equal(worker.parseVerdict('looks fine to me').verdict, null, 'inconclusive reply yields NO verdict');
  assert.equal(worker.parseVerdict('').verdict, null);
});

test('api-review-worker verdict bodies mirror the submit_verdict HTTP path', () => {
  const worker = require('../scripts/api-review-worker');
  const approve = worker.verdictStatusBody({ verdict: 'APPROVE', reason: 'ok', key: 't/1', workspace: '/ws' });
  assert.equal(approve.status, 'tested');
  assert.equal(approve.review.review_state, 'approved');
  assert.equal(approve.review.review_verdict, 'APPROVE');
  assert.equal(approve.review.merge_state, 'pending', 'APPROVE leaves the merge to the review-merge drain');
  const kick = worker.verdictStatusBody({ verdict: 'KICK_BACK', reason: 'missing tests', key: 't/1', workspace: '/ws' });
  assert.equal(kick.status, 'failed', 'KICK_BACK fails the implementation task for rework');
  assert.equal(kick.review.review_state, 'rejected');
  assert.equal(kick.review.merge_state, 'blocked');
});
