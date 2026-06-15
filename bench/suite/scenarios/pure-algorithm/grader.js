'use strict';
// grader.js — MedianFinder correctness grader.
// Usage: node grader.js <artifact-path>
// Returns JSON: { ok, pass, total }

const artifactPath = process.argv[2];
let MedianFinder;
try {
  ({ MedianFinder } = require(artifactPath));
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 10, error: 'require failed: ' + e.message }));
  process.exit(0);
}

let pass = 0;
const total = 10;
const tests = [];

function check(desc, actual, expected) {
  const ok = Math.abs(actual - expected) < 1e-9;
  tests.push({ desc, actual, expected, ok });
  if (ok) pass++;
}

// Test 1: single element
{
  const mf = new MedianFinder();
  mf.addNum(5);
  check('single element', mf.findMedian(), 5);
}

// Test 2: two elements (even count)
{
  const mf = new MedianFinder();
  mf.addNum(1);
  mf.addNum(2);
  check('two elements even average', mf.findMedian(), 1.5);
}

// Test 3: three elements (odd count)
{
  const mf = new MedianFinder();
  mf.addNum(1);
  mf.addNum(2);
  mf.addNum(3);
  check('three elements odd median', mf.findMedian(), 2);
}

// Test 4: unsorted insertion
{
  const mf = new MedianFinder();
  mf.addNum(3);
  mf.addNum(1);
  mf.addNum(2);
  check('unsorted insertion', mf.findMedian(), 2);
}

// Test 5: duplicates
{
  const mf = new MedianFinder();
  mf.addNum(4);
  mf.addNum(4);
  mf.addNum(4);
  check('all duplicates', mf.findMedian(), 4);
}

// Test 6: negative numbers
{
  const mf = new MedianFinder();
  mf.addNum(-5);
  mf.addNum(-1);
  mf.addNum(-3);
  check('negative numbers', mf.findMedian(), -3);
}

// Test 7: mixed negative and positive
{
  const mf = new MedianFinder();
  mf.addNum(-2);
  mf.addNum(0);
  mf.addNum(2);
  mf.addNum(4);
  check('mixed neg/pos even count', mf.findMedian(), 1);
}

// Test 8: large value spread
{
  const mf = new MedianFinder();
  mf.addNum(-1000000);
  mf.addNum(0);
  mf.addNum(1000000);
  check('large value spread', mf.findMedian(), 0);
}

// Test 9: running median — check after each insert
{
  const mf = new MedianFinder();
  mf.addNum(6);
  mf.addNum(10);
  mf.addNum(2);
  mf.addNum(6);
  mf.addNum(5);
  // sorted: [2, 5, 6, 6, 10] → median 6
  check('running median 5 elements', mf.findMedian(), 6);
}

// Test 10: even count with non-integer average
{
  const mf = new MedianFinder();
  mf.addNum(1);
  mf.addNum(3);
  check('even count non-integer average', mf.findMedian(), 2);
}

const ok = pass === total;
console.log(JSON.stringify({ ok, pass, total }));
