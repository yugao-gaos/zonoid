'use strict';
// Grader for write-tests scenario
// Evaluates an agent-written test suite for parseConfig.
// Checks: (1) exports runTests, (2) all tests pass, (3) enough coverage,
// (4) source covers key edge cases textually.

const artifactPath = process.argv[2]; // bench/sandbox/solution.js

let runTests;
try {
  ({ runTests } = require(artifactPath));
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 10, error: 'require failed: ' + e.message }));
  process.exit(0);
}
if (typeof runTests !== 'function') {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 10, error: 'runTests not exported or not a function' }));
  process.exit(0);
}

let pass = 0;
const total = 10;

// 1. require succeeded (we got here)
pass++;

// 2. runTests() returns {pass, total}
let result = null;
try { result = runTests(); } catch (e) { result = null; }
if (result && typeof result.pass === 'number' && typeof result.total === 'number') pass++;

// 3. All tests in suite pass (no failures)
if (result && result.pass === result.total) pass++;

// 4. At least 8 test cases
if (result && result.total >= 8) pass++;

// 5-10: coverage checks via source text
const fs = require('fs');
const src = fs.readFileSync(artifactPath, 'utf8');

const checks = [
  [/['"`]#|comment/i,           'comment lines ignored'],
  [/throw|Error|invalid/i,      'invalid line throws'],
  [/empty|''\s*\)|""\s*\)|null/i, 'empty input returns {}'],
  [/trim|\s+/i,                 'whitespace handling'],
  [/split|\\n|multiline/i,      'multiline input'],
  [/deepEqual|strictEqual|equal/i, 'uses assert'],
];
for (const [re] of checks) {
  if (re.test(src)) pass++;
}

console.log(JSON.stringify({ ok: pass === total, pass, total }));
