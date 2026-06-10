#!/usr/bin/env node
// Plain Node test for the daemon self-heal sweeps (no framework; matches test/autowire.test.js style).
// Run: node test/self-heal.test.js — exits non-zero on any failed assertion.
// Covers the two pure predicates that drive the sweeps:
//   (a) REAPER — staleClaimKeys: a dead-agent in_progress orphan (stale lastChanged, agent !running)
//       is selected once; after the claim is reverted to ready a second pass selects nothing (idempotent).
//   (b) SURFACING — staleVerdictKeys: a stale 'tested' node whose owner isn't live is surfaced exactly
//       once, its status is NOT mutated, and a live owner / fresh timestamp suppresses surfacing.
'use strict';
const ov = require('../lib/overlay');
const { staleClaimKeys, staleVerdictKeys } = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const NOW = Date.parse('2026-06-09T12:00:00.000Z');
const ISO = (msAgo) => new Date(NOW - msAgo).toISOString();
const STALE = 20 * 60000;   // 20m ago — past the 10m default
const FRESH = 60000;        // 1m ago — within the window

// --- (a) REAPER: dead-agent in_progress orphan is released once, then idempotent --------------
{
  const overlay = ov.EMPTY();
  overlay.status['s/1'] = 'in_progress';
  overlay.assignee['s/1'] = 'dead-worker';
  overlay.timestamps['s/1'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'in_progress' };
  // a control: a LIVE worker's in_progress claim must never be reaped
  overlay.status['s/2'] = 'in_progress';
  overlay.assignee['s/2'] = 'live-worker';
  overlay.timestamps['s/2'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'in_progress' };
  // a control: a FRESH dead-agent claim is given time (not yet stale)
  overlay.status['s/3'] = 'in_progress';
  overlay.assignee['s/3'] = 'dead-worker';
  overlay.timestamps['s/3'] = { firstSeen: ISO(FRESH), lastChanged: ISO(FRESH), lastStatus: 'in_progress' };
  const agents = { 'live-worker': { state: 'running' }, 'dead-worker': { state: 'unknown' } };

  const first = staleClaimKeys(overlay, agents, NOW);
  ok('reaper selects exactly one stale orphan', first.length === 1);
  ok('reaper selects the dead-agent stale claim (s/1)', first[0] && first[0].key === 's/1');
  ok('reaper records the dead agent id', first[0] && first[0].agentId === 'dead-worker');
  ok('reaper does NOT reap a live worker (s/2)', !first.some((c) => c.key === 's/2'));
  ok('reaper does NOT reap a fresh claim (s/3)', !first.some((c) => c.key === 's/3'));

  // simulate releaseClaim's effect: clearing the override reverts the task off in_progress (→ ready)
  delete overlay.status['s/1'];
  const second = staleClaimKeys(overlay, agents, NOW);
  ok('reaper second pass is idempotent (released claim not re-selected)', !second.some((c) => c.key === 's/1'));
}

// --- (b) SURFACING: stale verdict node surfaced once, status never mutated --------------------
{
  const overlay = ov.EMPTY();
  // stale 'tested' node, owner not live → must be surfaced
  overlay.status['s/10'] = 'tested';
  overlay.assignee['s/10'] = 'dead-judge';
  overlay.timestamps['s/10'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'tested' };
  // stale 'ready' node, no assignee at all → also surfaced (nobody picked it up)
  overlay.status['s/11'] = 'ready';
  overlay.timestamps['s/11'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'ready' };
  // control: 'tested' but owner still RUNNING → not surfaced
  overlay.status['s/12'] = 'tested';
  overlay.assignee['s/12'] = 'live-judge';
  overlay.timestamps['s/12'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'tested' };
  // control: 'tested', owner not live, but FRESH → given time, not surfaced
  overlay.status['s/13'] = 'tested';
  overlay.assignee['s/13'] = 'dead-judge';
  overlay.timestamps['s/13'] = { firstSeen: ISO(FRESH), lastChanged: ISO(FRESH), lastStatus: 'tested' };
  // control: 'in_progress' is the reaper's job, NOT a verdict — never surfaced here
  overlay.status['s/14'] = 'in_progress';
  overlay.timestamps['s/14'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'in_progress' };
  const agents = { 'live-judge': { state: 'running' }, 'dead-judge': { state: 'unknown' } };

  const v = staleVerdictKeys(overlay, agents, NOW);
  const keys = new Set(v.map((x) => x.key));
  ok('surfacing selects exactly the two stale verdict nodes', v.length === 2);
  ok('stale tested node surfaced (s/10)', keys.has('s/10'));
  ok('stale unowned ready node surfaced (s/11)', keys.has('s/11'));
  ok('live-owner tested node NOT surfaced (s/12)', !keys.has('s/12'));
  ok('fresh tested node NOT surfaced (s/13)', !keys.has('s/13'));
  ok('in_progress node NOT surfaced by verdict sweep (s/14)', !keys.has('s/14'));
  ok('verdict entry carries its status', v.find((x) => x.key === 's/10').status === 'tested');

  // status is a PURE read here — the predicate must not have mutated any task status
  ok('tested status NOT auto-promoted (s/10 still tested)', overlay.status['s/10'] === 'tested');
  ok('ready status NOT mutated (s/11 still ready)', overlay.status['s/11'] === 'ready');

  // idempotency model: the sweep enqueues ONE guidance item tagged with verdictKey and skips keys
  // that already have an unresolved tagged item. Simulate that skip here.
  const surfaced = new Set();
  const enqueueOnce = () => staleVerdictKeys(overlay, agents, NOW).filter((x) => !surfaced.has(x.key));
  const round1 = enqueueOnce();
  round1.forEach((x) => surfaced.add(x.key));
  ok('first enqueue surfaces both nodes', round1.length === 2);
  const round2 = enqueueOnce();
  ok('second enqueue is idempotent (already-surfaced keys skipped)', round2.length === 0);
}

// --- explicit stale_minutes=0 honors any past timestamp as stale ------------------------------
{
  const overlay = ov.EMPTY();
  overlay.config.stale_minutes = 0;
  overlay.status['s/20'] = 'tested';
  overlay.timestamps['s/20'] = { firstSeen: ISO(1000), lastChanged: ISO(1000), lastStatus: 'tested' };
  ok('stale_minutes=0 surfaces a verdict aged 1s', staleVerdictKeys(overlay, {}, NOW).length === 1);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
