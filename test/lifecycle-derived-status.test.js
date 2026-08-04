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
  ok('ordinary task has no lifecycle status', ovStore.lifecycleDerivedStatus(ov, 'task/plain') === null);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
