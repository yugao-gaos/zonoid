'use strict';

// Coverage for AUTO-mode loop default-on (task 0b5a907e/4): the daemon STARTS the heartbeat loop
// itself when the session is in an auto-accept permission mode and tasks are ready, instead of only
// nudging the model. Cases: (a) auto + ready + no loop → start once + confirmation (not nudge);
// (b) auto + already-active session loop → no double-start; (c) non-auto → unchanged nudge;
// (d) opted-out → no autostart (modeled: classify.sh never relays, so the composer never runs).

const { test } = require('node:test');
const assert = require('node:assert');

const {
  isAutoMode, hasActiveSessionLoop, maybeAutostartLoop, AUTOSTART_CONFIG,
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
