'use strict';
// Grader for fix-bug scenario.
// Runs bench/sandbox/tests.js which requires ./solution (the artifact).
// tests.js exports { run } which returns { pass, total }.

const path = require('path');
const artifactPath = process.argv[2]; // bench/sandbox/solution.js
const sandboxDir = path.dirname(artifactPath);
const testsPath = path.join(sandboxDir, 'tests.js');

let runResult;
try {
  const { run } = require(testsPath);
  runResult = run();
} catch (e) {
  console.log(JSON.stringify({ ok: false, pass: 0, total: 8, error: e.message }));
  process.exit(1);
}

const pass = runResult.pass;
const total = runResult.total;
console.log(JSON.stringify({ ok: pass === total, pass, total }));
process.exit(pass === total ? 0 : 1);
