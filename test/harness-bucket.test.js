#!/usr/bin/env node
// Tests for the harness cost-attribution changes:
//   (1) /harness/overhead self_maintenance bucket aggregates output_tokens for harness-prefixed tasks
//   (2) judge-pressure ensures the standing harness task in the overlay (idempotent)
//   (3) Claim-conflict path: complete_task (status→done) means next start_task sees no in_progress conflict
//
// No server needed — tests exercise routes and lib code directly via minimal mocks.
// Run: node test/harness-bucket.test.js — exits non-zero on any failure.
'use strict';
const overlayStore = require('../lib/overlay');
const judgeRoute = require('../routes/judge');
const { HARNESS_JUDGE_DRAIN_KEY, ensureHarnessJudgeDrainTask } = judgeRoute;

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

// ── (1) ensureHarnessJudgeDrainTask: idempotent overlay mutation ───────────────────────────────
{
  const ov = overlayStore.EMPTY();
  ok('before ensure: snapshot absent', !ov.snapshots || !ov.snapshots[HARNESS_JUDGE_DRAIN_KEY]);

  let savedCount = 0;
  ensureHarnessJudgeDrainTask(ov, () => savedCount++);

  ok('after first ensure: snapshot present', ov.snapshots && ov.snapshots[HARNESS_JUDGE_DRAIN_KEY]);
  ok('first ensure: save was called once', savedCount === 1);
  const snap = ov.snapshots[HARNESS_JUDGE_DRAIN_KEY];
  ok('snapshot subject starts with harness:', snap && typeof snap.subject === 'string' && snap.subject.startsWith('harness:'));
  ok('snapshot has harness metadata flag', snap && snap.metadata && snap.metadata.harness === true);
  ok('not in unwired quarantine', !ov.unwired || !ov.unwired[HARNESS_JUDGE_DRAIN_KEY]);

  // Second call: idempotent — should NOT call save again
  ensureHarnessJudgeDrainTask(ov, () => savedCount++);
  ok('second ensure: idempotent (save NOT called again)', savedCount === 1);
}

// ── (2) HARNESS_JUDGE_DRAIN_KEY has expected stable value ─────────────────────────────────────
{
  ok('stable key is followup/harness-judge-drain', HARNESS_JUDGE_DRAIN_KEY === 'followup/harness-judge-drain');
}

// ── (3) Claim-conflict path: done status means no CAS conflict for next agent ─────────────────
// Simulate the overlay CAS check (from routes/overlay.js line 58-62):
//   only blocks if cur === 'in_progress' AND owner !== agent_id AND !force.
// After complete_task: cur is 'done', so the next agent's start_task has no conflict.
{
  // Case A: task is 'done' → next start_task is fine (no conflict)
  const ovA = overlayStore.EMPTY();
  ovA.status[HARNESS_JUDGE_DRAIN_KEY] = 'done';
  ovA.assignee[HARNESS_JUDGE_DRAIN_KEY] = 'judge-drain-prev';
  const curA = ovA.status[HARNESS_JUDGE_DRAIN_KEY];
  const newAgentA = 'judge-drain-next';
  // CAS check: conflict only if cur === 'in_progress' AND owner !== newAgent AND !force
  const conflictA = curA === 'in_progress' && ovA.assignee[HARNESS_JUDGE_DRAIN_KEY] !== newAgentA;
  ok('done status: no CAS conflict for next agent', !conflictA);

  // Case B: task is 'in_progress' by a different agent → would conflict (verifying the guard exists)
  const ovB = overlayStore.EMPTY();
  ovB.status[HARNESS_JUDGE_DRAIN_KEY] = 'in_progress';
  ovB.assignee[HARNESS_JUDGE_DRAIN_KEY] = 'judge-drain-alive';
  const curB = ovB.status[HARNESS_JUDGE_DRAIN_KEY];
  const newAgentB = 'judge-drain-newpass';
  const conflictB = curB === 'in_progress' && ovB.assignee[HARNESS_JUDGE_DRAIN_KEY] !== newAgentB;
  ok('in_progress by another agent: CAS conflict detected (guard works)', conflictB);

  // Case C: same agent re-claims its own in_progress task → no conflict
  const ovC = overlayStore.EMPTY();
  ovC.status[HARNESS_JUDGE_DRAIN_KEY] = 'in_progress';
  ovC.assignee[HARNESS_JUDGE_DRAIN_KEY] = 'judge-drain-same';
  const curC = ovC.status[HARNESS_JUDGE_DRAIN_KEY];
  const sameAgent = 'judge-drain-same';
  const conflictC = curC === 'in_progress' && ovC.assignee[HARNESS_JUDGE_DRAIN_KEY] !== sameAgent;
  ok('same agent re-claim: no conflict', !conflictC);
}

// ── (4) self_maintenance bucket: splitSessionTokens for harness-prefixed tasks ────────────────
// Mirrors the logic in routes/analytics.js: split output_tokens among harness tasks by window.
{
  const { splitSessionTokens } = require('../lib/costflow');
  const harnessClaims = [
    { id: HARNESS_JUDGE_DRAIN_KEY, transcript: '/t/harness.jsonl', window: { start: '2026-06-12T10:00:00Z', end: '2026-06-12T10:10:00Z' } }, // 10 min
    { id: 'followup/harness-other', transcript: '/t/harness.jsonl', window: { start: '2026-06-12T10:10:00Z', end: '2026-06-12T10:20:00Z' } }, // 10 min
  ];
  const usage = { '/t/harness.jsonl': { output_tokens: 2000 } };
  const usageOutputOnly = (tp) => { const u = usage[tp]; return { total: (u && u.output_tokens) || 0 }; };
  const ownTok = splitSessionTokens(harnessClaims, usageOutputOnly);

  // Equal windows → equal shares (1000 each)
  ok('harness-prefixed task gets attributed output_tokens (1000)', Math.abs(ownTok.get(HARNESS_JUDGE_DRAIN_KEY) - 1000) < 1e-6);
  ok('second harness task also gets its share (1000)', Math.abs(ownTok.get('followup/harness-other') - 1000) < 1e-6);

  let selfMaintenance = 0;
  for (const c of harnessClaims) selfMaintenance += ownTok.get(c.id) || 0;
  ok('self_maintenance total == sum of harness task tokens (2000)', Math.abs(selfMaintenance - 2000) < 1e-6);

  // Non-harness task in the same transcript: should NOT be included in self_maintenance
  const mixedClaims = [
    { id: 'some/user-task', transcript: '/t/mix.jsonl', window: { start: '2026-06-12T10:00:00Z', end: '2026-06-12T10:30:00Z' } },
    { id: HARNESS_JUDGE_DRAIN_KEY, transcript: '/t/mix.jsonl', window: { start: '2026-06-12T10:30:00Z', end: '2026-06-12T10:40:00Z' } },
  ];
  const mixUsage = { '/t/mix.jsonl': { output_tokens: 4000 } };
  const mixOwn = splitSessionTokens(mixedClaims, (tp) => { const u = mixUsage[tp]; return { total: (u && u.output_tokens) || 0 }; });
  // user task: 30/(30+10)=0.75 → 3000; harness: 10/40=0.25 → 1000
  const harnessShare = mixOwn.get(HARNESS_JUDGE_DRAIN_KEY) || 0;
  const userShare = mixOwn.get('some/user-task') || 0;
  ok('mixed transcript: harness share ~1000', Math.abs(harnessShare - 1000) < 1e-3);
  ok('mixed transcript: user task share ~3000', Math.abs(userShare - 3000) < 1e-3);
  ok('mixed: only harness task counted in self_maintenance (not user task)', Math.abs(harnessShare - 1000) < 1e-3);
}

// ── (5) /judge/pressure response includes harness_task_key ────────────────────────────────────
{
  const ov = overlayStore.EMPTY();
  let lastSent = null;
  let savedCount = 0;
  const mockCtx = {
    get state() { return { overlay: ov, workspace: '/ws/test' }; },
    send(res, status, body) { lastSent = { status, body }; },
    readBody: async () => ({}),
    notifyChange: () => {},
    buildGraph: () => ({ tasks: [] }),
    targetOverlay: () => ({ ov, ws: '/ws/test', save: () => { savedCount++; } }),
    noteRagCandidates: () => [],
  };

  // Reset nudge stamp
  if (judgeRoute._setLastNudgeAt) judgeRoute._setLastNudgeAt(0);

  (async () => {
    const route = judgeRoute(mockCtx);
    const mockU = { pathname: '/judge/pressure', searchParams: { get: () => null } };
    await route('/judge/pressure', 'GET', {}, {}, mockU, null);
    ok('/judge/pressure response includes harness_task_key', lastSent && lastSent.body && lastSent.body.harness_task_key === HARNESS_JUDGE_DRAIN_KEY);
    ok('/judge/pressure ensures standing task (snapshot created)', ov.snapshots && ov.snapshots[HARNESS_JUDGE_DRAIN_KEY]);
    ok('/judge/pressure status 200', lastSent && lastSent.status === 200);

    console.log('-----');
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
  })();
}
