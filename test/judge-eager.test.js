#!/usr/bin/env node
// Plain Node test for the EAGER event-triggered judge queue (task C) — no framework; matches
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
//   DAEMON-OWNED DRAIN (lib/headless-drain):
//     - /next-action does NOT emit judge_eager/judge_edges actions; visible loops stay task-only.
//     - the headless drain claims eager nodes by lease, then runs node-scoped /judge/next?node work.
//     - one drain claim covers each node's full edge-set (node keys, not per-edge items).
//     - a creation BURST can be capped by the drain pump; excess nodes stay unleased for a later tick.
//     - periodic backlog remains due work for headless-drain, not a foreground loop action.
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');
const daemon = require('../daemon.js');
const hd = require('../lib/headless-drain');
const {
  HARNESS_JUDGE_DRAIN_KEY,
  HARNESS_LABEL_DRAIN_KEY,
  HARNESS_LEARNER_DRAIN_KEY,
} = require('../lib/harness-task');

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

// --- PURE: eagerJudgePending = is eager dispatch actively covering work (no mutation) -----------
{
  const o = ov.EMPTY();
  ok('eagerJudgePending: no marks → false', judge.eagerJudgePending(o) === false);
  o.epoch = 1; ov.markEagerJudge(o, 's/live');
  o.edges = [{ from: 's/live', to: 'note:b', kind: 'context', judged: false }];
  ok('eagerJudgePending: marked node with unverified edge → true', judge.eagerJudgePending(o) === true);
  // PURE: must NOT prune even a fully-drained mark (unlike eagerJudgeNodes).
  const o2 = ov.EMPTY();
  o2.epoch = 1; ov.markEagerJudge(o2, 's/drained');
  o2.edges = [{ from: 's/drained', to: 'note:a', kind: 'context', judged: true }];
  ok('eagerJudgePending: only-judged edges → false', judge.eagerJudgePending(o2) === false);
  ok('eagerJudgePending: does NOT mutate marks (pure)', 's/drained' in o2.eagerJudge);
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

// === standing harness drains are daemon/headless-owned, not interactive spawns ==================
{
  daemon.__setOverlayForTest(ov.EMPTY());
  const L = makeLoop();
  const g = {
    tasks: [
      { id: HARNESS_JUDGE_DRAIN_KEY, label: 'harness: judge drain', status: 'ready', deps: [] },
      { id: HARNESS_LABEL_DRAIN_KEY, label: 'harness: label drain', status: 'ready', deps: [] },
      { id: HARNESS_LEARNER_DRAIN_KEY, label: 'harness: learner drain', status: 'ready', deps: [] },
      { id: 's/user-ready', label: 'user ready', status: 'ready', deps: [] },
    ],
    ghosts: [],
  };
  const d = daemon.decideOne(L, ctxFor(g));
  ok('standing harness drains excluded from interactive spawn pool',
    d.action === 'spawn' &&
    d.tasks.length === 1 &&
    d.tasks[0].key === 's/user-ready');
}

// === one eager node stays off /next-action; headless-drain claims it ===========================
{
  const o = eagerOverlay(1);
  daemon.__setOverlayForTest(o);
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('one eager node → no visible judge action', d.action !== 'judge_eager' && d.action !== 'judge_edges' && !d.eager && !d.judge);
  ok('one eager node with no task work lets the loop drain/stop', d.action === 'stop');
  ok('next-action did not consume the eager mark', o.eagerJudge && o.eagerJudge['s/e0'] === 1);

  let saved = 0;
  const due = hd.claimDueJudgeWork('/irrelevant', {
    overlayLoad: () => o,
    overlaySave: () => { saved++; },
    overlayStore: ov,
    judgeLib: judge,
  }, { leaseOwner: 'test-drain', leaseTtlMs: 60000 });
  ok('headless drain claims the eager node', due.eagerNodes.length === 1 && due.eagerNodes[0] === 's/e0');
  ok('headless drain leases the claimed node', o.eagerJudgeLease && o.eagerJudgeLease['s/e0'] && o.eagerJudgeLease['s/e0'].loopId === 'test-drain');
  ok('periodic depth excludes the leased eager edge', due.periodic === false && due.depth === 0);
  ok('claim persists the lease when a save seam is supplied', saved === 1);
}

// === ONE claim per node's full edge-set: a node with MANY edges = ONE node entry ===============
{
  const o = ov.EMPTY();
  o.epoch = 1; o.config = { ...o.config, judge: { budgetPerRun: 6 } };
  ov.markEagerJudge(o, 's/fat');
  o.edges = [
    { from: 's/fat', to: 'note:a', kind: 'context', judged: false },
    { from: 's/fat', to: 'note:b', kind: 'context', judged: false },
    { from: 's/fat', to: 'note:c', kind: 'context', judged: false },
  ];
  const due = hd.claimDueJudgeWork('/irrelevant', {
    overlayLoad: () => o,
    overlayStore: ov,
    judgeLib: judge,
  }, { leaseOwner: 'test-drain', leaseTtlMs: 60000 });
  ok('fat node = ONE node entry (not one per edge)', due.eagerNodes.length === 1 && due.eagerNodes[0] === 's/fat');
  // and the node-scoped queue would hand a judge all 3 edges in one dispatch
  ok('node-scoped queue covers the whole 3-edge set', judge.buildQueueForNode(o, 's/fat').length === 3);
}

// === BURST respects the drain claim cap: 10 nodes minted, cap=6 → 6 leased, 4 stay available =====
{
  const o = eagerOverlay(10);
  const due = hd.claimDueJudgeWork('/irrelevant', {
    overlayLoad: () => o,
    overlayStore: ov,
    judgeLib: judge,
  }, { leaseOwner: 'test-drain', leaseTtlMs: 60000, maxEagerNodes: 6 });
  ok('burst claim returns eager nodes', due.eagerNodes.length === 6);
  ok('burst capped at maxEagerNodes=6', Object.keys(o.eagerJudgeLease || {}).length === 6);
  // 6 are leased; 4 remain unleased. eagerJudgeNodes skips leased nodes,
  // so the next tick sees 4 dispatchable (excess). The eagerJudge marks themselves stay (10 total).
  ok('excess nodes stay marked for next tick', Object.keys(o.eagerJudge || {}).length === 10);
  ok('excess unleased nodes available next tick', judge.eagerJudgeNodes(o).length === 4);
}

// === with BOTH a ready task and eager nodes, /next-action spawns tasks only =====================
{
  daemon.__setOverlayForTest(eagerOverlay(3));
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 2)));   // 2 ready tasks
  ok('both: action spawn (tasks win headroom)', d.action === 'spawn' && d.tasks.length === 2);
  ok('both: spawn carries no visible judge directive', !d.eager && !d.judge);
}

// === NO eager marks → periodic backlog is headless-drain due work, not a loop action ============
{
  const o = ov.EMPTY();
  o.epoch = 1; o.config = { ...o.config, judge: { budgetPerRun: 6 } };
  o.edges = [];
  for (let i = 0; i < 5; i++) o.edges.push({ from: `note:a${i}`, to: `note:b${i}`, kind: 'context', judged: false });
  // NO markEagerJudge calls → eager queue empty
  daemon.__setOverlayForTest(o);
  const L = makeLoop();
  const d = daemon.decideOne(L, ctxFor(makeGraph(0, 0)));
  ok('no eager marks → no visible periodic judge action', d.action !== 'judge_edges' && !d.judge);
  const due = hd.findDueJudgeWork('/irrelevant', {
    overlayLoad: () => o,
    judgeLib: judge,
  });
  ok('periodic backlog remains due for headless drain', due.periodic === true && due.depth === 5);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
