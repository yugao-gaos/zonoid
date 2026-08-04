#!/usr/bin/env node
// Unit test for the stale-claim reaper FIX 2 (note-mqq1rh9jnxp): the claim sweep must NOT reap a
// claim that is backed by a registered attempt worktree whose branch has RECENT commits (a live
// hookless background worker that never fired SubagentStart but is demonstrably still committing),
// while STILL reaping genuinely-orphaned / dead-process claims so stuck claims recover.
//
// Pure: drives staleClaimKeys / worktreeVouchesLive with an injected gitProbe so no real git is
// shelled. Also asserts the claim-sweep default window aligns with the 1h git lease (60m).
//
// Run: node --test test/reaper-worktree-vouch.test.js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reaper-vouch-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const ov = require('../lib/overlay');
const daemon = require('../daemon');
const { staleClaimKeys, worktreeVouchesLive, depSatisfied, STALE_MINUTES_DEFAULT } = daemon;

// A real directory on disk so worktreeVouchesLive's fs.existsSync(worktree) check passes.
const WT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reaper-vouch-wt-')));

const NOW = Date.parse('2026-06-23T12:00:00.000Z');
const ISO = (msAgo) => new Date(NOW - msAgo).toISOString();
const MIN = 60000;

// gitProbe stub: returns a `git log -1 --format=%ct` epoch-seconds string for a fixed commit age.
const probeCommittedMsAgo = (msAgo) => () => String(Math.floor((NOW - msAgo) / 1000));
const probeNoCommits = () => null;   // not a repo / no commits

test('claim-sweep default window aligns with the 1h git lease', () => {
  // Default is 60 unless ORCH_STALE_MINUTES overrides it in this process's env.
  const envOverride = Number(process.env.ORCH_STALE_MINUTES);
  const expected = Number.isFinite(envOverride) && envOverride >= 0 ? envOverride : 60;
  assert.equal(STALE_MINUTES_DEFAULT, expected, 'STALE_MINUTES_DEFAULT honors ORCH_STALE_MINUTES, else 60');
});

test('depSatisfied: terminal-success (done OR tested) satisfies a dependency', () => {
  assert.equal(depSatisfied('done'), true, 'done satisfies');
  assert.equal(depSatisfied('tested'), true, 'tested satisfies');
  assert.equal(depSatisfied('failed'), false, 'failed does NOT satisfy');
  assert.equal(depSatisfied('canceled'), false, 'canceled does NOT satisfy');
  assert.equal(depSatisfied('in_progress'), false, 'in_progress does NOT satisfy');
  assert.equal(depSatisfied('ready'), false, 'ready does NOT satisfy');
});

test('worktreeVouchesLive: fresh-commit worktree vouches, stale/absent does not', () => {
  const overlay = ov.EMPTY();
  overlay.git['s/live'] = { worktree: WT, branch: 'orch/attempt/s-live' };
  // (a) committed 5m ago, window 60m → vouched (recent commit, demonstrably live)
  assert.equal(worktreeVouchesLive(overlay, 's/live', 60, NOW, probeCommittedMsAgo(5 * MIN)), true, 'recent commit vouches');
  // (b) committed 90m ago, window 60m → NOT vouched (worker died after its last commit)
  assert.equal(worktreeVouchesLive(overlay, 's/live', 60, NOW, probeCommittedMsAgo(90 * MIN)), false, 'old commit does not vouch');
  // (c) no commits at all → NOT vouched
  assert.equal(worktreeVouchesLive(overlay, 's/live', 60, NOW, probeNoCommits), false, 'no commits does not vouch');
  // (d) explicit window 0 → nothing is recent (honors stale_minutes=0)
  assert.equal(worktreeVouchesLive(overlay, 's/live', 0, NOW, probeCommittedMsAgo(0)), false, 'window 0 vouches nothing');
  // (e) no registered worktree → NOT vouched
  const bare = ov.EMPTY();
  bare.status['s/x'] = 'in_progress';
  assert.equal(worktreeVouchesLive(bare, 's/x', 60, NOW, probeCommittedMsAgo(1 * MIN)), false, 'no worktree does not vouch');
  // (f) registered worktree path missing on disk → NOT vouched
  const gone = ov.EMPTY();
  gone.git['s/g'] = { worktree: path.join(WT, 'does-not-exist') };
  assert.equal(worktreeVouchesLive(gone, 's/g', 60, NOW, probeCommittedMsAgo(1 * MIN)), false, 'missing worktree dir does not vouch');
});

test('staleClaimKeys: worktree-backed live worker NOT swept; orphan IS swept', () => {
  const overlay = ov.EMPTY();
  // The owning agent is NOT vouched live by the registry (no record / not running) — the ONLY thing
  // shielding the live worker is its fresh attempt commits. Both claims are aged well past the window
  // by lastChanged, so the time cutoff alone would reap both.
  const agents = {};   // no agent vouches anyone — isolate the worktree-commit signal

  // (1) live worker: registered worktree + a commit 5m ago (within the 60m window) → must NOT be swept.
  overlay.status['s/live'] = 'in_progress';
  overlay.assignee['s/live'] = 'bg-worker';
  overlay.timestamps['s/live'] = { firstSeen: ISO(120 * MIN), lastChanged: ISO(120 * MIN), lastStatus: 'in_progress' };
  overlay.git['s/live'] = { worktree: WT, branch: 'orch/attempt/s-live' };

  // (2) genuine orphan: NO worktree, aged past the window → must be swept (stuck claim recovers).
  overlay.status['s/orphan'] = 'in_progress';
  overlay.assignee['s/orphan'] = 'dead-worker';
  overlay.timestamps['s/orphan'] = { firstSeen: ISO(120 * MIN), lastChanged: ISO(120 * MIN), lastStatus: 'in_progress' };

  // (3) dead-after-commit: registered worktree but last commit 90m ago (older than window) → swept.
  overlay.status['s/dead'] = 'in_progress';
  overlay.assignee['s/dead'] = 'dead-worker2';
  overlay.timestamps['s/dead'] = { firstSeen: ISO(120 * MIN), lastChanged: ISO(120 * MIN), lastStatus: 'in_progress' };
  overlay.git['s/dead'] = { worktree: WT, branch: 'orch/attempt/s-dead' };

  // Inject a gitProbe that answers per-worktree-ish: s/live committed recently, s/dead long ago. Since
  // both s/live and s/dead point at the same WT dir in this test, key the answer off a closure that
  // the test controls per call sequence is brittle — instead probe by branch via the args.
  const probe = (w, args) => {
    // args = ['log','-1','--format=%ct'] for the HEAD of the worktree's checked-out branch.
    // Emulate: the daemon runs it in `w` (the worktree). We can't see the branch from args here, so
    // distinguish by a marker file the test writes — but simpler: run two passes with different probes.
    return null;
  };
  void probe; // (kept for documentation; real per-key distinction below uses two targeted asserts)

  // Pass A: probe says "recent commit" for everything → only the genuine orphan (no worktree) is swept.
  const sweptA = staleClaimKeys(overlay, agents, NOW, undefined, probeCommittedMsAgo(5 * MIN));
  const keysA = sweptA.map((c) => c.key).sort();
  assert.deepEqual(keysA, ['s/orphan'], 'with fresh commits, only the no-worktree orphan is swept');
  assert.equal(sweptA[0].mins, STALE_MINUTES_DEFAULT, 'reported window is the aligned default');

  // Pass B: probe says "commit 90m ago" for everything → worktree no longer vouches; live+dead+orphan
  // all reap (the dead-after-commit and the orphan), but the genuinely-live one would too here since
  // the probe is global. This documents that an OLD commit does not shield — the recover path works.
  const sweptB = staleClaimKeys(overlay, agents, NOW, undefined, probeCommittedMsAgo(90 * MIN));
  const keysB = sweptB.map((c) => c.key).sort();
  assert.deepEqual(keysB, ['s/dead', 's/live', 's/orphan'], 'with only-stale commits, all aged claims reap (recovery)');
});

test('staleClaimKeys: a registry-vouched live worker is left alone regardless of commits', () => {
  const overlay = ov.EMPTY();
  overlay.config.stale_minutes = 10;   // tighten window; the registry vouch must still shield
  overlay.status['s/reg'] = 'in_progress';
  overlay.assignee['s/reg'] = 'live-agent';
  overlay.timestamps['s/reg'] = { firstSeen: ISO(60 * MIN), lastChanged: ISO(60 * MIN), lastStatus: 'in_progress' };
  // live-agent re-asserted this "boot": lastSeen >= bootMs. Pass bootMs <= lastSeen so vouchedLive is true.
  const bootMs = NOW - 120 * MIN;
  const agents = { 'live-agent': { state: 'running', lastSeen: ISO(1 * MIN), startedAt: ISO(1 * MIN) } };
  const swept = staleClaimKeys(overlay, agents, NOW, bootMs, probeNoCommits);
  assert.equal(swept.length, 0, 'a registry-vouched running agent is never swept even with no commits');
});

after(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(WT, { recursive: true, force: true }); } catch { /* */ }
  // Requiring ../daemon spawns a detached embed sidecar; force-exit past the lingering handle so the
  // project test runner (plain `node file`) does not hang to its 120s timeout. Mirrors graph-loop-owner.test.js.
  setImmediate(() => process.exit(process.exitCode || 0));
});
