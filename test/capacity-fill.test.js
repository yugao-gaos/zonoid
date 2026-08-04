#!/usr/bin/env node
// Plain Node test for decideOne's CAPACITY-FILL task-spawn logic in daemon.js (no framework;
// matches test/judge-queue.test.js style). Run: node test/capacity-fill.test.js — exits non-zero on
// any failed assertion. Uses the exported test hooks (decideOne, __setOverlayForTest); requiring the
// module does NOT start a server (server only runs under require.main === module).
//
// Properties under test (the headroom→task-spawn contract):
//   - headroom = maxConcurrency − running; spawn clamps take ≤ headroom (never past concurrency).
//   - judge/review queues are daemon-owned internal drains and never appear as visible loop actions.
//   - a heartbeat with BOTH ready tasks AND queue returns spawn tasks only.
//   - running ≥ maxConcurrency → 0 task slots → idle, still no judge directive.
'use strict';
const ov = require('../lib/overlay');
const daemon = require('../daemon.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --- fixtures ---------------------------------------------------------------------------------
// A graph with `running` in_progress tasks and `ready` ready tasks (labels/ids synthetic).
function makeGraph(running, ready) {
  const tasks = [];
  for (let i = 0; i < running; i++) tasks.push({ id: `s/r${i}`, label: `running ${i}`, status: 'in_progress', deps: [] });
  for (let i = 0; i < ready; i++) tasks.push({ id: `s/q${i}`, label: `ready ${i}`, status: 'ready', deps: [] });
  return { tasks, ghosts: [] };
}
// An overlay whose judge queue has `depth` UNVERIFIED note->note context edges (judgeQueueDepth counts
// each as one pending item). config.judge.budgetPerRun fixes the per-effort budget the directive reports.
function makeOverlay(depth, budgetPerRun = 6) {
  const o = ov.EMPTY();
  o.epoch = 1;
  o.config = { ...o.config, judge: { budgetPerRun } };
  o.edges = [];
  for (let i = 0; i < depth; i++) o.edges.push({ from: `note:a${i}`, to: `note:b${i}`, kind: 'context', judged: false });
  return o;
}
// A loop entry. iterations/spent are pre-advanced by decideOne, but the caller normally does that; here
// we seed them at the values decideOne would see AFTER its own increment (it ++iterations and adds
// estPerTick before the spawn/judge logic). We pass iterations one BELOW the cap and spent one
// estPerTick below where the budget bites, then let decideOne advance them.
function makeLoop(over = {}) {
  const config = { tokenBudget: 100000, maxIterations: 200, minPoll: 30, maxPoll: 1200, estPerTick: 800, batch: 8, maxConcurrency: 10, judgeParallelCap: 6, ...(over.config || {}) };
  return { id: 'L', active: true, iterations: 0, spent: 0, baseline: 0, real: false, startedAt: null, session: null, lastProgress: null, config, ...over, config };
}
function ctxFor(g) { return { graph: g, pendingGuidance: [], batch: { remaining: 999 } }; }

// === pure judge backlog is internal: no visible judge action ==================================
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('running0 deep queue → no judge_edges action', d.action !== 'judge_edges' && d.action !== 'judge_eager');
  ok('running0 deep queue → no judge directive', d.judge == null && d.eager == null);
  ok('pure internal judge backlog lets loop drain/stop', d.action === 'stop');
}

// === running ≥ maxConcurrency → 0 task slots → idle, NO judge directive ========================
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(10, 0)));
  ok('running10 (=cap) → no judge_edges', d.action !== 'judge_edges' && d.judge == null && d.eager == null);
  ok('running10 with work in flight → idle', d.action === 'idle');
}
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(12, 0)));  // over the cap
  ok('running12 (>cap) → no judge_edges', d.action !== 'judge_edges' && d.judge == null && d.eager == null);
}

// === empty queue → falls through to drained/stop ===============================================
{
  daemon.__setOverlayForTest(makeOverlay(0));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('empty queue → not judge_edges', d.action !== 'judge_edges' && d.judge == null);
}

// === BOTH: ready tasks AND queue → spawn tasks only ===========================================
{
  // running 2, ready 3, deep queue, cap room. headroom = 8. spawn take = min(batch8, pool, 8) = 3.
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(2, 3)));
  ok('both: action is spawn', d.action === 'spawn');
  ok('both: spawns the 3 ready tasks', d.tasks && d.tasks.length === 3);
  ok('both: no visible judge directive', d.judge == null && d.eager == null);
}

// === ready tasks fill the task headroom without attaching judge work ===========================
{
  // running 0, ready 9 (more than batch). batch=8 so take = min(8, pool, headroom10) = 8.
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 9)));
  ok('ready batch: spawns batch of 8', d.action === 'spawn' && d.tasks.length === 8);
  ok('ready batch: no visible judge directive', d.judge == null && d.eager == null);
}
{
  // ready fully consumes headroom → no leftover slots → spawn with NO judge directive.
  // running 0, ready 10, batch 10, maxConcurrency 10. take = 10, spawnedThisTick=10, leftover 0.
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop({ config: { batch: 10 } });
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 10)));
  ok('headroom fully consumed by tasks → spawn, NO judge', d.action === 'spawn' && d.tasks.length === 10 && d.judge == null);
}

// === spawn clamped by headroom (never past concurrency) =======================================
{
  // running 8, ready 9, batch 8, maxConcurrency 10. headroom = 2. take = min(8, pool, 2) = 2.
  daemon.__setOverlayForTest(makeOverlay(0));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(8, 9)));
  ok('spawn clamped to headroom=2 (not batch=8)', d.action === 'spawn' && d.tasks.length === 2);
}

// === loop STILL STOPS at tokenBudget with internal judge work pending ==========================
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop({ config: { tokenBudget: 2400, estPerTick: 800 }, spent: 2400 });
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  // decideOne adds another estPerTick (→3200 > 2400) → cap guard fires before any task logic.
  ok('budget exhausted → action stop (not judge_edges)', d.action === 'stop' && /budget/.test(d.reason));
  ok('exhausted loop deactivated', L.active === false);
}

// === tiny budget with internal judge work → no visible judge directive =========================
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop({ config: { tokenBudget: 1000, estPerTick: 800 } });  // spent→800, remaining 200, afford 0
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('budget affords 0 judge efforts → not judge_edges', d.action !== 'judge_edges');
}

// === UNWIRED quarantine: ready-but-unwired tasks are never spawned, surfaced in wire[] =========
{
  // 3 ready tasks, q0 flagged unwired in the overlay. Spawn must take only q1/q2; q0 goes to wire[].
  const o = makeOverlay(0);
  o.unwired = { 's/q0': true };
  daemon.__setOverlayForTest(o);
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 3)));
  ok('unwired: action is spawn (wired siblings exist)', d.action === 'spawn');
  ok('unwired: q0 NOT in spawn list', d.tasks && d.tasks.every((t) => t.key !== 's/q0'));
  ok('unwired: spawns only the 2 wired tasks', d.tasks && d.tasks.length === 2);
  ok('unwired: q0 listed in wire[]', Array.isArray(d.wire) && d.wire.length === 1 && d.wire[0].key === 's/q0' && d.wire[0].label === 'ready 0');
}
{
  // ONLY unwired ready tasks remain → idle with wire[] (NOT spawn, NOT a drained stop — the
  // dispatcher must wire/root them; they become spawnable next tick).
  const o = makeOverlay(0);
  o.unwired = { 's/q0': true };
  daemon.__setOverlayForTest(o);
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 1)));
  ok('all-unwired: idle, not spawn', d.action === 'idle');
  ok('all-unwired: not a drained stop (loop stays active)', L.active === true);
  ok('all-unwired: wire[] carries the task', Array.isArray(d.wire) && d.wire[0].key === 's/q0');
}
{
  // Flag cleared (simulating add_dependency wiring it in) → the task is spawnable again.
  const o = makeOverlay(0);
  o.unwired = { 's/q0': true };
  delete o.unwired['s/q0'];                                  // what lib/overlay addEdge/mark-root does
  daemon.__setOverlayForTest(o);
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 1)));
  ok('cleared: q0 spawnable after wiring', d.action === 'spawn' && d.tasks.length === 1 && d.tasks[0].key === 's/q0');
  ok('cleared: no wire field on the decision', d.wire == null);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
