#!/usr/bin/env node
// Plain Node test for decideOne's CAPACITY-FILL + PARALLEL judge logic in daemon.js (no framework;
// matches test/judge-queue.test.js style). Run: node test/capacity-fill.test.js — exits non-zero on
// any failed assertion. Uses the exported test hooks (decideOne, __setOverlayForTest); requiring the
// module does NOT start a server (server only runs under require.main === module).
//
// Properties under test (the headroom→parallelism contract):
//   - headroom = maxConcurrency − running; spawn clamps take ≤ headroom (never past concurrency).
//   - tasks WIN: ready tasks fill headroom first; judge fans into LEFTOVER slots only.
//   - judgeSlots = min(headroom − spawnedThisTick, queueDepth, judgeParallelCap).
//   - a heartbeat with BOTH ready tasks AND queue returns spawn tasks AND judge:{parallel,budget}.
//   - running ≥ maxConcurrency → 0 slots → no judge directive.
//   - token-budget clamp reduces parallel to what remaining budget affords (≈ estPerTick each), and
//     charges L.spent so the loop still stops at tokenBudget.
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

// === running 0, deep queue → judge parallel = min(10, depth, 6) = 6 ===========================
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));   // no ready tasks → pure judge
  ok('running0 deep queue → judge_edges', d.action === 'judge_edges');
  ok('running0 → parallel = min(10,20,6) = 6', d.parallel === 6);
  ok('running0 → budget = budgetPerRun (6)', d.budget === 6);
}

// === running 3 → headroom 7 → parallel = min(7, depth, 6) = 6 ==================================
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(3, 0)));
  ok('running3 → parallel = min(7,20,6) = 6', d.action === 'judge_edges' && d.parallel === 6);
}

// === running 9 → headroom 1 → parallel = 1 (clamped by headroom, below the cap) ===============
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(9, 0)));
  ok('running9 → parallel = min(1,20,6) = 1', d.action === 'judge_edges' && d.parallel === 1);
}

// === running ≥ maxConcurrency → 0 slots → NO judge directive ==================================
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(10, 0)));
  ok('running10 (=cap) → no judge_edges', d.action !== 'judge_edges' && d.judge == null);
  ok('running10 with work in flight → idle', d.action === 'idle');
}
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(12, 0)));  // over the cap
  ok('running12 (>cap) → no judge_edges', d.action !== 'judge_edges' && d.judge == null);
}

// === judgeSlots cap at judgeParallelCap (small cap dominates) ==================================
{
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop({ config: { judgeParallelCap: 2 } });
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('judgeParallelCap=2 caps parallel at 2 (min(10,20,2))', d.action === 'judge_edges' && d.parallel === 2);
}

// === queue depth dominates when shallow (min picks depth) =====================================
{
  daemon.__setOverlayForTest(makeOverlay(3));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('shallow queue depth=3 → parallel = min(10,3,6) = 3', d.action === 'judge_edges' && d.parallel === 3);
}

// === empty queue → no judge directive → falls through to drained/stop ==========================
{
  daemon.__setOverlayForTest(makeOverlay(0));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('empty queue → not judge_edges', d.action !== 'judge_edges' && d.judge == null);
}

// === BOTH: ready tasks AND queue → spawn tasks AND judge:{parallel,budget} =====================
{
  // running 2, ready 3, deep queue, cap room. headroom = 8. spawn take = min(batch8, pool, 8) = 3
  // (only 3 ready). spawnedThisTick = 3. judgeSlots = min(8−3=5, depth20, cap6) = 5.
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(2, 3)));
  ok('both: action is spawn', d.action === 'spawn');
  ok('both: spawns the 3 ready tasks', d.tasks && d.tasks.length === 3);
  ok('both: attaches judge directive', !!d.judge);
  ok('both: judge.parallel = min(8−3, 20, 6) = 5', d.judge && d.judge.parallel === 5);
  ok('both: judge.budget = budgetPerRun (6)', d.judge && d.judge.budget === 6);
}

// === tasks WIN: ready fills headroom first, judge gets the remainder ==========================
{
  // running 0, ready 9 (more than batch). batch=8 so take = min(8, pool, headroom10) = 8.
  // spawnedThisTick = 8. judgeSlots = min(10−8=2, depth20, cap6) = 2.
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 9)));
  ok('tasks-win: spawns batch of 8', d.action === 'spawn' && d.tasks.length === 8);
  ok('tasks-win: judge gets leftover 2 slots (min(10−8,20,6))', d.judge && d.judge.parallel === 2);
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

// === token-budget clamp REDUCES parallel to what budget affords ===============================
{
  // estPerTick 800. Set tokenBudget so that after the tick's own estPerTick charge, remaining affords
  // only ~2 efforts. spent starts 0; decideOne charges +800 → spent 800. tokenBudget = 800 + 2*800 =
  // 2400 → remaining 1600 → affordable = floor(1600/800) = 2. judgeSlots clamps 6 → 2.
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop({ config: { tokenBudget: 2400, estPerTick: 800 } });
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('budget clamp: parallel reduced to 2 (affordable)', d.action === 'judge_edges' && d.parallel === 2);
  ok('budget clamp: L.spent charges all K efforts (800 + 2*800 = 2400)', L.spent === 2400);
}

// === loop STILL STOPS at tokenBudget with judge work pending ==================================
{
  // After the clamp above charged spent to the budget, the NEXT tick's guard must flip to stop.
  daemon.__setOverlayForTest(makeOverlay(20));
  const L = makeLoop({ config: { tokenBudget: 2400, estPerTick: 800 }, spent: 2400 });
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  // decideOne adds another estPerTick (→3200 > 2400) → cap guard fires BEFORE the judge logic.
  ok('budget exhausted → action stop (not judge_edges)', d.action === 'stop' && /budget/.test(d.reason));
  ok('exhausted loop deactivated', L.active === false);
}

// === tiny budget that affords ZERO efforts → no judge directive ===============================
{
  // tokenBudget barely above one estPerTick: after the tick charge, remaining < estPerTick → affordable 0.
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
