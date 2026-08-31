#!/usr/bin/env node
// Runs bench/zonoid_bench/test_judge_drain.py under `npm run test:all`.
//
// The judge-drain path (client.judge_drain + arms.run_canonical_wiring, commit 86dd386) is Python,
// and scripts/run-tests.js only discovers test/*.test.js — so this wrapper is what gives that path
// coverage in the repo suite. The assertions live in the .py file (also runnable on its own).
//
// Interpreter resolution: PATH `python3`/`python` are unreliable on Windows, where the App Execution
// Alias shim exits 9009 without running anything, so each candidate is probed with `--version` and
// only accepted if it actually reports a Python 3. The bench's documented embeddable interpreter
// (%LOCALAPPDATA%\py312embed) is probed too, since that is what runs the bench on this box.
'use strict';

const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const script = path.join(repo, 'bench', 'zonoid_bench', 'test_judge_drain.py');

function candidates() {
  const list = [];
  if (process.env.PYTHON) list.push(process.env.PYTHON);
  list.push('python3', 'python');
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) list.push(path.join(localAppData, 'py312embed', 'python.exe'));
  return list;
}

// A candidate counts only if `--version` exits 0 AND prints "Python 3.x" — the Windows Store alias
// exits non-zero with an install prompt, and would otherwise be mistaken for a usable interpreter.
function resolvePython() {
  for (const exe of candidates()) {
    const probe = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (probe.error || probe.status !== 0) continue;
    if (/Python 3\./.test(`${probe.stdout}${probe.stderr}`)) return exe;
  }
  return null;
}

const python = resolvePython();
if (!python) {
  // No usable interpreter: report loudly and pass, rather than failing the whole JS suite on a box
  // that has no Python at all. Set PYTHON=<path> to force one.
  console.log('SKIP bench-judge-drain: no Python 3 interpreter found (set PYTHON=<path> to run)');
  process.exit(0);
}

const result = spawnSync(python, [script], {
  cwd: repo,
  encoding: 'utf8',
  windowsHide: true,
  timeout: 60_000,
});

assert.ifError(result.error);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /PASS bench judge drain: \d+ tests/);
console.log(result.stdout.trim());
