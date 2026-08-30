#!/usr/bin/env node
'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');

const originalSpawn = childProcess.spawn;
const interceptedSpawns = [];
let spawnHandler = null;

function fakeChild(opts = {}) {
  const child = new EventEmitter();
  child.pid = 9000 + interceptedSpawns.length;
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => { child.emit('close', null); return true; };
  child.unref = () => {};
  setImmediate(async () => {
    try {
      if (typeof opts.beforeClose === 'function') await opts.beforeClose();
      if (opts.stdout) child.stdout.emit('data', opts.stdout);
      if (opts.stderr) child.stderr.emit('data', opts.stderr);
      child.emit('close', opts.code == null ? 0 : opts.code);
    } catch (error) {
      child.stderr.emit('data', error && error.stack || String(error));
      child.emit('close', 1);
    }
  });
  return child;
}

// Patch before loading product modules: lib/embed eagerly launches its sidecar on require, while
// runDueDrains launches review/judge workers. This validation must never start either real child.
childProcess.spawn = (bin, args, opts) => {
  const call = { bin, args: Array.isArray(args) ? [...args] : args, opts };
  interceptedSpawns.push(call);
  return (spawnHandler && spawnHandler(call)) || fakeChild();
};

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
const { TOOLS } = require('../lib/mcp-core');
const overlayStore = require('../lib/overlay');
const overlayRoute = require('../routes/overlay');
const apiReviewWorker = require('../scripts/api-review-worker');
const taskRecovery = require('../lib/task-recovery');

const assignmentTool = TOOLS.find((tool) => tool.name === 'subconscious_assignment');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function noopHttp() {
  return {
    request(_opts, callback) {
      const response = { resume() {}, on(event, fn) { if (event === 'end') fn(); } };
      if (callback) callback(response);
      return { on() {}, write() {}, end() {} };
    },
  };
}

function idleLabelDeps() {
  return {
    labelDeps: {
      rowKey: (row) => row._k,
      journalPath: () => path.join(ROOT, 'irrelevant-gate-journal.jsonl'),
      labeledPath: () => path.join(ROOT, 'irrelevant-gate-labeled.jsonl'),
      readJsonl: () => [],
    },
  };
}

function makeOverlayHarness(workspace, overlay, keys) {
  let response = null;
  let requestBody = null;
  const opCache = new Map();
  const graph = () => ({
    tasks: keys.map((key) => ({
      id: key,
      label: key,
      status: overlay.status[key] || overlayStore.lifecycleDerivedStatus(overlay, key) || 'tested',
      deps: [],
      context_deps: [],
    })),
  });
  const context = {
    state: { agents: {} },
    ALL_STATUSES: ['not_ready', 'ready', 'in_progress', 'tested', 'done', 'failed', 'canceled'],
    send: (_res, status, body) => { response = { status, body }; },
    sendOp: (_res, body, status, payload) => {
      response = { status, body: payload };
      if (body && body.op_id) opCache.set(String(body.op_id), response);
    },
    readBody: async () => requestBody,
    targetOverlay: () => ({ ov: overlay, ws: workspace, save: () => {} }),
    buildGraph: graph,
    nodeExistsInGraph: (built, key) => built.tasks.some((task) => task.id === key),
    opReplay: (_res, body) => {
      const replay = body && body.op_id ? opCache.get(String(body.op_id)) : null;
      if (!replay) return false;
      response = replay;
      return true;
    },
    notifyChange: () => {},
    now: () => new Date().toISOString(),
    embed: async () => null,
    knowledgeText: () => '',
    snapshotNative: () => {},
    suggestToks: () => new Set(),
    scoreNodeAgainstTokens: () => ({ score: 0 }),
    SUGGEST_DUP_THRESHOLD: 0.6,
    DIMS: 384,
    followups: { validate: () => null, apply: () => [], onBucketComplete: () => null },
    verdicts: {
      validate: () => null,
      apply: () => [],
      sweepStaleHolds: () => ({ released: [], flagged: [] }),
      lintProse: () => null,
    },
    agentsArr: () => [],
    saveAgents: () => {},
    cache: { agg: new Map(), aggAt: new Map() },
    judge: { judgingState: () => ({ judging: false, timedOut: false }) },
    resolveRepo: () => workspace,
    git: { currentBranch: () => null },
    touchAgent: () => {},
    writeTaskStatus: () => {},
    ingestNode: async () => ({ seeded: 0, vec: null }),
    readNativeTask: () => null,
    harness: { scheduler: { writeScheduledTask: () => ({ armed: false }) } },
  };
  const route = overlayRoute(context);
  const call = async (method, routePath, body) => {
    assert.equal(method, 'POST');
    assert.equal(routePath, '/overlay/status');
    requestBody = body;
    response = null;
    await route(routePath, method, { headers: {} }, {}, { searchParams: { get: () => null } }, null);
    assert.ok(response);
    return response.body;
  };
  return { call, graph };
}

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
    recordOutcome: () => { governor.backoffUntil = Date.now() + 500; },
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

    const blocked = await executor.runDueDrains();
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

test('real KICK_BACK recovery survives an API review refresh and unrelated same-tick save', async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(ROOT, 'lifecycle-workspace-')));
  fs.mkdirSync(path.join(workspace, '.graph'), { recursive: true });
  const reviewKey = 'work/integrated-kick-back';
  const unrelatedTasks = ['other:task/a', 'other:task/b'];
  const unrelatedJudge = 'note:unrelated-same-tick-judge';
  const authoritative = overlayStore.EMPTY();
  authoritative.config = { automode: true, backend: { provider: 'integrated-api' } };
  overlayStore.setStatus(authoritative, reviewKey, 'tested');
  overlayStore.setSnapshot(authoritative, reviewKey, {
    subject: reviewKey, status: 'tested', blockedBy: [],
  });
  overlayStore.setReviewLifecycle(authoritative, reviewKey, {
    review_state: 'requested', merge_state: 'review_pending', review_requested_by: 'dispatcher',
  });

  const unrelatedGuidanceIds = unrelatedTasks.map((key, index) => overlayStore.addGuidance(authoritative, {
    question: `Keep unrelated guidance ${index + 1}?`,
    context: `Unrelated guidance payload ${index + 1} must retain its exact value and order.`,
    trigger: 'scope_expansion',
    severity: 'blocking',
    origin_task: key,
    action: { kind: 'task-recovery', task_key: key, recommended: 'keep' },
  }));
  authoritative.judgedTaskDecisions[`decision:merge:${unrelatedTasks[0]}`] = true;
  authoritative.judgedTaskDecisions[`decision:review:${unrelatedTasks[1]}`] = false;
  authoritative.reviewVerdictLease = {
    [unrelatedTasks[0]]: { owner: 'unrelated-reviewer-a', leaseExpiry: Date.now() + 120000 },
    [unrelatedTasks[1]]: { owner: 'unrelated-reviewer-b', leaseExpiry: Date.now() + 180000 },
  };
  authoritative.eagerJudgeLease = {
    'note:existing-lease-a': { owner: 'judge-a', leaseExpiry: Date.now() + 120000 },
    'note:existing-lease-b': { owner: 'judge-b', leaseExpiry: Date.now() + 180000 },
  };
  authoritative.git[unrelatedTasks[0]] = { branch: 'orch/attempt/unrelated-a', head: 'head-a' };
  authoritative.git[unrelatedTasks[1]] = { branch: 'orch/attempt/unrelated-b', head: 'head-b' };
  authoritative.blocked[unrelatedTasks[0]] = { reason: 'keep blocked a' };
  authoritative.blocked[unrelatedTasks[1]] = { reason: 'keep blocked b' };

  const harness = makeOverlayHarness(workspace, authoritative, [reviewKey, ...unrelatedTasks]);
  const first = await assignmentTool.run({
    action: 'submit_verdict', verdict: 'KICK_BACK', workspace, task_key: reviewKey,
    reason: 'First integrated review failed',
  }, harness.call);
  assert.equal(first.ok, true);
  assert.equal(authoritative.status[reviewKey], 'failed');
  assert.equal(authoritative.reviews[reviewKey].review_state, 'rejected');
  assert.equal(authoritative.retryConfig[reviewKey].pendingKickBackRetry, true);

  const firstRecovery = taskRecovery.reconcile(authoritative, harness.graph().tasks, {
    now: '2026-08-29T14:00:00.000Z',
  });
  assert.deepEqual(firstRecovery.actions.map((action) => action.action), ['retry']);
  assert.equal(authoritative.status[reviewKey], undefined, 'the first KICK_BACK is automatically requeued');
  assert.equal(authoritative.retryConfig[reviewKey].retryCount, 1);
  assert.equal(authoritative.retryConfig[reviewKey].pendingKickBackRetry, undefined);

  overlayStore.setStatus(authoritative, reviewKey, 'tested');
  overlayStore.applyLifecycleEvent(authoritative, reviewKey, 'review_request', {
    task_status: 'tested', rework: true,
  });
  authoritative.eagerJudge[unrelatedJudge] = { at: Date.now() };

  const expectedGuidance = clone(authoritative.guidance);
  const expectedDecisions = clone(Object.entries(authoritative.judgedTaskDecisions));
  const expectedReviewLeases = clone(authoritative.reviewVerdictLease);
  const expectedEagerLeases = clone(Object.entries(authoritative.eagerJudgeLease));
  const expectedGit = clone(authoritative.git);
  const expectedBlocked = clone(authoritative.blocked);
  const tickOverlay = clone(authoritative);
  let unrelatedSave = null;
  let secondResponse = null;
  let secondRecovery = null;
  const apiProvider = {
    id: 'integrated-api',
    kind: 'api',
    isAvailable: () => true,
    isAuthed: () => true,
    buildInvocation: () => { throw new Error('API validation must use a worker'); },
    callApi: async () => ({ text: '{"verdict":"KICK_BACK","reason":"still failing"}' }),
  };
  const backendDeps = {
    backendDeps: {
      backendLib: {
        getActiveBackend: () => ({
          provider: apiProvider,
          providerId: apiProvider.id,
          model: 'integrated-model',
          config: { provider: apiProvider.id, model: 'integrated-model' },
        }),
        getProvider: (id) => id === apiProvider.id ? apiProvider : null,
        listProviders: () => [apiProvider],
      },
    },
  };
  const save = (_workspace, value) => {
    if (value.eagerJudgeLease && value.eagerJudgeLease[unrelatedJudge]) unrelatedSave = clone(value);
  };
  const drainSpawnStart = interceptedSpawns.length;
  spawnHandler = ({ args }) => {
    const script = String(args && args[0] || '');
    if (script.includes('api-review-worker.js')) {
      return fakeChild({
        stdout: `review verdict: KICK_BACK task=${reviewKey}`,
        beforeClose: async () => {
          const body = apiReviewWorker.verdictStatusBody({
            verdict: 'KICK_BACK', reason: 'Second integrated review failed', key: reviewKey,
            workspace, agentId: 'api-reviewer', opId: 'integrated-kick-back-2',
          });
          secondResponse = await harness.call('POST', '/overlay/status', body);
          assert.equal(
            apiReviewWorker.verdictApplyError({ status: 200, body: secondResponse }, body.lifecycle_event),
            null
          );
          secondRecovery = taskRecovery.reconcile(authoritative, harness.graph().tasks, {
            now: '2026-08-29T14:01:00.000Z',
          });
        },
      });
    }
    if (script.includes('api-judge-worker.js')) {
      return fakeChild({ stdout: '{"judged":1,"kept":1,"pruned":0}' });
    }
    throw new Error(`unexpected child spawn in validation: ${script}`);
  };

  let result;
  try {
    result = await headlessDrain.runDueDrains({ workspace }, noopHttp(), {
      ...idleLabelDeps(),
      ...backendDeps,
      reviewVerdictDeps: {
        overlay: tickOverlay,
        overlayStore,
        overlayLoad: () => clone(authoritative),
        overlaySave: save,
      },
      judgeDeps: {
        overlay: tickOverlay,
        overlayStore,
        overlaySave: save,
        judgeLib: {
          eagerJudgeNodes: () => [unrelatedJudge],
          judgeQueueDepth: () => 0,
          buildQueue: () => [],
        },
        acquireEagerJudgeLease: (value, key, owner, ttlMs) => {
          if (!value.eagerJudgeLease) value.eagerJudgeLease = {};
          value.eagerJudgeLease[key] = { owner, leaseExpiry: Date.now() + ttlMs };
          return true;
        },
      },
      reviewMergeDeps: { overlay: tickOverlay, overlayStore },
    });
  } finally {
    spawnHandler = null;
  }

  assert.equal(secondResponse.ok, true, 'the second worker verdict reaches the real overlay route');
  assert.deepEqual(secondRecovery.actions.map((action) => action.action), ['needs_guidance']);
  assert.equal(result.drains.some((item) => item.drain === headlessDrain.REVIEW_VERDICT_DRAIN_KEY), true);
  assert.equal(result.drains.some((item) => item.drain === headlessDrain.JUDGE_DRAIN_KEY), true);
  assert.ok(unrelatedSave, 'an unrelated judge performs the later same-tick overlay save');

  const drainSpawns = interceptedSpawns.slice(drainSpawnStart);
  assert.equal(drainSpawns.length, 2, 'only the mocked API review and judge workers are requested');
  assert.deepEqual(
    drainSpawns.map((call) => path.basename(String(call.args[0]))),
    ['api-review-worker.js', 'api-judge-worker.js']
  );
  assert.ok(interceptedSpawns.some((call) => (call.args || []).some((arg) =>
    String(arg).includes('embed-server.js'))), 'the eager embed sidecar was intercepted before module loading');

  for (const value of [authoritative, tickOverlay, unrelatedSave]) {
    assert.equal(value.status[reviewKey], 'failed');
    assert.equal(value.reviews[reviewKey].review_state, 'rejected');
    assert.equal(value.reviews[reviewKey].review_verdict, 'KICK_BACK');
    assert.equal(value.reviews[reviewKey].merge_state, 'blocked');
    assert.equal(value.retryConfig[reviewKey].retryCount, 1);
    assert.equal(value.retryConfig[reviewKey].pendingKickBackRetry, undefined);
    const recoveryGuidance = value.guidance.filter((item) => !item.resolved
      && item.action && item.action.kind === 'task-recovery'
      && item.action.task_key === reviewKey);
    assert.equal(recoveryGuidance.length, 1, 'the exhausted task exposes exactly one Needs You row');
    assert.deepEqual(value.guidance.slice(0, expectedGuidance.length), expectedGuidance);
    assert.deepEqual(value.guidance.map((item) => item.id), [...unrelatedGuidanceIds, recoveryGuidance[0].id]);
    assert.deepEqual(Object.entries(value.judgedTaskDecisions), [
      ...expectedDecisions,
      [`decision:review:${reviewKey}`, true],
      [`decision:merge:${reviewKey}`, true],
      [`decision:kick_back:${reviewKey}`, true],
    ]);
    assert.deepEqual(value.reviewVerdictLease, expectedReviewLeases);
    assert.deepEqual(Object.entries(value.eagerJudgeLease).slice(0, expectedEagerLeases.length), expectedEagerLeases);
    assert.deepEqual(value.git, expectedGit);
    assert.deepEqual(value.blocked, expectedBlocked);
    assert.deepEqual(
      judge.buildQueue(value).filter((item) => item.kind === 'task-decision' && item.task_key === reviewKey),
      [],
      'settled review/merge/kick_back bookkeeping cannot be re-offered'
    );
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
  childProcess.spawn = originalSpawn;
  if (previousOrchData === undefined) delete process.env.ORCH_DATA;
  else process.env.ORCH_DATA = previousOrchData;
  fs.rmSync(ROOT, { recursive: true, force: true });
});
