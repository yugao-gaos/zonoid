#!/usr/bin/env node
/**
 * test/judge-drain-sync.test.js
 *
 * Focused unit test for the SYNCHRONOUS node-scoped judge drain (P1):
 *   lib/headless-drain.runJudgeDrainSync(...)
 *
 * Property under test: a node seeded with weight-0 autowire candidate edges (judged:false) is driven
 * to idle:true in ONE synchronous call that REUSES the in-process judge (resolveJudgeBackend →
 * provider.runJudgeLoop — the kind:'api' path). No real CLI / child process / LLM call is executed:
 * the backend is stubbed at the SAME seam the existing headless-drain api-kind tests stub
 * (deps.backendDeps.backendLib.getActiveBackend → provider.runJudgeLoop), and idle-detection reads a
 * synthetic in-memory overlay via injected overlayLoad/judgeLib deps.
 *
 * Run: node --test test/judge-drain-sync.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const realJudge = require('../lib/judge');

// The route file (routes/judge.js) binds `const headlessDrain = require('../lib/headless-drain')`
// ONCE at load. Require both here, at top of file, BEFORE any freshModule() churns the cache — so
// `routeHd` is the EXACT instance routes/judge.js holds, and the route-wiring test can stub it.
const judgeRoute = require('../routes/judge');
const routeHd = require('../lib/headless-drain');

/** Reset module cache so each test gets a fresh headless-drain module instance (env reads fresh). */
function freshModule() {
  const key = require.resolve('../lib/headless-drain');
  delete require.cache[key];
  return require('../lib/headless-drain');
}

/**
 * Build a synthetic overlay with `node` carrying `n` weight-0 autowire candidate edges (judged:false)
 * — the exact shape whole-graph recall seeds on node-add (by:'autowire', weight 0, retrieval-invisible
 * until a keep promotes them). Edges alternate from/to incidence so both endpoint directions count.
 */
function seededOverlay(node, n) {
  const edges = [];
  for (let i = 0; i < n; i++) {
    edges.push(i % 2 === 0
      ? { from: node, to: `note:cand${i}`, kind: 'context', by: 'autowire', weight: 0, judged: false, score: 0.7 }
      : { from: `note:cand${i}`, to: node, kind: 'context', by: 'autowire', weight: 0, judged: false, score: 0.7 });
  }
  return { epoch: 1, edges, note_nodes: {}, config: { backend: {} } };
}

/**
 * Stub the backend + overlay deps for runJudgeDrainSync, driven entirely by the test (no real
 * lib/llm-backend, no ambient API key, no live daemon).
 *
 *  - backendDeps: an AUTHED api-kind provider. Its runJudgeLoop is the IN-PROCESS judge seam: each
 *    call DRAINS up to `budget` of the node's unjudged edges in the shared synthetic overlay (marks
 *    them judged:true — exactly what a real keep/prune verdict does to the unjudged set) and returns a
 *    drain-result whose stdout carries the applied counts ("applied={kept,pruned}"), mirroring the
 *    real runJudgeLoop's stdout contract that runJudgeDrainSync parses.
 *  - overlayLoad/judgeLib: idle-detection reads THIS overlay (real judge.unverifiedEdgesForNode), so
 *    runJudgeDrainSync sees the edge-set shrink across rounds and stops at idle.
 */
function makeDeps(overlay, node, { perRoundCap = Infinity } = {}) {
  const calls = { runJudgeLoop: 0, args: [] };
  const provider = {
    id: 'mock-api', displayName: 'Mock api', kind: 'api',
    isAvailable: () => true,
    isAuthed: () => true,
    buildInvocation() { throw new Error('api backend must not build a spawn invocation'); },
    async runJudgeLoop(args) {
      calls.runJudgeLoop++;
      calls.args.push(args);
      const budget = Math.max(1, Math.min(Number(args.budget) || 20, 50));
      const limit = Math.min(budget, perRoundCap);
      // Drain (mark judged) up to `limit` of THIS node's still-unjudged edges in the shared overlay.
      const unjudged = realJudge.unverifiedEdgesForNode(overlay, node);
      let kept = 0, pruned = 0;
      for (let i = 0; i < unjudged.length && i < limit; i++) {
        unjudged[i].judged = true;        // verdict applied → leaves the unjudged set
        if (i % 2 === 0) { unjudged[i].weight = 0.6; kept++; } else { pruned++; }
      }
      if (kept + pruned === 0) {
        return { exitCode: 0, stdout: 'judge idle: nothing to adjudicate', stderr: '', timedOut: false, spawnError: null };
      }
      return {
        exitCode: 0,
        stdout: `judge: adjudicated ${kept + pruned} item(s) applied=${JSON.stringify({ kept, pruned })}`,
        stderr: '', timedOut: false, spawnError: null,
      };
    },
  };
  const backendLib = {
    getActiveBackend: () => ({ provider, providerId: provider.id, model: 'mock-model', config: { provider: provider.id, model: 'mock-model' } }),
    getProvider: (q) => (q === provider.id ? provider : null),
    listProviders: () => [provider],
  };
  const deps = {
    backendDeps: { backendLib },
    overlayLoad: () => overlay,
    judgeLib: realJudge,
    timeoutMs: 5000,
  };
  return { deps, calls, provider };
}

// ---- the core property: seeded edges → judged to idle in ONE synchronous call ------------------

test('runJudgeDrainSync drains a node\'s seeded weight-0 autowire edges to idle in one call', async () => {
  const hd = freshModule();
  const node = 's/anchor';
  const overlay = seededOverlay(node, 4);
  // sanity: 4 unjudged candidate edges incident to the node before the drain
  assert.equal(realJudge.unverifiedEdgesForNode(overlay, node).length, 4);

  const { deps, calls } = makeDeps(overlay, node);
  const out = await hd.runJudgeDrainSync({ workspaceRoot: '/ws', node, budget: 50, deps });

  // ONE synchronous call judged the whole edge-set to idle.
  assert.equal(out.idle, true, 'node reaches idle (no unjudged candidate edges remain)');
  assert.equal(out.judged, 4, 'all 4 candidate edges were judged');
  assert.equal(out.kept + out.pruned, 4, 'every judged edge is accounted as kept or pruned');
  assert.equal(realJudge.unverifiedEdgesForNode(overlay, node).length, 0, 'overlay edge-set fully drained');
  // It reused the IN-PROCESS judge (runJudgeLoop), node-scoped, not a spawn.
  assert.ok(calls.runJudgeLoop >= 1, 'drove the in-process runJudgeLoop judge');
  assert.ok(calls.args.every((a) => a.node === node), 'every round is node-scoped to this node');
  assert.ok(calls.args.every((a) => /^http:\/\//.test(String(a.daemonUrl))), 'each call carries the daemon URL');
});

// ---- budget is clamped 1..50 and forwarded to the in-process judge -----------------------------

test('runJudgeDrainSync clamps budget to 1..50', async () => {
  const hd = freshModule();
  const node = 's/anchor';

  const big = makeDeps(seededOverlay(node, 1), node);
  await hd.runJudgeDrainSync({ workspaceRoot: '/ws', node, budget: 9999, deps: big.deps });
  assert.equal(big.calls.args[0].budget, 50, 'budget clamps to 50 max');

  const small = makeDeps(seededOverlay(node, 1), node);
  await hd.runJudgeDrainSync({ workspaceRoot: '/ws', node, budget: 0, deps: small.deps });
  assert.equal(small.calls.args[0].budget, 1, 'budget 0 floors to 1 (not the default)');
});

// ---- multi-round: a per-round cap below the edge count still reaches idle, bounded by maxRounds --

test('runJudgeDrainSync loops bounded rounds until idle when one round cannot drain all edges', async () => {
  const hd = freshModule();
  const node = 's/anchor';
  const overlay = seededOverlay(node, 5);
  // Each round only judges 2 edges → needs 3 rounds to drain 5. maxRounds caps the loop.
  const { deps, calls } = makeDeps(overlay, node, { perRoundCap: 2 });
  const out = await hd.runJudgeDrainSync({ workspaceRoot: '/ws', node, budget: 20, maxRounds: 10, deps });
  assert.equal(out.idle, true, 'reaches idle across multiple rounds');
  assert.equal(out.judged, 5, 'all 5 edges judged');
  assert.equal(calls.runJudgeLoop, 3, 'three node-scoped rounds (cap 2/round over 5 edges)');
});

// ---- hard-block: an unauthed/unavailable backend cleanly pauses (skipped) rather than crashing ---

test('runJudgeDrainSync hard-blocks cleanly when the backend is unusable (no spawn, no crash)', async () => {
  const hd = freshModule();
  const node = 's/anchor';
  const overlay = seededOverlay(node, 2);
  const provider = {
    id: 'mock-api', kind: 'api',
    isAvailable: () => true,
    isAuthed: () => false, // no key ⇒ hard-block
    buildInvocation() { throw new Error('must not build'); },
    runJudgeLoop() { throw new Error('must not call runJudgeLoop when hard-blocked'); },
  };
  const deps = {
    backendDeps: { backendLib: { getActiveBackend: () => ({ provider, providerId: 'mock-api', model: 'm' }) } },
    overlayLoad: () => overlay,
    judgeLib: realJudge,
    timeoutMs: 5000,
  };
  const out = await hd.runJudgeDrainSync({ workspaceRoot: '/ws', node, budget: 10, deps });
  assert.equal(out.skipped, 'no_backend', 'unusable backend ⇒ clean skip, not a throw');
  assert.equal(out.judged, 0, 'nothing judged when hard-blocked');
  assert.equal(out.rounds, 0, 'no rounds attempted');
});

// ---- a missing node arg is a clean no-op (idle), never a throw -----------------------------------

test('runJudgeDrainSync returns a clean idle no-op when node is omitted', async () => {
  const hd = freshModule();
  const out = await hd.runJudgeDrainSync({ workspaceRoot: '/ws' });
  assert.equal(out.idle, true);
  assert.equal(out.judged, 0);
  assert.equal(out.skipped, 'node_required');
});

// ---- HTTP route wiring: POST /judge/drain drives runJudgeDrainSync and returns its counts --------
// The route is a thin wrapper over the (already unit-tested) sync-drain core, so here we stub
// runJudgeDrainSync at the module seam and assert ONLY the HTTP contract: query parsing
// (node/budget), workspace+node validation, and the { judged, kept, pruned, idle } response shape.

function mockU(pathname, params = {}) {
  return { pathname, searchParams: { get: (k) => (k in params ? String(params[k]) : null) } };
}
function mockCtx({ ws = '/tmp/ws', body = {} } = {}) {
  let lastSent = null;
  const ctx = {
    send(res, status, b) { lastSent = { status, body: b }; },
    readBody: async () => body,
    notifyChange: () => {},
    buildGraph: () => ({ tasks: [] }),
    targetOverlay: () => ({ ov: { edges: [] }, ws, save: () => {} }),
    noteRagCandidates: () => [],
  };
  return { ctx, getLastSent: () => lastSent };
}

test('POST /judge/drain drives runJudgeDrainSync and returns { judged, kept, pruned, idle }', async () => {
  // Stub on routeHd — the SAME module instance routes/judge.js holds (captured at top of file before
  // any freshModule() churn), so the already-required route sees the stub.
  const hd = routeHd;
  let received = null;
  const orig = hd.runJudgeDrainSync;
  hd.runJudgeDrainSync = async (opts) => { received = opts; return { judged: 3, kept: 2, pruned: 1, idle: true, rounds: 2 }; };
  try {
    const { ctx, getLastSent } = mockCtx({ ws: '/ws/A' });
    const route = judgeRoute(ctx);
    const handled = await route('/judge/drain', 'POST', { method: 'POST' }, {}, mockU('/judge/drain', { node: 's/anchor', budget: '12' }), null);
    assert.equal(handled, true, 'route handled the request');
    // query was parsed and forwarded to the sync drain
    assert.equal(received.node, 's/anchor', 'node forwarded from query');
    assert.equal(received.budget, 12, 'budget parsed from query');
    assert.equal(received.workspaceRoot, '/ws/A', 'workspace forwarded');
    const sent = getLastSent();
    assert.equal(sent.status, 200);
    assert.deepEqual(
      { judged: sent.body.judged, kept: sent.body.kept, pruned: sent.body.pruned, idle: sent.body.idle },
      { judged: 3, kept: 2, pruned: 1, idle: true },
      'response carries the drain counts'
    );
    assert.equal(sent.body.node, 's/anchor');
  } finally {
    hd.runJudgeDrainSync = orig;
  }
});

test('POST /judge/drain requires a node (400 when absent)', async () => {
  const { ctx, getLastSent } = mockCtx({ ws: '/ws/A' });
  const route = judgeRoute(ctx);
  const handled = await route('/judge/drain', 'POST', { method: 'POST' }, {}, mockU('/judge/drain', {}), null);
  assert.equal(handled, true);
  const sent = getLastSent();
  assert.equal(sent.status, 400, 'missing node ⇒ 400');
  assert.match(String(sent.body.error), /node/i);
});
