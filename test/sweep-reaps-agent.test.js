#!/usr/bin/env node
// Plain Node test (matches test/self-heal.test.js style): sweepStaleClaims must REAP the owning
// agent's registry record in lockstep with the stale claim it held, so /health's
// summary.agents.running (a.filter(x => x.state === 'running').length) stops counting the zombie.
// Bug: a swept claim released the task but left the agent stuck 'running' forever, inflating the
// dashboard's running count (cosmetic/observability, not dispatch starvation). Run:
//   node test/sweep-reaps-agent.test.js — exits non-zero on any failed assertion.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const {
  sweepStaleClaims, __setOverlayForTest, __setAgentsForTest, __getAgentsForTest,
} = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// running count exactly as /health computes it (daemon summaryFor).
const runningCount = (agents) => Object.values(agents).filter((x) => x.state === 'running').length;

const NOW = Date.now();
const STALE_ISO = new Date(NOW - 30 * 60000).toISOString();   // 30m ago — past the 10m default
// lastSeen far in the past (predates this boot) so the agent is NOT vouchedLive (the post-restart
// zombie shape: a 'running' record restored from disk whose worker never re-asserted).
const OLD_SEEN = new Date(NOW - 60 * 60000).toISOString();

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reap-ws-')));

try {
  const overlay = ov.EMPTY();
  overlay.config.stale_minutes = 0;   // any past timestamp is stale; 0 also defeats the boot grace
  // (1) stale orphan: dead worker's in_progress claim — claim released AND agent reaped
  overlay.status['s/1'] = 'in_progress';
  overlay.assignee['s/1'] = 'zombie-worker';
  overlay.timestamps['s/1'] = { firstSeen: STALE_ISO, lastChanged: STALE_ISO, lastStatus: 'in_progress' };
  // (2) control: a genuinely live worker's claim must be left alone (claim + agent untouched)
  overlay.status['s/2'] = 'in_progress';
  overlay.assignee['s/2'] = 'live-worker';
  overlay.timestamps['s/2'] = { firstSeen: STALE_ISO, lastChanged: STALE_ISO, lastStatus: 'in_progress' };

  const agents = {
    // zombie: 'running' but lastSeen predates boot and stale_minutes=0 → not vouchedLive
    'zombie-worker': { agent_id: 'zombie-worker', state: 'running', startedAt: OLD_SEEN, lastSeen: OLD_SEEN, endedAt: null },
    // live: re-asserted just now → vouchedLive, never reaped
    'live-worker': { agent_id: 'live-worker', state: 'running', startedAt: new Date(NOW).toISOString(), lastSeen: new Date(NOW).toISOString(), endedAt: null },
  };

  __setOverlayForTest(overlay);
  __setAgentsForTest(agents);

  ok('precondition: both agents counted as running (=2)', runningCount(__getAgentsForTest()) === 2);

  const dirty = sweepStaleClaims(WS, overlay);
  ok('sweep reports work done', dirty === true);

  const after = __getAgentsForTest();
  // The core fix: the swept agent drops out of the /health running count.
  ok('zombie agent no longer running', after['zombie-worker'].state !== 'running');
  ok('zombie agent moved to terminal stale state', after['zombie-worker'].state === 'stale');
  ok('zombie agent stamped endedAt', typeof after['zombie-worker'].endedAt === 'string');
  ok('live agent still running (never touched)', after['live-worker'].state === 'running');
  ok('running count dropped to 1 (zombie reaped, live kept)', runningCount(after) === 1);

  // the claim itself was released (status override cleared → task re-derives off in_progress)
  ok('stale claim released', overlay.status['s/1'] !== 'in_progress');
  ok('live claim left in_progress', overlay.status['s/2'] === 'in_progress');

  // idempotent: a second pass finds nothing to do and does not re-touch the now-stale agent
  const dirty2 = sweepStaleClaims(WS, overlay);
  ok('second sweep is a no-op (idempotent)', dirty2 === false);
  ok('running count stable at 1 after second sweep', runningCount(__getAgentsForTest()) === 1);
} finally {
  try { fs.rmSync(WS, { recursive: true }); } catch { /* */ }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
