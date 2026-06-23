#!/usr/bin/env node
// Regression coverage for /costflow's route-level claim/session attribution glue.
'use strict';

const analyticsRoute = require('../routes/analytics');
const { sessionCatchalls } = require('../lib/costflow');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const { claimedOutputForSession } = analyticsRoute._internal;

{
  const claims = [
    { id: 'T1', session: 'S1', transcript: '/tmp/S1.jsonl' },
    { id: 'T2', session: null, transcript: '/tmp/S1.jsonl' },
    { id: 'T3', session: 'S2', transcript: '/tmp/S2.jsonl' },
  ];
  const ownTok = new Map([['T1', 100], ['T2', 150], ['T3', 200]]);
  const claimed = claimedOutputForSession({ id: 'S1', path: '/tmp/S1.jsonl', total: 1000 }, claims, ownTok);
  ok('claimedOutputForSession matches both session id and transcript path without double-counting', claimed === 250);

  const ca = sessionCatchalls(
    [{ id: 'S1', total: 1000, claimed }],
    [{ id: 'T1', session: 'S1' }, { id: 'T2', session: 'S1' }],
  );
  const node = ca.nodes.find((n) => n.id === 'session:S1');
  ok('session catch-all subtracts task-attributed output from transcript-path claims', node && node.own === 750);
}

{
  const claims = [{ id: 'T3', session: 'S2', transcript: null }];
  const ownTok = new Map([['T3', 200]]);
  const claimed = claimedOutputForSession({ id: 'S2', total: 500 }, claims, ownTok);
  ok('claimedOutputForSession matches usage-record sessions when no transcript path exists', claimed === 200);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
