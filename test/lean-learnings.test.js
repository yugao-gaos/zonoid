#!/usr/bin/env node
// Plain Node test for daemon.js leanLearnings + isTruthy — the /learnings ?compact=1 lean payload
// (no framework; matches test/rejected-digest.test.js style). Run: node test/lean-learnings.test.js
//
// Lean payload keeps rejected[] as-is, trims verdicts to {key,winner,why} (why <=200 chars), DROPS
// recent, and collapses failures to failuresCount. Non-compact path returns the full payload as-is.
'use strict';
const { leanLearnings, isTruthy } = require('../daemon.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const longWhy = 'x'.repeat(500);
const full = {
  verdicts: [
    { key: 'sess/1', verdict: { winner: 'sess/3', why: longWhy, losers: [{ key: 'sess/2', reason: 'slow' }], extra: 'noise' } },
    { key: 'sess/4', verdict: { winner: 'sess/5', reason: 'fallback to reason field' } },
  ],
  failures: [
    { key: 'sess/9', label: 'dead end', status: 'failed', note: 'big note '.repeat(40) },
    { key: 'sess/10', label: 'other', status: 'canceled', note: 'another big note' },
  ],
  recent: [{ key: 'sess/8', label: 'done thing', summary: 'a long completion summary '.repeat(20) }],
  rejected: [{ approach: 'sess/2 (b)', reason: 'slow', beatenBy: 'sess/3', source: 'verdict' }],
};

const lean = leanLearnings(full);

// (a) compact omits recent, trims verdicts.why, keeps rejected[]
ok('lean drops recent', !('recent' in lean));
ok('lean keeps rejected[] unchanged', JSON.stringify(lean.rejected) === JSON.stringify(full.rejected));
ok('lean verdicts trimmed to {key,winner,why}', lean.verdicts.every((v) => Object.keys(v).sort().join(',') === 'key,why,winner'));
ok('lean verdict why truncated to <=200', lean.verdicts[0].why.length === 200);
ok('lean verdict carries winner', lean.verdicts[0].winner === 'sess/3');
ok('lean verdict falls back to reason when no why', lean.verdicts[1].why === 'fallback to reason field');
ok('lean collapses failures to count', lean.failuresCount === 2 && !('failures' in lean));

// (b) non-compact path is the full payload untouched (route passes `full` straight through)
ok('full payload retains recent', Array.isArray(full.recent) && full.recent.length === 1);
ok('full payload retains failures array', Array.isArray(full.failures) && full.failures.length === 2);
ok('full payload verdicts still carry nested verdict object', 'verdict' in full.verdicts[0]);

// (c) serialized lean is materially smaller than full
const leanLen = JSON.stringify(lean).length;
const fullLen = JSON.stringify(full).length;
ok(`lean (${leanLen}) materially < full (${fullLen})`, leanLen < fullLen * 0.6);

// isTruthy helper sanity
ok('isTruthy 1/true/yes', isTruthy('1') && isTruthy('true') && isTruthy('yes') && isTruthy('anything'));
ok('isTruthy falsey/empty/null', !isTruthy('0') && !isTruthy('false') && !isTruthy('no') && !isTruthy('') && !isTruthy(null));

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
