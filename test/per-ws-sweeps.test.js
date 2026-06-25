#!/usr/bin/env node
// Test for per-repo daemon: per-workspace self-healing sweeps + workspace-tagged SSE (#1, #5).
// Run: node test/per-ws-sweeps.test.js — exits non-zero on any failed assertion.
//
// (a) sweepStaleVerdicts(ws, ov) / sweepStaleGuidance(ws, ov): a stale verdict/guidance item in
//     a NON-current workspace is swept when those sweeps are called directly with a 2nd ws overlay.
// (b) notifyChange(ws) emits `data: changed:<ws>\n\n`; bare notifyChange() emits `data: changed\n\n`.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const {
  sweepStaleVerdicts, sweepStaleGuidance,
  notifyChange, sseClients,
  __setOverlayForTest, __setWorkspaceForTest, __setAgentsForTest,
} = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Use REAL Date.now() so sweepStale* internal calls to Date.now() stay in sync with our offsets.
const NOW = Date.now();
const ISO = (msAgo) => new Date(NOW - msAgo).toISOString();
const STALE_MS = 20 * 60000;   // 20m ago — past the 10m default stale_minutes
const FRESH_MS =       60000;  // 1m ago — within the 10m stale window

// ─── Set up a primary workspace so daemon state is valid ─────────────────────
const PRIMARY_WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-per-ws-primary-')));
const SECONDARY_WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-per-ws-secondary-')));

process.env.CLAUDE_PLUGIN_DATA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-per-ws-base-')));

// Minimal primary overlay in daemon state
const primaryOv = ov.EMPTY();
__setOverlayForTest(primaryOv);
__setWorkspaceForTest(PRIMARY_WS);
__setAgentsForTest({
  'live-judge': { agent_id: 'live-judge', state: 'running', startedAt: ISO(1000), lastSeen: ISO(1000) },
  'dead-judge': { agent_id: 'dead-judge', state: 'unknown', startedAt: ISO(STALE_MS), lastSeen: ISO(STALE_MS) },
});

// ─── (a1) sweepStaleVerdicts on a SECONDARY workspace overlay ────────────────
{
  const secondOv = ov.EMPTY();
  // stale 'tested' task in secondary ws — owner dead, timestamp stale
  secondOv.status['s/101'] = 'tested';
  secondOv.assignee['s/101'] = 'dead-judge';
  secondOv.timestamps['s/101'] = { firstSeen: ISO(STALE_MS), lastChanged: ISO(STALE_MS), lastStatus: 'tested' };
  // control: fresh 'tested' task — must NOT be swept
  secondOv.status['s/102'] = 'tested';
  secondOv.assignee['s/102'] = 'dead-judge';
  secondOv.timestamps['s/102'] = { firstSeen: ISO(FRESH_MS), lastChanged: ISO(FRESH_MS), lastStatus: 'tested' };
  // control: 'tested' with live owner — must NOT be swept
  secondOv.status['s/103'] = 'tested';
  secondOv.assignee['s/103'] = 'live-judge';
  secondOv.timestamps['s/103'] = { firstSeen: ISO(STALE_MS), lastChanged: ISO(STALE_MS), lastStatus: 'tested' };

  const dirty = sweepStaleVerdicts(SECONDARY_WS, secondOv);
  ok('(a1) sweepStaleVerdicts: dirty=true when stale verdict in secondary ws', dirty === true);
  ok('(a1) sweepStaleVerdicts: stale tested task status preserved', secondOv.status['s/101'] === 'tested');
  ok('(a1) sweepStaleVerdicts: stale tested task assignee preserved', secondOv.assignee['s/101'] === 'dead-judge');
  const surfaced = secondOv.guidance.find((g) => g.verdictKey === 's/101');
  ok('(a1) sweepStaleVerdicts: stale tested task surfaced as guidance', !!surfaced);
  ok('(a1) sweepStaleVerdicts: guidance is review severity with stale-verdict action', surfaced && surfaced.severity === 'review' && surfaced.action && surfaced.action.kind === 'stale-verdict' && surfaced.action.task_key === 's/101');
  ok('(a1) sweepStaleVerdicts: fresh tested task NOT swept', secondOv.status['s/102'] === 'tested');
  ok('(a1) sweepStaleVerdicts: live-owner task NOT swept', secondOv.status['s/103'] === 'tested');

  // Primary workspace overlay must be untouched
  ok('(a1) sweepStaleVerdicts: primary overlay NOT mutated', !primaryOv.status['s/101'] && (!Array.isArray(primaryOv.guidance) || primaryOv.guidance.length === 0));

  // Idempotency: second pass leaves the unresolved tagged guidance as the single surfaced item
  const dirty2 = sweepStaleVerdicts(SECONDARY_WS, secondOv);
  ok('(a1) sweepStaleVerdicts: idempotent — second pass is clean', dirty2 === false);
  ok('(a1) sweepStaleVerdicts: idempotent — no duplicate guidance', secondOv.guidance.filter((g) => g.verdictKey === 's/101').length === 1);
}

// ─── (a2) sweepStaleGuidance on a SECONDARY workspace overlay ────────────────
{
  const secondOv = ov.EMPTY();
  secondOv.guidance = [];

  // Stale blocking guidance: origin task completed in this overlay → should auto-resolve
  const ORIGIN_KEY = 's/200';
  secondOv.status[ORIGIN_KEY] = 'done';
  const gId = 'g-test-1';
  secondOv.guidance.push({ id: gId, question: 'should we do X?', context: '', trigger: 'scope_expansion',
    resolved: false, action: null, severity: undefined, origin_task: ORIGIN_KEY, origin_notes: [] });

  // Control: guidance with NO origin → never auto-resolved (no provenance to reason about)
  const gIdNoOrigin = 'g-test-2';
  secondOv.guidance.push({ id: gIdNoOrigin, question: 'unrelated question', context: '', trigger: 'ambiguous_intent',
    resolved: false, action: null, severity: undefined, origin_task: null, origin_notes: [] });

  // Control: already-resolved guidance → must be skipped
  const gIdResolved = 'g-test-3';
  secondOv.guidance.push({ id: gIdResolved, question: 'already done', context: '', trigger: 'ambiguous_intent',
    resolved: true, action: 'proceed', severity: undefined, origin_task: ORIGIN_KEY, origin_notes: [] });

  const dirty = sweepStaleGuidance(SECONDARY_WS, secondOv);
  ok('(a2) sweepStaleGuidance: dirty=true when stale guidance in secondary ws', dirty === true);

  const resolved = secondOv.guidance.find((g) => g.id === gId);
  ok('(a2) sweepStaleGuidance: stale guidance auto-resolved', !!(resolved && resolved.resolved));

  const noOriginG = secondOv.guidance.find((g) => g.id === gIdNoOrigin);
  ok('(a2) sweepStaleGuidance: no-origin guidance NOT auto-resolved', !!(noOriginG && !noOriginG.resolved));

  // Primary overlay untouched
  ok('(a2) sweepStaleGuidance: primary overlay NOT mutated (no guidance array)', !Array.isArray(primaryOv.guidance) || primaryOv.guidance.length === 0);

  // Idempotency
  const dirty2 = sweepStaleGuidance(SECONDARY_WS, secondOv);
  ok('(a2) sweepStaleGuidance: idempotent — second pass is clean', dirty2 === false);
}

// ─── (b) notifyChange(ws) emits workspace-tagged SSE line ────────────────────
{
  const captured = [];
  // Fake SSE response object
  const fakeRes = {
    write(chunk) { captured.push(chunk); },
  };
  sseClients.add(fakeRes);

  // Bare call → legacy payload
  notifyChange();
  ok('(b) bare notifyChange emits `data: changed\\n\\n`', captured[captured.length - 1] === 'data: changed\n\n');

  // Tagged call → workspace-tagged payload
  const TAG_WS = '/some/repo/path';
  notifyChange(TAG_WS);
  ok('(b) notifyChange(ws) emits `data: changed:<ws>\\n\\n`', captured[captured.length - 1] === `data: changed:${TAG_WS}\n\n`);

  // Different ws tag → different payload
  notifyChange('/other/workspace');
  ok('(b) notifyChange(ws2) emits different tag', captured[captured.length - 1] === 'data: changed:/other/workspace\n\n');

  // Total calls
  ok('(b) all three writes were received by the fake client', captured.length === 3);

  sseClients.delete(fakeRes);
}

// ─── (c) notifyChange: broken client is pruned from sseClients ───────────────
{
  const brokenRes = { write() { throw new Error('stream dead'); } };
  sseClients.add(brokenRes);
  const sizeBefore = sseClients.size;
  notifyChange(); // must not throw; must prune brokenRes
  ok('(c) broken SSE client is pruned on write error', !sseClients.has(brokenRes));
  ok('(c) sseClients shrinks by 1 after prune', sseClients.size === sizeBefore - 1);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
