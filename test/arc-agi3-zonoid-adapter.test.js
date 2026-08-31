#!/usr/bin/env node
'use strict';

const assert = require('assert');
const test = require('node:test');
const { spawnSync } = require('child_process');
const path = require('path');
const { pythonExe } = require('./helpers/tools');

const repo = path.resolve(__dirname, '..');
const script = String.raw`
import os
import sys

repo = sys.argv[1]
sys.path.insert(0, os.path.join(repo, "bench"))

from bench.arc_agi3_zonoid import adapter

instructions = adapter.zonoid_task_instructions(
    daemon_url="http://localhost:8787",
    workspace="/tmp/zonoid-ws",
    task_key="task-123",
)

assert "REPL" in instructions
assert "decide/reflect" in instructions
assert "vision" in instructions.lower()
assert "world model" in instructions.lower()
assert "KB protocol" in instructions
assert "observe -> decide -> act -> reflect" in instructions
assert "/overlay/note" in instructions
assert "/search" in instructions

summary = adapter.contract_summary()
assert "REPL" in summary
assert "decide/reflect" in summary
assert "zonoid-on" in summary
assert "ZONOID_TASK_INSTRUCTIONS" in summary

payload = adapter.zonoid_context_payload(
    enabled=True,
    daemon_url="http://localhost:8787",
    workspace="/tmp/zonoid-ws",
    task_key="task-123",
    kb_snapshot="snapshot.json",
)
env = adapter.zonoid_context_env(payload, context_json="/tmp/zonoid-context.json")
assert env["ZONOID_ENABLED"] == "1"
assert env["ZONOID_TASK_KEY"] == "task-123"
assert env["ZONOID_TASK_INSTRUCTIONS"] == instructions
assert env["ZONOID_CONTEXT_JSON"] == "/tmp/zonoid-context.json"

print("PASS arc-agi3 zonoid adapter prompt contract")
`;

// Python is optional developer tooling here, not a project dependency. The previous ENOENT-only
// fallback treated the Windows Microsoft Store alias stub as a usable interpreter: it resolves on
// PATH (so no ENOENT), prints an install ad, and exits 9009 — reporting the machine rather than the
// adapter. pythonExe() RUNS each candidate and returns one only if it is a real Python 3.
const python = pythonExe();

test('arc-agi3 zonoid adapter prompt contract', {
  skip: python ? false : 'no Python 3 interpreter found (set PYTHON=<path> to run)',
}, () => {
  const result = spawnSync(python, ['-c', script, repo], {
    cwd: repo,
    encoding: 'utf8',
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS arc-agi3 zonoid adapter prompt contract/);
});
