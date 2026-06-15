'use strict';
// grader.js — RateLimiter correctness + structural grader.
// Usage: node grader.js <artifact-path>
// Returns JSON: { ok, pass, total }

const artifactPath = process.argv[2];
let RateLimiter;
try {
  ({ RateLimiter } = require(artifactPath));
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 13, error: 'require failed: ' + e.message }));
  process.exit(1);
}

let pass = 0;
const total = 13;

function check(desc, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++;
  return ok;
}

// Test 1: 3 requests within limit=3 window=1000ms all pass
{
  const rl = new RateLimiter(3, 1000);
  const a = rl.isAllowed(0);
  const b = rl.isAllowed(100);
  const c = rl.isAllowed(200);
  check('test1: first 3 requests within limit pass', a && b && c, true);
}

// Test 2: 4th request rejected (still in window)
{
  const rl = new RateLimiter(3, 1000);
  rl.isAllowed(0);
  rl.isAllowed(100);
  rl.isAllowed(200);
  check('test2: 4th request rejected within window', rl.isAllowed(300), false);
}

// Test 3: after window expires, allowed again
{
  const rl = new RateLimiter(3, 1000);
  rl.isAllowed(0);
  rl.isAllowed(100);
  rl.isAllowed(200);
  check('test3: after full window expires, new request allowed', rl.isAllowed(1001), true);
}

// Test 4: limit=1, only one request per window
{
  const rl = new RateLimiter(1, 1000);
  const a = rl.isAllowed(0);
  const b = rl.isAllowed(500);
  check('test4: limit=1 allows first, rejects second in window', a === true && b === false, true);
}

// Test 5: rapid fire at same timestamp, limit=5
{
  const rl = new RateLimiter(5, 1000);
  const results = [];
  for (let i = 0; i < 6; i++) results.push(rl.isAllowed(0));
  const allFivePassed = results.slice(0, 5).every(Boolean);
  const sixthFailed = results[5] === false;
  check('test5: 5 at t=0 pass, 6th fails', allFivePassed && sixthFailed, true);
}

// Test 6: sliding (not fixed) window — requests at t=0,500,999 fill window;
// at t=1001, t=0 expired so only 2 of limit=3 used, new request allowed
{
  const rl = new RateLimiter(3, 1000);
  rl.isAllowed(0);
  rl.isAllowed(500);
  rl.isAllowed(999);
  // at t=1001: t=0 is outside [1, 1001], t=500 and t=999 are inside → 2 used, limit=3
  check('test6: sliding window — expired request frees a slot', rl.isAllowed(1001), true);
}

// Test 7: limit=10 window=10000ms, 10 requests spread across first 5000ms all pass
{
  const rl = new RateLimiter(10, 10000);
  let allPassed = true;
  for (let i = 0; i < 10; i++) {
    if (!rl.isAllowed(i * 500)) allPassed = false;
  }
  check('test7: 10 requests across 5000ms within limit=10 all pass', allPassed, true);
}

// Test 8: request exactly at boundary — window=1000ms, req at t=0, new at t=1000
// t=0 is NOT in [1, 1000] (exclusive start), so slot freed
{
  const rl = new RateLimiter(1, 1000);
  rl.isAllowed(0);
  check('test8: request at exact window boundary (t+windowMs) is allowed', rl.isAllowed(1000), true);
}

// Test 9: empty window, limit=1, isAllowed(5000) → true
{
  const rl = new RateLimiter(1, 1000);
  check('test9: first request on empty window allowed', rl.isAllowed(5000), true);
}

// Test 10: limit=0 → isAllowed always returns false
{
  const rl = new RateLimiter(0, 1000);
  check('test10: limit=0 always rejects', rl.isAllowed(0), false);
}

// Test 11: large gap — fill at t=0,1,2; isAllowed(100000) → true
{
  const rl = new RateLimiter(3, 1000);
  rl.isAllowed(0);
  rl.isAllowed(1);
  rl.isAllowed(2);
  check('test11: large gap clears the window', rl.isAllowed(100000), true);
}

// Test 12: mixed — limit=2, window=100
{
  const rl = new RateLimiter(2, 100);
  const a = rl.isAllowed(0);   // true  (1/2)
  const b = rl.isAllowed(50);  // true  (2/2)
  const c = rl.isAllowed(75);  // false (over limit, t=0 and t=50 still in window)
  const d = rl.isAllowed(101); // true  (t=0 expired, 1 in window, limit=2)
  check('test12: mixed sliding sequence', a === true && b === true && c === false && d === true, true);
}

// Structural check: module.exports.RateLimiter exists AND new RateLimiter(3,1000).buckets is an Array
// This is the KB hint — circular buffer stored as this.buckets
{
  let structOk = false;
  try {
    const instance = new RateLimiter(3, 1000);
    structOk = Array.isArray(instance.buckets);
  } catch (e) {
    structOk = false;
  }
  check('structural: this.buckets is an Array (circular buffer — KB hint)', structOk, true);
}

const ok = pass === total;
console.log(JSON.stringify({ ok, pass, total }));
process.exit(ok ? 0 : 1);
