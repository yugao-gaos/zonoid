#!/usr/bin/env node
// Tests for the eager-judge dispatch lease (task 27): concurrent next_action calls must not
// double-dispatch the same node. After TTL expiry the node becomes re-dispatchable.
// Run: node test/judge-eager-lease.test.js — exits non-zero on any failed assertion.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const judge = require('../lib/judge');
const daemon = require('../daemon.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log('PASS  ' + label); pass++; } else { console.log('FAIL  ' + label); fail++; } };

// --- Helper: overlay with one marked node that has one unverified edge ---
function oneNodeOverlay() {
  const o = ov.EMPTY();
  o.epoch = 1;
  o.config = { ...o.config, judge: { budgetPerRun: 6 } };
  ov.markEagerJudge(o, 's/n1');
  o.edges = [{ from: 's/n1', to: 'note:x', kind: 'context', judged: false }];
  return o;
}
function makeGraph(running, ready) {
  const tasks = [];
  for (let i = 0; i < running; i++) tasks.push({ id: 's/r' + i, label: 'r' + i, status: 'in_progress', deps: [] });
  for (let i = 0; i < ready; i++) tasks.push({ id: 's/q' + i, label: 'q' + i, status: 'ready', deps: [] });
  return { tasks, ghosts: [] };
}
function makeLoop(id, over) {
  const cfg = { tokenBudget: 100000, maxIterations: 200, minPoll: 30, maxPoll: 1200, estPerTick: 800, batch: 8, maxConcurrency: 10, judgeParallelCap: 6, ...((over || {}).config || {}) };
  return { id: id || 'L', active: true, iterations: 0, spent: 0, baseline: 0, real: false, startedAt: null, session: null, lastProgress: null, config: cfg, ...(over || {}), config: cfg };
}
function ctxFor(g) { return { graph: g, pendingGuidance: [], batch: { remaining: 999 } }; }
function tempWorkspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-eager-lease-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  try { fs.unlinkSync(ov.fileFor(ws)); } catch {}
  return ws;
}

// --- PURE: acquireEagerJudgeLease / clearEagerJudgeLease -----------------------------------------
{
  const o = ov.EMPTY();
  ok('acquire: first acquire succeeds on unlocked node', ov.acquireEagerJudgeLease(o, 's/n', 'loop1', 60000) === true);
  ok('acquire: second acquire fails while lease is held', ov.acquireEagerJudgeLease(o, 's/n', 'loop2', 60000) === false);
  ok('acquire: lease entry has correct loopId', o.eagerJudgeLease['s/n'].loopId === 'loop1');
  ok('clear: clearEagerJudgeLease removes the lease', ov.clearEagerJudgeLease(o, 's/n') === true && !o.eagerJudgeLease['s/n']);
  ok('clear: second clear returns false', ov.clearEagerJudgeLease(o, 's/n') === false);
  ok('acquire: after clear, re-acquire succeeds', ov.acquireEagerJudgeLease(o, 's/n', 'loop3', 60000) === true);
}

// --- TTL EXPIRY: expired lease is treated as if unlocked ------------------------------------------
{
  const o = ov.EMPTY();
  // Acquire with a very short TTL (already expired)
  ov.acquireEagerJudgeLease(o, 's/exp', 'loopA', 1); // 1ms TTL
  // Poll for a tick to let time pass
  const deadline = Date.now() + 50;
  while (Date.now() < deadline) { /* spin */ }
  ok('expired lease: re-acquire succeeds after TTL', ov.acquireEagerJudgeLease(o, 's/exp', 'loopB', 60000) === true);
  ok('expired lease: new loopId recorded', o.eagerJudgeLease['s/exp'].loopId === 'loopB');
}

// --- DISPATCH: eagerJudgeNodes skips leased nodes -----------------------------------------------
{
  const o = oneNodeOverlay();
  // Lease s/n1 so it won't appear in eagerJudgeNodes
  ov.acquireEagerJudgeLease(o, 's/n1', 'loop1', 60000);
  const pending = judge.eagerJudgeNodes(o);
  ok('eagerJudgeNodes: leased node is skipped', !pending.includes('s/n1'));
  ok('eagerJudgeNodes: skipped node does NOT get pruned from eagerJudge', 's/n1' in o.eagerJudge);
  ok('buildQueue: leased eager edge is suppressed from periodic queue', !judge.buildQueue(o).some((i) => i.kind === 'edge' && i.from === 's/n1'));
}
{
  // After lease expires, node reappears
  const o = oneNodeOverlay();
  ov.acquireEagerJudgeLease(o, 's/n1', 'loop1', 1); // 1ms TTL
  const deadline = Date.now() + 50;
  while (Date.now() < deadline) { /* spin */ }
  const pending = judge.eagerJudgeNodes(o);
  ok('eagerJudgeNodes: node reappears after lease expires', pending.includes('s/n1'));
}

// --- DISPATCH (daemon): second loop call does NOT get the leased node ----------------------------
{
  const o = oneNodeOverlay();
  daemon.__setOverlayForTest(o);
  // First loop dispatches s/n1 and acquires the lease
  const L1 = makeLoop('loop1');
  const d1 = daemon.decideOne(L1, ctxFor(makeGraph(0, 0)));
  ok('dispatch L1: first loop gets the node', d1.action === 'judge_eager' && d1.nodes.length === 1 && d1.nodes[0] === 's/n1');
  ok('dispatch L1: lease is held after first dispatch', o.eagerJudgeLease['s/n1'] !== undefined);

  // Second loop (concurrent) tries to dispatch the same node — should get nothing
  const L2 = makeLoop('loop2');
  const d2 = daemon.decideOne(L2, ctxFor(makeGraph(0, 0)));
  ok('dispatch L2: second loop does NOT get the leased node', d2.action !== 'judge_eager' || !d2.nodes.includes('s/n1'));
}

// --- LEASE EXPIRY: node re-dispatchable after TTL (short TTL simulated via fake Date.now) ------
{
  const o = oneNodeOverlay();
  // Manually set an already-expired lease
  if (!o.eagerJudgeLease) o.eagerJudgeLease = {};
  o.eagerJudgeLease['s/n1'] = { leaseExpiry: Date.now() - 1000, loopId: 'old-loop' };
  daemon.__setOverlayForTest(o);
  const L3 = makeLoop('loop3');
  const d3 = daemon.decideOne(L3, ctxFor(makeGraph(0, 0)));
  ok('expired lease: node re-dispatched by new loop', d3.action === 'judge_eager' && d3.nodes.includes('s/n1'));
  ok('expired lease: lease updated to new loopId', o.eagerJudgeLease['s/n1'].loopId === 'loop3');
}

// --- PERSISTENCE: dispatch lease survives overlay reload -----------------------------------------
{
  const ws = tempWorkspace();
  const o = oneNodeOverlay();
  daemon.__setWorkspaceForTest(ws);
  daemon.__setOverlayForTest(o);
  const L4 = makeLoop('loop4');
  const d4 = daemon.decideOne(L4, ctxFor(makeGraph(0, 0)));
  const persisted = ov.load(ws);
  ok('persistence: eager dispatch happened', d4.action === 'judge_eager' && d4.nodes.includes('s/n1'));
  ok('persistence: eager lease saved to overlay file', persisted.eagerJudgeLease && persisted.eagerJudgeLease['s/n1'] && persisted.eagerJudgeLease['s/n1'].loopId === 'loop4');
}

console.log('-----');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
