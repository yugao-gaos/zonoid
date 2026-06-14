#!/usr/bin/env node
// Plain Node test for the EAGER event-triggered judge dispatch (task C) — no framework; matches
// test/capacity-fill.test.js / judge-queue.test.js style. Run: node test/judge-eager.test.js —
// exits non-zero on any failed assertion. Requiring daemon.js does NOT start a server.
//
// Properties under test (the eager-dispatch contract — daemon stays DUMB, signals only):
//   PURE substrate (lib/overlay + lib/judge):
//     - markEagerJudge stamps a node with the current epoch; clearEagerJudge removes it.
//     - eagerJudgeNodes returns marked nodes FIFO (oldest epoch first) and SELF-PRUNES marks whose
//       candidate edge-set is fully judged (drained) — a node never re-dispatches once resolved.
//     - buildQueueForNode returns ONLY the unverified context edges incident to the node (whole
//       edge-set, one dispatch covers all), stably ordered, excluding clusters/orphans.
//   DISPATCH (daemon.decideOne):
//     - a marked node makes the heartbeat emit action:'judge_eager' with nodes:[key] (the PRIMARY
//       judge trigger) — NOT the periodic judge_edges — within ONE tick (no periodic wait).
//     - one dispatch per node's full edge-set (nodes carries node keys, not per-edge items).
//     - a creation BURST respects the concurrency cap (judgeParallelCap): excess nodes stay marked.
//     - eager runs AHEAD of the periodic drain; tasks still win headroom first.
//     - no eager marks → falls back to the periodic judge_edges exactly as before.
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');
const daemon = require('../daemon.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --- PURE: markEagerJudge / clearEagerJudge -----------------------------------------------------
{
  const o = ov.EMPTY();
  o.epoch = 5;
  ov.markEagerJudge(o, 's/1');
  ok('markEagerJudge stamps node with current epoch', o.eagerJudge['s/1'] === 5);
  ov.markEagerJudge(o, null);
  ok('markEagerJudge ignores null key', Object.keys(o.eagerJudge).length === 1);
  ok('clearEagerJudge removes the mark (returns true)', ov.clearEagerJudge(o, 's/1') === true && !('s/1' in o.eagerJudge));
  ok('clearEagerJudge on absent node returns false', ov.clearEagerJudge(o, 's/1') === false);
}

// --- PURE: eagerJudgeNodes FIFO order + self-prune of drained marks ------------------------------
{
  const o = ov.EMPTY();
  o.epoch = 1; ov.markEagerJudge(o, 's/late');   // stamped epoch 1
  o.epoch = 0; ov.markEagerJudge(o, 's/early');  // stamped epoch 0 (older) — should come first
  // both have an unverified incident edge so neither is pruned
  o.edges = [
    { from: 's/early', to: 'note:a', kind: 'context', judged: false },
    { from: 'note:b', to: 's/late', kind: 'context', judged: false },
  ];
  const order = judge.eagerJudgeNodes(o);
  ok('eagerJudgeNodes FIFO: oldest epoch first', order[0] === 's/early' && order[1] === 's/late');
}
{
  // a marked node whose only incident edge is already judged → pruned from the signal (drained).
  const o = ov.EMPTY();
  o.epoch = 1; ov.markEagerJudge(o, 's/drained'); ov.markEagerJudge(o, 's/live');
  o.edges = [
    { from: 's/drained', to: 'note:a', kind: 'context', judged: true },   // already judged → not eager
    { from: 's/live', to: 'note:b', kind: 'context', judged: false },     // unverified → eager
  ];
  const pending = judge.eagerJudgeNodes(o);
  ok('eagerJudgeNodes drops the drained node', !pending.includes('s/drained') && pending.includes('s/live'));
  ok('eagerJudgeNodes prunes the drained mark in place', !('s/drained' in o.eagerJudge));
}

// --- PURE: buildQueueForNode = node's whole unverified edge-set (incident either endpoint) -------
{
  const o = ov.EMPTY();
  o.edges = [
    { from: 's/anchor', to: 's/t1', kind: 'context', judged: false },    // outgoing unverified → in
    { from: 'note:n1', to: 's/anchor', kind: 'context', judged: false }, // incoming unverified → in
    { from: 's/anchor', to: 's/t2', kind: 'context', judged: true },     // judged → out
    { from: 's/anchor', to: 's/t3', kind: 'blocking' },                  // blocking → out
    { from: 's/other', to: 's/t4', kind: 'context', judged: false },     // not incident → out
  ];
  const items = judge.buildQueueForNode(o, 's/anchor');
  ok('buildQueueForNode returns 2 incident unverified edges', items.length === 2);
  ok('buildQueueForNode items are kind:edge', items.every((i) => i.kind === 'edge'));
  ok('buildQueueForNode stably sorted by id', items[0].id <= items[1].id);
  ok('buildQueueForNode excludes judged/blocking/non-incident', !items.some((i) => i.to === 's/t2' || i.to === 's/t3' || i.from === 's/other'));
}

// === DISPATCH harness (mirrors capacity-fill.test.js) ==========================================
function makeGraph(running, ready) {
  const tasks = [];
  for (let i = 0; i < running; i++) tasks.push({ id: `s/r${i}`, label: `running ${i}`, status: 'in_progress', deps: [] });
  for (let i = 0; i < ready; i++) tasks.push({ id: `s/q${i}`, label: `ready ${i}`, status: 'ready', deps: [] });
  return { tasks, ghosts: [] };
}
function makeLoop(over = {}) {
  const config = { tokenBudget: 100000, maxIterations: 200, minPoll: 30, maxPoll: 1200, estPerTick: 800, batch: 8, maxConcurrency: 10, judgeParallelCap: 6, ...(over.config || {}) };
  return { id: 'L', active: true, iterations: 0, spent: 0, baseline: 0, real: false, startedAt: null, session: null, lastProgress: null, config, ...over, config };
}
function ctxFor(g) { return { graph: g, pendingGuidance: [], batch: { remaining: 999 } }; }
// overlay with `n` eager-marked nodes, each carrying ONE unverified incident edge (so none prune).
function eagerOverlay(n, budgetPerRun = 6) {
  const o = ov.EMPTY();
  o.epoch = 1;
  o.config = { ...o.config, judge: { budgetPerRun } };
  o.edges = [];
  for (let i = 0; i < n; i++) {
    ov.markEagerJudge(o, `s/e${i}`);
    o.edges.push({ from: `s/e${i}`, to: `note:p${i}`, kind: 'context', judged: false });
  }
  return o;
}

// === one eager node → judge_eager THIS tick (not periodic judge_edges) =========================
{
  daemon.__setOverlayForTest(eagerOverlay(1));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('one eager node → action judge_eager (primary, not judge_edges)', d.action === 'judge_eager');
  ok('judge_eager carries the node key', Array.isArray(d.nodes) && d.nodes.length === 1 && d.nodes[0] === 's/e0');
  ok('judge_eager budget = budgetPerRun', d.budget === 6);
}

// === ONE dispatch per node's full edge-set: a node with MANY edges = ONE node entry ============
{
  const o = ov.EMPTY();
  o.epoch = 1; o.config = { ...o.config, judge: { budgetPerRun: 6 } };
  ov.markEagerJudge(o, 's/fat');
  o.edges = [
    { from: 's/fat', to: 'note:a', kind: 'context', judged: false },
    { from: 's/fat', to: 'note:b', kind: 'context', judged: false },
    { from: 's/fat', to: 'note:c', kind: 'context', judged: false },
  ];
  daemon.__setOverlayForTest(o);
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('fat node = ONE node entry (not one per edge)', d.action === 'judge_eager' && d.nodes.length === 1 && d.nodes[0] === 's/fat');
  // and the node-scoped queue would hand a judge all 3 edges in one dispatch
  ok('node-scoped queue covers the whole 3-edge set', judge.buildQueueForNode(o, 's/fat').length === 3);
}

// === BURST respects the concurrency cap: 10 nodes minted, cap=6 → 6 dispatched, 4 stay marked ===
{
  const o = eagerOverlay(10);
  daemon.__setOverlayForTest(o);
  const L = makeLoop({ config: { judgeParallelCap: 6 } });
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('burst of 10 → judge_eager', d.action === 'judge_eager');
  ok('burst capped at judgeParallelCap=6 nodes', d.nodes.length === 6);
  // the daemon does NOT clear marks (the /judge/next?node call clears on dispatch) → all 10 still marked,
  // so the next tick drains the remaining 4. eagerJudgeNodes still reports all 10 pending here.
  ok('excess nodes stay marked for next tick', judge.eagerJudgeNodes(o).length === 10);
}

// === burst clamped by HEADROOM too (running workers eat slots) =================================
{
  daemon.__setOverlayForTest(eagerOverlay(10));
  const L = makeLoop();   // judgeParallelCap 6, maxConcurrency 10
  const d = daemon.decideOne(L, ctxFor(makeGraph(9, 0)));  // headroom 1
  ok('headroom 1 → only 1 eager node dispatched', d.action === 'judge_eager' && d.nodes.length === 1);
}

// === eager is PRIMARY: with BOTH a ready task and eager nodes, spawn carries eager (tasks win) ===
{
  daemon.__setOverlayForTest(eagerOverlay(3));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 2)));   // 2 ready tasks
  ok('both: action spawn (tasks win headroom)', d.action === 'spawn' && d.tasks.length === 2);
  ok('both: spawn carries eager directive', d.eager && d.eager.nodes.length === 3);
}

// === NO eager marks → periodic judge_edges fallback (unchanged behavior) ========================
{
  const o = ov.EMPTY();
  o.epoch = 1; o.config = { ...o.config, judge: { budgetPerRun: 6 } };
  o.edges = [];
  for (let i = 0; i < 5; i++) o.edges.push({ from: `note:a${i}`, to: `note:b${i}`, kind: 'context', judged: false });
  // NO markEagerJudge calls → eager queue empty
  daemon.__setOverlayForTest(o);
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('no eager marks → falls back to periodic judge_edges', d.action === 'judge_edges' && d.parallel === 5);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
