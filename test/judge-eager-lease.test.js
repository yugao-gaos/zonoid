#!/usr/bin/env node
// Tests for the eager-judge drain lease (task 27): concurrent daemon-owned drain claims must not
// double-claim the same node. After TTL expiry the node becomes re-claimable.
// Run: node test/judge-eager-lease.test.js — exits non-zero on any failed assertion.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const judge = require('../lib/judge');
const hd = require('../lib/headless-drain');

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

// --- DRAIN CLAIM: second drain claim does NOT get the leased node -------------------------------
{
  const o = oneNodeOverlay();
  const deps = { overlayLoad: () => o, overlayStore: ov, judgeLib: judge };
  // First drain claim acquires the lease
  const d1 = hd.claimDueJudgeWork('/irrelevant', deps, { leaseOwner: 'drain1', leaseTtlMs: 60000 });
  ok('claim drain1: first drain gets the node', d1.eagerNodes.length === 1 && d1.eagerNodes[0] === 's/n1');
  ok('claim drain1: lease is held after first claim', o.eagerJudgeLease['s/n1'] !== undefined);

  // Second drain claim tries to claim the same node — should get nothing
  const d2 = hd.claimDueJudgeWork('/irrelevant', deps, { leaseOwner: 'drain2', leaseTtlMs: 60000 });
  ok('claim drain2: second drain does NOT get the leased node', !d2.eagerNodes.includes('s/n1'));
  ok('claim drain2: periodic queue also skips the leased eager edge', d2.periodic === false && d2.depth === 0);
}

// --- LEASE EXPIRY: node re-claimable after TTL --------------------------------------------------
{
  const o = oneNodeOverlay();
  // Manually set an already-expired lease
  if (!o.eagerJudgeLease) o.eagerJudgeLease = {};
  o.eagerJudgeLease['s/n1'] = { leaseExpiry: Date.now() - 1000, loopId: 'old-loop' };
  const d3 = hd.claimDueJudgeWork('/irrelevant', {
    overlayLoad: () => o,
    overlayStore: ov,
    judgeLib: judge,
  }, { leaseOwner: 'drain3', leaseTtlMs: 60000 });
  ok('expired lease: node re-claimed by new drain', d3.eagerNodes.includes('s/n1'));
  ok('expired lease: lease updated to new owner', o.eagerJudgeLease['s/n1'].loopId === 'drain3');
}

// --- PERSISTENCE: drain-claim lease survives overlay reload --------------------------------------
{
  const ws = tempWorkspace();
  const o = oneNodeOverlay();
  ov.save(ws, o);
  const d4 = hd.claimDueJudgeWork(ws, {}, { leaseOwner: 'drain4', leaseTtlMs: 60000 });
  const persisted = ov.load(ws);
  ok('persistence: eager claim happened', d4.eagerNodes.includes('s/n1'));
  ok('persistence: eager lease saved to overlay file', persisted.eagerJudgeLease && persisted.eagerJudgeLease['s/n1'] && persisted.eagerJudgeLease['s/n1'].loopId === 'drain4');
}

console.log('-----');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
