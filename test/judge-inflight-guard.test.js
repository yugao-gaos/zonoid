#!/usr/bin/env node
// Tests for the judge in-flight guard (autonomy hardening):
//   A1 — lib/internal-lanes.js reviewItems only surfaces 'review' decision items for tasks whose
//        status is 'tested'. prepare stamps review_state 'requested' at dispatch, so an
//        in_progress/ready task with a requested review is a live worker, not a reviewable attempt.
//   A2 — POST /judge/verdict refuses terminal taskDecision actions (approve/kick_back/discard/
//        cancel) for live (in_progress/ready) tasks and does NOT stamp the decision, so the item
//        re-surfaces once the task reaches 'tested' (the stamp is permanent — see
//        judgedTaskDecisions; a stamped skip could never be re-judged).
// Run: node test/judge-inflight-guard.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ov = require('../lib/overlay');
const judge = require('../lib/judge');
const judgeRoute = require('../routes/judge');
const { buildInternalLaneProjection } = require('../lib/internal-lanes');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-inflight-guard-')));
fs.mkdirSync(path.join(WS, '.graph'), { recursive: true });

// ---------- A1: reviewItems tested gate ------------------------------------------------------
{
  const o = ov.EMPTY();
  ov.setReviewLifecycle(o, 't/inflight', { review_state: 'requested', merge_state: 'review_pending', attempt_branch: 'orch/attempt/t-inflight' });
  ov.setReviewLifecycle(o, 't/claimable', { review_state: 'requested', merge_state: 'review_pending' });
  ov.setReviewLifecycle(o, 't/done-work', { review_state: 'requested', merge_state: 'review_pending' });
  ov.setReviewLifecycle(o, 't/approved', { review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending' });
  const graph = {
    tasks: [
      { id: 't/inflight', label: 'worker mid-flight', status: 'in_progress', deps: [] },
      { id: 't/claimable', label: 'ready not started', status: 'ready', deps: [] },
      { id: 't/done-work', label: 'worker done', status: 'tested', deps: [] },
      { id: 't/approved', label: 'approved awaiting merge', status: 'tested', deps: [] },
    ],
  };
  const proj = buildInternalLaneProjection({ workspace: WS, graph, overlay: o });
  const lifecycleItems = (key) => proj.items.filter((i) => i.source === 'review_lifecycle' && i.key === key);
  ok('A1: in_progress task with requested review produces NO review item', lifecycleItems('t/inflight').length === 0);
  ok('A1: ready task with requested review produces NO review item', lifecycleItems('t/claimable').length === 0);
  ok('A1: tested task with requested review produces a review item', lifecycleItems('t/done-work').some((i) => i.kind === 'review'));
  ok('A1: tested approved task still produces a merge item', lifecycleItems('t/approved').some((i) => i.kind === 'merge'));
}

// ---------- A2: /judge/verdict in-flight guard (real route, mock ctx) -------------------------
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

(async () => {
  // cancel on an in_progress task → refused, not stamped, not canceled.
  {
    const o = ov.EMPTY();
    o.status['s/1'] = 'in_progress';
    ov.setReviewLifecycle(o, 's/1', { review_state: 'requested', merge_state: 'review_pending' });
    const h = makeCtx(o, [{ id: 's/1', label: 'live worker', status: 'in_progress' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 's/1', action: 'cancel', reason: 'empty diff' } }]);
    ok('A2: cancel on in_progress refused (counted skippedInFlight)', r.status === 200 && r.body.applied.skippedInFlight === 1);
    ok('A2: cancel on in_progress does not apply the cancel', !r.body.applied.canceled && o.status['s/1'] === 'in_progress' && !(o.cancel_requested && o.cancel_requested['s/1']));
    ok('A2: cancel on in_progress leaves review lifecycle intact', o.reviews['s/1'].review_state === 'requested');
    ok('A2: cancel on in_progress is NOT stamped (re-surfaces later)', !o.judgedTaskDecisions[judge.taskDecisionId('s/1', 'cancel')]);
    const journal = fs.readFileSync(path.join(WS, '.graph', 'judge-journal.jsonl'), 'utf8');
    ok('A2: skip is journaled for audit', journal.includes('task:cancel_skipped_in_flight'));
  }

  // discard on an in_progress task → refused, not stamped.
  {
    const o = ov.EMPTY();
    o.status['s/2'] = 'in_progress';
    const h = makeCtx(o, [{ id: 's/2', label: 'live worker', status: 'in_progress' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 's/2', action: 'discard', reason: 'stale' } }]);
    ok('A2: discard on in_progress refused', r.body.applied.skippedInFlight === 1 && !r.body.applied.discarded);
    ok('A2: discard on in_progress writes no lifecycle/note', !(o.reviews && o.reviews['s/2']) && !o.notes['s/2']);
    ok('A2: discard on in_progress not stamped', !o.judgedTaskDecisions[judge.taskDecisionId('s/2', 'discard')]);
  }

  // approve on a ready task (same race: empty diff) → refused, not stamped.
  {
    const o = ov.EMPTY();
    o.status['s/3'] = 'ready';
    const h = makeCtx(o, [{ id: 's/3', label: 'claimable', status: 'ready' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 's/3', action: 'approve', reason: 'looks fine' } }]);
    ok('A2: approve on ready refused', r.body.applied.skippedInFlight === 1 && !r.body.applied.taskDecisions);
    ok('A2: approve on ready writes no approved lifecycle', !(o.reviews && o.reviews['s/3']));
    ok('A2: approve on ready not stamped', !o.judgedTaskDecisions[judge.taskDecisionId('s/3', 'approve')]);
  }

  // kick_back on an in_progress task → refused (would fail a live worker's task).
  {
    const o = ov.EMPTY();
    o.status['s/4'] = 'in_progress';
    const h = makeCtx(o, [{ id: 's/4', label: 'live worker', status: 'in_progress' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 's/4', action: 'kick_back', reason: 'no tests' } }]);
    ok('A2: kick_back on in_progress refused', r.body.applied.skippedInFlight === 1 && o.status['s/4'] === 'in_progress');
    ok('A2: kick_back on in_progress not stamped', !o.judgedTaskDecisions[judge.taskDecisionId('s/4', 'kick_back')]);
  }

  // unstamped skip re-surfaces: the decision item is still in buildQueue after the refusal.
  {
    const o = ov.EMPTY();
    o.status['s/5'] = 'in_progress';
    ov.setReviewLifecycle(o, 's/5', { review_state: 'requested', merge_state: 'review_pending' });
    const h = makeCtx(o, [{ id: 's/5', label: 'live worker', status: 'in_progress' }]);
    await postVerdict(h, [{ taskDecision: { task_key: 's/5', action: 'cancel', source_action: 'review', reason: 'empty diff' } }]);
    const q = judge.buildQueue(o);
    ok('A2: refused decision item re-surfaces in buildQueue (not retired)', q.some((it) => it.kind === 'task-decision' && it.task_key === 's/5'));
  }

  // cancel on a tested task → applied and stamped (guard only protects live tasks).
  {
    const o = ov.EMPTY();
    o.status['s/6'] = 'tested';
    const h = makeCtx(o, [{ id: 's/6', label: 'finished attempt', status: 'tested' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 's/6', action: 'cancel', reason: 'superseded' } }]);
    ok('A2: cancel on tested task applies', r.body.applied.canceled === 1 && o.status['s/6'] === 'canceled');
    ok('A2: cancel on tested task IS stamped', o.judgedTaskDecisions[judge.taskDecisionId('s/6', 'cancel')] === true);
  }

  // approve on a tested task → applied (regression: normal review path unaffected).
  {
    const o = ov.EMPTY();
    o.status['s/7'] = 'tested';
    ov.setReviewLifecycle(o, 's/7', { review_state: 'requested', merge_state: 'review_pending' });
    const h = makeCtx(o, [{ id: 's/7', label: 'finished attempt', status: 'tested' }]);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 's/7', action: 'approve', reason: 'sound attempt' } }]);
    ok('A2: approve on tested task applies', r.body.applied.taskDecisions === 1 && o.reviews['s/7'].review_state === 'approved' && o.reviews['s/7'].merge_state === 'pending');
    ok('A2: approve on tested task IS stamped', o.judgedTaskDecisions[judge.taskDecisionId('s/7', 'approve')] === true);
  }

  // task missing from the graph (no status known) → guard does not block (back-compat).
  {
    const o = ov.EMPTY();
    const h = makeCtx(o, []);
    const r = await postVerdict(h, [{ taskDecision: { task_key: 's/ghost', action: 'discard', reason: 'orphan record' } }]);
    ok('A2: unknown-status task still accepts the decision (back-compat)', r.body.applied.discarded === 1);
    ok('A2: unknown-status decision stamped as before', o.judgedTaskDecisions[judge.taskDecisionId('s/ghost', 'discard')] === true);
  }

  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
