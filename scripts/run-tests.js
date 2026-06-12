#!/usr/bin/env node
// Dependency-free test runner: discovers test/*.test.js, runs each as a child
// process with ZONOID_SKIP_LIVE=1, reports per-file pass/fail, exits non-zero
// if any file fails. Run: node scripts/run-tests.js
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEST_DIR = path.join(ROOT, 'test');
const TIMEOUT_MS = 120_000; // per-file safety net

const files = fs.readdirSync(TEST_DIR)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

if (files.length === 0) {
  console.error('No test files found in test/');
  process.exit(1);
}

const failures = [];
const t0 = Date.now();

for (const file of files) {
  const start = Date.now();
  const res = spawnSync(process.execPath, [path.join(TEST_DIR, file)], {
    cwd: ROOT,
    env: { ...process.env, ZONOID_SKIP_LIVE: '1' },
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
  });
  const ms = Date.now() - start;
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  const passed = !timedOut && res.status === 0;

  if (passed) {
    console.log(`PASS  ${file} (${ms}ms)`);
  } else {
    const why = timedOut ? `timeout after ${TIMEOUT_MS}ms`
      : res.error ? res.error.message
      : `exit ${res.status === null ? `signal ${res.signal}` : res.status}`;
    console.log(`FAIL  ${file} (${why}, ${ms}ms)`);
    if (res.stdout) process.stdout.write(indent(res.stdout));
    if (res.stderr) process.stdout.write(indent(res.stderr));
    failures.push(file);
  }
}

console.log('');
console.log(`${files.length - failures.length}/${files.length} files passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failures.length) {
  console.log('Failed:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}

function indent(s) {
  return s.split('\n').map((l) => `      ${l}`).join('\n') + '\n';
}
