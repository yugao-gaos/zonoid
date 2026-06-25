#!/usr/bin/env node
// Tests for GET /judge/pressure — queue depth, dup-cluster count, and capacity-gated nudge.
// Run: node test/judge-pressure.test.js
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');
const judgeRoute = require('../routes/judge');
const { DEFAULT_MAX_RUNNING } = require('../lib/pressure-nudge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function makeBuildGraph(tasks) {
  return () => ({ tasks });
}

function makeMockCtx(overlay, tasks, ws) {
  let lastSent = null;
  const taskList = tasks || [];
  const ctx = {
    get state() { return { overlay, workspace: ws || '/tmp/ws' }; },
    send(res, status, body) { lastSent = { status, body }; },
    readBody: async () => ({}),
    notifyChange: () => {},
    buildGraph: makeBuildGraph(taskList),
    // P3: the route requires a resolved workspace (no daemon-global default), so bind one.
    targetOverlay: () => ({ ov: overlay, ws: ws || '/tmp/ws', save: () => {} }),
    noteRagCandidates: () => [],
  };
  function getLastSent() { return lastSent; }
  return { ctx, getLastSent };
}

async function callPressure(ctx) {
  const route = judgeRoute(ctx);
  const mockReq = { method: 'GET' };
  const mockRes = {};
  const mockU = { pathname: '/judge/pressure', searchParams: { get: () => null } };
  return route('/judge/pressure', 'GET', mockReq, mockRes, mockU, null);
}

(async () => {
  // ── 1: below threshold → nudge:false ────────────────────────────────────────
  {
    const overlay = ov.EMPTY(); overlay.epoch = 1;
    overlay.edges = [
      { from: 'note:a', to: 'note:b', kind: 'context', judged: false },
    ];
    const { ctx, getLastSent } = makeMockCtx(overlay, []);
    const handled = await callPressure(ctx);
    const result = getLastSent();
    ok('below-threshold: handled returns true', handled === true);
    ok('below-threshold: status 200', result && result.status === 200);
    ok('below-threshold: nudge:false', result && result.body.nudge === false);
    ok('below-threshold: depth matches buildQueue', result && result.body.depth === judge.buildQueue(overlay).length);
    ok('below-threshold: dupClusters is 0', result && result.body.dupClusters === 0);
  }

  // ── 2: above threshold, capacity available → nudge:true ─────────────────────
  {
    const overlay = ov.EMPTY(); overlay.epoch = 1;
    overlay.edges = [];
    for (let i = 0; i < 30; i++) {
      overlay.edges.push({ from: `note:src${i}`, to: `note:dst${i}`, kind: 'context', judged: false });
    }
    const dim = 384;
    const makeVec = (k) => { const a = new Array(dim).fill(0); a[0] = 1; a[1] = k * 0.01; const n = Math.hypot(a[0], a[1]); a[0] /= n; a[1] /= n; return a; };
    overlay.note_nodes = {
      d1: { id: 'd1', title: 'D1', summary: '', validTo: null, vec: makeVec(1) },
      d2: { id: 'd2', title: 'D2', summary: '', validTo: null, vec: makeVec(2) },
    };

    const { ctx, getLastSent } = makeMockCtx(overlay, []);
    await callPressure(ctx);
    const result = getLastSent();
    ok('above-threshold: nudge:true', result && result.body.nudge === true);
    ok('above-threshold: depth >= 30', result && result.body.depth >= 30);
    ok('above-threshold: dupClusters >= 1', result && result.body.dupClusters >= 1);
    ok('above-threshold: capacity_ok true', result && result.body.capacity_ok === true);
  }

  // ── 3: immediate repeat → nudge:true (no debounce) ──────────────────────────
  {
    const overlay = ov.EMPTY(); overlay.epoch = 1;
    overlay.edges = [];
    for (let i = 0; i < 30; i++) {
      overlay.edges.push({ from: `note:src${i}`, to: `note:dst${i}`, kind: 'context', judged: false });
    }
    const { ctx, getLastSent } = makeMockCtx(overlay, []);
    await callPressure(ctx);
    await callPressure(ctx);
    const result = getLastSent();
    ok('immediate repeat: nudge:true', result && result.body.nudge === true);
    ok('immediate repeat: depth still reported', result && result.body.depth >= 30);
  }

  // ── 4: at capacity (10 in_progress) → nudge:false ───────────────────────────
  {
    const overlay = ov.EMPTY(); overlay.epoch = 1;
    overlay.edges = [];
    for (let i = 0; i < 30; i++) {
      overlay.edges.push({ from: `note:src${i}`, to: `note:dst${i}`, kind: 'context', judged: false });
    }
    const tasks = Array.from({ length: DEFAULT_MAX_RUNNING }, (_, i) => ({ id: `task/r${i}`, status: 'in_progress' }));
    const { ctx, getLastSent } = makeMockCtx(overlay, tasks);
    await callPressure(ctx);
    const result = getLastSent();
    ok('at capacity: nudge:false', result && result.body.nudge === false);
    ok('at capacity: capacity_ok false', result && result.body.capacity_ok === false);
    ok('at capacity: running 10', result && result.body.running === DEFAULT_MAX_RUNNING);
  }

  // ── 5: harness drain in_progress → nudge:false ──────────────────────────────
  {
    const overlay = ov.EMPTY(); overlay.epoch = 1;
    overlay.edges = [];
    for (let i = 0; i < 30; i++) {
      overlay.edges.push({ from: `note:src${i}`, to: `note:dst${i}`, kind: 'context', judged: false });
    }
    overlay.status[judgeRoute.HARNESS_JUDGE_DRAIN_KEY] = 'in_progress';
    const { ctx, getLastSent } = makeMockCtx(overlay, []);
    await callPressure(ctx);
    const result = getLastSent();
    ok('harness in_progress: nudge:false', result && result.body.nudge === false);
    ok('harness in_progress: drain_in_progress true', result && result.body.drain_in_progress === true);
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
