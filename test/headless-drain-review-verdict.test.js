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
    // The embed sidecar (lib/embed-server.js) spawns on overlay/embed module load since the
    // code-node-embed-enrich work — it is not a drain child, and recording it fails every
    // "no spawn" assertion for a process unrelated to the drains. Give it a fake child
    // (embed() is null-safe when the sidecar never answers) and keep it out of `calls`.
    if (Array.isArray(args) && args.some((a) => String(a).includes('embed-server.js'))) {
      return makeFakeChild();
    }
    calls.push({ bin, args, opts });
    return stub ? stub(bin, args, opts) : makeFakeChild({
      stdout: '{"verdict":"APPROVE","reason":"mock reviewer approved"}',
    });
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

function makePendingLearnerWorkspace() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-rv-priority-'));
  const queueDir = path.join(workspace, '.graph', 'onboard');
  fs.mkdirSync(queueDir, { recursive: true });
  fs.writeFileSync(path.join(queueDir, 'onboard-queue.json'), JSON.stringify({
    total: 2,
    cursor: 0,
    kept: [],
    rejected: [],
    pending: [{ title: 'candidate-a' }, { title: 'candidate-b' }],
  }));
  return workspace;
}

/** runDueDrains options wiring one review-verdict overlay + idle everything else. */
function reviewRunOptions(o, overlayStore, backend) {
  return {
    ...idleJudgeDeps(),
    ...idleLabelDeps(),
    ...backend.deps,
    reviewVerdictDeps: {
      overlay: o,
      overlayStore,
      overlaySave: () => {},
      call: async (method, route) => {
        if (method === 'GET' && route.startsWith('/task/detail')) return { task: { label: 'Mock task' } };
        if (method === 'GET' && route.startsWith('/attempt/diff')) return { stat: '1 file changed', diff: '+mock change' };
        return { ok: true, lifecycle_refused: [] };
      },
    },
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

test('findReviewVerdictCandidates accepts a native reviewed attempt hidden by judging readiness', () => {
  const hd = freshModule();
  const { o, overlayStore } = pendingReviewOverlay('t/native');
  delete o.status['t/native'];
  o.git['t/native'] = {
    branch: 'orch/attempt/t-native',
    worktree: '/worktrees/t-native',
    head: 'abc123',
  };
  const graph = {
    tasks: [{
      id: 't/native',
      status: 'not_ready',
      kind: 'task',
      deps: [],
      readiness: { kind: 'judging_hold' },
      git: { target: { target_repo: '/repo/from-native-task' } },
    }],
  };

  assert.deepEqual(
    hd.findReviewVerdictCandidates('/irrelevant', { overlay: o, overlayStore, graph }),
    [{
      key: 't/native',
      repo_path: '/repo/from-native-task',
      attempt_branch: 'orch/attempt/t-native',
      attempt_worktree: '/worktrees/t-native',
    }]
  );
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

test('buildReviewVerdictPrompt embeds bounded inputs and requires one JSON verdict', () => {
  const hd = freshModule();
  const { prompt } = hd.buildReviewVerdictPrompt({
    key: 'feat/x 1',
    detail: { task: { label: 'Feature X', summary: 'worker summary' } },
    diff: { stat: '1 file changed', diff: '+safe change' },
  });
  assert.match(prompt, /Feature X/, 'task context is embedded by the daemon');
  assert.match(prompt, /worker summary/, 'worker summary is embedded');
  assert.match(prompt, /\+safe change/, 'attempt diff is embedded');
  assert.match(prompt, /correctness/, 'rubric: correctness');
  assert.match(prompt, /scope discipline/, 'rubric: scope discipline');
  assert.match(prompt, /dead\/redundant code/, 'rubric: dead/redundant code');
  assert.match(prompt, /test presence\/quality/, 'rubric: tests');
  assert.match(prompt, /style/, 'rubric: style');
  assert.match(prompt, /"verdict":"APPROVE"/, 'APPROVE output shape present');
  assert.match(prompt, /"verdict":"KICK_BACK"/, 'KICK_BACK output shape present');
  assert.match(prompt, /daemon validates and applies/, 'the child never mutates lifecycle state');
  assert.match(prompt, /NEVER post, merge/, 'reviewer must never post or merge');
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
    assert.match(prompt, /\+mock change/, 'prompt carries the daemon-fetched attempt diff');
    assert.match(prompt, /NEVER post, merge/, 'prompt forbids posting or merging');
    assert.ok(calls[0].args.includes('--backend-id'), 'provider-owned argv, not a hardcoded claude path');
    assert.ok(o.reviewVerdictLease && o.reviewVerdictLease['t/auto'], 'candidate was leased before spawning');
  } finally {
    restore();
  }
});

test('cli reviewer JSON is validated and applied by the daemon-owned verdict call', async () => {
  const backend = mockBackendDeps();
  const { hd, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({
    stdout: '{"verdict":"APPROVE","reason":"focused diff and tests are sound"}',
  }));
  const verdictCalls = [];
  try {
    const { o, overlayStore } = pendingReviewOverlay('t/daemon-submit', { automode: true });
    const options = reviewRunOptions(o, overlayStore, backend);
    options.reviewVerdictDeps.call = async (method, route, body) => {
      verdictCalls.push({ method, route, body });
      if (method === 'GET' && route.startsWith('/task/detail')) return { task: { label: 'Reviewed task' } };
      if (method === 'GET' && route.startsWith('/attempt/diff')) return { stat: '1 file changed', diff: '+safe change' };
      return { ok: true, lifecycle_refused: [] };
    };

    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), options);
    const submitted = verdictCalls.find((call) => call.method === 'POST' && call.route === '/overlay/status');
    assert.ok(submitted, 'daemon applies the parsed verdict itself');
    assert.equal(submitted.body.lifecycle_event, 'review_approve');
    assert.equal(submitted.body.review_reason, 'focused diff and tests are sound');
    assert.equal(result.drains.find((d) => d.drain === hd.REVIEW_VERDICT_DRAIN_KEY).verdict, 'APPROVE');
  } finally {
    restore();
  }
});

test('cli reviewer resolves a persisted graph target and can kick back an empty attempt diff', async () => {
  const backend = mockBackendDeps();
  const { hd, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({
    stdout: '{"verdict":"KICK_BACK","reason":"attempt branch matches its base"}',
  }));
  const verdictCalls = [];
  try {
    const { o, overlayStore } = pendingReviewOverlay('t/empty-diff', { automode: true });
    const options = reviewRunOptions(o, overlayStore, backend);
    options.reviewVerdictDeps.call = async (method, route, body) => {
      verdictCalls.push({ method, route, body });
      if (method === 'GET' && route.startsWith('/task/detail')) {
        return { task: { label: 'No-op attempt', git: { target: { target_repo: '/repo/from-detail' } } } };
      }
      if (method === 'GET' && route.startsWith('/attempt/diff')) return { stat: '', diff: '' };
      return { ok: true, lifecycle_refused: [] };
    };

    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), options);
    const diffCall = verdictCalls.find((call) => call.method === 'GET' && call.route.startsWith('/attempt/diff'));
    const submitted = verdictCalls.find((call) => call.method === 'POST');
    assert.match(diffCall.route, /target_repo=%2Frepo%2Ffrom-detail/, 'the persisted task target scopes the diff read');
    assert.equal(submitted.body.lifecycle_event, 'review_kick_back');
    assert.equal(result.drains.find((d) => d.drain === hd.REVIEW_VERDICT_DRAIN_KEY).verdict, 'KICK_BACK');
  } finally {
    restore();
  }
});

test('cli reviewer exit zero without a verdict fails into bounded backoff without posting', async () => {
  const backend = mockBackendDeps();
  const { hd, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({
    stdout: 'review was inconclusive',
  }));
  const verdictCalls = [];
  try {
    const { o, overlayStore } = pendingReviewOverlay('t/no-verdict', { automode: true });
    const options = reviewRunOptions(o, overlayStore, backend);
    options.reviewVerdictDeps.call = async (method, route, body) => {
      verdictCalls.push({ method, route, body });
      if (method === 'GET' && route.startsWith('/task/detail')) return { task: { label: 'Inconclusive task' } };
      if (method === 'GET' && route.startsWith('/attempt/diff')) return { stat: '1 file changed', diff: '+uncertain change' };
      return { ok: true, lifecycle_refused: [] };
    };

    const before = Date.now();
    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), options);
    const review = result.drains.find((d) => d.drain === hd.REVIEW_VERDICT_DRAIN_KEY);
    assert.equal(review.exitCode, 1, 'a clean child exit is not success without a verdict');
    assert.equal(verdictCalls.some((call) => call.method === 'POST'), false, 'inconclusive output cannot mutate lifecycle state');
    assert.ok(hd._governor.backoffUntil > before, 'the failure creates bounded provider backoff');
  } finally {
    restore();
  }
});

test('daemon lifecycle refusal makes the cli review drain fail instead of reporting false success', async () => {
  const backend = mockBackendDeps();
  const { hd, restore } = freshModuleWithMockedSpawn(() => makeFakeChild({
    stdout: '{"verdict":"APPROVE","reason":"looks sound"}',
  }));
  try {
    const { o, overlayStore } = pendingReviewOverlay('t/refused', { automode: true });
    const options = reviewRunOptions(o, overlayStore, backend);
    options.reviewVerdictDeps.call = async (method, route) => {
      if (method === 'GET' && route.startsWith('/task/detail')) return { task: { label: 'Already settled task' } };
      if (method === 'GET' && route.startsWith('/attempt/diff')) return { stat: '1 file changed', diff: '+late change' };
      return {
        ok: true,
        lifecycle_refused: [{ event: 'review_approve', code: 'already_merged', reason: 'Attempt already merged.' }],
      };
    };

    const result = await hd.runDueDrains({ workspace: os.tmpdir() }, noopHttp(), options);
    const review = result.drains.find((d) => d.drain === hd.REVIEW_VERDICT_DRAIN_KEY);
    assert.equal(review.exitCode, 1, 'a refused lifecycle transition is a failed drain');
    assert.equal(review.verdict, undefined, 'a refused verdict is not reported as applied');
  } finally {
    restore();
  }
});

test('pending task review runs before a failing learner can create global backoff', async () => {
  const backend = mockBackendDeps();
  const workspace = makePendingLearnerWorkspace();
  const { hd, calls, restore } = freshModuleWithMockedSpawn((_bin, args) => {
    const learner = Array.isArray(args) && args.some((arg) => String(arg).includes('onboard-learn.js'));
    return makeFakeChild(learner
      ? { code: 1, stderr: 'structural learner failure' }
      : { code: 0, stdout: '{"verdict":"APPROVE","reason":"priority review passed"}' });
  });
  try {
    const { o, overlayStore } = pendingReviewOverlay('t/priority', { automode: true });
    const result = await hd.runDueDrains(
      { workspace },
      noopHttp(),
      reviewRunOptions(o, overlayStore, backend)
    );
    const reviewIndex = calls.findIndex((call) => call.bin === backend.bin);
    const learnerIndex = calls.findIndex((call) => call.args.some((arg) => String(arg).includes('onboard-learn.js')));

    assert.ok(reviewIndex >= 0, 'pending task review must launch despite unrelated learner failure');
    assert.ok(learnerIndex >= 0, 'learner remains eligible after the priority review');
    assert.ok(reviewIndex < learnerIndex, 'review claims the provider before deferrable onboarding work');
    assert.equal(result.drains.some((d) => d.drain === hd.REVIEW_VERDICT_DRAIN_KEY), true);
  } finally {
    restore();
    fs.rmSync(workspace, { recursive: true, force: true });
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
