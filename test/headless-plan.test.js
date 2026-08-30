#!/usr/bin/env node
/**
 * test/headless-plan.test.js
 *
 * Unit tests for the headless PLANNER path in lib/headless-spawn.js — the daemon-internal executor
 * that spawns planner children for managed graph-loop 'plan'/'optimize' decisions.
 * Run: node --test test/headless-plan.test.js
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

/**
 * Build a full mocked deps bundle + call log. Defaults model a single gated-on workspace with one
 * active managed graph loop ('m1'), self_plan enabled, and a healthy agentic-cli backend.
 */
function makeFixture(opts = {}) {
  const loops = new Map();
  for (const L of opts.loops || [{ id: 'm1', active: true, managed: 'graph', session: null, workspace: WS }]) {
    loops.set(L.id, L);
  }
  const overlay = opts.overlay || {
    config: { headless_driver: true, self_plan: true, planner_cooldown_ms: 0 },
    spawnLease: {}, status: {}, planner: {},
  };
  const overlays = opts.overlays || null;   // optional per-workspace overlays (multi-workspace tests)
  const calls = { decide: 0, decideOpts: [], runDrain: [], saves: [] };
  const governor = { iterationsUsed: 0, tokensUsed: 0, concurrentRunning: 0, backoffUntil: 0, consecutiveThrottles: 0 };
  const deps = {
    loops,
    decide: (o) => {
      calls.decide++;
      calls.decideOpts.push(o);
      const d = opts.decisions || [];
      // Mirror the daemon: a scoped decide pass only ticks/returns loops passing the filter.
      if (!o || typeof o.loopFilter !== 'function') return d;
      return d.filter((x) => o.loopFilter(loops.get(x.loopId)));
    },
    overlayLoad: (ws) => (overlays ? (overlays[ws] || null) : overlay),
    overlaySave: (ws, ov) => { calls.saves.push({ ws, ov }); },
    governor,
    acquireSlot: opts.acquireSlot || (() => ({ ok: true, release() {} })),
    resolveMcpConfig: () => null,
    recordOutcome: () => {},
    backendLib: opts.backendLib || { getActiveBackend: () => ({ provider: mockProvider(), providerId: 'mock', model: 'test-model' }) },
    runDrain: async (spec) => {
      calls.runDrain.push(spec);
      return opts.drainResult || { exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };
    },
    effectiveConfig: () => ({ tokenBudget: 200000, maxIterations: 50, maxConcurrency: 2, timeoutMs: 1000 }),
  };
  return { deps, calls, overlay, overlays, governor, loops };
}

const planDecision = (loopId = 'm1') => [{ loopId, action: 'plan', reason: 'DAG drained; self-planning a next initiative' }];
const optimizeDecision = (extra = {}, loopId = 'm1') => [{
  loopId,
  action: 'optimize',
  problem: 'p/1',
  label: 'speed up recall',
  metric: 'recall@10',
  reason: 'new judged round on p/1',
  prior_verdict: { winner: 'attempt/2', reason: 'best delta', delta: 0.03 },
  ...extra,
}];

// Extract the planner prompt text from a recorded runDrain spec (args = ['-p', prompt]).
function promptOf(spec) { return spec.args[spec.args.indexOf('-p') + 1]; }

// ---------------------------------------------------------------------------
// Test 1: config gates — off / headless_driver only / +self_plan
// ---------------------------------------------------------------------------

test('headless_driver off (default) → no dispatch and no decide pass', async () => {
  const { deps, calls } = makeFixture({
    overlay: { config: { self_plan: true }, spawnLease: {}, status: {} },   // driver gate NOT set
    decisions: planDecision(),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'headless_driver_off');
  assert.equal(calls.decide, 0, 'gated-off executor must never tick decideAll');
  assert.equal(calls.runDrain.length, 0);
});

test('headless_driver on but self_plan off → plan decision skipped, no planner child', async () => {
  const { deps, calls } = makeFixture({
    overlay: { config: { headless_driver: true }, spawnLease: {}, status: {}, planner: {} },
    decisions: planDecision(),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'self_plan_off');
  assert.equal(calls.runDrain.length, 0, 'a plan decision must not dispatch without self_plan');
  const row = result.drains.find((d) => d.drain === headlessSpawn.PLANNER_DRAIN_KEY);
  assert.equal(row && row.skipped, 'self_plan_off');
});

test('headless_driver + self_plan on → planner dispatches with the guardrail prompt', async () => {
  const { deps, calls, overlay } = makeFixture({ decisions: planDecision() });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.equal(calls.runDrain.length, 1);
  assert.equal(calls.runDrain[0].cwd, WS, 'planner child cwd must be the workspace root');
  const prompt = promptOf(calls.runDrain[0]);
  assert.match(prompt, /AT MOST 3 new initiatives/, 'max-initiative cap must be in the prompt');
  assert.match(prompt, /Dedup BEFORE creating/, 'dedup guardrail must be in the prompt');
  assert.match(prompt, /suggest_links/, 'wiring duty must be in the prompt');
  assert.match(prompt, /NEVER cancel, supersede, or modify any in-flight task/, 'in-flight no-fly zone must be in the prompt');
  assert.match(prompt, /request_guidance/, 'requires-approval routing must be in the prompt');
  assert.match(prompt, /NO-ACTION IS A VALID OUTCOME/, 'no-action outcome must be in the prompt');
  // Debounce stamp after the run: lease cleared, cooldown anchor set.
  assert.ok(overlay.planner.lastPlanAt, 'lastPlanAt must be stamped after the run');
  assert.equal(overlay.planner.lastMode, 'plan');
  assert.equal(overlay.planner.lease, undefined, 'run lease must be cleared when the child settles');
});

// ---------------------------------------------------------------------------
// Test 2: debounce — run lease + cooldown after a (no-action) run
// ---------------------------------------------------------------------------

test('live planner lease → skip planner_running, no second child stacks', async () => {
  const { deps, calls } = makeFixture({
    overlay: {
      config: { headless_driver: true, self_plan: true, planner_cooldown_ms: 0 },
      spawnLease: {}, status: {},
      planner: { lease: { leaseExpiry: Date.now() + 60000, owner: 'headless-plan:123', mode: 'plan' } },
    },
    decisions: planDecision(),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'planner_running');
  assert.equal(calls.runDrain.length, 0);
});

test('cooldown after a finished run → skip planner_cooldown until it elapses', async () => {
  const { deps, calls } = makeFixture({
    overlay: {
      config: { headless_driver: true, self_plan: true, planner_cooldown_ms: 60 * 60 * 1000 },
      spawnLease: {}, status: {},
      planner: { lastPlanAt: Date.now() - 1000, lastMode: 'plan' },   // ran 1s ago, 1h cooldown
    },
    decisions: planDecision(),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'planner_cooldown');
  assert.equal(calls.runDrain.length, 0, 'a no-action outcome must back off, not re-plan every tick');
});

test('elapsed cooldown → planner dispatches again', async () => {
  const { deps, calls } = makeFixture({
    overlay: {
      config: { headless_driver: true, self_plan: true, planner_cooldown_ms: 500 },
      spawnLease: {}, status: {},
      planner: { lastPlanAt: Date.now() - 1000, lastMode: 'plan' },   // ran 1s ago, 0.5s cooldown
    },
    decisions: planDecision(),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.equal(calls.runDrain.length, 1);
});

test('two plan decisions for one workspace in one pump → only one planner child', async () => {
  const loops = [
    { id: 'm1', active: true, managed: 'graph', session: null, workspace: WS },
    { id: 'm2', active: true, managed: 'graph', session: null, workspace: WS },
  ];
  const { deps, calls } = makeFixture({
    loops,
    decisions: [...planDecision('m1'), ...planDecision('m2')],
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1, 'at most ONE planner per workspace per pump');
  assert.equal(calls.runDrain.length, 1);
});

test('failed planner child still stamps the cooldown (no hot-loop on a crashing planner)', async () => {
  const { deps, overlay } = makeFixture({
    decisions: planDecision(),
    drainResult: { exitCode: 1, stdout: '', stderr: 'boom', timedOut: false, spawnError: null },
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1);
  assert.ok(overlay.planner.lastPlanAt, 'a failed run must still start the cooldown window');
  assert.equal(overlay.planner.lease, undefined);
});

test('detached planner failure reports a newly-created backoff to its runner listener', async () => {
  const notices = [];
  const { deps, governor } = makeFixture({
    decisions: planDecision(),
    drainResult: { exitCode: 1, stdout: '', stderr: '429 overloaded', timedOut: false, spawnError: null },
  });
  deps.detachChildren = true;
  deps.onDetachedSettled = (outcome) => { notices.push(outcome); };
  deps.recordOutcome = () => { governor.backoffUntil = Date.now() + 1000; };

  const result = await headlessSpawn.runDueSpawns({}, deps);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.ran, 1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'planner');
  assert.equal(notices[0].newBackoff, true);
  assert.ok(notices[0].backoffUntil > notices[0].previousBackoffUntil);
});

// ---------------------------------------------------------------------------
// Test 3: optimize mode — payload embedded, different-change instruction, no self_plan needed
// ---------------------------------------------------------------------------

test('optimize decision → prompt carries problem/metric/prior_verdict and the different-change rule', async () => {
  const { deps, calls, overlay } = makeFixture({
    // self_plan intentionally OFF: optimize is not gated on it (matches decideOne's ordering).
    overlay: { config: { headless_driver: true, planner_cooldown_ms: 0 }, spawnLease: {}, status: {}, planner: {} },
    decisions: optimizeDecision(),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1, 'optimize must dispatch without self_plan');
  const prompt = promptOf(calls.runDrain[0]);
  assert.match(prompt, /OPTIMIZE MODE/);
  assert.match(prompt, /p\/1/, 'problem key must be embedded');
  assert.match(prompt, /recall@10/, 'metric must be embedded');
  assert.ok(prompt.includes(JSON.stringify({ winner: 'attempt/2', reason: 'best delta', delta: 0.03 })),
    'prior_verdict JSON must be embedded');
  assert.match(prompt, /DIFFERENT change than the prior winner \(attempt\/2\)/,
    'the planner must be told to propose a different change than prior_verdict.winner');
  assert.match(prompt, /ADD a fresh attempts->judge round on the SAME problem task p\/1/);
  assert.match(prompt, /NEVER cancel or edit the existing problem\/attempt nodes/);
  assert.equal(overlay.planner.lastMode, 'optimize');
  const row = result.drains.find((d) => d.drain === headlessSpawn.PLANNER_DRAIN_KEY);
  assert.equal(row && row.problem, 'p/1', 'drain summary must carry the problem key');
});

// ---------------------------------------------------------------------------
// Test 4: stand-down + backend/governor gates (planner path)
// ---------------------------------------------------------------------------

test('session-bound loop on the SAME workspace → stands down, no planner dispatch', async () => {
  const { deps, calls } = makeFixture({
    loops: [
      { id: 'm1', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 's1', active: true, managed: null, session: 'sess-1', workspace: WS },
    ],
    decisions: planDecision(),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'interactive_driver_active');
  assert.equal(calls.decide, 0, 'executor must not steal the interactive driver\'s decide pass');
  assert.equal(calls.runDrain.length, 0);
});

test('session-bound loop on ANOTHER workspace → the un-driven workspace still plans', async () => {
  const WS_B = '/ws/b';
  const plannerOverlay = () => ({
    config: { headless_driver: true, self_plan: true, planner_cooldown_ms: 0 },
    spawnLease: {}, status: {}, planner: {},
  });
  const overlays = { [WS]: plannerOverlay(), [WS_B]: plannerOverlay() };
  const { deps, calls } = makeFixture({
    overlays,
    loops: [
      { id: 'm-a', active: true, managed: 'graph', session: null, workspace: WS },
      { id: 'm-b', active: true, managed: 'graph', session: null, workspace: WS_B },
      { id: 's-b', active: true, managed: null, session: 'sess-b', workspace: WS_B },
    ],
    decisions: [...planDecision('m-a'), ...planDecision('m-b')],
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 1, 'only the un-driven workspace plans');
  assert.equal(calls.runDrain.length, 1);
  assert.equal(calls.runDrain[0].cwd, WS, 'planner child must run in the un-driven workspace');
  assert.ok(!overlays[WS_B].planner.lease, 'the session-driven workspace must not take a planner lease');
});

test('api-kind backend → no_backend clean pause for the planner (documented skip)', async () => {
  const { deps, calls } = makeFixture({
    decisions: planDecision(),
    backendLib: { getActiveBackend: () => ({ provider: { id: 'api-x', kind: 'api', isAuthed: () => true }, providerId: 'api-x' }) },
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'no_backend');
  assert.equal(calls.runDrain.length, 0);
});

test('host-wide slot refused → planner skipped with the lease reason, lease NOT taken', async () => {
  const { deps, calls, overlay } = makeFixture({
    decisions: planDecision(),
    acquireSlot: () => ({ ok: false, reason: 'global_concurrency_cap' }),
  });
  const result = await headlessSpawn.runDueSpawns({}, deps);
  assert.equal(result.ran, 0);
  assert.equal(result.skipped, 'global_concurrency_cap');
  assert.equal(calls.runDrain.length, 0);
  assert.equal(overlay.planner.lease, undefined, 'no run lease may be left behind on a refused slot');
});

// ---------------------------------------------------------------------------
// Test 5: prompt builder unit checks
// ---------------------------------------------------------------------------

test('buildPlannerPrompt: MCP-only transport instruction and single-run bound', () => {
  const { prompt, mode } = headlessSpawn.buildPlannerPrompt({ mode: 'plan', workspace: WS, decision: {} });
  assert.equal(mode, 'plan');
  assert.match(prompt, /ONLY via the orchestrator-graph MCP tools/, 'MCP-only transport (daemon HTTP routes ignore body workspace)');
  assert.match(prompt, /get_learnings\(\) and get_graph\(\) FIRST/);
  assert.match(prompt, /rejected-approaches ledger/);
  assert.match(prompt, /do not loop, re-plan, or spawn workers/);
});

test('buildPlannerPrompt: unknown mode falls back to plan; optimize without winner still instructs a different change', () => {
  const fallback = headlessSpawn.buildPlannerPrompt({ mode: 'bogus', workspace: WS, decision: {} });
  assert.equal(fallback.mode, 'plan');
  const opt = headlessSpawn.buildPlannerPrompt({
    mode: 'optimize', workspace: WS,
    decision: { problem: 'p/2', label: 'L', metric: 'm', prior_verdict: null },
  });
  assert.match(opt.prompt, /DIFFERENT change than the prior winner/);
  assert.match(opt.prompt, /p\/2/);
});
