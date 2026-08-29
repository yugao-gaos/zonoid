#!/usr/bin/env node
// Review/merge lifecycle metadata must keep stale tasks out of the ready spawn pool.
'use strict';

const ovStore = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

{
  const ov = ovStore.EMPTY();
  ov.git['task/merged'] = { merged: true };
  ok('git merged derives done', ovStore.lifecycleDerivedStatus(ov, 'task/merged') === 'done');
}

{
  const ov = ovStore.EMPTY();
  ov.reviews['task/review-merged'] = { merge_state: 'merged', review_verdict: 'APPROVE' };
  ok('review merged derives done', ovStore.lifecycleDerivedStatus(ov, 'task/review-merged') === 'done');
}

{
  const ov = ovStore.EMPTY();
  ov.reviews['task/approved'] = { review_verdict: 'APPROVE', merge_state: 'conflict' };
  ok('approved conflict derives tested, not ready', ovStore.lifecycleDerivedStatus(ov, 'task/approved') === 'tested');
}

{
  const ov = ovStore.EMPTY();
  ov.reviews['task/landed'] = { review_state: 'landed', review_verdict: 'KICK_BACK', merge_state: 'conflict' };
  ok('landed lifecycle is terminal done despite stale conflict metadata', ovStore.lifecycleDerivedStatus(ov, 'task/landed') === 'done');
  const view = ovStore.reviewLifecycleFor(ov, 'task/landed', 'done');
  ok('done lifecycle view closes stale conflict provenance', view.review_state === 'landed' && view.review_verdict === 'APPROVE' && view.merge_state === 'closed');
}

{
  const ov = ovStore.EMPTY();
  ov.reviews['task/canceled'] = { review_state: 'rejected', review_verdict: 'KICK_BACK', merge_state: 'blocked' };
  ok('rejected lifecycle derives failed', ovStore.lifecycleDerivedStatus(ov, 'task/canceled') === 'failed');
  const view = ovStore.reviewLifecycleFor(ov, 'task/canceled', 'canceled');
  ok('explicit canceled status owns its lifecycle view', view.review_state === 'canceled' && view.review_verdict === null && view.merge_state === 'closed');
}

{
  const ov = ovStore.EMPTY();
  ov.reviews['task/canceled'] = { review_state: 'canceled', merge_state: 'closed' };
  ok('canceled lifecycle keeps a stale native row terminal', ovStore.lifecycleDerivedStatus(ov, 'task/canceled') === 'canceled');
  ov.reviews['task/blocked'] = { review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'blocked' };
  ok('merge-blocked lifecycle enters failure recovery', ovStore.lifecycleDerivedStatus(ov, 'task/blocked') === 'failed');
}

{
  const ov = ovStore.EMPTY();
  ok('ordinary task has no lifecycle status', ovStore.lifecycleDerivedStatus(ov, 'task/plain') === null);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
