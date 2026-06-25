#!/usr/bin/env node
// Unit tests for lib/pressure-nudge.js capacity gate.
// Run: node test/pressure-nudge.test.js
'use strict';
const {
  JUDGE_DEPTH, LABEL_DEPTH, DEFAULT_MAX_RUNNING,
  countRunning, harnessInProgress, computePressureNudge,
} = require('../lib/pressure-nudge');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

function makeBuildGraph(running, harnessStatus, harnessKey) {
  const tasks = [];
  for (let i = 0; i < running; i++) {
    tasks.push({ id: `task/r${i}`, status: 'in_progress' });
  }
  if (harnessKey && harnessStatus) {
    tasks.push({ id: harnessKey, status: harnessStatus });
  }
  return () => ({ tasks });
}

// ── below threshold → nudge:false ────────────────────────────────────────────
{
  const r = computePressureNudge({
    depth: JUDGE_DEPTH - 1,
    depthThreshold: JUDGE_DEPTH,
    buildGraph: makeBuildGraph(0),
    ws: '/tmp/ws',
    overlay: {},
    harnessKey: 'followup/harness-judge-drain',
  });
  ok('below threshold: nudge false', r.nudge === false);
  ok('below threshold: capacity_ok true', r.capacity_ok === true);
}

// ── at threshold, capacity available → nudge:true ─────────────────────────────
{
  const r = computePressureNudge({
    depth: JUDGE_DEPTH,
    depthThreshold: JUDGE_DEPTH,
    buildGraph: makeBuildGraph(0),
    ws: '/tmp/ws',
    overlay: {},
    harnessKey: 'followup/harness-judge-drain',
  });
  ok('at threshold: nudge true', r.nudge === true);
  ok('at threshold: running 0', r.running === 0);
}

// ── immediate repeat → still nudge:true (no debounce) ─────────────────────────
{
  const buildGraph = makeBuildGraph(0);
  const args = {
    depth: LABEL_DEPTH,
    depthThreshold: LABEL_DEPTH,
    buildGraph,
    ws: '/tmp/ws',
    overlay: {},
    harnessKey: 'followup/harness-label-drain',
  };
  const r1 = computePressureNudge(args);
  const r2 = computePressureNudge(args);
  ok('repeat call 1: nudge true', r1.nudge === true);
  ok('repeat call 2: nudge true', r2.nudge === true);
}

// ── at capacity (10 in_progress) → nudge:false ────────────────────────────────
{
  const r = computePressureNudge({
    depth: JUDGE_DEPTH,
    depthThreshold: JUDGE_DEPTH,
    buildGraph: makeBuildGraph(DEFAULT_MAX_RUNNING),
    ws: '/tmp/ws',
    overlay: {},
    harnessKey: 'followup/harness-judge-drain',
  });
  ok('at capacity: nudge false', r.nudge === false);
  ok('at capacity: capacity_ok false', r.capacity_ok === false);
  ok('at capacity: running 10', r.running === DEFAULT_MAX_RUNNING);
}

// ── harness drain in_progress → nudge:false ───────────────────────────────────
{
  const harnessKey = 'followup/harness-judge-drain';
  const overlay = { status: { [harnessKey]: 'in_progress' } };
  const r = computePressureNudge({
    depth: JUDGE_DEPTH,
    depthThreshold: JUDGE_DEPTH,
    buildGraph: makeBuildGraph(0),
    ws: '/tmp/ws',
    overlay,
    harnessKey,
  });
  ok('drain in flight: nudge false', r.nudge === false);
  ok('drain in flight: drain_in_progress true', r.drain_in_progress === true);
}

// ── eager dispatch active → judge nudge demoted to fallback (nudge:false) ─────
{
  const r = computePressureNudge({
    depth: JUDGE_DEPTH,
    depthThreshold: JUDGE_DEPTH,
    buildGraph: makeBuildGraph(0),
    ws: '/tmp/ws',
    overlay: {},
    harnessKey: 'followup/harness-judge-drain',
    eagerActive: true,
  });
  ok('eager active: nudge false (demoted to fallback)', r.nudge === false);
  ok('eager active: eager_active true', r.eager_active === true);
}

// ── eager idle (default) → catch-up nudge re-arms ─────────────────────────────
{
  const r = computePressureNudge({
    depth: JUDGE_DEPTH,
    depthThreshold: JUDGE_DEPTH,
    buildGraph: makeBuildGraph(0),
    ws: '/tmp/ws',
    overlay: {},
    harnessKey: 'followup/harness-judge-drain',
    eagerActive: false,
  });
  ok('eager idle: nudge true (fallback fires)', r.nudge === true);
  ok('eager idle: eager_active false', r.eager_active === false);
}

// ── harnessInProgress via buildGraph ──────────────────────────────────────────
{
  const harnessKey = 'followup/harness-label-drain';
  const buildGraph = makeBuildGraph(0, 'in_progress', harnessKey);
  ok('harnessInProgress overlay', harnessInProgress({ status: { [harnessKey]: 'in_progress' } }, buildGraph, '/tmp/ws', harnessKey));
  ok('harnessInProgress graph', harnessInProgress({}, buildGraph, '/tmp/ws', harnessKey));
  ok('harnessInProgress absent', !harnessInProgress({}, makeBuildGraph(0), '/tmp/ws', harnessKey));
}

// ── countRunning ──────────────────────────────────────────────────────────────
{
  ok('countRunning 3', countRunning(makeBuildGraph(3), '/tmp/ws') === 3);
  ok('countRunning no ws', countRunning(makeBuildGraph(3), null) === 0);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
