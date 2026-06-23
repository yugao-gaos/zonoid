#!/usr/bin/env node
// Regression test for note-mqq1rh9jnxp: an impl worker whose claim is released by the stale-claim
// sweep, then completes with status 'tested', MUST ready its blocked_by judge.
//
// The bug: the readiness gate in daemon.js makeResolver().effective() readied a dependent only when
// every blocking dep resolved to === 'done'. A 'tested' impl (the required impl terminal status when
// its paired judge has not yet merged) is NOT 'done', so the blocked_by judge stayed not_ready
// forever — even after the claim was reverted by the sweep and the worker re-reported 'tested'.
//
// This drives the REAL readiness derivation (buildGraph → makeResolver().effective) through the
// daemon's unit test hooks, which is deterministic and independent of the embed/judging environment
// (HTTP-level claim tests in this repo are gated by the autowire judging phase and need a live embed
// backend to clear it; this exercises the exact gate that had the bug without that coupling).
//
// It reproduces BOTH halves of the report:
//   1. claim the impl (in_progress override), then run the stale-claim SWEEP, which reverts the
//      override (the >10min reap) — asserted via sweepStaleClaims releasing it; and
//   2. set the impl to 'tested' and assert the judge derives 'ready' (and would appear in newly_ready:
//      ready-keys diff before vs after).
//
// Run: node --test --test-force-exit test/stale-reaper-readiness.test.js
'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reaper-ready-base-')));
process.env.CLAUDE_PLUGIN_DATA = BASE;   // before any module reads it
const ov = require('../lib/overlay');
const filedrop = require('../lib/filedrop-tasks');
const newlyReady = require('../lib/newly-ready');
const daemon = require('../daemon');
const {
  buildGraph, sweepStaleClaims,
  __setOverlayForTest, __setWorkspaceForTest, __setAgentsForTest, __clearOverlayCacheForTest, overlayFor,
} = daemon;

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-reaper-ready-ws-')));

function dropStub(harness, id, extra = {}) {
  const dir = path.join(filedrop.dirFor(WS), harness);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, subject: `stub ${id}`, ...extra }, null, 2));
}

const statusOf = (g, key) => { const t = g.tasks.find((x) => x.id === key); return t ? t.status : null; };

test('stale-reaper readiness regression', { timeout: 30000 }, async (t) => {
  // impl ← judge (blocked_by impl). The judge is the dependent that must ready once the impl reaches
  // a terminal-success status. A bystander (also blocked_by impl) discriminates newly_ready.
  dropStub('cursor', 'impl');
  dropStub('cursor', 'judge', { blockedBy: ['impl'] });
  dropStub('cursor', 'bystander', { blockedBy: ['impl'] });

  const overlay = ov.EMPTY();
  overlay.config.stale_minutes = 0;   // any past timestamp is immediately stale (drives the reap deterministically)
  __setWorkspaceForTest(WS);
  __setAgentsForTest({});
  __setOverlayForTest(overlay);

  // First build adopts the stubs (mints snapshots + the blockedBy edges).
  let g = buildGraph(WS);
  assert.equal(statusOf(g, 'cursor/judge'), 'not_ready', 'judge not_ready while impl is pending');

  // The impl worker claims the task: an in_progress override owned by a worker that is NOT vouched
  // live (no agent record) and whose claim timestamp is already past the (0-minute) window.
  const live = overlayFor(WS);
  live.status['cursor/impl'] = 'in_progress';
  live.assignee['cursor/impl'] = 'impl-worker';
  live.timestamps['cursor/impl'] = { firstSeen: new Date(Date.now() - 3600000).toISOString(), lastChanged: new Date(Date.now() - 3600000).toISOString(), lastStatus: 'in_progress' };
  __clearOverlayCacheForTest(); __setOverlayForTest(live);

  await t.test('the stale-claim sweep reverts the long-running impl claim (the >10min reap)', () => {
    const reaped = sweepStaleClaims(WS, overlayFor(WS));
    assert.equal(reaped, true, 'sweep released the stale in_progress claim');
    assert.equal(overlayFor(WS).status['cursor/impl'], undefined, 'in_progress override cleared by the reap');
    const after = buildGraph(WS);
    assert.equal(statusOf(after, 'cursor/judge'), 'not_ready', 'judge still not_ready after the reap (impl reverted to pending)');
  });

  // Ready-keys BEFORE the tested completion (the newly_ready baseline the /overlay/status handler diffs).
  const readyBefore = newlyReady.readyKeys(buildGraph(WS));

  // Now the impl completes with status 'tested' (NOT 'done' — the required impl terminal status while
  // its paired judge has not yet merged). This is the late completion from the reaped worker.
  const liveOv = overlayFor(WS);
  liveOv.status['cursor/impl'] = 'tested';
  __clearOverlayCacheForTest(); __setOverlayForTest(liveOv);

  await t.test('a tested impl readies its blocked_by judge (root fix)', () => {
    const after = buildGraph(WS);
    assert.equal(statusOf(after, 'cursor/impl'), 'tested', 'impl reflects its tested status');
    assert.equal(statusOf(after, 'cursor/judge'), 'ready', 'judge derives READY once impl is tested');
    assert.equal(statusOf(after, 'cursor/bystander'), 'ready', 'sibling dependent also readies');
  });

  await t.test('the judge appears in newly_ready (ready-keys diff before vs after the completion)', () => {
    const readyAfter = newlyReady.readyKeys(buildGraph(WS));
    const newly = newlyReady.diffNewlyReady(readyBefore, readyAfter);
    assert.ok(newly.includes('cursor/judge'), `judge in newly_ready (got ${JSON.stringify(newly)})`);
    assert.ok(!newly.includes('cursor/impl'), 'the completed impl is not in its own newly_ready');
  });
});

after(() => {
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
  // Requiring ../daemon spawns a detached embed sidecar; force-exit past the lingering handle so the
  // project test runner (plain `node file`) does not hang to its 120s timeout. Mirrors graph-loop-owner.test.js.
  setImmediate(() => process.exit(process.exitCode || 0));
});
