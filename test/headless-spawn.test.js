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
const WS_B = '/ws/b';

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
  // Optional per-workspace overlays (multi-workspace tests); everything else shares `overlay`.
  const overlays = opts.overlays || null;
  const calls = { decide: 0, decideOpts: [], prepare: [], runDrain: [], failed: [] };
  const governor = { iterationsUsed: 0, tokensUsed: 0, concurrentRunning: 0, backoffUntil: 0, consecutiveThrottles: 0 };
  const deps = {
    loops,
    decide: (o) => {
      calls.decide++;
      calls.decideOpts.push(o);
      const d = opts.decisions || [];
      // Mirror the daemon: a scoped decide pass only ticks/returns loops passing the filter.
      if (opts.honorFilter === false || !o || typeof o.loopFilter !== 'function') return d;
      return d.filter((x) => o.loopFilter(loops.get(x.loopId)));
    },
    overlayLoad: (ws) => (overlays ? (overlays[ws] || null) : overlay),
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
      if (opts.runDrain) return opts.runDrain(spec);
      return opts.drainResult || { exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };
    },
    effectiveConfig: () => ({ tokenBudget: 200000, maxIterations: 50, maxConcurrency: 2, timeoutMs: 1000 }),
  };
  return { deps, calls, overlay, overlays, governor, loops };
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
// Test 2: interactive session loop active → per-workspace stand-down
// ---------------------------------------------------------------------------

test('active session-bound loop on the ONLY workspace → interactive_driver_active, no decide, no dispatch', async () => {
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

// --- per-workspace stand-down (mixed regime) ---------------------------------------------

const gatedOverlay = () => ({ config: { headless_driver: true }, spawnLease: {}, status: {} });

test('session loop on ANOTHER workspace → that workspace stands down, the gated one still dispatches', async () => {
  const overlays = { [WS]: gatedOverlay(), [WS_B]: gatedOverlay() };
  const { deps, calls } = makeFixture({
    overlays,
    loops: [
      { id: 'm-a', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 'm-b', active: true, managed: 'graph', session: null, workspace: WS_B },
      { id: 's-b', active: true, managed: null, session: 'sess-b', workspace: WS_B },  // drives WS_B only
    ],
    decisions: [
      { loopId: 'm-a', action: 'spawn', tasks: [{ key: 'a/1', label: 'a one' }] },
      { loopId: 'm-b', action: 'spawn', tasks: [{ key: 'b/1', label: 'b one' }] },
    ],
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1, 'the un-driven workspace must still dispatch');
  assert.equal(calls.prepare.length, 1);
  assert.equal(calls.prepare[0].task_key, 'a/1');
  assert.equal(calls.prepare[0].workspace, WS);
  assert.equal(calls.decide, 1, 'the decide pass runs — it is scoped, not skipped');

  // The pass must be SCOPED so the session loop is never ticked or leased.
  const o = calls.decideOpts[0];
  assert.ok(o && typeof o.loopFilter === 'function', 'decide must receive a loopFilter');
  assert.equal(o.loopFilter(deps.loops.get('s-b')), false, 'session loop must be filtered out');
  assert.equal(o.loopFilter(deps.loops.get('m-b')), false, 'busy-workspace managed loop must be filtered out');
  assert.equal(o.loopFilter(deps.loops.get('m-a')), true, 'un-driven gated loop must be servable');
  assert.ok(o.skipWorkspaces instanceof Set && o.skipWorkspaces.has(WS_B) && !o.skipWorkspaces.has(WS));

  assert.ok(!overlays[WS_B].spawnLease['b/1'], 'a session-driven workspace\'s task must not be leased here');
});

test('post-decide safety net: a decide seam ignoring loopFilter still cannot dispatch a busy workspace', async () => {
  const overlays = { [WS]: gatedOverlay(), [WS_B]: gatedOverlay() };
  const { deps, calls } = makeFixture({
    overlays,
    honorFilter: false,   // legacy/injected seam that returns every decision regardless of scoping
    loops: [
      { id: 'm-a', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 'm-b', active: true, managed: 'graph', session: null, workspace: WS_B },
      { id: 's-b', active: true, managed: null, session: 'sess-b', workspace: WS_B },
    ],
    decisions: [
      { loopId: 'm-a', action: 'spawn', tasks: [{ key: 'a/1', label: 'a one' }] },
      { loopId: 'm-b', action: 'spawn', tasks: [{ key: 'b/1', label: 'b one' }] },
    ],
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.deepEqual(calls.prepare.map((p) => p.task_key), ['a/1'], 'WS_B decision must be dropped post-decide');
});

test('gated workspace with no session dispatches even while another workspace is fully driven', async () => {
  const overlays = { [WS]: gatedOverlay(), [WS_B]: { config: {}, spawnLease: {}, status: {} } };
  const { deps, calls } = makeFixture({
    overlays,
    loops: [
      { id: 'm-a', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 's-b', active: true, managed: null, session: 'sess-b', workspace: WS_B },
    ],
    decisions: [{ loopId: 'm-a', action: 'spawn', tasks: [{ key: 'a/1', label: 'a one' }] }],
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.equal(calls.runDrain.length, 1);
});

test('detached workers do not hold the pump closed while another managed workspace becomes ready', async () => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const decisions = [{ loopId: 'm-a', action: 'spawn', tasks: [{ key: 'a/1', label: 'a one' }] }];
  const overlays = { [WS]: gatedOverlay(), [WS_B]: gatedOverlay() };
  const { deps, calls, loops, governor } = makeFixture({
    overlays,
    loops: [{ id: 'm-a', active: true, managed: 'graph', session: null, workspace: WS }],
    decisions,
    runDrain: () => held,
  });
  const executor = headlessSpawn.createSpawnExecutor(deps);

  const first = await executor.runDueDrains({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.ran, 1);
  assert.equal(governor.concurrentRunning, 1, 'the detached worker still owns its shared slot');

  loops.set('m-b', { id: 'm-b', active: true, managed: 'graph', session: null, workspace: WS_B });
  decisions.splice(0, decisions.length,
    { loopId: 'm-b', action: 'spawn', tasks: [{ key: 'b/1', label: 'b one' }] });

  const second = await executor.runDueDrains({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(second.ran, 1, 'the spare slot must serve the newly-ready workspace immediately');
  assert.deepEqual(calls.prepare.map((p) => p.task_key), ['a/1', 'b/1']);

  release({ exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnError: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(governor.concurrentRunning, 0);
});

test('detached completion listener teardown cannot clear a newer registration', () => {
  const executor = headlessSpawn.createSpawnExecutor({});
  const releaseOlder = executor._setDetachedCompletionListener(() => {});
  const releaseNewer = executor._setDetachedCompletionListener(() => {});

  assert.equal(releaseOlder(), false, 'an overlapped runner no longer owns the listener slot');
  assert.equal(releaseNewer(), true, 'the current runner can release its own listener');
});

test('shared capacity is interleaved across workspace jobs instead of consumed by one workspace', async () => {
  const overlays = { [WS]: gatedOverlay(), [WS_B]: gatedOverlay() };
  const { deps, calls } = makeFixture({
    overlays,
    loops: [
      { id: 'm-a', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 'm-b', active: true, managed: 'graph', session: null, workspace: WS_B },
    ],
    decisions: [
      { loopId: 'm-a', action: 'spawn', tasks: [{ key: 'a/1', label: 'a one' }, { key: 'a/2', label: 'a two' }] },
      { loopId: 'm-b', action: 'spawn', tasks: [{ key: 'b/1', label: 'b one' }, { key: 'b/2', label: 'b two' }] },
    ],
  });

  const result = await headlessSpawn.runDueSpawns({}, deps);

  assert.equal(result.ran, 2);
  assert.deepEqual(calls.prepare.map((p) => p.task_key), ['a/1', 'b/1'],
    'the two available slots must be shared across workspaces');
});

test('existing frontier work defers drained-workspace self-planning', async () => {
  const overlays = {
    [WS]: { config: { headless_driver: true, self_plan: true }, spawnLease: {}, status: {}, planner: {} },
    [WS_B]: gatedOverlay(),
  };
  const { deps, calls } = makeFixture({
    overlays,
    loops: [
      { id: 'm-a', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 'm-b', active: true, managed: 'graph', session: null, workspace: WS_B },
    ],
    decisions: [
      { loopId: 'm-a', action: 'plan', reason: 'DAG drained' },
      { loopId: 'm-b', action: 'spawn', tasks: [{ key: 'b/1', label: 'b one' }] },
    ],
  });

  const result = await headlessSpawn.runDueSpawns({}, deps);

  assert.equal(result.ran, 1);
  assert.deepEqual(calls.prepare.map((p) => p.task_key), ['b/1']);
  assert.equal(calls.runDrain.length, 1, 'no planner child may run while existing work is dispatchable');
  const deferred = result.drains.find((d) => d.drain === headlessSpawn.PLANNER_DRAIN_KEY);
  assert.equal(deferred && deferred.skipped, 'frontier_work_pending');
});

test('an external dependency wait does not masquerade as Ready work and block planning', async () => {
  const overlays = {
    [WS]: { config: { headless_driver: true, self_plan: true }, spawnLease: {}, status: {}, planner: {} },
    [WS_B]: gatedOverlay(),
  };
  const { deps, calls } = makeFixture({
    overlays,
    loops: [
      { id: 'm-a', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 'm-b', active: true, managed: 'graph', session: null, workspace: WS_B },
    ],
    decisions: [
      { loopId: 'm-a', action: 'plan', reason: 'DAG drained' },
      { loopId: 'm-b', action: 'idle', reason: 'waiting on cross-workspace dependencies' },
    ],
  });

  const result = await headlessSpawn.runDueSpawns({}, deps);

  assert.equal(result.ran, 1);
  assert.equal(calls.prepare.length, 0);
  assert.equal(calls.runDrain.length, 1, 'a non-Ready external wait must not suppress the planner');
});

test('unpinned active session loop → conservative GLOBAL stand-down (cannot attribute a workspace)', async () => {
  const { deps, calls } = makeFixture({
    loops: [
      { id: 'm1', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 's0', active: true, managed: null, session: 'sess-0', workspace: null },
    ],
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'interactive_driver_active');
  assert.equal(calls.decide, 0);
});

test('INACTIVE session loop does not stand its workspace down', async () => {
  const { deps, calls } = makeFixture({
    loops: [
      { id: 'm1', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 's1', active: false, managed: null, session: 'sess-1', workspace: WS },   // closed session
    ],
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.equal(calls.runDrain.length, 1);
});

test('interactiveWorkspaces partitions the registry by session pin', () => {
  const loops = new Map([
    ['m', { id: 'm', active: true, managed: 'graph', session: null, workspace: WS }],
    ['s', { id: 's', active: true, managed: null, session: 'x', workspace: WS_B }],
    ['dead', { id: 'dead', active: false, managed: null, session: 'y', workspace: '/ws/c' }],
  ]);
  const r = headlessSpawn.interactiveWorkspaces(loops);
  assert.deepEqual([...r.busy], [WS_B]);
  assert.equal(r.unpinned, false);

  loops.set('u', { id: 'u', active: true, managed: null, session: 'z', workspace: null });
  assert.equal(headlessSpawn.interactiveWorkspaces(loops).unpinned, true);
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

// ---------------------------------------------------------------------------
// Test 7: explicit Git target on the prepare request
//
// resolveRepoTarget never INFERS a target (no workspace fallback, even single-repo), so a headless
// prepare that omits target_repo 400s with repo_target_required and nothing can ever dispatch.
// ---------------------------------------------------------------------------

test('prepare request carries the loop workspace as an explicit target_repo', async () => {
  const { deps, calls } = makeFixture({
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.equal(calls.prepare[0].target_repo, WS, 'headless dispatcher must select the repo it drives');
});

test('a task with a persisted repo target omits target_repo (route keeps provenance:task)', async () => {
  const { deps, calls } = makeFixture({
    overlay: {
      config: { headless_driver: true }, spawnLease: {}, status: {},
      repos: { 't/1': '/other/repo' },
    },
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
  });
  await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(calls.prepare[0].target_repo, null, 'a persisted target must not be restamped explicit');
});

test('defaultTargetRepo: persisted target wins (null ⇒ omit), else the workspace', () => {
  assert.equal(headlessSpawn.defaultTargetRepo({ repos: { 'a': '/r' } }, 'a', '/ws'), null);
  assert.equal(headlessSpawn.defaultTargetRepo({ repos: {} }, 'a', '/ws'), '/ws');
  assert.equal(headlessSpawn.defaultTargetRepo(null, 'a', '/ws'), '/ws');
  assert.equal(headlessSpawn.defaultTargetRepo(null, 'a', null), null);
});

// ---------------------------------------------------------------------------
// Test 8: prepare backoff — an unpreparable task must not be re-attempted every pump
// ---------------------------------------------------------------------------

test('prepare failure stamps an exponential backoff window on the task', async () => {
  const overlay = { config: { headless_driver: true }, spawnLease: {}, status: {} };
  const { deps } = makeFixture({
    overlay,
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
    prepareResult: { ok: false, error: 'target_repo (deprecated alias: repo_path) or persisted task target required' },
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  const row = result.drains.find((d) => d.task === 't/1');
  assert.equal(row.skipped, 'prepare_failed');
  const entry = overlay.spawnBackoff['t/1'];
  assert.equal(entry.attempts, 1);
  assert.ok(entry.until > Date.now(), 'window must be in the future');
  assert.match(entry.error, /repo_target_required|target required/);
});

test('a task inside its backoff window is skipped before any lease or prepare', async () => {
  const overlay = {
    config: { headless_driver: true },
    spawnLease: {},
    status: {},
    spawnBackoff: { 't/1': { until: Date.now() + 300000, attempts: 2, error: 'boom' } },
  };
  const { deps, calls } = makeFixture({
    overlay,
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'prepare_backoff');
  assert.equal(calls.prepare.length, 0, 'backed-off task must not re-hit the prepare route');
  assert.equal(overlay.spawnLease['t/1'], undefined, 'backed-off task must not consume a spawn lease');
  const row = result.drains.find((d) => d.task === 't/1');
  assert.equal(row.backoff_attempts, 2);
});

test('an elapsed backoff window lets the task be re-attempted', async () => {
  const overlay = {
    config: { headless_driver: true },
    spawnLease: {},
    status: {},
    spawnBackoff: { 't/1': { until: Date.now() - 1000, attempts: 1, error: 'boom' } },
  };
  const { deps, calls } = makeFixture({
    overlay,
    decisions: spawnDecision([{ key: 't/1', label: 'one' }]),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.equal(calls.prepare.length, 1);
  assert.equal(overlay.spawnBackoff['t/1'], undefined, 'a successful prepare must wipe the penalty');
});

test('spawnBackoffMs doubles per attempt and caps at one hour', () => {
  const base = headlessSpawn.spawnBackoffMs(1);
  assert.equal(headlessSpawn.spawnBackoffMs(2), base * 2);
  assert.equal(headlessSpawn.spawnBackoffMs(3), base * 4);
  assert.equal(headlessSpawn.spawnBackoffMs(99), 60 * 60 * 1000);
});

test('recordSpawnPrepareFailure accumulates attempts; clearSpawnBackoff reports whether it removed one', () => {
  const ov = {};
  headlessSpawn.recordSpawnPrepareFailure(ov, 'k', 'e1');
  headlessSpawn.recordSpawnPrepareFailure(ov, 'k', 'e2');
  assert.equal(ov.spawnBackoff['k'].attempts, 2);
  assert.equal(ov.spawnBackoff['k'].error, 'e2');
  assert.equal(headlessSpawn.clearSpawnBackoff(ov, 'k'), true);
  assert.equal(headlessSpawn.clearSpawnBackoff(ov, 'k'), false, 'no write signalled when nothing to clear');
});
