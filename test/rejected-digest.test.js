#!/usr/bin/env node
// Plain Node test for daemon.js digestRejected — the /learnings `rejected[]` ledger (no framework;
// matches test/token-attr.test.js style). Run: node test/rejected-digest.test.js — exits non-zero on fail.
//
// rejected[] = verdict losers (source:'verdict', carrying beatenBy=winner) + GENUINE dead-end failures
// (source:'failure'). Superseded/duplicate/consolidated failures are replaced work, not dead ends, and
// are excluded. Labels are resolved via labelFor(key) when available.
'use strict';
const { digestRejected } = require('../daemon.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const labelFor = (k) => ({ 'sess/2': 'attempt-bravo', 'sess/9': 'dead-end task' }[k] || '');

// (a) A verdict with losers yields source:'verdict' entries with beatenBy set + resolved label.
const verdicts = [{ key: 'sess/1', verdict: { winner: 'sess/3', losers: [{ key: 'sess/2', reason: 'slower under load' }] } }];
// Failures: one superseded (EXCLUDED), one genuine dead end (INCLUDED).
const failures = [
  { key: 'sess/5', label: 'replaced', status: 'canceled', note: 'superseded by sess/6: replan' },
  { key: 'sess/9', label: 'dead-end task', status: 'failed', note: 'approach fundamentally cannot satisfy constraint X' },
];

const r = digestRejected(verdicts, failures, labelFor);

// (a) verdict loser
const vr = r.find((e) => e.source === 'verdict');
ok('verdict loser present with source:verdict', !!vr);
ok('verdict loser carries beatenBy = winner', vr && vr.beatenBy === 'sess/3');
ok('verdict loser reason preserved', vr && vr.reason === 'slower under load');
ok('verdict loser approach includes resolved label', vr && vr.approach === 'sess/2 (attempt-bravo)');

// (b) superseded failure EXCLUDED
ok('superseded failure excluded', !r.some((e) => e.approach.startsWith('sess/5')));

// (c) genuine dead-end failure INCLUDED
const fr = r.find((e) => e.source === 'failure');
ok('genuine dead-end failure included with source:failure', !!fr);
ok('dead-end failure approach + reason set', fr && fr.approach === 'sess/9 (dead-end task)' && /constraint X/.test(fr.reason));

// Bag sanity: exactly 2 entries (1 verdict loser + 1 dead end; superseded dropped).
ok('exactly two rejected entries (superseded dropped)', r.length === 2);

// regex breadth: 'duplicate' and 'consolidated' notes are also excluded.
const r2 = digestRejected([], [
  { key: 'sess/10', label: 'dup', status: 'canceled', note: 'duplicate of sess/11' },
  { key: 'sess/12', label: 'merged', status: 'canceled', note: 'consolidated into sess/13' },
], labelFor);
ok('duplicate + consolidated failures excluded', r2.length === 0);

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
