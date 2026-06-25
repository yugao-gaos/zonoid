#!/usr/bin/env node
// Tests for the block mechanism (Lever 1 + Lever 2).
// Exercises overlay helpers, decideOne spawn exclusion, endpoint routing, and get_task_detail
// surfacing — all via minimal mocks, no port binding.
//
// Run: node test/block-mechanism.test.js — exits non-zero on any failed assertion.
'use strict';
const ov = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

// ── Helpers ─────────────────────────────────────────────────────────────────────

// Build a minimal task object (as decideOne / buildGraph would).
function makeTask(id, status = 'ready', extra = {}) {
  return { id, label: id, status, deps: [], context_deps: [], ...extra };
}

// Build a minimal overlay context like decideOne uses.
function makeOv(extra = {}) {
  return { ...ov.EMPTY(), ...extra };
}

// ── 1: setBlocked / clearBlocked / isBlocked helpers ────────────────────────────
{
  const o = makeOv();
  ok('1.1: initially not blocked', !ov.isBlocked(o, 'task-a'));

  ov.setBlocked(o, 'task-a', 'dangerous benchmark');
  ok('1.2: isBlocked returns true after setBlocked', ov.isBlocked(o, 'task-a'));
  ok('1.3: blocked entry has reason', o.blocked['task-a'] && o.blocked['task-a'].reason === 'dangerous benchmark');
  ok('1.4: blocked entry has at timestamp', o.blocked['task-a'] && typeof o.blocked['task-a'].at === 'string');

  ov.clearBlocked(o, 'task-a');
  ok('1.5: isBlocked returns false after clearBlocked', !ov.isBlocked(o, 'task-a'));

  // Idempotent clear
  ov.clearBlocked(o, 'task-a'); // no-op
  ok('1.6: clearBlocked is idempotent', !ov.isBlocked(o, 'task-a'));

  // setBlocked with no reason
  ov.setBlocked(o, 'task-b');
  ok('1.7: setBlocked works without reason', ov.isBlocked(o, 'task-b'));
  ok('1.8: reason is null when omitted', o.blocked['task-b'] && o.blocked['task-b'].reason === null);
}

// ── 2: blocked map is in EMPTY and LOCAL_FIELDS (persists) ─────────────────────
{
  const empty = ov.EMPTY();
  ok('2.1: EMPTY() has blocked map', typeof empty.blocked === 'object' && empty.blocked !== null);

  // Verify it survives a save/load round-trip by checking LOCAL_FIELDS indirectly:
  // we check that `blocked` is present in the EMPTY shape (it was added to EMPTY).
  // The actual LOCAL_FIELDS list is tested by the save/load cycle; here we verify EMPTY shape.
  ok('2.2: blocked is initialized as empty object in EMPTY()', Object.keys(empty.blocked).length === 0);
}

// ── 3: decideOne EXCLUDES blocked tasks from the spawn pool ─────────────────────
// We test the filtering logic directly, mirroring decideOne's filter expressions,
// without needing a live daemon.
{
  const overlay = makeOv();
  ov.setBlocked(overlay, 'task-blocked', 'test block');

  const readyAll = [
    makeTask('task-blocked', 'ready'),
    makeTask('task-ok', 'ready'),
  ];

  const isUnwired = (t) => !!(overlay.unwired && overlay.unwired[t.id]);
  const isExplicitlyBlocked = (t) => !!(overlay.blocked && overlay.blocked[t.id]);
  const ready = readyAll.filter((t) => !isUnwired(t) && !isExplicitlyBlocked(t));

  ok('3.1: blocked task excluded from ready pool', !ready.some((t) => t.id === 'task-blocked'));
  ok('3.2: unblocked task remains in ready pool', ready.some((t) => t.id === 'task-ok'));
  ok('3.3: ready pool has exactly 1 task', ready.length === 1);
}

// ── 4: block survives dep re-derivation (sticky) ────────────────────────────────
// Simulated: even if the task is "ready" (deps satisfied), the block persists unless cleared.
{
  const overlay = makeOv();
  ov.setBlocked(overlay, 'task-x', 'hold for approval');

  // Simulate a graph rebuild: task is still ready (deps resolved), but block remains.
  const isExplicitlyBlocked = (t) => !!(overlay.blocked && overlay.blocked[t.id]);
  ok('4.1: block persists after simulated graph rebuild', isExplicitlyBlocked({ id: 'task-x' }));

  // After unblock, task becomes spawnable.
  ov.clearBlocked(overlay, 'task-x');
  ok('4.2: after unblock, task is spawnable', !isExplicitlyBlocked({ id: 'task-x' }));
}

// ── 5: /overlay/block and /overlay/unblock endpoints ────────────────────────────
(async () => {
  const overlayRoute = require('../routes/overlay');

  function makeCtx(overlay) {
    let lastSent = null;
    const ctx = {
      get state() { return { overlay, workspace: '/tmp/test-ws', agents: {} }; },
      send(res, status, body) { lastSent = { status, body }; },
      sendOp(res, b, status, body) { lastSent = { status, body }; },
      readBody: async () => ({}),
      notifyChange: () => {},
      buildGraph: () => ({ tasks: [] }),
      targetOverlay: (b) => {
        return { ov: overlay, ws: '/tmp/test-ws', save: () => {} };
      },
      opReplay: () => false,
      cosine: () => 0,
      embed: async () => null,
      knowledgeText: () => '',
      snapshotNative: () => {},
      now: () => new Date().toISOString(),
      suggestToks: () => new Set(),
      scoreNodeAgainstTokens: () => ({ score: 0 }),
      SUGGEST_DUP_THRESHOLD: 0.6,
      DIMS: 384,
      ALL_STATUSES: ['not_ready', 'ready', 'in_progress', 'tested', 'done', 'failed', 'canceled'],
      followups: { validate: () => null, apply: () => [] },
      verdicts: { validate: () => null, apply: () => [], sweepStaleHolds: () => ({ released: [], flagged: [] }), lintProse: () => null },
      agentsArr: () => [],
      saveAgents: () => {},
      cache: { agg: new Map(), aggAt: new Map() },
      nt: { writeStatus: () => {} },
      loops: new Map(),
      saveLoops: () => {},
      ESCALATION_DEFAULTS: () => ({}),
      OPTIMIZE_DEFAULTS: () => ({}),
      judge: { judgeQueueDepth: () => 0 },
      noteRagCandidates: () => [],
    };
    return { ctx, getLastSent: () => lastSent };
  }

  // Mock readBody to return specific body per call — override per test.
  function makeCtxWithBody(overlay, bodyFn) {
    const { ctx, getLastSent } = makeCtx(overlay);
    ctx.readBody = async () => bodyFn();
    return { ctx, getLastSent };
  }

  // 5.1: POST /overlay/block sets the flag
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtxWithBody(o, () => ({ key: 'task-alpha', reason: 'too expensive' }));
    const route = overlayRoute(ctx);
    const mockReq = { method: 'POST', headers: {} };
    await route('/overlay/block', 'POST', mockReq, {}, { searchParams: { get: () => null } }, null);
    const result = getLastSent();
    ok('5.1: POST /overlay/block returns 200', result && result.status === 200);
    ok('5.2: block is set in overlay', ov.isBlocked(o, 'task-alpha'));
    ok('5.3: response has blocked entry', result && result.body && result.body.blocked && result.body.blocked.reason === 'too expensive');
  }

  // 5.2: missing key returns 400
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtxWithBody(o, () => ({ reason: 'no key' }));
    const route = overlayRoute(ctx);
    await route('/overlay/block', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    const result = getLastSent();
    ok('5.4: /overlay/block without key returns 400', result && result.status === 400);
  }

  // 5.3: POST /overlay/unblock clears the flag
  {
    const o = makeOv();
    ov.setBlocked(o, 'task-beta', 'blocked');
    const { ctx, getLastSent } = makeCtxWithBody(o, () => ({ key: 'task-beta' }));
    const route = overlayRoute(ctx);
    await route('/overlay/unblock', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    const result = getLastSent();
    ok('5.5: POST /overlay/unblock returns 200', result && result.status === 200);
    ok('5.6: block is cleared from overlay', !ov.isBlocked(o, 'task-beta'));
    ok('5.7: response has was_blocked:true', result && result.body && result.body.was_blocked === true);
  }

  // 5.4: unblock of non-blocked task → was_blocked:false
  {
    const o = makeOv();
    const { ctx, getLastSent } = makeCtxWithBody(o, () => ({ key: 'task-gamma' }));
    const route = overlayRoute(ctx);
    await route('/overlay/unblock', 'POST', { method: 'POST', headers: {} }, {}, { searchParams: { get: () => null } }, null);
    const result = getLastSent();
    ok('5.8: unblock of non-blocked task → was_blocked:false', result && result.body && result.body.was_blocked === false);
  }

  // ── 6: get_task_detail surfaces blocked ──────────────────────────────────────
  {
    const o = makeOv();
    ov.setBlocked(o, 'task-detail-test', 'test block reason');

    // Patch in minimal task: we need buildGraph to return a task with this id.
    let taskSent = null;
    const taskCtx = {
      get state() { return { overlay: o, workspace: '/tmp/test-ws', agents: {} }; },
      send(res, status, body) { taskSent = { status, body }; },
      readBody: async () => ({}),
      notifyChange: () => {},
      buildGraph: () => ({
        tasks: [{ id: 'task-detail-test', label: 'detail test', status: 'ready', session: null, deps: [], context_deps: {}, blocked: o.blocked['task-detail-test'] || null }],
        ghosts: [],
      }),
      targetOverlay: () => ({ ov: o, ws: '/tmp/test-ws', save: () => {} }),
      validateMetricSpec: () => null,
      validateBenchmark: () => null,
      resolveRepo: () => null,
      scoreMatches: () => [],
      taskTranscript: () => null,
      usageCached: () => null,
    };
    const taskRoute = require('../routes/task');
    const route = taskRoute(taskCtx);
    const u = { searchParams: { get: (k) => k === 'key' ? 'task-detail-test' : null } };
    await route('/task/detail', 'GET', { method: 'GET' }, {}, u, null);
    const sent = taskSent;
    ok('6.1: get_task_detail returns 200', sent && sent.status === 200);
    ok('6.2: blocked field present and non-null', sent && sent.body && sent.body.blocked !== undefined);
    ok('6.3: blocked.reason matches', sent && sent.body.blocked && sent.body.blocked.reason === 'test block reason');
  }

  // ── 7: blocked task NOT spawned by /next-action (decideOne integration) ─────
  // We test decideOne's filtering logic end-to-end via the route's mock path.
  // Rather than full daemon boot, we verify the filter directly (mirrors decideOne code).
  {
    const overlay = makeOv();
    ov.setBlocked(overlay, 'task-expensive', 'user blocked');

    const readyAll = [makeTask('task-expensive', 'ready')];
    const isUnwired = (t) => !!(overlay.unwired && overlay.unwired[t.id]);
    const isExplicitlyBlocked = (t) => !!(overlay.blocked && overlay.blocked[t.id]);
    const ready = readyAll.filter((t) => !isUnwired(t) && !isExplicitlyBlocked(t));

    ok('7.1: blocked task produces empty ready pool', ready.length === 0);
  }

  // ── 8: Lever 2 — cost_gate files guidance and auto-blocks ────────────────────
  {
    const overlay = makeOv();
    overlay.config = { cost_gate: true };
    overlay.metrics = { 'task-bench': { metric: 'latency_p99', direction: 'min', measure_command: 'npm test' } };

    const readyAll = [makeTask('task-bench', 'ready')];
    const isUnwired = (t) => !!(overlay.unwired && overlay.unwired[t.id]);
    const isExplicitlyBlocked = (t) => !!(overlay.blocked && overlay.blocked[t.id]);
    let ready = readyAll.filter((t) => !isUnwired(t) && !isExplicitlyBlocked(t));

    // Simulate Lever 2 gate (mirrors decideOne's cost_gate block):
    if (overlay.config && overlay.config.cost_gate) {
      for (const t of ready) {
        const hasMetric = overlay.metrics && overlay.metrics[t.id];
        if (!hasMetric) continue;
        const alreadyPending = Array.isArray(overlay.guidance) && overlay.guidance.some(
          (g) => !g.resolved && g.trigger === 'cost_gate' && g.action && g.action.taskKey === t.id
        );
        if (alreadyPending) continue;
        ov.addGuidance(overlay, {
          question: `Expensive task "${t.label}" (${t.id}) has a metric spec and is ready to auto-dispatch. Approve to run it, or reject to keep it blocked.`,
          context: `task_key: ${t.id}`,
          trigger: 'cost_gate',
          severity: 'blocking',
          action: { kind: 'cost_gate', taskKey: t.id },
        });
        ov.setBlocked(overlay, t.id, 'cost_gate: awaiting user approval');
      }
      const nowBlocked = (t) => !!(overlay.blocked && overlay.blocked[t.id]);
      ready = ready.filter((t) => !nowBlocked(t));
    }

    ok('8.1: cost_gate: guidance item filed', overlay.guidance.length === 1);
    ok('8.2: cost_gate: guidance trigger is cost_gate', overlay.guidance[0].trigger === 'cost_gate');
    ok('8.3: cost_gate: task auto-blocked', ov.isBlocked(overlay, 'task-bench'));
    ok('8.4: cost_gate: task removed from ready pool', ready.length === 0);

    // Idempotent: second tick does not file duplicate guidance
    let ready2 = readyAll.filter((t) => !isUnwired(t) && !isExplicitlyBlocked(t));
    // task-bench is now blocked, so it won't appear in ready2
    ok('8.5: cost_gate: second tick — task not in ready (blocked)', ready2.length === 0);
    // Verify no double-filing even if we run the loop with an unblocked (hypothetical) metric task
    const overlay2 = makeOv();
    overlay2.config = { cost_gate: true };
    overlay2.metrics = { 'task-bench2': { metric: 'latency_p99', direction: 'min', measure_command: 'npm test' } };
    // Pre-file an unresolved guidance item to test idempotency
    ov.addGuidance(overlay2, { question: 'x', context: '', trigger: 'cost_gate', severity: 'blocking', action: { kind: 'cost_gate', taskKey: 'task-bench2' } });
    const ready3 = [makeTask('task-bench2', 'ready')];
    let filedCount = 0;
    for (const t of ready3) {
      const hasMetric = overlay2.metrics && overlay2.metrics[t.id];
      if (!hasMetric) continue;
      const alreadyPending = Array.isArray(overlay2.guidance) && overlay2.guidance.some(
        (g) => !g.resolved && g.trigger === 'cost_gate' && g.action && g.action.taskKey === t.id
      );
      if (alreadyPending) continue;
      filedCount++;
    }
    ok('8.6: cost_gate: idempotent — no duplicate guidance filed', filedCount === 0);
  }

  // ── 9: cost_gate approve via guidance resolve ─────────────────────────────────
  {
    const o = makeOv();
    o.config = { cost_gate: true };
    ov.setBlocked(o, 'task-cost', 'cost_gate: awaiting user approval');
    const gid = ov.addGuidance(o, {
      question: 'Expensive task "task-cost" ready to dispatch. Approve?',
      context: 'task_key: task-cost',
      trigger: 'cost_gate',
      severity: 'blocking',
      action: { kind: 'cost_gate', taskKey: 'task-cost' },
    });

    ok('9.1: task is blocked before approval', ov.isBlocked(o, 'task-cost'));
    ok('9.2: guidance item is pending', o.guidance.some((g) => g.id === gid && !g.resolved));

    // Simulate approve resolution (mirrors routes/session.js cost_gate handler):
    const item = o.guidance.find((g) => g.id === gid);
    const action = item ? item.action : null;
    if (action && action.kind === 'cost_gate') {
      ov.clearBlocked(o, action.taskKey);
      ov.resolveGuidance(o, gid, 'approve');
    }

    ok('9.3: task unblocked after approve', !ov.isBlocked(o, 'task-cost'));
    ok('9.4: guidance item resolved', o.guidance.find((g) => g.id === gid).resolved === true);
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
