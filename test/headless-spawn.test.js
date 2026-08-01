#!/usr/bin/env node
/**
 * test/headless-spawn.test.js
 *
 * Unit tests for lib/headless-spawn.js — the daemon-internal executor that dispatches headless
 * workers for managed graph-loop spawn decisions.
 * Run: node --test test/headless-spawn.test.js
 *
 * ALL seams are MOCKED — no real CLI child, daemon HTTP, or overlay file is touched. Each test
 * injects its own governor so shared headless-drain state never leaks between tests.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const headlessSpawn = require('../lib/headless-spawn');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WS = '/ws/a';

function mockProvider(overrides = {}) {
  return {
    id: 'mock',
    kind: 'agentic-cli',
    isAvailable: () => true,
    isAuthed: () => true,
    buildInvocation: ({ prompt }) => ({ bin: 'mock-bin', args: ['-p', prompt], env: null }),
    ...overrides,
  };
}

// Tiny overlayStore stand-in with the SAME acquireSpawnLease semantics as lib/overlay.js
// (fail on a live lease regardless of owner; acquire otherwise).
function mockOverlayStore() {
  return {
    acquireSpawnLease(overlay, taskKey, loopId, ttlMs) {
      if (!overlay.spawnLease) overlay.spawnLease = {};
      const ex = overlay.spawnLease[taskKey];
      if (ex && ex.leaseExpiry > Date.now()) return false;
      overlay.spawnLease[taskKey] = { leaseExpiry: Date.now() + (ttlMs || 60000), loopId: loopId || null };
      return true;
    },
    save() {},
  };
}

/**
 * Build a full mocked deps bundle + call log. Defaults model a single gated-on workspace with one
 * active managed graph loop ('m1') and a healthy agentic-cli backend.
 */
function makeFixture(opts = {}) {
  const loops = new Map();
  for (const L of opts.loops || [{ id: 'm1', active: true, managed: 'graph', session: null, workspace: WS }]) {
    loops.set(L.id, L);
  }
  const overlay = opts.overlay || { config: { headless_driver: true }, spawnLease: {}, status: {} };
  const calls = { decide: 0, prepare: [], runDrain: [], failed: [] };
  const governor = { iterationsUsed: 0, tokensUsed: 0, concurrentRunning: 0, backoffUntil: 0, consecutiveThrottles: 0 };
  const deps = {
    loops,
    decide: () => { calls.decide++; return opts.decisions || []; },
    overlayLoad: () => overlay,
    overlaySave: () => {},
    overlayStore: mockOverlayStore(),
    governor,
    acquireSlot: opts.acquireSlot || (() => ({ ok: true, release() {} })),
    resolveMcpConfig: () => null,
    recordOutcome: () => {},
    backendLib: opts.backendLib || { getActiveBackend: () => ({ provider: mockProvider(), providerId: 'mock', model: 'test-model' }) },
    prepareAssignment: async (a) => {
      calls.prepare.push(a);
      if (opts.prepareResult) return opts.prepareResult;
      return {
        ok: true,
        branch: `orch/attempt/${a.task_key.replace(/[^A-Za-z0-9._-]+/g, '-')}`,
        worktree: `/wt/${a.task_key.replace(/[^A-Za-z0-9._-]+/g, '-')}`,
        target_repo: '/repo',
        assignment: { context: { dependency_summaries: [{ key: 'dep/1', summary: 'dep one summary', via: 'context' }] } },
      };
    },
    completeFailed: async (a) => { calls.failed.push(a); return { ok: true }; },
    runDrain: async (spec) => {
      calls.runDrain.push(spec);
      return opts.drainResult || { exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };
    },
    effectiveConfig: () => ({ tokenBudget: 200000, maxIterations: 50, maxConcurrency: 2, timeoutMs: 1000 }),
  };
  return { deps, calls, overlay, governor, loops };
}

const spawnDecision = (tasks, loopId = 'm1') => [{ loopId, action: 'spawn', tasks }];

// ---------------------------------------------------------------------------
// Test 1: config gate off → no dispatch, decide never runs
// ---------------------------------------------------------------------------

test('headless_driver off (default) → no dispatch and no decide pass', async () => {
  const { deps, calls } = makeFixture({
    overlay: { config: {}, spawnLease: {}, status: {} },   // gate NOT set — the default
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'headless_driver_off');
  assert.equal(calls.decide, 0, 'gated-off executor must never tick decideAll');
  assert.equal(calls.runDrain.length, 0, 'gated-off executor must never spawn');
});

// ---------------------------------------------------------------------------
// Test 2: interactive session loop active → executor stands down entirely
// ---------------------------------------------------------------------------

test('active session-bound loop → interactive_driver_active, no decide, no dispatch', async () => {
  const { deps, calls } = makeFixture({
    loops: [
      { id: 'm1', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 's1', active: true, managed: null, session: 'sess-1', workspace: WS },
    ],
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'interactive_driver_active');
  assert.equal(calls.decide, 0, 'executor must not steal the interactive driver\'s decide pass');
  assert.equal(calls.runDrain.length, 0);
});

// ---------------------------------------------------------------------------
// Test 3: lease exclusivity — a foreign live lease skips the task
// ---------------------------------------------------------------------------

test('task with a live foreign spawn lease is skipped; own-lease task dispatches', async () => {
  const overlay = {
    config: { headless_driver: true },
    spawnLease: {
      't/1': { leaseExpiry: Date.now() + 60000, loopId: 'other-dispatcher' }, // foreign — skip
      't/2': { leaseExpiry: Date.now() + 60000, loopId: 'm1' },               // decideOne's own — run
    },
    status: {},
  };
  const { deps, calls } = makeFixture({
    overlay,
    decisions: spawnDecision([{ key: 't/1', label: 'one' }, { key: 't/2', label: 'two' }]),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1, 'only the own-lease task dispatches');
  assert.equal(calls.runDrain.length, 1);
  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.prepare[0].task_key, 't/2');
  assert.match(calls.prepare[0].agent_id, /^headless-worker-/, 'minted agent id must carry the headless-worker- prefix');
  assert.equal(calls.runDrain[0].cwd, '/wt/t-2', 'worker child cwd must be the attempt worktree');
  const skippedRow = result.drains.find((d) => d.task === 't/1');
  assert.equal(skippedRow && skippedRow.skipped, 'lease_held');
});

test('expired/missing lease is re-acquired under the deciding loop before dispatch', async () => {
  const overlay = { config: { headless_driver: true }, spawnLease: {}, status: {} };
  const { deps, calls } = makeFixture({
    overlay,
    decisions: spawnDecision([{ key: 't/3', label: 'three' }]),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.equal(calls.runDrain.length, 1);
  assert.ok(overlay.spawnLease['t/3'], 're-acquired lease must exist');
  assert.equal(overlay.spawnLease['t/3'].loopId, 'm1', 'lease owner must be the deciding loop');
});

// ---------------------------------------------------------------------------
// Test 4: failure path — a dead worker's claimed task is completed as failed
// ---------------------------------------------------------------------------

test('worker child fails with task in_progress → assignment completed as failed', async () => {
  const overlay = {
    config: { headless_driver: true },
    spawnLease: { 't/1': { leaseExpiry: Date.now() + 60000, loopId: 'm1' } },
    status: { 't/1': 'in_progress' },   // worker accepted, then died
  };
  const { deps, calls } = makeFixture({
    overlay,
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
    drainResult: { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, spawnError: null },
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.equal(calls.failed.length, 1, 'strand guard must post the terminal failed status');
  assert.equal(calls.failed[0].key, 't/1');
  assert.equal(calls.failed[0].workspace, WS);
  assert.match(calls.failed[0].agent_id, /^headless-worker-/, 'failed write must reuse the worker claim identity');
  const row = result.drains.find((d) => d.task === 't/1');
  assert.equal(row && row.marked_failed, true);
});

test('worker child times out with task in_progress → assignment completed as failed', async () => {
  const overlay = {
    config: { headless_driver: true },
    spawnLease: { 't/1': { leaseExpiry: Date.now() + 60000, loopId: 'm1' } },
    status: { 't/1': 'in_progress' },
  };
  const { deps, calls } = makeFixture({
    overlay,
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
    drainResult: { exitCode: null, stdout: '', stderr: '', timedOut: true, spawnError: null },
  });
  await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(calls.failed.length, 1);
  assert.match(calls.failed[0].reason, /timed out/i);
});

test('clean worker exit with completed task → no failed write', async () => {
  const overlay = {
    config: { headless_driver: true },
    spawnLease: { 't/1': { leaseExpiry: Date.now() + 60000, loopId: 'm1' } },
    status: { 't/1': 'tested' },   // worker completed properly
  };
  const { deps, calls } = makeFixture({
    overlay,
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.equal(calls.failed.length, 0, 'a completed task must not be re-marked failed');
  const row = result.drains.find((d) => d.task === 't/1');
  assert.equal(row.exitCode, 0);
});

test('failed child that never claimed → no failed write (lease TTL frees the task)', async () => {
  const overlay = {
    config: { headless_driver: true },
    spawnLease: { 't/1': { leaseExpiry: Date.now() + 60000, loopId: 'm1' } },
    status: {},   // still ready — never accepted
  };
  const { deps, calls } = makeFixture({
    overlay,
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
    drainResult: { exitCode: 1, stdout: '', stderr: '', timedOut: false, spawnError: 'ENOENT' },
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(calls.failed.length, 0, 'an unclaimed task has no assignment to fail');
  const row = result.drains.find((d) => d.task === 't/1');
  assert.equal(row && row.never_claimed, true);
});

// ---------------------------------------------------------------------------
// Test 5: backend + governor gates
// ---------------------------------------------------------------------------

test('api-kind backend → no_backend clean pause (no impl-worker loop for api providers)', async () => {
  const { deps, calls } = makeFixture({
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
    backendLib: { getActiveBackend: () => ({ provider: { id: 'api-x', kind: 'api', isAuthed: () => true }, providerId: 'api-x' }) },
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'no_backend');
  assert.equal(calls.runDrain.length, 0);
});

test('governor concurrency cap → skip before the decide pass', async () => {
  const { deps, calls, governor } = makeFixture({
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
  });
  governor.concurrentRunning = 2;   // at the mocked maxConcurrency
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'concurrency_cap');
  assert.equal(calls.decide, 0);
});

test('host-wide slot refused → task skipped with the lease reason', async () => {
  const { deps, calls } = makeFixture({
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
    acquireSlot: () => ({ ok: false, reason: 'global_concurrency_cap' }),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'global_concurrency_cap');
  assert.equal(calls.runDrain.length, 0);
});

// ---------------------------------------------------------------------------
// Test 6: envelope + prompt carry the worker contract slots
// ---------------------------------------------------------------------------

test('handoff envelope carries slots from the prepare response; prompt embeds the contract', async () => {
  const job = { ws: WS, loopId: 'm1', key: 't/9', label: 'nine' };
  const prepare = {
    ok: true,
    branch: 'orch/attempt/t-9',
    worktree: '/wt/t-9',
    target_repo: '/repo',
    assignment: { context: { dependency_summaries: [{ key: 'dep/1', summary: 'dep summary' }] } },
  };
  const envelope = headlessSpawn.buildHandoffEnvelope({
    job, prepare, agentId: headlessSpawn.workerAgentId(job.key), siblings: [{ key: 't/8', label: 'eight' }],
  });
  assert.equal(envelope.version, 1);
  assert.equal(envelope.task_key, 't/9');
  assert.equal(envelope.branch, 'orch/attempt/t-9');
  assert.equal(envelope.target_repo, '/repo');
  assert.match(envelope.agent_id, /^headless-worker-/);
  assert.deepEqual(envelope.sibling_tasks, [{ task_key: 't/8', title: 'eight' }]);
  assert.deepEqual(envelope.context_deps, [{ task_key: 'dep/1', summary: 'dep summary' }]);

  const prompt = headlessSpawn.buildWorkerPrompt(envelope);
  assert.match(prompt, /action:"accept"/);
  assert.match(prompt, /git add -A && git commit/);
  assert.match(prompt, /status:"failed"/, 'failure contract must be explicit in the prompt');
  assert.ok(prompt.includes(envelope.branch));
});
