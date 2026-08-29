#!/usr/bin/env node
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-frontier-integrated-'));
const previousOrchData = process.env.ORCH_DATA;
process.env.ORCH_DATA = path.join(ROOT, 'runtime');

const decisionDelivery = require('../lib/decision-delivery');
const frontier = require('../lib/frontier');
const headlessDrain = require('../lib/headless-drain');
const { createHeadlessDrainRunner } = require('../lib/headless-drain-runner');
const headlessSpawn = require('../lib/headless-spawn');
const internalLanes = require('../lib/internal-lanes');
const judge = require('../lib/judge');
const kanban = require('../lib/kanban');
const loopAutostart = require('../lib/loop-autostart');
const overlayStore = require('../lib/overlay');
const taskRecovery = require('../lib/task-recovery');

function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const check = () => {
      if (predicate()) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(check, 5);
    };
    check();
  });
}

function provider() {
  return {
    id: 'integrated-mock',
    kind: 'agentic-cli',
    isAvailable: () => true,
    isAuthed: () => true,
    buildInvocation: () => ({ bin: 'mock-bin', args: [], env: null }),
  };
}

test('multi-workspace Ready work precedes planning and detached failure preserves shared fairness', async () => {
  const planWorkspace = path.join(ROOT, 'plan-workspace');
  const readyWorkspace = path.join(ROOT, 'ready-workspace');
  fs.mkdirSync(planWorkspace, { recursive: true });
  fs.mkdirSync(readyWorkspace, { recursive: true });

  const governor = {
    iterationsUsed: 0,
    tokensUsed: 0,
    concurrentRunning: 0,
    backoffUntil: 0,
    consecutiveThrottles: 0,
  };
  const loops = new Map([
    ['managed-plan', { id: 'managed-plan', active: true, managed: 'graph', session: null, workspace: planWorkspace }],
    ['managed-ready', { id: 'managed-ready', active: true, managed: 'graph', session: null, workspace: readyWorkspace }],
  ]);
  const overlays = {
    [planWorkspace]: {
      config: { headless_driver: true, self_plan: true }, spawnLease: {}, spawnBackoff: {}, status: {}, planner: {},
    },
    [readyWorkspace]: {
      config: { headless_driver: true }, spawnLease: {}, spawnBackoff: {}, status: {}, planner: {},
    },
  };
  let decideCalls = 0;
  let releaseChild;
  let hostSlots = 0;
  let hostReleases = 0;
  let maintenanceRuns = 0;
  const prepared = [];
  const childRuns = [];
  const heldChild = new Promise((resolve) => { releaseChild = resolve; });
  const executor = headlessSpawn.createSpawnExecutor({
    governor,
    loops,
    decide: () => decideCalls++ === 0 ? [
      { loopId: 'managed-plan', action: 'plan', reason: 'DAG drained' },
      { loopId: 'managed-ready', action: 'spawn', tasks: [{ key: 'work/ready', label: 'Ready work' }] },
    ] : [],
    overlayLoad: (workspace) => overlays[workspace],
    overlaySave: () => {},
    overlayStore,
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
      getActiveBackend: () => ({ provider: provider(), providerId: 'integrated-mock', model: 'test-model' }),
    },
    prepareAssignment: async ({ workspace, task_key }) => {
      prepared.push({ workspace, task_key });
      return {
        ok: true,
        branch: 'orch/attempt/work-ready',
        worktree: path.join(ROOT, 'attempt-worktree'),
        target_repo: readyWorkspace,
        assignment: { context: { dependency_summaries: [] } },
      };
    },
    resolveMcpConfig: () => null,
    runDrain: (spec) => {
      childRuns.push(spec);
      return heldChild;
    },
    recordOutcome: () => { governor.backoffUntil = Date.now() + 80; },
    completeFailed: async () => ({ ok: true }),
  });
  const maintenance = createHeadlessDrainRunner({
    lane: 'maintenance',
    headlessDrain: {
      _governor: governor,
      runDueDrains: async () => {
        maintenanceRuns++;
        return { ran: 0, skipped: 'no_due_drains', drains: [] };
      },
    },
    state: {},
  });
  const frontierRunner = createHeadlessDrainRunner({ lane: 'frontier', headlessDrain: executor, state: {} });

  try {
    const dispatched = await frontierRunner._runPump('integrated-dispatch');
    assert.equal(dispatched.ran, 1, 'one shared slot dispatches existing Ready work');
    assert.deepEqual(prepared, [{ workspace: readyWorkspace, task_key: 'work/ready' }]);
    assert.equal(childRuns.length, 1, 'the drained workspace cannot launch a planner child first');
    assert.equal(
      dispatched.drains.find((item) => item.drain === headlessSpawn.PLANNER_DRAIN_KEY).skipped,
      'frontier_work_pending'
    );
    assert.equal(governor.concurrentRunning, 1, 'the detached child retains the shared governor slot');
    assert.equal(hostSlots, 1, 'the detached child retains the host-wide slot');

    releaseChild({ exitCode: 1, stdout: '', stderr: '429 overloaded', timedOut: false, spawnError: null });
    assert.equal(await waitFor(() => governor.concurrentRunning === 0 && !!governor.postBackoffFairness), true);
    assert.equal(hostSlots, 0);
    assert.equal(hostReleases, 1, 'the detached completion releases the host slot exactly once');
    assert.ok(governor.backoffUntil > Date.now(), 'the failure establishes a real future backoff');
    assert.equal(governor.postBackoffFairness.lane, 'maintenance');
    assert.equal(governor.postBackoffFairness.createdBy, 'frontier');

    const blocked = await maintenance._runPump('backoff-cannot-be-bypassed');
    assert.equal(blocked.skipped, 'backoff');
    assert.equal(maintenanceRuns, 0);
    assert.equal(await waitFor(() => maintenanceRuns === 1), true,
      'the opposite lane receives the first post-backoff wake');
  } finally {
    releaseChild({ exitCode: 1, stdout: '', stderr: 'cleanup', timedOut: false, spawnError: null });
    frontierRunner._stop();
    maintenance._stop();
  }
});

test('terminal recovery, guidance, Frontier, Kanban, and internal lanes agree on one settled overlay', () => {
  const workspace = path.join(ROOT, 'projection-workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const landedKey = '019c3ac8-f971-7b80-9d14-1b34dfd3c9e9';
  const canceledKey = '019c3ac8-f971-7b80-9d14-1b34dfd3c9e9/42';
  const planKey = 'work/needs-user-choice';
  const readyKey = 'work/legitimate-ready';
  const unrelatedKey = 'work/unrelated';
  const tasks = [
    { id: landedKey, label: landedKey, status: 'ready', deps: [] },
    { id: canceledKey, label: canceledKey, status: 'ready', deps: [] },
    { id: planKey, label: 'Choose rollout policy', status: 'not_ready', deps: [] },
    { id: readyKey, label: 'Legitimate ready work', status: 'ready', deps: [] },
  ];
  const overlay = overlayStore.EMPTY();
  overlay.config = { automode: true, headless_driver: true };
  overlay.git[landedKey] = { merged: true, merge_sha: 'landed-head' };
  overlay.reviews[landedKey] = { review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending' };
  overlay.status[canceledKey] = 'canceled';
  overlay.reviews[canceledKey] = { review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending' };
  overlay.snapshots[canceledKey] = { subject: canceledKey, status: 'pending', blockedBy: [] };
  overlay.notes[unrelatedKey] = 'preserve unrelated state';
  overlay.retryConfig[unrelatedKey] = { retryCount: 7 };
  overlay.judgedTaskDecisions[`decision:merge:${unrelatedKey}`] = true;
  const staleGuidanceId = overlayStore.addGuidance(overlay, {
    question: 'Merge the already-landed task?',
    context: 'Historical prompt from before the merge landed.',
    trigger: 'repeated_failure',
    severity: 'blocking',
    origin_task: landedKey,
    action: { kind: 'task-recovery', task_key: landedKey, recommended: 'retry' },
  });
  const genuineGuidanceId = overlayStore.addGuidance(overlay, {
    question: 'Which rollout policy should be used?',
    context: 'This choice is still required.',
    trigger: 'scope_expansion',
    severity: 'blocking',
    origin_task: planKey,
    action: { kind: 'task-recovery', task_key: planKey, recommended: 'keep' },
  });

  const recovery = taskRecovery.reconcile(overlay, tasks, { now: '2026-08-29T20:00:00.000Z' });
  assert.equal(recovery.changed, true);
  assert.equal(overlay.status[landedKey], 'done');
  assert.equal(overlay.status[canceledKey], 'canceled');
  assert.equal(overlay.summaries[landedKey], undefined, 'landed evidence settles even without a summary');
  assert.deepEqual(overlay.reviews[landedKey], {
    review_state: 'landed', review_verdict: 'APPROVE', merge_state: 'merged',
  });
  assert.deepEqual(overlay.reviews[canceledKey], {
    review_state: 'canceled', review_verdict: null, merge_state: 'closed',
  });
  for (const key of [landedKey, canceledKey]) {
    assert.equal(overlay.judgedTaskDecisions[`decision:review:${key}`], true);
    assert.equal(overlay.judgedTaskDecisions[`decision:merge:${key}`], true);
  }
  assert.equal(overlay.judgedTaskDecisions[`decision:merge:${unrelatedKey}`], true);
  assert.equal(overlay.notes[unrelatedKey], 'preserve unrelated state');
  assert.deepEqual(overlay.retryConfig[unrelatedKey], { retryCount: 7 });

  const normalizedTasks = tasks.map((task) => ({
    ...task,
    status: overlay.status[task.id] || task.status,
    ...overlayStore.reviewLifecycleFor(overlay, task.id, overlay.status[task.id] || task.status),
  }));
  const normalizedGraph = { tasks: normalizedTasks };
  assert.equal(loopAutostart.isLegitimateReadyTask(tasks[0], overlay), false, 'landed stale root is not Ready');
  assert.equal(loopAutostart.isLegitimateReadyTask(tasks[1], overlay), false, 'canceled stale root is not Ready');
  assert.equal(loopAutostart.isLegitimateReadyTask(tasks[3], overlay), true);
  assert.deepEqual(
    headlessDrain.findReviewMergeCandidates(workspace, { overlay, overlayStore, graph: normalizedGraph }),
    [],
    'terminal normalization cannot queue historical merges'
  );
  assert.deepEqual(
    judge.buildQueue(overlay).filter((item) => item.kind === 'task-decision'
      && [landedKey, canceledKey].includes(item.task_key)),
    [],
    'terminal lifecycle bookkeeping cannot be re-offered'
  );

  const resolvedGuidance = decisionDelivery.reconcileStale(
    overlay, Date.parse('2026-08-29T20:01:00.000Z'), normalizedGraph
  );
  assert.deepEqual(resolvedGuidance, [staleGuidanceId]);
  assert.equal(overlay.guidance.find((item) => item.id === staleGuidanceId).decision_state, 'stale');
  assert.equal(overlay.guidance.find((item) => item.id === genuineGuidanceId).resolved, false,
    'a genuine user decision remains visible');

  const projection = kanban.buildKanbanProjection({
    tasks: normalizedTasks,
    frontierTaskIds: normalizedTasks.map((task) => task.id),
    guidance: overlay.guidance,
  });
  assert.deepEqual(kanban.COLUMNS.map(({ id, label }) => ({ id, label }))[0], { id: 'queue', label: 'Plan' });
  assert.equal(projection.cards.find((card) => card.task_key === planKey).lane, 'queue');
  assert.equal(projection.cards.find((card) => card.task_key === canceledKey).lane, 'done');
  assert.ok(!projection.columns.find((column) => column.id === 'ready').task_keys.includes(canceledKey));

  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
  const displaySource = html.slice(
    html.indexOf('const OPAQUE_KANBAN_TASK_KEY='),
    html.indexOf('function kanbanCueLabel'),
  );
  const displayContext = {};
  vm.runInNewContext(`${displaySource};this.display=kanbanCardDisplay;`, displayContext);
  const canceledDisplay = displayContext.display({ task_key: canceledKey, label: canceledKey });
  assert.equal(canceledDisplay.title, 'Untitled legacy task');
  assert.equal(canceledDisplay.subtitle, '');
  assert.ok(!JSON.stringify(canceledDisplay).includes(canceledKey), 'opaque task IDs stay internal to card selection');

  const lanes = internalLanes.buildInternalLaneProjection({ workspace, graph: normalizedGraph, overlay });
  assert.ok(!lanes.items.some((item) => item.lane === 'work'
    && [landedKey, canceledKey].includes(item.key)), 'terminal roots are absent from the work lane');
  assert.ok(lanes.items.some((item) => item.lane === 'user_gate'
    && item.key === genuineGuidanceId), 'genuine Needs You guidance remains in the user lane');
  assert.ok(!lanes.items.some((item) => item.key === staleGuidanceId), 'settled guidance leaves active lanes');
  assert.ok(frontier.frontierKeep(normalizedTasks).has(readyKey));
});

after(() => {
  if (previousOrchData === undefined) delete process.env.ORCH_DATA;
  else process.env.ORCH_DATA = previousOrchData;
  fs.rmSync(ROOT, { recursive: true, force: true });
});
