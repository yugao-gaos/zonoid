#!/usr/bin/env node
// Contract tests for POST /judge/verdict taskDecision handling AFTER it was routed through the one
// guarded transition authority (lib/overlay/lifecycle-machine.js).
//
// The judge queue's stamp (overlay.judgedTaskDecisions) is PERMANENT — it is keyed on task+action
// and is never cleared by an epoch bump — so "was this item retired?" is the sharpest contract in
// the whole surface. These tests pin exactly when it is and is not stamped:
//   J1  an action with no handler is refused and NOT retired  (the old else-if chain fell through
//       to the stamp with zero state change, destroying the item — observed live with the
//       advertised-but-unimplemented "review" action)
//   J2  a timing refusal (live worker) is NOT retired          (re-offer once the diff is real)
//   J3  a settled-state refusal IS retired                     (re-offering would loop forever)
//   J4  refusals are reported explicitly, because a zero applied-counter is not evidence of a no-op
//   J5  escalate stays the one non-terminal action, legal even mid-flight
// Run: node test/judge-lifecycle-contract.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ov = require('../lib/overlay');
const judge = require('../lib/judge');
const judgeRoute = require('../routes/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-judge-lifecycle-')));
fs.mkdirSync(path.join(WS, '.graph'), { recursive: true });

function makeCtx(overlay, tasks) {
  let lastSent = null;
  let body = {};
  const ctx = {
    send: (res, status, respBody) => { lastSent = { status, body: respBody }; },
    readBody: async () => body,
    notifyChange: () => {},
    buildGraph: () => ({ tasks }),
    state: {},
    targetOverlay: () => ({ ov: overlay, ws: WS, save: () => {} }),
    noteRagCandidates: () => [],
  };
  return { ctx, getLastSent: () => lastSent, setBody: (b) => { body = b; } };
}

async function postVerdict(harness, verdicts) {
  harness.setBody({ verdicts });
  const route = judgeRoute(harness.ctx);
  const mockU = { pathname: '/judge/verdict', searchParams: { get: () => null } };
  await route('/judge/verdict', 'POST', { method: 'POST' }, {}, mockU, null);
  return harness.getLastSent();
}

const stamped = (o, key, action) => o.judgedTaskDecisions[judge.taskDecisionId(key, action)] === true;

(async () => {
  // --- J1: unhandled action -----------------------------------------------------------------------
  {
    const o = ov.EMPTY();
    o.status['j/1'] = 'tested';
    ov.setReviewLifecycle(o, 'j/1', { review_state: 'requested', merge_state: 'review_pending' });
    const h = makeCtx(o, [{ id: 'j/1', label: 'finished attempt', status: 'tested' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 'j/1', action: 'review', reason: 'take a second look' } }]);
    ok('J1: unhandled action is refused', r.body.applied.refused === 1 && !r.body.applied.taskDecisions);
    ok('J1: unhandled action changes NO lifecycle state', o.reviews['j/1'].review_state === 'requested' && o.reviews['j/1'].merge_state === 'review_pending');
    ok('J1: unhandled action does NOT retire the item', !stamped(o, 'j/1', 'review'));
    ok('J1: refusal is reported with a machine-readable code', r.body.refusals[0].code === 'unknown_action' && r.body.refusals[0].retired === false);
    ok('J1: refusal reason lists the actions that DO exist', r.body.refusals[0].reason.includes('approve'));
  }

  // --- J2: timing refusal (live worker) is not retired --------------------------------------------
  {
    const o = ov.EMPTY();
    o.status['j/2'] = 'in_progress';
    ov.setReviewLifecycle(o, 'j/2', { review_state: 'requested', merge_state: 'review_pending' });
    const h = makeCtx(o, [{ id: 'j/2', label: 'live worker', status: 'in_progress' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 'j/2', action: 'merge', reason: 'ship it' } }]);
    ok('J2: merge on a live worker is refused (it would be a silent no-op merge of an empty branch)',
      r.body.applied.skippedInFlight === 1 && !r.body.applied.mergeRequested);
    ok('J2: timing refusal is marked retryable and NOT retired',
      r.body.refusals[0].code === 'in_flight' && r.body.refusals[0].retryable === true && r.body.refusals[0].retired === false);
    ok('J2: refused merge is not stamped, so it re-surfaces', !stamped(o, 'j/2', 'merge'));
    ok('J2: item is still in the queue after the refusal',
      judge.buildQueue(o).some((it) => it.kind === 'task-decision' && it.task_key === 'j/2'));
  }

  // --- J3: settled-state refusals ARE retired -----------------------------------------------------
  {
    // already merged: a late kick_back must not un-merge, and must not loop.
    const o = ov.EMPTY();
    o.status['j/3'] = 'tested';
    ov.setGit(o, 'j/3', { merged: true, merge_sha: 'abc123' });
    ov.setReviewLifecycle(o, 'j/3', { review_state: 'landed', merge_state: 'merged', merge_sha: 'abc123' });
    const h = makeCtx(o, [{ id: 'j/3', label: 'already merged', status: 'tested' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 'j/3', action: 'kick_back', reason: 'late review' } }]);
    ok('J3: kick_back after merge is refused', r.body.applied.refused === 1 && r.body.refusals[0].code === 'already_merged');
    ok('J3: merged state is preserved', o.reviews['j/3'].merge_state === 'merged' && o.status['j/3'] === 'tested');
    ok('J3: settled refusal IS retired (no re-offer loop)', r.body.refusals[0].retired === true && stamped(o, 'j/3', 'kick_back'));
    ok('J3: a settled refusal is not counted as an in-flight skip', !r.body.applied.skippedInFlight);
  }
  {
    // already reviewed: a contradicting second verdict must not overwrite the first.
    const o = ov.EMPTY();
    o.status['j/4'] = 'tested';
    ov.setReviewLifecycle(o, 'j/4', { review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending' });
    const h = makeCtx(o, [{ id: 'j/4', label: 'already approved', status: 'tested' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 'j/4', action: 'kick_back', reason: 'changed my mind' } }]);
    ok('J4: contradicting verdict on a settled review is refused', r.body.refusals[0].code === 'already_reviewed');
    ok('J4: the first verdict survives', o.reviews['j/4'].review_verdict === 'APPROVE' && o.status['j/4'] !== 'failed');
    ok('J4: contradicting verdict IS retired', stamped(o, 'j/4', 'kick_back'));
  }
  {
    // Exact historical race: terminal overlay status + stale graph projection + pending review.
    // A late approval must retire the stale review item without creating merge work.
    const o = ov.EMPTY();
    o.status['j/done-pending'] = 'done';
    ov.setReviewLifecycle(o, 'j/done-pending', { review_state: 'requested', merge_state: 'review_pending' });
    const h = makeCtx(o, [{ id: 'j/done-pending', label: 'already done', status: 'tested' }]);
    const r = await postVerdict(h, [{ taskDecision: {
      task_key: 'j/done-pending', action: 'approve', source_action: 'review', reason: 'late approval',
    } }]);
    ok('J3: review_approve on explicit done is refused as historical',
      r.body.refusals[0].code === 'already_terminal' && r.body.refusals[0].retired === true);
    ok('J3: historical approval cannot queue a merge',
      o.reviews['j/done-pending'].merge_state === 'review_pending'
      && !judge.buildQueue(o).some((it) => it.id === 'decision:merge:j/done-pending'));
    ok('J3: stale review decision is retired', stamped(o, 'j/done-pending', 'review'));
  }

  // --- J4: refusals are reported, applies are still reported the old way ---------------------------
  {
    const o = ov.EMPTY();
    o.status['j/5'] = 'tested';
    ov.setReviewLifecycle(o, 'j/5', { review_state: 'requested', merge_state: 'review_pending' });
    const h = makeCtx(o, [{ id: 'j/5', label: 'finished attempt', status: 'tested' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 'j/5', action: 'approve', reason: 'sound attempt' } }]);
    ok('J4: an accepted decision reports no refusals', Array.isArray(r.body.refusals) && r.body.refusals.length === 0);
    ok('J4: an accepted approve still writes the lifecycle',
      o.reviews['j/5'].review_state === 'approved' && o.reviews['j/5'].merge_state === 'pending' && o.reviews['j/5'].review_agent === 'judge');
    ok('J4: an accepted approve is retired', stamped(o, 'j/5', 'approve'));
  }

  // --- J5: escalate stays legal mid-flight --------------------------------------------------------
  {
    const o = ov.EMPTY();
    o.status['j/6'] = 'in_progress';
    const h = makeCtx(o, [{ id: 'j/6', label: 'live worker', status: 'in_progress' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 'j/6', action: 'escalate', reason: 'a human should look' } }]);
    ok('J5: escalate on a live task is allowed', r.body.applied.escalated === 1 && !r.body.applied.refused);
    ok('J5: escalate raises a blocking guidance row', (o.guidance || []).some((g) => g.action && g.action.task_key === 'j/6'));
    ok('J5: escalate writes no review verdict', !(o.reviews && o.reviews['j/6'] && o.reviews['j/6'].review_verdict));
  }

  // --- source_action retirement keying is unchanged ------------------------------------------------
  {
    const o = ov.EMPTY();
    o.status['j/7'] = 'tested';
    const h = makeCtx(o, [{ id: 'j/7', label: 'finished attempt', status: 'tested' }]);
    await postVerdict(h, [{ taskDecision: { task_key: 'j/7', action: 'discard', source_action: 'review', reason: 'superseded' } }]);
    ok('source_action (not action) is what retires the offered item', stamped(o, 'j/7', 'review') && !stamped(o, 'j/7', 'discard'));
  }

  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
