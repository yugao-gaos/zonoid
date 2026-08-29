'use strict';

// Coverage for AUTO-mode loop default-on (task 0b5a907e/4): the daemon STARTS the heartbeat loop
// itself when the session is in an auto-accept permission mode and tasks are ready, instead of only
// nudging the model. Cases: (a) auto + ready + no loop → start once + confirmation (not nudge);
// (b) auto + already-active session loop → no double-start; (c) non-auto → unchanged nudge;
// (d) opted-out → no autostart (modeled: classify.sh never relays, so the composer never runs).

const { test } = require('node:test');
const assert = require('node:assert');

const {
  resolveAutoLoopMode, isAutoMode, hasActiveSessionLoop, maybeAutostartLoop, AUTOSTART_CONFIG,
  ensureManagedGraphLoop, hasNormalReadyWork, hasVisibleIntegrationWork, managedGraphLoopId,
  taskAlreadySettled,
} = require('../lib/loop-autostart');
const { classifyHeuristic } = require('../lib/prompt-heuristic');
const { assembleClassifyResponse } = require('../lib/classify-assemble');
const readyCache = require('../lib/ready-flag-cache');

function makeCtx() {
  const loops = new Map();
  let saved = 0;
  return {
    loops,
    newLoop: (over) => ({
      id: null, active: false, iterations: 0, spent: 0, baseline: 0, real: false, startedAt: null,
      session: null, lastProgress: null, workspace: null,
      config: { tokenBudget: 100000, maxIterations: 200, minPoll: 30, maxPoll: 1200, estPerTick: 800, batch: 8, maxConcurrency: 10, judgeParallelCap: 6 },
      ...over,
    }),
    saveLoops: () => { saved++; },
    state: { workspace: '/ws' },
    now: () => 1000,
    _saved: () => saved,
  };
}

// ---- isAutoMode -----------------------------------------------------------
test('isAutoMode: bypassPermissions and acceptEdits are auto; default/plan are not', () => {
  assert.ok(isAutoMode({ permissionMode: 'bypassPermissions' }));
  assert.ok(isAutoMode({ permissionMode: 'acceptEdits' }));
  assert.ok(!isAutoMode({ permissionMode: 'default' }));
  assert.ok(!isAutoMode({ permissionMode: 'plan' }));
  assert.ok(!isAutoMode({}));
});

test('isAutoMode: ORCH_AUTO_LOOP env fallback forces auto regardless of permission_mode', () => {
  assert.ok(isAutoMode({ permissionMode: 'default', autoLoopEnv: true }));
  assert.ok(isAutoMode({ autoLoopEnv: true }));
});

test('resolveAutoLoopMode: adapter-neutral auto_mode forces auto regardless of client permission names', () => {
  assert.ok(resolveAutoLoopMode({ autoMode: true, permissionMode: 'manual' }));
  assert.ok(resolveAutoLoopMode({ autoMode: '1', permissionMode: 'ask' }));
  assert.ok(!resolveAutoLoopMode({ autoMode: false, permissionMode: 'manual' }));
});

test('resolveAutoLoopMode: client capabilities auto_execute is the universal adapter contract', () => {
  assert.ok(resolveAutoLoopMode({ clientCapabilities: { auto_execute: true }, permissionMode: 'manual' }));
  assert.ok(resolveAutoLoopMode({ clientCapabilities: { auto_execute: 'true' } }));
  assert.ok(!resolveAutoLoopMode({ clientCapabilities: { auto_execute: false }, permissionMode: 'manual' }));
});

// ---- maybeAutostartLoop ---------------------------------------------------
test('(a) auto + ready + no loop → starts exactly one loop with default config + confirmation', () => {
  const ctx = makeCtx();
  const line = maybeAutostartLoop({ ctx, sessionId: 'sid-a', autoMode: true, hasReady: true });
  assert.ok(line && line.startsWith('[Orchestrator] Auto-started loop '));
  assert.ok(line.endsWith('(auto mode)'));
  assert.strictEqual(ctx.loops.size, 1);
  const L = [...ctx.loops.values()][0];
  assert.strictEqual(L.active, true);
  assert.strictEqual(L.session, 'sid-a');
  assert.strictEqual(L.workspace, '/ws');
  for (const [k, v] of Object.entries(AUTOSTART_CONFIG)) {
    assert.strictEqual(L.config[k], v, `config.${k} should be ${v}`);
  }
});

test('(b) auto + already-active session loop → no double-start (idempotent)', () => {
  const ctx = makeCtx();
  // pre-seed an active loop bound to the session
  ctx.loops.set('existing', { id: 'existing', active: true, session: 'sid-b', config: {} });
  const line = maybeAutostartLoop({ ctx, sessionId: 'sid-b', autoMode: true, hasReady: true });
  assert.strictEqual(line, null);
  assert.strictEqual(ctx.loops.size, 1, 'must not add a second loop');
});

test('an inactive same-session loop does NOT block autostart', () => {
  const ctx = makeCtx();
  ctx.loops.set('stale', { id: 'stale', active: false, session: 'sid-c', config: {} });
  const line = maybeAutostartLoop({ ctx, sessionId: 'sid-c', autoMode: true, hasReady: true });
  assert.ok(line, 'a dead loop should not suppress autostart');
  assert.strictEqual(ctx.loops.size, 2);
});

test('a loop active for a DIFFERENT session does not count as this session\'s loop', () => {
  const ctx = makeCtx();
  ctx.loops.set('other', { id: 'other', active: true, session: 'someone-else', config: {} });
  assert.ok(!hasActiveSessionLoop(ctx.loops, 'sid-d'));
  const line = maybeAutostartLoop({ ctx, sessionId: 'sid-d', autoMode: true, hasReady: true });
  assert.ok(line);
});

test('no autostart when not auto, when no ready tasks, or when no sessionId', () => {
  assert.strictEqual(maybeAutostartLoop({ ctx: makeCtx(), sessionId: 's', autoMode: false, hasReady: true }), null);
  assert.strictEqual(maybeAutostartLoop({ ctx: makeCtx(), sessionId: 's', autoMode: true, hasReady: false }), null);
  assert.strictEqual(maybeAutostartLoop({ ctx: makeCtx(), sessionId: null, autoMode: true, hasReady: true }), null);
});

test('managed graph autostart ignores disposable worktree workspaces', () => {
  const ctx = makeCtx();
  const graph = { tasks: [{ id: 'codex/ready', status: 'ready' }] };
  const overlay = { blocked: {} };
  for (const workspace of [
    '/repo/.zonoid/worktrees/hash/task',
    '/repo/worktrees/hash/task',
    '/Users/me/.local/share/opencode/worktree/hash/task',
  ]) {
    const result = ensureManagedGraphLoop({ ctx, workspace, graph, overlay });
    assert.strictEqual(result.created, false);
    assert.strictEqual(result.loop, null);
  }
  assert.strictEqual(ctx.loops.size, 0);
});

test('pending dashboard decisions do not suppress managed-loop readiness', () => {
  const graph = { tasks: [{ id: 'codex/ready', status: 'ready' }] };
  const overlay = { blocked: {}, decision_holds: { 'codex/ready': { guidance_id: 'legacy' } } };
  assert.strictEqual(hasNormalReadyWork(graph, overlay), true);
  overlay.blocked['codex/ready'] = { reason: 'explicit structural block' };
  assert.strictEqual(hasNormalReadyWork(graph, overlay), false);
});

test('cold boot repairs legacy partial autonomy and creates the deterministic managed owner', () => {
  const ctx = makeCtx();
  const workspace = '/registered/cold-boot';
  const overlay = { config: { automode: true, self_plan: true }, blocked: {}, unwired: {}, git: {}, reviews: {}, snapshots: {} };
  const graph = { tasks: [{ id: 'codex/ready', status: 'ready' }] };

  const result = ensureManagedGraphLoop({ ctx, workspace, graph, overlay });
  const id = managedGraphLoopId(workspace);

  assert.strictEqual(result.created, true);
  assert.strictEqual(overlay.config.headless_driver, true);
  assert.strictEqual(ctx.loops.size, 1);
  assert.strictEqual(ctx.loops.get(id).active, true);
  assert.strictEqual(overlay.frontier_liveness.status, 'active');
  assert.strictEqual(overlay.frontier_liveness.managed_loop_id, id);
});

test('periodic reconciliation reactivates a safely stale owner without creating a duplicate', () => {
  const ctx = makeCtx();
  const workspace = '/registered/periodic';
  const overlay = { config: { headless_driver: true }, blocked: {}, unwired: {}, git: {}, reviews: {}, snapshots: {} };
  const graph = { tasks: [{ id: 'codex/ready', status: 'ready' }] };
  ensureManagedGraphLoop({ ctx, workspace, graph, overlay });
  const id = managedGraphLoopId(workspace);
  const original = ctx.loops.get(id);
  original.active = false;
  original.iterations = 42;
  original.spent = 12345;
  original.sweptReason = 'no progress >30m';

  const result = ensureManagedGraphLoop({ ctx, workspace, graph, overlay });

  assert.strictEqual(result.created, false);
  assert.strictEqual(result.loop, original);
  assert.strictEqual(original.active, true);
  assert.strictEqual(original.iterations, 0);
  assert.strictEqual(original.spent, 0);
  assert.strictEqual(ctx.loops.size, 1);
});

test('reconciliation retires duplicate legacy managed owners', () => {
  const ctx = makeCtx();
  const workspace = '/registered/duplicates';
  const overlay = { config: { headless_driver: true }, blocked: {}, unwired: {}, git: {}, reviews: {}, snapshots: {} };
  const graph = { tasks: [{ id: 'codex/ready', status: 'ready' }] };
  const id = managedGraphLoopId(workspace);
  const canonical = ctx.newLoop({ id, active: true, workspace, managed: 'graph' });
  const legacy = ctx.newLoop({ id: 'legacy-random-owner', active: true, workspace, managed: 'graph' });
  ctx.loops.set(id, canonical);
  ctx.loops.set(legacy.id, legacy);

  ensureManagedGraphLoop({ ctx, workspace, graph, overlay });

  assert.strictEqual(canonical.active, true);
  assert.strictEqual(legacy.active, false);
  assert.match(legacy.sweptReason, /superseded/);
  assert.strictEqual([...ctx.loops.values()].filter((l) => l.active && l.managed === 'graph').length, 1);
});

test('completed stale requeues and internal drains are not legitimate work', () => {
  const ctx = makeCtx();
  const overlay = {
    config: { automode: true }, blocked: {}, unwired: {}, reviews: {},
    git: { 'codex/merged': { merged: true } },
    snapshots: {
      'codex/completed': { status: 'completed' },
      'followup/harness-judge-drain': { status: 'pending', metadata: { harness: true } },
    },
  };
  const graph = { tasks: [
    { id: 'codex/merged', status: 'ready' },
    { id: 'codex/completed', status: 'ready' },
    { id: 'followup/harness-judge-drain', status: 'ready' },
  ] };

  const result = ensureManagedGraphLoop({ ctx, workspace: '/registered/no-work', graph, overlay });

  assert.strictEqual(result.changed, false);
  assert.strictEqual(ctx.loops.size, 0);
  assert.strictEqual(overlay.config.headless_driver, undefined);
  assert.strictEqual(overlay.frontier_liveness, undefined);
});

test('terminal overlay status settles stale review integration metadata', () => {
  const overlay = {
    config: { automode: true }, blocked: {}, unwired: {}, git: {},
    status: { 'codex/canceled-conflict': 'canceled' },
    reviews: {
      'codex/canceled-conflict': {
        review_state: 'approved',
        review_verdict: 'APPROVE',
        merge_state: 'conflict',
      },
    },
    snapshots: { 'codex/canceled-conflict': { status: 'pending' } },
  };

  assert.strictEqual(taskAlreadySettled(overlay, 'codex/canceled-conflict'), true);
});

test('blocked tasks and non-task nodes are not visible integration work', () => {
  const overlay = {
    blocked: { 'codex/blocked-merge': { reason: 'unsafe stale integration' } },
    git: {}, status: {}, snapshots: {},
    reviews: {
      'codex/blocked-merge': { review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending' },
      'note:historical': { review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending' },
    },
  };
  const graph = { tasks: [
    { id: 'codex/blocked-merge', status: 'not_ready' },
    { id: 'note:historical', kind: 'note', status: 'note' },
  ] };

  assert.strictEqual(hasVisibleIntegrationWork(graph, overlay), false);
});

test('unsafe unwired recovery exposes a stalled reason instead of guessing graph structure', () => {
  const ctx = makeCtx();
  const overlay = {
    config: { automode: true, headless_driver: true }, blocked: {}, git: {}, reviews: {}, snapshots: {},
    unwired: { 'codex/unwired': true },
  };
  const graph = { tasks: [{ id: 'codex/unwired', status: 'ready' }] };

  const result = ensureManagedGraphLoop({ ctx, workspace: '/registered/unwired', graph, overlay });

  assert.strictEqual(result.stalledReason, 'ready_work_requires_wiring');
  assert.strictEqual(overlay.frontier_liveness.status, 'stalled');
  assert.strictEqual(overlay.frontier_liveness.reason, 'ready_work_requires_wiring');
  assert.strictEqual(ctx.loops.size, 0);
});

test('an exhausted managed-loop safety budget is surfaced and never silently reset', () => {
  const ctx = makeCtx();
  const workspace = '/registered/exhausted';
  const overlay = { config: { automode: true, headless_driver: true }, blocked: {}, unwired: {}, git: {}, reviews: {}, snapshots: {} };
  const graph = { tasks: [{ id: 'codex/ready', status: 'ready' }] };
  const id = managedGraphLoopId(workspace);
  const exhausted = ctx.newLoop({ id, active: false, workspace, managed: 'graph', sweptReason: 'token budget exhausted', spent: 999 });
  ctx.loops.set(id, exhausted);

  const result = ensureManagedGraphLoop({ ctx, workspace, graph, overlay });

  assert.strictEqual(result.loop, null);
  assert.strictEqual(result.stalledReason, 'managed_loop_token_budget_exhausted');
  assert.strictEqual(exhausted.active, false);
  assert.strictEqual(exhausted.spent, 999);
  assert.strictEqual(overlay.frontier_liveness.reason, 'managed_loop_token_budget_exhausted');
});

// ---- assembler integration ------------------------------------------------
function assemble(opts) {
  readyCache._resetForTests();
  // readyInjection composes from the module flag cache (keyed by session), not the readyEntry arg —
  // populate it so the soft-nudge path is reachable for the non-auto case.
  const sid = opts.sessionId ?? 'sid';
  if (opts.readyEntry) {
    readyCache.refreshReadyFlag(sid, () => opts.readyEntry.labels.map((l) => ({ key: l, label: l })));
  }
  return assembleClassifyResponse({
    prompt: 'do the work',
    sessionId: opts.sessionId ?? 'sid',
    heuristic: classifyHeuristic('do the work'),
    contextClassify: { complexity: 0.5, gate_decision: 'abstain', rag_score: 0, dag_score: 0 },
    hasMetricSpec: false,
    readyEntry: opts.readyEntry ?? null,
    autostartLine: opts.autostartLine ?? null,
    judgePressure: null,
    labelPressure: null,
    learnerPressure: null,
    orchGateOff: false,
    hasActiveLoop: opts.hasActiveLoop ?? false,
  }).additional_context;
}

test('(a-composer) autostartLine present → confirmation emitted, soft nudge suppressed', () => {
  const ctx = assemble({
    readyEntry: { count: 2, labels: ['x', 'y'] },
    autostartLine: '[Orchestrator] Auto-started loop abc-123 (auto mode)',
  });
  assert.ok(ctx.includes('Auto-started loop abc-123'), 'confirmation must be present');
  assert.ok(!ctx.includes('No active loop detected'), 'soft nudge must be suppressed in auto mode');
});

test('(c-composer) non-auto (no autostartLine) → unchanged soft nudge', () => {
  const ctx = assemble({
    readyEntry: { count: 2, labels: ['x', 'y'] },
    autostartLine: null,
  });
  assert.ok(ctx.includes('No active loop detected'), 'soft nudge must remain for non-auto sessions');
  assert.ok(!ctx.includes('Auto-started loop'), 'no confirmation when nothing was autostarted');
});

test('(c-composer) non-auto + hasActiveLoop=true → loop-aware nudge, not the start nudge', () => {
  const ctx = assemble({
    readyEntry: { count: 2, labels: ['x', 'y'] },
    autostartLine: null,
    hasActiveLoop: true,
  });
  assert.ok(ctx.includes('Loop already active'), 'loop-aware nudge must be present');
  assert.ok(!ctx.includes('No active loop detected'), 'must not emit the start nudge when a loop is active');
});

test('autostart confirmation marks session busy so a later tick does not re-nudge', () => {
  readyCache._resetForTests();
  // first tick: auto autostart
  assembleClassifyResponse({
    prompt: 'p', sessionId: 'busy-sid', heuristic: classifyHeuristic('p'),
    contextClassify: { complexity: 0.5, gate_decision: 'abstain' }, hasMetricSpec: false,
    readyEntry: { count: 1, labels: ['x'] },
    autostartLine: '[Orchestrator] Auto-started loop z (auto mode)',
    judgePressure: null, labelPressure: null, learnerPressure: null, orchGateOff: false,
  });
  // populate the flag cache for the same session, then a non-auto tick must NOT re-nudge
  readyCache.refreshReadyFlag('busy-sid', () => [{ key: 'x', label: 'x' }]);
  const second = assembleClassifyResponse({
    prompt: 'p2', sessionId: 'busy-sid', heuristic: classifyHeuristic('p2'),
    contextClassify: { complexity: 0.5, gate_decision: 'abstain' }, hasMetricSpec: false,
    readyEntry: { count: 1, labels: ['x'] }, autostartLine: null,
    judgePressure: null, labelPressure: null, learnerPressure: null, orchGateOff: false,
  }).additional_context;
  assert.ok(!second.includes('No active loop detected'), 'busy flag should suppress the repeat nudge');
});
