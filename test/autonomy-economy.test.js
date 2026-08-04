#!/usr/bin/env node
/**
 * test/autonomy-economy.test.js
 *
 * "When does it stop?" — the two ceilings that bound full autonomy:
 *   (1) the planner's EXPONENTIAL no-action cooldown (lib/headless-spawn), and
 *   (2) the per-workspace-per-day AUTONOMY TOKEN CEILING (lib/autonomy-budget), enforced by both
 *       the spawn executor and the drain pump and surfaced on GET /status.
 *
 * Run: node test/autonomy-economy.test.js
 *
 * All seams are MOCKED — no real CLI child, daemon HTTP, or overlay file is touched.
 */
'use strict';

const assert = require('node:assert/strict');

const headlessSpawn = require('../lib/headless-spawn');
const autonomyBudget = require('../lib/autonomy-budget');
const activity = require('../lib/activity');

let pass = 0;
let fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log(`ok    ${label}`); }
  else { fail++; console.log(`FAIL  ${label}`); }
}
function test(label, fn) {
  try { fn(); ok(label, true); } catch (e) { fail++; console.log(`FAIL  ${label}\n      ${e && e.message}`); }
}
async function atest(label, fn) {
  try { await fn(); ok(label, true); } catch (e) { fail++; console.log(`FAIL  ${label}\n      ${e && e.message}`); }
}

const WS = '/ws/a';
const MIN = 60 * 1000;
const BASE = 30 * MIN;   // the shipped default planner cooldown base

// ===========================================================================================
// PART 1 — planner exponential no-action back-off
// ===========================================================================================

function plannerOverlay(planner = {}, config = {}, epoch = 0) {
  return { config: { planner_cooldown_ms: BASE, ...config }, planner, epoch };
}

test('ladder: streak 1→30m, 2→1h, 3→4h, 4+→24h (capped)', () => {
  const at = (streak) => headlessSpawn.plannerEffectiveCooldownMs(
    plannerOverlay({ noActionStreak: streak, lastEpoch: 0 })
  );
  assert.equal(at(0), BASE, 'never-no-actioned ⇒ the plain base window');
  assert.equal(at(1), 30 * MIN);
  assert.equal(at(2), 60 * MIN);
  assert.equal(at(3), 4 * 60 * MIN);
  assert.equal(at(4), 24 * 60 * MIN);
  assert.equal(at(9), 24 * 60 * MIN, 'the ladder CAPS at 24h — it does not keep doubling');
});

test('ladder scales with a retuned base rather than being a fixed ms table', () => {
  const ov = plannerOverlay({ noActionStreak: 3, lastEpoch: 0 }, { planner_cooldown_ms: 1000 });
  assert.equal(headlessSpawn.plannerEffectiveCooldownMs(ov), 8000, '3rd step is 8x the base');
  const off = plannerOverlay({ noActionStreak: 4, lastEpoch: 0 }, { planner_cooldown_ms: 0 });
  assert.equal(headlessSpawn.plannerEffectiveCooldownMs(off), 0, 'an explicit 0 base still disables the cooldown');
});

test('markPlannerRan: an unchanged graph epoch is a NO-ACTION run ⇒ the streak grows', () => {
  const ov = plannerOverlay({}, {}, 7);
  headlessSpawn.markPlannerRan(ov, 'plan', { epochBefore: 7 });
  assert.equal(ov.planner.noActionStreak, 1);
  assert.equal(ov.planner.lastEpoch, 7);
  headlessSpawn.markPlannerRan(ov, 'plan', { epochBefore: 7 });
  assert.equal(ov.planner.noActionStreak, 2, 'consecutive no-action runs accumulate');
  assert.equal(ov.planner.lease, undefined, 'the run lease is still cleared');
  assert.ok(ov.planner.lastPlanAt, 'the cooldown anchor is still stamped');
});

test('markPlannerRan: a planner that CREATED nodes (epoch bumped) resets the streak', () => {
  const ov = plannerOverlay({ noActionStreak: 3, lastEpoch: 7 }, {}, 7);
  ov.epoch = 9;                                   // the child added task nodes while it ran
  headlessSpawn.markPlannerRan(ov, 'plan', { epochBefore: 7 });
  assert.equal(ov.planner.noActionStreak, 0, 'an acting planner earns no back-off');
  assert.equal(ov.planner.lastEpoch, 9);
});

test('reset on graph change: a bumped epoch invalidates an earned streak with no extra wiring', () => {
  const ov = plannerOverlay({ noActionStreak: 4, lastEpoch: 12, lastPlanAt: Date.now() }, {}, 12);
  assert.equal(headlessSpawn.plannerNoActionStreak(ov), 4);
  assert.equal(headlessSpawn.plannerEffectiveCooldownMs(ov), 24 * 60 * MIN);
  ov.epoch = 13;                                  // ANY graph change (a task/note added anywhere)
  assert.equal(headlessSpawn.plannerNoActionStreak(ov), 0, 'fresh input ⇒ the streak no longer counts');
  assert.equal(headlessSpawn.plannerEffectiveCooldownMs(ov), BASE, 'and the window falls back to base');
});

test('legacy overlay (lastPlanAt only, pre-ladder fields absent) behaves exactly as before', () => {
  const ov = plannerOverlay({ lastPlanAt: Date.now() - 1000, lastMode: 'plan' });
  assert.equal(headlessSpawn.plannerNoActionStreak(ov), 0);
  assert.equal(headlessSpawn.plannerEffectiveCooldownMs(ov), BASE);
  assert.equal(headlessSpawn.plannerOnCooldown(ov), true);
});

test('plannerOnCooldown honours the LADDER, not just the base window', () => {
  const ranAt = Date.now() - (45 * MIN);          // 45 min ago: past base (30m), inside step 2 (1h)
  const base = plannerOverlay({ lastPlanAt: ranAt, noActionStreak: 1, lastEpoch: 0 });
  assert.equal(headlessSpawn.plannerOnCooldown(base), false, 'one no-action run ⇒ 30m ⇒ eligible again');
  const grown = plannerOverlay({ lastPlanAt: ranAt, noActionStreak: 2, lastEpoch: 0 });
  assert.equal(headlessSpawn.plannerOnCooldown(grown), true, 'two ⇒ 1h ⇒ still held');
});

test('plannerBackoffView reports the window, the streak, and when it lifts', () => {
  const ranAt = Date.parse('2026-08-03T00:00:00Z');
  const ov = plannerOverlay({ lastPlanAt: ranAt, lastMode: 'plan', noActionStreak: 3, lastEpoch: 0 });
  const v = headlessSpawn.plannerBackoffView(ov, ranAt + 1000);
  assert.equal(v.no_action_streak, 3);
  assert.equal(v.cooldown_ms, 4 * 60 * MIN);
  assert.equal(v.base_cooldown_ms, BASE);
  assert.equal(v.next_eligible_at, new Date(ranAt + 4 * 60 * MIN).toISOString());
  assert.equal(v.on_cooldown, true);
  const fresh = headlessSpawn.plannerBackoffView({ config: {}, planner: {} });
  assert.equal(fresh.last_plan_at, null);
  assert.equal(fresh.on_cooldown, false);
});

// ===========================================================================================
// PART 2 — daily autonomy spend ceiling
// ===========================================================================================

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-08-03T12:00:00');           // local noon
const T_NEXT = T0 + DAY;

function budgetOverlay(config = {}) {
  return { config: { autonomy_daily_token_budget: 1000, ...config }, autonomySpend: {} };
}

test('budget resolution: config > env > default, and 0 DISABLES the ceiling', () => {
  assert.equal(autonomyBudget.dailyTokenBudget({ config: { autonomy_daily_token_budget: 42 } }), 42);
  assert.equal(autonomyBudget.dailyTokenBudget({ config: {} }), autonomyBudget.DEFAULT_DAILY_TOKEN_BUDGET);
  const off = { config: { autonomy_daily_token_budget: 0 } };
  assert.equal(autonomyBudget.dailyTokenBudget(off), 0);
  autonomyBudget.recordSpend(off, 10 ** 9, { nowMs: T0 });
  assert.equal(autonomyBudget.overBudget(off, T0), false, '0 means unbounded, not instantly exceeded');
});

test('usage normalization: Anthropic and OpenAI shapes; cache reads are NOT counted', () => {
  assert.equal(autonomyBudget.usageTokens({ input_tokens: 100, output_tokens: 20 }), 120);
  assert.equal(autonomyBudget.usageTokens({ prompt_tokens: 7, completion_tokens: 3 }), 10);
  assert.equal(autonomyBudget.usageTokens({ total_tokens: 55 }), 55);
  assert.equal(
    autonomyBudget.usageTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 9_000_000 }),
    15,
    'cache reads dwarf real spend by ~500x — folding them in would trip any human-scale ceiling instantly'
  );
  assert.equal(autonomyBudget.usageTokens(null), 0);
  assert.equal(autonomyBudget.usageTokens('nonsense'), 0);
});

test('tokensFromResult asks the PROVIDER to parse its own stdout; unknown usage meters 0', () => {
  const provider = {
    parseResult: (out) => (out.includes('usage') ? { usage: { input_tokens: 30, output_tokens: 12 } } : { usage: null }),
  };
  assert.equal(autonomyBudget.tokensFromResult({ stdout: 'has usage' }, provider), 42);
  assert.equal(autonomyBudget.tokensFromResult({ stdout: 'silent child' }, provider), 0);
  assert.equal(autonomyBudget.tokensFromResult({ usage: { input_tokens: 1, output_tokens: 1 } }, null), 2,
    'a caller-supplied usage object wins over stdout parsing');
  const boom = { parseResult: () => { throw new Error('bad stream'); } };
  assert.equal(autonomyBudget.tokensFromResult({ stdout: 'x' }, boom), 0, 'a throwing parser meters 0, never throws');
});

test('recordSpend accumulates, flags exceeded, and reports the crossing ONCE', () => {
  const ov = budgetOverlay();
  const a = autonomyBudget.recordSpend(ov, 400, { kind: 'worker', nowMs: T0 });
  assert.equal(a.spent, 400);
  assert.equal(a.exceeded, false);
  assert.equal(a.crossed, false);
  assert.equal(a.remaining, 600);

  const b = autonomyBudget.recordSpend(ov, 700, { kind: 'planner', nowMs: T0 });
  assert.equal(b.spent, 1100);
  assert.equal(b.exceeded, true);
  assert.equal(b.crossed, true, 'the under→over transition is the single notify trigger');

  const c = autonomyBudget.recordSpend(ov, 50, { kind: 'judge', nowMs: T0 });
  assert.equal(c.exceeded, true);
  assert.equal(c.crossed, false, 'already over ⇒ NOT a fresh crossing (this is what prevents spam)');
  assert.deepEqual(ov.autonomySpend.by_kind, { worker: 400, planner: 700, judge: 50 });
  assert.equal(ov.autonomySpend.runs, 3);
  assert.ok(ov.autonomySpend.first_exceeded_at);
});

test('next-day reset: the counter rolls over at the local day boundary', () => {
  const ov = budgetOverlay();
  autonomyBudget.recordSpend(ov, 5000, { nowMs: T0 });
  assert.equal(autonomyBudget.overBudget(ov, T0), true);
  assert.equal(autonomyBudget.spentToday(ov, T_NEXT), 0, 'yesterday\'s record reads as 0 tokens today');
  assert.equal(autonomyBudget.overBudget(ov, T_NEXT), false, 'work resumes the next day with no operator action');
  const fresh = autonomyBudget.recordSpend(ov, 10, { nowMs: T_NEXT });
  assert.equal(fresh.spent, 10, 'the new day starts from zero, not from yesterday\'s total');
  assert.equal(autonomyBudget.dayKey(T_NEXT), '2026-08-04');
});

test('a persisted counter survives a restart AND a fresh loop — it is keyed by workspace+day', () => {
  const ov = budgetOverlay();
  autonomyBudget.recordSpend(ov, 900, { nowMs: T0 });
  // Simulate the overlay round-trip a daemon restart performs (LOCAL_FIELDS ⇒ JSON ⇒ back).
  const reloaded = JSON.parse(JSON.stringify(ov));
  assert.equal(autonomyBudget.spentToday(reloaded, T0), 900);
  autonomyBudget.recordSpend(reloaded, 200, { nowMs: T0 });
  assert.equal(autonomyBudget.overBudget(reloaded, T0), true,
    'a restart (or a newly minted managed loop) cannot mint a fresh budget');
});

test('noteDailyBudgetPause emits ONE event per workspace per day, then re-arms tomorrow', () => {
  activity.reset();
  const ov = budgetOverlay();
  autonomyBudget.recordSpend(ov, 2000, { nowMs: T0 });
  assert.equal(autonomyBudget.noteDailyBudgetPause(WS, ov, T0), true, 'first pause announces');
  assert.equal(autonomyBudget.noteDailyBudgetPause(WS, ov, T0), false, 'every later tick is silent');
  assert.equal(autonomyBudget.noteDailyBudgetPause(WS, ov, T0 + 1000), false);
  const rows = activity.list({ workspace: WS }).filter((e) => e.reason === autonomyBudget.DAILY_BUDGET_SKIP);
  assert.equal(rows.length, 1, 'exactly one digest row, not one per pump tick');
  assert.equal(ov.autonomySpend.notified_day, '2026-08-03');
  // A new day re-arms the announcement (and zeroes the counter).
  assert.equal(autonomyBudget.noteDailyBudgetPause(WS, ov, T_NEXT), true);
  activity.reset();
});

test('budgetView is the /status shape and never throws on a virgin overlay', () => {
  const ov = budgetOverlay();
  autonomyBudget.recordSpend(ov, 250, { kind: 'worker', nowMs: T0 });
  const v = autonomyBudget.budgetView(ov, T0);
  assert.equal(v.spent, 250);
  assert.equal(v.budget, 1000);
  assert.equal(v.remaining, 750);
  assert.equal(v.exceeded, false);
  assert.equal(v.enabled, true);
  assert.deepEqual(v.by_kind, { worker: 250 });
  const virgin = autonomyBudget.budgetView({ config: {} }, T0);
  assert.equal(virgin.spent, 0);
  assert.equal(virgin.exceeded, false);
  const disabled = autonomyBudget.budgetView({ config: { autonomy_daily_token_budget: 0 } }, T0);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.remaining, null);
});

// ===========================================================================================
// PART 3 — the ceilings enforced through the pumps
// ===========================================================================================

function mockProvider(overrides = {}) {
  return {
    id: 'mock',
    kind: 'agentic-cli',
    isAvailable: () => true,
    isAuthed: () => true,
    buildInvocation: ({ prompt }) => ({ bin: 'mock-bin', args: ['-p', prompt], env: null }),
    parseResult: (out) => {
      const m = /USAGE:(\d+)/.exec(String(out || ''));
      return m ? { usage: { input_tokens: Number(m[1]), output_tokens: 0 } } : { usage: null };
    },
    ...overrides,
  };
}

function makeFixture(opts = {}) {
  const loops = new Map();
  for (const L of opts.loops || [{ id: 'm1', active: true, managed: 'graph', session: null, workspace: WS }]) {
    loops.set(L.id, L);
  }
  const overlay = opts.overlay || {
    config: { headless_driver: true, self_plan: true, planner_cooldown_ms: 0 },
    spawnLease: {}, status: {}, planner: {}, autonomySpend: {}, epoch: 0,
  };
  const calls = { decide: 0, runDrain: [], saves: [] };
  const governor = { iterationsUsed: 0, tokensUsed: 0, concurrentRunning: 0, backoffUntil: 0, consecutiveThrottles: 0 };
  const deps = {
    loops,
    decide: (o) => {
      calls.decide++;
      const d = opts.decisions || [];
      if (!o || typeof o.loopFilter !== 'function') return d;
      return d.filter((x) => o.loopFilter(loops.get(x.loopId)));
    },
    overlayLoad: () => overlay,
    overlaySave: (ws, ov) => { calls.saves.push({ ws, ov }); },
    governor,
    acquireSlot: () => ({ ok: true, release() {} }),
    resolveMcpConfig: () => null,
    recordOutcome: () => {},
    backendLib: { getActiveBackend: () => ({ provider: mockProvider(), providerId: 'mock', model: 'm' }) },
    runDrain: async (spec) => {
      calls.runDrain.push(spec);
      return opts.drainResult || { exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };
    },
    effectiveConfig: () => ({ tokenBudget: 200000, maxIterations: 50, maxConcurrency: 2, timeoutMs: 1000 }),
  };
  return { deps, calls, overlay, governor };
}

const planDecision = (loopId = 'm1') => [{ loopId, action: 'plan', reason: 'DAG drained' }];

async function pumpTests() {
  await atest('runDueSpawns: an over-ceiling workspace is NOT ticked at all (no lease is taken)', async () => {
    const { deps, calls, overlay } = makeFixture({
      overlay: {
        config: { headless_driver: true, self_plan: true, planner_cooldown_ms: 0, autonomy_daily_token_budget: 100 },
        spawnLease: {}, status: {}, planner: {}, epoch: 0,
        autonomySpend: { day: autonomyBudget.dayKey(), tokens: 500 },
      },
      decisions: planDecision(),
    });
    const r = await headlessSpawn.runDueSpawns({}, deps);
    assert.equal(r.ran, 0);
    assert.equal(r.skipped, autonomyBudget.DAILY_BUDGET_SKIP);
    assert.equal(calls.decide, 0, 'decideOne LEASES the tasks it picks — an over-ceiling workspace must not be ticked');
    assert.equal(calls.runDrain.length, 0);
    const row = r.drains[0];
    assert.equal(row.skipped, autonomyBudget.DAILY_BUDGET_SKIP);
    assert.equal(row.daily_budget.spent, 500);
    assert.equal(row.daily_budget.budget, 100);
    assert.equal(overlay.autonomySpend.notified_day, autonomyBudget.dayKey(), 'the durable notify marker is stamped');
  });

  await atest('runDueSpawns: under the ceiling the pump behaves normally', async () => {
    const { deps, calls } = makeFixture({
      overlay: {
        config: { headless_driver: true, self_plan: true, planner_cooldown_ms: 0, autonomy_daily_token_budget: 10_000 },
        spawnLease: {}, status: {}, planner: {}, epoch: 0,
        autonomySpend: { day: autonomyBudget.dayKey(), tokens: 500 },
      },
      decisions: planDecision(),
    });
    const r = await headlessSpawn.runDueSpawns({}, deps);
    assert.equal(r.ran, 1);
    assert.equal(calls.runDrain.length, 1);
  });

  await atest('a settled planner child meters its tokens into the day counter AND the governor', async () => {
    const { deps, overlay, governor } = makeFixture({
      decisions: planDecision(),
      drainResult: { exitCode: 0, stdout: 'USAGE:250\n', stderr: '', timedOut: false, spawnError: null },
    });
    const r = await headlessSpawn.runDueSpawns({}, deps);
    assert.equal(r.ran, 1);
    assert.equal(autonomyBudget.spentToday(overlay), 250);
    assert.equal(overlay.autonomySpend.by_kind.planner, 250);
    assert.equal(governor.tokensUsed, 250, 'the per-boot governor counter is charged the same tokens');
    const row = r.drains.find((d) => d.drain === headlessSpawn.PLANNER_DRAIN_KEY);
    assert.equal(row.tokens, 250);
  });

  await atest('a planner run that changed nothing grows the streak on the persisted overlay', async () => {
    const { deps, overlay } = makeFixture({ decisions: planDecision() });
    await headlessSpawn.runDueSpawns({}, deps);
    assert.equal(overlay.planner.noActionStreak, 1, 'epoch unchanged across the run ⇒ no-action');
    assert.equal(overlay.planner.lastEpoch, 0);
  });

  await atest('the planner_cooldown skip row carries the ladder state for diagnosis', async () => {
    const { deps } = makeFixture({
      overlay: {
        config: { headless_driver: true, self_plan: true, planner_cooldown_ms: BASE },
        spawnLease: {}, status: {}, epoch: 4,
        planner: { lastPlanAt: Date.now() - 1000, noActionStreak: 4, lastEpoch: 4 },
      },
      decisions: planDecision(),
    });
    const r = await headlessSpawn.runDueSpawns({}, deps);
    assert.equal(r.skipped, 'planner_cooldown');
    const row = r.drains.find((d) => d.drain === headlessSpawn.PLANNER_DRAIN_KEY);
    assert.equal(row.no_action_streak, 4);
    assert.equal(row.cooldown_ms, 24 * 60 * MIN, 'a 24h skip must be visibly EARNED, not a mis-set knob');
  });

  await atest('a graph change collapses an earned 24h window back to the BASE window', async () => {
    // Ran 45 min ago with a streak of 4 (a 24h window). Without the reset the planner would sit out
    // the rest of the day; with it the window is the plain 30m base, which has already elapsed.
    const plannerState = () => ({ lastPlanAt: Date.now() - (45 * MIN), noActionStreak: 4, lastEpoch: 4 });
    const stale = makeFixture({
      overlay: {
        config: { headless_driver: true, self_plan: true, planner_cooldown_ms: BASE },
        spawnLease: {}, status: {}, epoch: 4, planner: plannerState(),   // graph unchanged since the run
      },
      decisions: planDecision(),
    });
    const held = await headlessSpawn.runDueSpawns({}, stale.deps);
    assert.equal(held.ran, 0, 'an unchanged graph keeps waiting out the earned 24h window');
    assert.equal(held.skipped, 'planner_cooldown');

    const changed = makeFixture({
      overlay: {
        config: { headless_driver: true, self_plan: true, planner_cooldown_ms: BASE },
        spawnLease: {}, status: {}, epoch: 5, planner: plannerState(),   // something was ADDED since the run
      },
      decisions: planDecision(),
    });
    const r = await headlessSpawn.runDueSpawns({}, changed.deps);
    assert.equal(r.ran, 1, 'fresh graph input must not wait out a window earned against a different graph');
    assert.equal(changed.calls.runDrain.length, 1);
  });

  await atest('dispatch reads the overlay AFTER decide, so a decide-pass write is not reverted', async () => {
    // decideOne WRITES the overlay during the decide pass — it leases every task it picks, and its
    // cost_gate path blocks the task + appends guidance and saves. overlay save() rewrites every
    // LOCAL_FIELD, so a pump that dispatched from a PRE-decide snapshot would both miss the fresh
    // foreign lease (double-dispatch) and revert the cost_gate write when it persisted its own.
    let persisted = {
      config: { headless_driver: true, self_plan: true, planner_cooldown_ms: 0 },
      spawnLease: {}, status: {}, planner: {}, autonomySpend: {}, epoch: 0,
    };
    const loops = new Map([['m1', { id: 'm1', active: true, managed: 'graph', session: null, workspace: WS }]]);
    const ran = [];
    const deps = {
      loops,
      decide: () => {
        persisted.spawnLease.t1 = { loopId: 'other-driver', leaseExpiry: Date.now() + 60_000 };
        persisted.guidance = ['cost_gate: loop over budget'];
        return [{ loopId: 'm1', action: 'spawn', tasks: [{ key: 't1', label: 'T' }] }];
      },
      overlayLoad: () => JSON.parse(JSON.stringify(persisted)),
      overlaySave: (_ws, ov) => { persisted = ov; },
      governor: { iterationsUsed: 0, tokensUsed: 0, concurrentRunning: 0, backoffUntil: 0, consecutiveThrottles: 0 },
      acquireSlot: () => ({ ok: true, release() {} }),
      resolveMcpConfig: () => null,
      recordOutcome: () => {},
      backendLib: { getActiveBackend: () => ({ provider: mockProvider(), providerId: 'mock', model: 'm' }) },
      runDrain: async (spec) => { ran.push(spec); return { exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnError: null }; },
      effectiveConfig: () => ({ tokenBudget: Infinity, maxIterations: 50, maxConcurrency: 2, timeoutMs: 1000 }),
    };
    const r = await headlessSpawn.runDueSpawns({}, deps);
    assert.equal(ran.length, 0, 'a task another driver leased during the decide pass must not be dispatched');
    assert.equal(r.skipped, 'lease_held');
    assert.deepEqual(persisted.guidance, ['cost_gate: loop over budget'],
      'the pump must not persist a pre-decide snapshot over the decide pass writes');
  });

  test('drain_token_budget is UNBOUNDED unless set — metering must not park the pumps for a boot', () => {
    // The per-boot counter never resets while the daemon runs, and one agentic child reports ~1M
    // input+output; the old 200000 default only looked harmless because nothing incremented the
    // counter it gates. The standing ceiling is the per-DAY one, which resets at midnight.
    const tuning = require('../lib/tuning');
    const headlessDrain = require('../lib/headless-drain');
    const saved = process.env.HEADLESS_DRAIN_TOKEN_BUDGET;
    delete process.env.HEADLESS_DRAIN_TOKEN_BUDGET;
    try {
      assert.equal(tuning.get('drain_token_budget'), Number.POSITIVE_INFINITY);
      assert.equal(headlessDrain.effectiveConfig().tokenBudget, Number.POSITIVE_INFINITY);
      assert.ok(autonomyBudget.DEFAULT_DAILY_TOKEN_BUDGET > 0, 'the per-day ceiling is the one that is on by default');
    } finally {
      if (saved === undefined) delete process.env.HEADLESS_DRAIN_TOKEN_BUDGET;
      else process.env.HEADLESS_DRAIN_TOKEN_BUDGET = saved;
    }
  });

  await atest('an EXHAUSTED per-boot token budget still lands approved merges', async () => {
    // An operator-set per-boot cap parks the pump until the next restart. The deterministic
    // review-merge sweep spends no tokens, so it must still run — otherwise approved attempts
    // strand on their branches for the whole boot (the same starvation the at-capacity carve-out
    // was added to fix).
    const headlessDrain = require('../lib/headless-drain');
    const overlayStore = require('../lib/overlay');
    const os = require('os');
    const fs = require('fs');
    const path = require('path');

    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-perboot-'));
    const key = 'codex/approved-attempt';
    const ov = overlayStore.load(ws);
    ov.config = { automode: true, autonomy_daily_token_budget: 0 };  // per-DAY ceiling off: isolate the per-boot one
    overlayStore.setStatus(ov, key, 'tested');
    overlayStore.setReviewLifecycle(ov, key, {
      review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending',
    });
    overlayStore.save(ws, ov);

    const savedEnv = process.env.HEADLESS_DRAIN_TOKEN_BUDGET;
    const savedGov = { ...headlessDrain._governor };
    process.env.HEADLESS_DRAIN_TOKEN_BUDGET = '1000';
    const calls = [];
    try {
      headlessDrain._governor.tokensUsed = 5000;   // one metered child already blew past the cap
      const r = await headlessDrain.runDueDrains({ workspace: ws }, null, {
        reviewMergeDeps: {
          mergeTask: async (c) => { calls.push(['merge', c.key]); return { merged: true, head: 'deadbee' }; },
          promoteTask: async (c, m) => { calls.push(['promote', c.key, m.head]); return { ok: true }; },
        },
      });
      assert.deepEqual(calls, [['merge', key], ['promote', key, 'deadbee']],
        'the token cap must not strand an approved attempt on its branch');
      assert.ok(r.ran >= 1);
      assert.notEqual(r.skipped, 'token_budget_exhausted');
    } finally {
      if (savedEnv === undefined) delete process.env.HEADLESS_DRAIN_TOKEN_BUDGET;
      else process.env.HEADLESS_DRAIN_TOKEN_BUDGET = savedEnv;
      Object.assign(headlessDrain._governor, savedGov);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  await atest('runDueDrains: an over-ceiling workspace pauses with skipped:daily_budget', async () => {
    const headlessDrain = require('../lib/headless-drain');
    const overlayStore = require('../lib/overlay');
    const os = require('os');
    const fs = require('fs');
    const path = require('path');

    // A real (temp) workspace so the drain pump's own overlay load/save path is exercised.
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-budget-'));
    const ov = overlayStore.load(ws);
    ov.config = { headless_driver: true, automode: false, autonomy_daily_token_budget: 100 };
    ov.autonomySpend = { day: autonomyBudget.dayKey(), tokens: 999 };
    overlayStore.save(ws, ov);

    const before = { ...headlessDrain._governor };
    try {
      const r = await headlessDrain.runDueDrains({ workspace: ws });
      assert.equal(r.ran, 0);
      assert.equal(r.skipped, autonomyBudget.DAILY_BUDGET_SKIP);
      assert.equal(r.drains[0].daily_budget.exceeded, true);
      const after = overlayStore.load(ws);
      assert.equal(after.autonomySpend.notified_day, autonomyBudget.dayKey(),
        'the pause is announced once and the marker persisted');
    } finally {
      Object.assign(headlessDrain._governor, before);
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  await atest('_meterDrainSpend charges the governor and the day counter, and tolerates a silent child', async () => {
    const headlessDrain = require('../lib/headless-drain');
    const overlayStore = require('../lib/overlay');
    const os = require('os');
    const fs = require('fs');
    const path = require('path');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-meter-'));
    const before = headlessDrain._governor.tokensUsed;
    try {
      const provider = mockProvider();
      const n = headlessDrain._meterDrainSpend(ws, { stdout: 'USAGE:77' }, provider, 'judge');
      assert.equal(n, 77);
      assert.equal(headlessDrain._governor.tokensUsed, before + 77);
      assert.equal(overlayStore.load(ws).autonomySpend.by_kind.judge, 77);
      // A child with no parseable usage must cost nothing — and must not write.
      assert.equal(headlessDrain._meterDrainSpend(ws, { stdout: 'quiet' }, provider, 'judge'), 0);
      assert.equal(overlayStore.load(ws).autonomySpend.tokens, 77);
    } finally {
      headlessDrain._governor.tokensUsed = before;
      try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  // ---- GET /status surfaces both ceilings --------------------------------------------------
  await atest('GET /status reports daily_budget and planner_backoff', async () => {
    const activityRoute = require('../routes/activity');
    const overlayStore = require('../lib/overlay');
    const ov = overlayStore.EMPTY();
    ov.config = { headless_driver: true, self_plan: true, automode: true, autonomy_daily_token_budget: 1000, planner_cooldown_ms: BASE };
    ov.epoch = 3;
    ov.planner = { lastPlanAt: Date.now() - 1000, lastMode: 'plan', noActionStreak: 3, lastEpoch: 3 };
    autonomyBudget.recordSpend(ov, 900, { kind: 'worker' });

    let sent = null;
    const ctx = {
      send: (_res, code, body) => { sent = { code, body }; },
      targetOverlay: (_b, u) => ({ ws: u.searchParams.get('workspace'), ov }),
    };
    const u = new URL(`http://localhost:8787/status?workspace=${encodeURIComponent(WS)}`);
    const handled = await activityRoute(ctx)(u.pathname, 'GET', {}, {}, u);
    assert.equal(handled, true);
    assert.equal(sent.code, 200);
    assert.equal(sent.body.daily_budget.spent, 900);
    assert.equal(sent.body.daily_budget.budget, 1000);
    assert.equal(sent.body.daily_budget.exceeded, false);
    assert.equal(sent.body.planner_backoff.no_action_streak, 3);
    assert.equal(sent.body.planner_backoff.cooldown_ms, 4 * 60 * MIN);
    assert.equal(sent.body.planner_backoff.on_cooldown, true);

    // Unscoped (no workspace) must degrade to null rather than 500.
    let sent2 = null;
    const ctx2 = { send: (_r, code, body) => { sent2 = { code, body }; }, targetOverlay: () => ({ ws: null, ov: null }) };
    const u2 = new URL('http://localhost:8787/status');
    await activityRoute(ctx2)(u2.pathname, 'GET', {}, {}, u2);
    assert.equal(sent2.code, 200);
    assert.equal(sent2.body.daily_budget, null);
    assert.equal(sent2.body.planner_backoff, null);
  });

  // ---- POST /config validation --------------------------------------------------------------
  await atest('POST /config accepts autonomy_daily_token_budget and rejects a negative value', async () => {
    const sessionRoute = require('../routes/session');
    const overlayStore = require('../lib/overlay');
    const ov = overlayStore.EMPTY();
    let sent = null;
    const ctx = {
      send: (_r, code, body) => { sent = { code, body }; },
      readBody: async (req) => req._body,
      notifyChange: () => {},
      buildGraph: () => ({ tasks: [] }),
      targetOverlay: (b) => ({ ws: (b && b.workspace) || WS, ov, save: () => {} }),
    };
    const u = new URL('http://localhost:8787/config');
    const post = async (body) => {
      sent = null;
      await sessionRoute(ctx)(u.pathname, 'POST', { _body: body }, {}, u);
      return sent;
    };
    const okRes = await post({ workspace: WS, autonomy_daily_token_budget: 5_000_000 });
    assert.equal(okRes.code, 200);
    assert.equal(ov.config.autonomy_daily_token_budget, 5_000_000);
    const zero = await post({ workspace: WS, autonomy_daily_token_budget: 0 });
    assert.equal(zero.code, 200);
    assert.equal(ov.config.autonomy_daily_token_budget, 0, '0 is a valid explicit opt-out');
    const bad = await post({ workspace: WS, autonomy_daily_token_budget: -1 });
    assert.equal(bad.code, 400, 'a negative value must be rejected, not silently read as "disabled"');
    assert.equal(ov.config.autonomy_daily_token_budget, 0, 'the rejected write left the config untouched');
  });
}

pumpTests().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log(`FAIL  pump tests threw: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
