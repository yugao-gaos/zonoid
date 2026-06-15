'use strict';
// grader.js — balanced-brackets correctness grader
// Usage: node grader.js <artifact-path>
// Output: JSON { ok, pass, total }

const artifactPath = process.argv[2];
let isBalanced;
try {
  ({ isBalanced } = require(artifactPath));
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 10, error: 'require failed: ' + e.message }));
  process.exit(0);
}

let pass = 0;
const total = 10;

function check(input, expected) {
  try {
    const result = isBalanced(input);
    if (result === expected) pass++;
  } catch (e) {
    // unexpected throw counts as fail
  }
}

check('', true);               // Test 1: empty string
check('()', true);             // Test 2: simple pair
check('()[]{}'  , true);      // Test 3: multiple pairs
check('([])', true);           // Test 4: nested
check('([{}])', true);         // Test 5: deeply nested
check('(]', false);            // Test 6: wrong closer
check('([)]', false);          // Test 7: interleaved
check('{', false);             // Test 8: unclosed opener
check('(((', false);           // Test 9: multiple unclosed
check('a(b[c]d)e', true);     // Test 10: non-bracket chars ignored

const ok = pass === total;
console.log(JSON.stringify({ ok, pass, total }));
