#!/usr/bin/env node
// Plain Node test for the daemon self-heal sweeps (no framework; matches test/autowire.test.js style).
// Run: node test/self-heal.test.js — exits non-zero on any failed assertion.
// Covers the two pure predicates that drive the sweeps:
//   (a) REAPER — staleClaimKeys: a dead-agent in_progress orphan (stale lastChanged, agent !running)
//       is selected once; after the claim is reverted to ready a second pass selects nothing (idempotent).
//   (b) SURFACING — staleVerdictKeys: a stale 'tested' node whose owner isn't live is surfaced exactly
//       once, its status is NOT mutated, and a live owner / fresh timestamp suppresses surfacing.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const {
  staleClaimKeys, staleSnapshotClaimKeys, releaseSnapshotClaim, staleNativeClaimKeys,
  releaseNativeClaim, staleVerdictKeys, sweepStaleVerdicts, __setAgentsForTest,
} = require('../daemon');

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

// --- (a2) REAPER: adopted snapshot in_progress orphan is released once ------------------------
{
  const overlay = ov.EMPTY();
  ov.setSnapshot(overlay, 's/20', { subject: 'orphan snapshot', description: '', status: 'in_progress', blockedBy: [] });
  overlay.timestamps['s/20'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'in_progress' };
  // Explicit overlay status still belongs to staleClaimKeys, not the snapshot fallback selector.
  ov.setSnapshot(overlay, 's/21', { subject: 'explicit status wins', description: '', status: 'in_progress', blockedBy: [] });
  overlay.status['s/21'] = 'in_progress';
  overlay.timestamps['s/21'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'in_progress' };
  // A fresh adopted snapshot gets time before it is released.
  ov.setSnapshot(overlay, 's/22', { subject: 'fresh snapshot', description: '', status: 'in_progress', blockedBy: [] });
  overlay.timestamps['s/22'] = { firstSeen: ISO(FRESH), lastChanged: ISO(FRESH), lastStatus: 'in_progress' };
  const agents = {};

  const first = staleSnapshotClaimKeys(overlay, agents, NOW);
  ok('snapshot reaper selects exactly one stale adopted orphan', first.length === 1);
  ok('snapshot reaper selects the stale snapshot claim (s/20)', first[0] && first[0].key === 's/20');
  ok('snapshot reaper ignores explicit overlay claims (s/21)', !first.some((c) => c.key === 's/21'));
  ok('snapshot reaper ignores fresh snapshots (s/22)', !first.some((c) => c.key === 's/22'));

  ok('snapshot release mutates status back to pending', releaseSnapshotClaim('s/20', 'test release', overlay, null, null) && overlay.snapshots['s/20'].status === 'pending');
  const second = staleSnapshotClaimKeys(overlay, agents, NOW);
  ok('snapshot reaper second pass is idempotent', !second.some((c) => c.key === 's/20'));
}

// --- (a3) REAPER: native in_progress echo is released once ------------------------
{
  const overlay = ov.EMPTY();
  overlay.timestamps['s/30'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'in_progress' };
  overlay.timestamps['s/31'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'in_progress' };
  overlay.status['s/31'] = 'in_progress';
  overlay.timestamps['s/32'] = { firstSeen: ISO(FRESH), lastChanged: ISO(FRESH), lastStatus: 'in_progress' };
  ov.setSnapshot(overlay, 's/33', { subject: 'native plus snapshot', description: '', status: 'in_progress', blockedBy: [] });
  overlay.timestamps['s/33'] = { firstSeen: ISO(STALE), lastChanged: ISO(STALE), lastStatus: 'in_progress' };
  const tasks = [
    { key: 's/30', session: 's', native_status: 'in_progress' },
    { key: 's/31', session: 's', native_status: 'in_progress' },
    { key: 's/32', session: 's', native_status: 'in_progress' },
    { key: 's/33', session: 's', native_status: 'in_progress' },
    { key: 's/34', session: 's', native_status: 'pending' },
  ];
  const agents = {};

  const first = staleNativeClaimKeys(overlay, agents, tasks, NOW);
  ok('native reaper selects stale native echoes', first.map((c) => c.key).sort().join(',') === 's/30,s/33');
  ok('native reaper ignores explicit overlay claims (s/31)', !first.some((c) => c.key === 's/31'));
  ok('native reaper ignores fresh native echoes (s/32)', !first.some((c) => c.key === 's/32'));
  ok('native reaper ignores non-in_progress tasks (s/34)', !first.some((c) => c.key === 's/34'));

  ok('native release can clear snapshot echo without native write-through', releaseNativeClaim('s/33', 'test release', overlay, null, null) && overlay.snapshots['s/33'].status === 'pending');
  const second = staleNativeClaimKeys(overlay, agents, tasks.filter((t) => t.key !== 's/33'), NOW);
  ok('native reaper second pass does not re-select released snapshot echo', !second.some((c) => c.key === 's/33'));
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

  // The sweep enqueues ONE guidance item tagged with verdictKey and skips keys that already have
  // an unresolved tagged item.
  __setAgentsForTest(agents);
  const realFresh = new Date().toISOString();
  overlay.timestamps['s/13'] = { firstSeen: realFresh, lastChanged: realFresh, lastStatus: 'tested' };
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-self-heal-verdict-')));
  ok('first sweep surfaces stale verdicts as guidance', sweepStaleVerdicts(ws, overlay) === true);
  ok('tested status still NOT mutated by sweep', overlay.status['s/10'] === 'tested');
  ok('ready status still NOT mutated by sweep', overlay.status['s/11'] === 'ready');
  ok('sweep tagged tested verdict guidance', overlay.guidance.some((g) => !g.resolved && g.verdictKey === 's/10'));
  ok('sweep tagged ready verdict guidance', overlay.guidance.some((g) => !g.resolved && g.verdictKey === 's/11'));
  ok('sweep skips fresh verdicts under the real clock', overlay.guidance.filter((g) => g.action && g.action.kind === 'stale-verdict').length === 2);
  ok('second sweep is idempotent (already-surfaced keys skipped)', sweepStaleVerdicts(ws, overlay) === false);
  ok('second sweep does not duplicate guidance', overlay.guidance.filter((g) => g.verdictKey === 's/10' || g.verdictKey === 's/11').length === 2);
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
