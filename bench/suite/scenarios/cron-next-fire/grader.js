'use strict';
// grader.js — cron-next-fire correctness grader
// Usage: node grader.js <artifact-path>
// Output: JSON { ok, pass, total }

const artifactPath = process.argv[2];
let nextFire;
try {
  ({ nextFire } = require(artifactPath));
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 12, error: 'require failed: ' + e.message }));
  process.exit(0);
}

let pass = 0;
const total = 12;

function check(desc, fn) {
  try {
    const result = fn();
    if (result) {
      pass++;
    } else {
      // silent fail
    }
  } catch (e) {
    // unexpected throw counts as fail
  }
}

function checkThrows(desc, fn) {
  try {
    fn();
    // did not throw — fail
  } catch (e) {
    pass++;
  }
}

function dateEq(a, b) {
  return a instanceof Date && Math.abs(a.getTime() - b.getTime()) === 0;
}

// Test 1: every minute — fires next minute at :00
check('every minute', () => {
  const from = new Date(Date.UTC(2024, 0, 15, 10, 30, 45));
  const expected = new Date(Date.UTC(2024, 0, 15, 10, 31, 0));
  return dateEq(nextFire('* * * * *', from), expected);
});

// Test 2: every hour at :30 — already past :30, fires next hour
check('hourly at :30', () => {
  const from = new Date(Date.UTC(2024, 0, 15, 10, 45, 0));
  const expected = new Date(Date.UTC(2024, 0, 15, 11, 30, 0));
  return dateEq(nextFire('30 * * * *', from), expected);
});

// Test 3: daily at 09:15 — already past today's fire
check('daily at 09:15', () => {
  const from = new Date(Date.UTC(2024, 0, 15, 9, 20, 0));
  const expected = new Date(Date.UTC(2024, 0, 16, 9, 15, 0));
  return dateEq(nextFire('15 9 * * *', from), expected);
});

// Test 4: step — */15 minutes, currently at :07
check('*/15 step from :07', () => {
  const from = new Date(Date.UTC(2024, 0, 15, 10, 7, 0));
  const expected = new Date(Date.UTC(2024, 0, 15, 10, 15, 0));
  return dateEq(nextFire('*/15 * * * *', from), expected);
});

// Test 5: range — 0 9-17 * * *, from 17:00 → next day 09:00
check('range 9-17, from 17:00', () => {
  const from = new Date(Date.UTC(2024, 0, 15, 17, 0, 0));
  const expected = new Date(Date.UTC(2024, 0, 16, 9, 0, 0));
  return dateEq(nextFire('0 9-17 * * *', from), expected);
});

// Test 6: comma list DOW — 0 9 * * 1,3,5 (Mon/Wed/Fri)
// from = Mon 2024-01-15 09:00 → next fire is Wed 2024-01-17 09:00
// (from is AT the fire time, so it must be strictly after → Wed)
check('dow comma list Mon/Wed/Fri', () => {
  const from = new Date(Date.UTC(2024, 0, 15, 9, 0, 0)); // Monday
  const expected = new Date(Date.UTC(2024, 0, 17, 9, 0, 0)); // Wednesday
  return dateEq(nextFire('0 9 * * 1,3,5', from), expected);
});

// Test 7: month-specific — 0 0 1 3 * (1st March midnight)
check('month-specific March 1', () => {
  const from = new Date(Date.UTC(2024, 0, 15, 0, 0, 0));
  const expected = new Date(Date.UTC(2024, 2, 1, 0, 0, 0));
  return dateEq(nextFire('0 0 1 3 *', from), expected);
});

// Test 8: year rollover — 0 0 1 1 *, from Dec 1 → Jan 1 next year
check('year rollover Jan 1', () => {
  const from = new Date(Date.UTC(2024, 11, 1, 0, 0, 0));
  const expected = new Date(Date.UTC(2025, 0, 1, 0, 0, 0));
  return dateEq(nextFire('0 0 1 1 *', from), expected);
});

// Test 9: DOM+DOW OR semantics — 0 12 15 * 1 (noon on 15th OR any Monday)
// from = Mon 2024-01-08 12:00 → next is Mon 2024-01-13 12:00 (NOT Jan 8 because exclusive)
// Wait: from=Jan 8 12:00 exactly, exclusive. Next Monday is Jan 15 (also the 15th!).
// Actually next fire after Jan 8 12:00: Jan 13 is Saturday... let's recheck.
// 2024-01-08 = Monday (dow=1). Mondays: 8,15,22,29. 15th = Mon = both match.
// Strictly after Jan 8 12:00: next Monday at noon = Jan 15. Also the 15th at noon.
// So expected = Jan 15 2024 12:00 UTC.
// But wait — was the scenario spec asking for Jan 13? Let me re-examine:
// The spec says: from 2024-01-08 12:00:00 → 2024-01-13 12:00:00 (Monday the 13th)
// 2024-01-13 is a Saturday, not Monday. Let me verify: Jan 1 2024 = Monday.
// Jan 8 = Monday, Jan 13 = Saturday, Jan 15 = Monday.
// The spec example had an error. Use correct: from Jan 8 (Mon) → Jan 13 is Sat, not Mon.
// With OR: dom=15 OR dow=1. After Jan 8 12:00:
//   Jan 13 Sat noon: dom!=15, dow=6!=1 → no
//   Jan 14 Sun noon: no
//   Jan 15 Mon noon: dom=15 ✓ AND dow=1 ✓ → yes
// So expected is Jan 15 2024 12:00 UTC.
check('dom+dow OR semantics', () => {
  const from = new Date(Date.UTC(2024, 0, 8, 12, 0, 0));  // Monday Jan 8
  const expected = new Date(Date.UTC(2024, 0, 15, 12, 0, 0)); // Monday Jan 15 (also 15th)
  return dateEq(nextFire('0 12 15 * 1', from), expected);
});

// Test 10: exactly on a fire time is exclusive — */5, from 10:15:00 → 10:20:00
check('exclusive boundary at fire time', () => {
  const from = new Date(Date.UTC(2024, 0, 15, 10, 15, 0));
  const expected = new Date(Date.UTC(2024, 0, 15, 10, 20, 0));
  return dateEq(nextFire('*/5 * * * *', from), expected);
});

// Test 11: wrong field count throws
checkThrows('wrong field count throws', () => {
  nextFire('* * * *', new Date());
});

// Test 12: out-of-range minute (60) throws
checkThrows('out-of-range minute throws', () => {
  nextFire('60 * * * *', new Date());
});

const ok = pass === total;
console.log(JSON.stringify({ ok, pass, total }));
