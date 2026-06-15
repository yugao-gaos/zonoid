#!/usr/bin/env node
// Tests for the spawn dispatch lease (task /3): concurrent heartbeat loops must not double-dispatch
// the same READY task in one tick. Symmetric to judge-eager-lease.test.js (the eager-judge lease).
// Run: node test/spawn-lease.test.js — exits non-zero on any failed assertion.
'use strict';
const ov = require('../lib/overlay');
const daemon = require('../daemon.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log('PASS  ' + label); pass++; } else { console.log('FAIL  ' + label); fail++; } };

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

// --- PURE: acquireSpawnLease / hasLiveSpawnLease / clearSpawnLease -------------------------------
{
  const o = ov.EMPTY();
  ok('acquire: first acquire succeeds on unleased task', ov.acquireSpawnLease(o, 's/t', 'loop1', 60000) === true);
  ok('acquire: second acquire fails while lease is held', ov.acquireSpawnLease(o, 's/t', 'loop2', 60000) === false);
  ok('hasLive: held lease reads live', ov.hasLiveSpawnLease(o, 's/t') === true);
  ok('hasLive: unleased task reads not-live', ov.hasLiveSpawnLease(o, 's/other') === false);
  ok('acquire: lease entry records loopId', o.spawnLease['s/t'].loopId === 'loop1');
  ok('clear: clearSpawnLease removes the lease', ov.clearSpawnLease(o, 's/t') === true && !o.spawnLease['s/t']);
  ok('clear: second clear returns false', ov.clearSpawnLease(o, 's/t') === false);
  ok('acquire: after clear, re-acquire succeeds', ov.acquireSpawnLease(o, 's/t', 'loop3', 60000) === true);
}

// --- TTL EXPIRY: expired lease is treated as unlocked -------------------------------------------
{
  const o = ov.EMPTY();
  ov.acquireSpawnLease(o, 's/exp', 'loopA', 1); // 1ms TTL
  const deadline = Date.now() + 50;
  while (Date.now() < deadline) { /* spin */ }
  ok('expired lease: hasLive reads false after TTL', ov.hasLiveSpawnLease(o, 's/exp') === false);
  ok('expired lease: re-acquire succeeds after TTL', ov.acquireSpawnLease(o, 's/exp', 'loopB', 60000) === true);
  ok('expired lease: new loopId recorded', o.spawnLease['s/exp'].loopId === 'loopB');
}

// --- DISPATCH (daemon): two concurrent loops get DISJOINT spawn sets -----------------------------
{
  const o = ov.EMPTY();
  daemon.__setOverlayForTest(o);
  // Two ready tasks, nothing running. First loop spawns both and leases them.
  const L1 = makeLoop('loop1');
  const d1 = daemon.decideOne(L1, ctxFor(makeGraph(0, 2)));
  ok('dispatch L1: first loop spawns the ready tasks', d1.action === 'spawn' && d1.tasks.length === 2);
  ok('dispatch L1: both tasks are leased after dispatch', ov.hasLiveSpawnLease(o, 's/q0') && ov.hasLiveSpawnLease(o, 's/q1'));

  // Second loop (same shared overlay, same tick) must NOT re-dispatch the leased tasks.
  const L2 = makeLoop('loop2');
  const d2 = daemon.decideOne(L2, ctxFor(makeGraph(0, 2)));
  const l2Spawned = d2.action === 'spawn' ? d2.tasks.map((t) => t.key) : [];
  ok('dispatch L2: second loop does NOT re-spawn q0', !l2Spawned.includes('s/q0'));
  ok('dispatch L2: second loop does NOT re-spawn q1', !l2Spawned.includes('s/q1'));
}

// --- RELEASE: a leased task becomes re-dispatchable after the lease clears -----------------------
{
  const o = ov.EMPTY();
  ov.acquireSpawnLease(o, 's/q0', 'loop1', 60000);
  daemon.__setOverlayForTest(o);
  // Worker claimed then released → lease cleared. Now a loop should be able to dispatch it again.
  ov.clearSpawnLease(o, 's/q0');
  const L3 = makeLoop('loop3');
  const d3 = daemon.decideOne(L3, ctxFor(makeGraph(0, 1)));
  ok('release: cleared task is re-dispatchable', d3.action === 'spawn' && d3.tasks.some((t) => t.key === 's/q0'));
}

console.log('-----');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
