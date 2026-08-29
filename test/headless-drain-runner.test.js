'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createHeadlessDrainRunner } = require('../lib/headless-drain-runner');

function fakeDrain(governor, run) {
  return { _governor: governor, runDueDrains: run };
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
