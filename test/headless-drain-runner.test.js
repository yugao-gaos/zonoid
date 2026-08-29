'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHeadlessDrainRunner } = require('../lib/headless-drain-runner');
const headlessSpawn = require('../lib/headless-spawn');

function fakeDrain(governor, run) {
  return { _governor: governor, runDueDrains: run };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

test('a failing maintenance run hands the first post-backoff opportunity to frontier work', async () => {
  const governor = { backoffUntil: 0 };
  let maintenanceRuns = 0;
  let frontierRuns = 0;
  const maintenance = createHeadlessDrainRunner({
    lane: 'maintenance',
    headlessDrain: fakeDrain(governor, async () => {
      maintenanceRuns++;
      governor.backoffUntil = Date.now() + 60_000;
      return { ran: 1, drains: [{ exitCode: 1 }] };
    }),
    state: {},
  });
  const frontier = createHeadlessDrainRunner({
    lane: 'frontier',
    headlessDrain: fakeDrain(governor, async () => {
      frontierRuns++;
      return { ran: 1, drains: [{ task: 'codex/ready-user-task' }] };
    }),
    state: {},
  });

  try {
    await maintenance._runPump('initial-maintenance');
    maintenance._stop();
    assert.equal(maintenanceRuns, 1);

    // The real runner wakes both lanes at the shared deadline. Model the instant immediately after
    // that deadline without sleeping for the production backoff window.
    governor.backoffUntil = Date.now() - 1;
    const yielded = await maintenance._runPump('post-backoff-race-winner');
    maintenance._stop();
    assert.equal(yielded.skipped, 'fairness_handoff');
    assert.equal(maintenanceRuns, 1, 'the failing lane must not reacquire the first slot');

    const dispatched = await frontier._runPump('post-backoff-frontier');
    frontier._stop();
    assert.equal(dispatched.ran, 1);
    assert.equal(frontierRuns, 1, 'eligible user work receives the bounded opportunity');

    await maintenance._runPump('maintenance-resumes');
    maintenance._stop();
    assert.equal(maintenanceRuns, 2, 'the handoff is one turn, not permanent maintenance starvation');
  } finally {
    maintenance._stop();
    frontier._stop();
  }
});

test('active backoff still blocks frontier and repeated failures alternate bounded opportunities', async () => {
  const governor = { backoffUntil: 0 };
  const order = [];
  const maintenance = createHeadlessDrainRunner({
    lane: 'maintenance',
    headlessDrain: fakeDrain(governor, async () => {
      order.push('maintenance');
      governor.backoffUntil = Date.now() + 60_000;
      return { ran: 1, drains: [{ exitCode: 1 }] };
    }),
    state: {},
  });
  const frontier = createHeadlessDrainRunner({
    lane: 'frontier',
    headlessDrain: fakeDrain(governor, async () => {
      order.push('frontier');
      governor.backoffUntil = Date.now() + 60_000;
      return { ran: 1, drains: [{ exitCode: 1 }] };
    }),
    state: {},
  });

  try {
    await maintenance._runPump('maintenance-fails');
    maintenance._stop();
    const blocked = await frontier._runPump('too-early');
    frontier._stop();
    assert.equal(blocked.skipped, 'backoff');
    assert.deepEqual(order, ['maintenance'], 'fairness never bypasses a live throttle window');

    governor.backoffUntil = Date.now() - 1;
    await frontier._runPump('frontier-turn');
    frontier._stop();
    governor.backoffUntil = Date.now() - 1;

    const frontierYield = await frontier._runPump('frontier-cannot-reacquire');
    frontier._stop();
    assert.equal(frontierYield.skipped, 'fairness_handoff');
    await maintenance._runPump('maintenance-turn');
    maintenance._stop();
    assert.deepEqual(order, ['maintenance', 'frontier', 'maintenance']);
  } finally {
    maintenance._stop();
    frontier._stop();
  }
});

test('concurrent wakeups collapse to one run and keep the fairness handoff intact', async () => {
  const governor = { backoffUntil: 0 };
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let maintenanceRuns = 0;
  const maintenance = createHeadlessDrainRunner({
    lane: 'maintenance',
    headlessDrain: fakeDrain(governor, async () => {
      maintenanceRuns++;
      await held;
      governor.backoffUntil = Date.now() + 60_000;
      return { ran: 1, drains: [{ exitCode: 1 }] };
    }),
    state: {},
  });

  try {
    const running = maintenance._runPump('first');
    const duplicate = maintenance._runPump('concurrent');
    maintenance.requestWake();
    release();
    await Promise.all([running, duplicate]);
    maintenance._stop();
    assert.equal(maintenanceRuns, 1, 'concurrent wakes do not duplicate a child spawn');

    governor.backoffUntil = Date.now() - 1;
    const yielded = await maintenance._runPump('after-backoff');
    maintenance._stop();
    assert.equal(yielded.skipped, 'fairness_handoff', 'the pending wake cannot erase the handoff');
    assert.equal(maintenanceRuns, 1);
  } finally {
    maintenance._stop();
  }
});

test('a fairness handoff wakes a target lane parked on its idle timer', async () => {
  const governor = { backoffUntil: 0 };
  let frontierRuns = 0;
  const frontier = createHeadlessDrainRunner({
    lane: 'frontier',
    headlessDrain: fakeDrain(governor, async () => {
      frontierRuns++;
      return { ran: 0, skipped: 'no_spawn_decisions', drains: [] };
    }),
    state: {},
  });
  const maintenance = createHeadlessDrainRunner({
    lane: 'maintenance',
    headlessDrain: fakeDrain(governor, async () => {
      governor.backoffUntil = Date.now() + 30;
      return { ran: 1, drains: [{ exitCode: 1 }] };
    }),
    state: {},
  });

  try {
    await frontier._runPump('idle-frontier');
    assert.equal(frontierRuns, 1);

    await maintenance._runPump('maintenance-fails');
    await new Promise((resolve) => setTimeout(resolve, 120));

    assert.equal(frontierRuns, 2, 'the handoff deadline must preempt the target lane idle timer');
  } finally {
    maintenance._stop();
    frontier._stop();
  }
});

test('detached executor failure releases slots and asynchronously hands post-backoff fairness to the opposite runner', async () => {
  const WS = '/ws/detached-integration';
  const governor = {
    iterationsUsed: 0,
    tokensUsed: 0,
    concurrentRunning: 0,
    backoffUntil: 0,
    consecutiveThrottles: 0,
  };
  const loops = new Map([[
    'managed-a',
    { id: 'managed-a', active: true, managed: 'graph', session: null, workspace: WS },
  ]]);
  const overlay = { config: { headless_driver: true }, spawnLease: {}, status: {} };
  let decideCalls = 0;
  let releaseChild;
  let hostSlots = 0;
  let hostReleases = 0;
  let maintenanceRuns = 0;
  const heldChild = new Promise((resolve) => { releaseChild = resolve; });
  const executor = headlessSpawn.createSpawnExecutor({
    governor,
    loops,
    decide: () => decideCalls++ === 0
      ? [{ loopId: 'managed-a', action: 'spawn', tasks: [{ key: 'task/a', label: 'Task A' }] }]
      : [],
    overlayLoad: () => overlay,
    overlaySave: () => {},
    overlayStore: {
      acquireSpawnLease(ov, key, loopId, ttlMs) {
        ov.spawnLease[key] = { loopId, leaseExpiry: Date.now() + ttlMs };
        return true;
      },
      save() {},
    },
    effectiveConfig: () => ({ tokenBudget: 1000, maxIterations: 10, maxConcurrency: 1, timeoutMs: 1000 }),
    acquireSlot: () => {
      hostSlots++;
      let released = false;
      return {
        ok: true,
        release() {
          if (released) return;
          released = true;
          hostSlots--;
          hostReleases++;
        },
      };
    },
    backendLib: {
      getActiveBackend: () => ({
        provider: {
          id: 'mock', kind: 'agentic-cli', isAvailable: () => true, isAuthed: () => true,
          buildInvocation: () => ({ bin: 'mock-bin', args: [] }),
        },
        providerId: 'mock', model: 'test-model',
      }),
    },
    prepareAssignment: async () => ({
      ok: true, branch: 'orch/attempt/task-a', worktree: '/wt/task-a', target_repo: WS,
      assignment: { context: { dependency_summaries: [] } },
    }),
    resolveMcpConfig: () => null,
    runDrain: () => heldChild,
    recordOutcome: () => { governor.backoffUntil = Date.now() + 80; },
    completeFailed: async () => ({ ok: true }),
  });
  const maintenance = createHeadlessDrainRunner({
    lane: 'maintenance',
    headlessDrain: fakeDrain(governor, async () => {
      maintenanceRuns++;
      return { ran: 0, skipped: 'no_due_drains', drains: [] };
    }),
    state: {},
  });
  const frontier = createHeadlessDrainRunner({ lane: 'frontier', headlessDrain: executor, state: {} });

  try {
    const dispatched = await frontier._runPump('dispatch-detached-child');
    assert.equal(dispatched.ran, 1, 'one pump dispatches the detached child');
    assert.equal(governor.concurrentRunning, 1);
    assert.equal(hostSlots, 1);

    releaseChild({ exitCode: 1, stdout: '', stderr: '429 overloaded', timedOut: false, spawnError: null });
    assert.equal(await waitFor(() => governor.concurrentRunning === 0 && !!governor.postBackoffFairness), true,
      'detached completion must release slots and publish the fairness token');
    assert.equal(hostSlots, 0);
    assert.equal(hostReleases, 1);
    assert.ok(governor.backoffUntil > Date.now(), 'the failure establishes a future shared backoff');
    assert.equal(governor.postBackoffFairness.lane, 'maintenance');
    assert.equal(governor.postBackoffFairness.createdBy, 'frontier');

    const blocked = await maintenance._runPump('active-backoff-is-not-bypassable');
    assert.equal(blocked.skipped, 'backoff');
    assert.equal(maintenanceRuns, 0);

    assert.equal(await waitFor(() => maintenanceRuns === 1), true,
      'the opposite lane must be woken when the real backoff expires');
  } finally {
    releaseChild({ exitCode: 1, stdout: '', stderr: 'cleanup', timedOut: false, spawnError: null });
    frontier._stop();
    maintenance._stop();
  }
});

test('a stale detached completion cannot replace newer fairness provenance', () => {
  const now = Date.now();
  const staleBackoffUntil = now + 30_000;
  const newerBackoffUntil = now + 60_000;
  const newerTurn = {
    lane: 'frontier',
    createdBy: 'maintenance',
    backoffUntil: newerBackoffUntil,
    expiresAt: newerBackoffUntil + 2_000,
  };
  const governor = {
    backoffUntil: newerBackoffUntil,
    postBackoffFairness: newerTurn,
  };
  let detachedListener = null;
  const drain = {
    _governor: governor,
    runDueDrains: async () => ({ ran: 0, skipped: 'no_spawn_decisions', drains: [] }),
    _setDetachedCompletionListener(listener) {
      detachedListener = listener;
      return () => {
        if (detachedListener !== listener) return false;
        detachedListener = null;
        return true;
      };
    },
  };
  const runner = createHeadlessDrainRunner({ lane: 'frontier', headlessDrain: drain, state: {} });

  try {
    detachedListener({
      newBackoff: true,
      previousBackoffUntil: 0,
      backoffUntil: staleBackoffUntil,
      kind: 'worker',
      workspace: '/ws/stale',
    });
    assert.equal(governor.postBackoffFairness, newerTurn,
      'the stale notice may wake the runner but cannot rewrite a newer transition token');
  } finally {
    runner._stop();
  }
});

test('stopping an older overlapping runner preserves the newer detached listener', () => {
  const governor = { backoffUntil: 0 };
  let detachedListener = null;
  const drain = {
    _governor: governor,
    runDueDrains: async () => ({ ran: 0, skipped: 'no_spawn_decisions', drains: [] }),
    _setDetachedCompletionListener(listener) {
      detachedListener = listener;
      return () => {
        if (detachedListener !== listener) return false;
        detachedListener = null;
        return true;
      };
    },
  };
  const older = createHeadlessDrainRunner({ lane: 'frontier', headlessDrain: drain, state: {} });
  const olderListener = detachedListener;
  const newer = createHeadlessDrainRunner({ lane: 'frontier', headlessDrain: drain, state: {} });
  const newerListener = detachedListener;

  try {
    assert.notEqual(newerListener, olderListener);
    older._stop();
    assert.equal(detachedListener, newerListener,
      'identity-bound teardown cannot unregister an overlapping replacement');

    const backoffUntil = Date.now() + 30_000;
    governor.backoffUntil = backoffUntil;
    detachedListener({ newBackoff: true, previousBackoffUntil: 0, backoffUntil });
    assert.equal(governor.postBackoffFairness.createdBy, 'frontier',
      'the newer runner remains reachable through the registered completion seam');
  } finally {
    older._stop();
    newer._stop();
  }
  assert.equal(detachedListener, null);
});
