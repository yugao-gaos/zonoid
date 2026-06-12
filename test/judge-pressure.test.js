#!/usr/bin/env node
// Tests for GET /judge/pressure — queue depth, dup-cluster count, and rate-limited nudge.
// Exercises the route module directly with a minimal ctx mock (no port binding needed).
// Run: node test/judge-pressure.test.js — exits non-zero on any failed assertion.
//
// Properties under test:
//   - depth == buildQueue().length, dupClusters == count of dup-cluster items.
//   - nudge:false when depth < NUDGE_DEPTH.
//   - nudge:true on FIRST call when depth >= NUDGE_DEPTH AND stamp is stale.
//   - nudge:false on SECOND call within the hour window (stamp was set by first).
//   - Clock and stamp are injectable via _lastNudgeAt (module-level let, exported for test seam).
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// We test the pressure logic by extracting it inline (same logic as the route, but without HTTP).
// The route uses module-level _lastNudgeAt and Date.now(). We replicate the logic here and
// verify the stamp seam via the route module's exported seam.
//
// Rather than binding a port, we verify the route module directly: require it and call the
// returned async handler with a minimal mock req/res/ctx.

// Minimal mock ctx: injects a controllable overlay and a capture for send().
function makeMockCtx(overlay) {
  let lastSent = null;
  const ctx = {
    get state() { return { overlay }; },
    send(res, status, body) { lastSent = { status, body }; },
    readBody: async () => ({}),
    notifyChange: () => {},
    buildGraph: () => ({ tasks: [] }),
    targetOverlay: () => ({ ov: overlay, ws: null, save: () => {} }),
    noteRagCandidates: () => [],
  };
  function getLastSent() { return lastSent; }
  return { ctx, getLastSent };
}

// We need to reset _lastNudgeAt between tests. The route module exports it via a seam function.
// Since Node caches modules, we control the stamp by monkey-patching via a seam we add to the module.
// The route module exposes _setLastNudgeAt for test use (see routes/judge.js).
const judgeRoute = require('../routes/judge');
// If the seam isn't present, fall back to requiring from module cache (tests still run via the logic).

// Helper: call the route with GET /judge/pressure and return the sent body.
async function callPressure(ctx) {
  const route = judgeRoute(ctx);
  const mockReq = { method: 'GET' };
  const mockRes = {};
  const mockU = { pathname: '/judge/pressure', searchParams: { get: () => null } };
  const handled = await route('/judge/pressure', 'GET', mockReq, mockRes, mockU, null);
  return handled;
}

// ── Test 1: below threshold → nudge:false ──────────────────────────────────────────────────────
{
  const overlay = ov.EMPTY();
  overlay.epoch = 1;
  // Add a small number of items (below NUDGE_DEPTH=30)
  overlay.edges = [
    { from: 'note:a', to: 'note:b', kind: 'context', judged: false },
  ];
  // Reset the nudge stamp to 0 (fresh state)
  if (judgeRoute._setLastNudgeAt) judgeRoute._setLastNudgeAt(0);

  const { ctx, getLastSent } = makeMockCtx(overlay);
  let handled;
  (async () => {
    handled = await callPressure(ctx);
  })();
  // spawnSync so we can check synchronously — use setImmediate flush
  setImmediate(() => {
    const result = getLastSent();
    ok('below-threshold: handled returns true', handled === true);
    ok('below-threshold: status 200', result && result.status === 200);
    ok('below-threshold: nudge:false', result && result.body.nudge === false);
    ok('below-threshold: depth == buildQueue length', result && result.body.depth === judge.buildQueue(overlay).length);
  });
}

// We run async tests sequentially via promises to avoid setImmediate races.
// Rewrite as a clean async IIFE:
(async () => {
  // Reset pass/fail from the sync block above (those haven't run yet — clear to start fresh).
  pass = 0; fail = 0;

  // ── 1: below threshold → nudge:false ──────────────────────────────────────────────────────────
  {
    const overlay = ov.EMPTY(); overlay.epoch = 1;
    overlay.edges = [
      { from: 'note:a', to: 'note:b', kind: 'context', judged: false },
    ];
    if (judgeRoute._setLastNudgeAt) judgeRoute._setLastNudgeAt(0);

    const { ctx, getLastSent } = makeMockCtx(overlay);
    const handled = await callPressure(ctx);
    const result = getLastSent();
    ok('below-threshold: handled returns true', handled === true);
    ok('below-threshold: status 200', result && result.status === 200);
    ok('below-threshold: nudge:false', result && result.body.nudge === false);
    ok('below-threshold: depth matches buildQueue', result && result.body.depth === judge.buildQueue(overlay).length);
    ok('below-threshold: dupClusters is 0', result && result.body.dupClusters === 0);
  }

  // ── 2: above threshold, stamp=0 → first call gets nudge:true ──────────────────────────────────
  {
    const dim = 384;
    const makeVec = (k) => { const a = new Array(dim).fill(0); a[0] = 1; a[1] = k * 0.01; const n = Math.hypot(a[0], a[1]); a[0] /= n; a[1] /= n; return a; };
    const overlay = ov.EMPTY(); overlay.epoch = 1;

    // Build 30+ queue items: 30 unverified edges (cheapest)
    overlay.edges = [];
    for (let i = 0; i < 30; i++) {
      overlay.edges.push({ from: `note:src${i}`, to: `note:dst${i}`, kind: 'context', judged: false });
    }
    // Also add a dup-cluster (2 notes with similar vecs)
    overlay.note_nodes = {
      d1: { id: 'd1', title: 'D1', summary: '', validTo: null, vec: makeVec(1) },
      d2: { id: 'd2', title: 'D2', summary: '', validTo: null, vec: makeVec(2) },
    };

    // Reset stamp to 0 (no nudge sent recently)
    if (judgeRoute._setLastNudgeAt) judgeRoute._setLastNudgeAt(0);

    const { ctx, getLastSent } = makeMockCtx(overlay);
    const handled = await callPressure(ctx);
    const result = getLastSent();
    ok('above-threshold first call: nudge:true', result && result.body.nudge === true);
    ok('above-threshold first call: depth >= 30', result && result.body.depth >= 30);
    ok('above-threshold first call: dupClusters >= 1', result && result.body.dupClusters >= 1);
  }

  // ── 3: second call within the hour → nudge:false (stamp already set) ──────────────────────────
  {
    const overlay = ov.EMPTY(); overlay.epoch = 1;
    overlay.edges = [];
    for (let i = 0; i < 30; i++) {
      overlay.edges.push({ from: `note:src${i}`, to: `note:dst${i}`, kind: 'context', judged: false });
    }

    // Stamp was set just now (within the hour)
    if (judgeRoute._setLastNudgeAt) judgeRoute._setLastNudgeAt(Date.now());

    const { ctx, getLastSent } = makeMockCtx(overlay);
    await callPressure(ctx);
    const result = getLastSent();
    ok('within-hour second call: nudge:false', result && result.body.nudge === false);
    ok('within-hour second call: depth still reported', result && result.body.depth >= 30);
  }

  // ── 4: after the hour window → nudge:true again ───────────────────────────────────────────────
  {
    const overlay = ov.EMPTY(); overlay.epoch = 1;
    overlay.edges = [];
    for (let i = 0; i < 30; i++) {
      overlay.edges.push({ from: `note:src${i}`, to: `note:dst${i}`, kind: 'context', judged: false });
    }

    // Stamp set over an hour ago
    if (judgeRoute._setLastNudgeAt) judgeRoute._setLastNudgeAt(Date.now() - 3600001);

    const { ctx, getLastSent } = makeMockCtx(overlay);
    await callPressure(ctx);
    const result = getLastSent();
    ok('after-hour window: nudge:true again', result && result.body.nudge === true);
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
