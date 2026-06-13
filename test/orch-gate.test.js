#!/usr/bin/env node
// Tests for hooks/orch-gate.sh path allowlist and claim-check logic.
// Run: node test/orch-gate.test.js  — exits non-zero on any failed assertion.
//
// Strategy: pipe synthetic PreToolUse JSON into the hook and check exit codes.
//   - A stub `curl` on PATH returns a "subagent, no claim" response to drive exit-2 paths.
//   - Task mint paths (~/.claude/tasks/*, ~/.claude/orchestrator/tasks/*) must exit 0
//     even when the stub reports no claim.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'orch-gate.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gate-test-'));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
}

function mkInput(filePath, sessionId) {
  return JSON.stringify({
    tool_input: { file_path: filePath, new_string: 'x' },
    session_id: sessionId || 'test-session-x',
  });
}

function runHook(input, extraEnv) {
  const env = { ...process.env, ...extraEnv };
  const r = spawnSync('bash', [HOOK], {
    input,
    encoding: 'utf8',
    env,
  });
  return { status: r.status, stderr: r.stderr || '' };
}

// Stub curl: subagent with no claim → would block non-exempt paths
const stubDir = path.join(TMP, 'stub-blocked');
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(
  path.join(stubDir, 'curl'),
  '#!/bin/bash\nU="${@: -1}"\nif [[ "$U" == *"/active-claim"* ]]; then\n  echo \'{"claimed":false}\'\nelif [[ "$U" == *"/session-info"* ]]; then\n  echo \'{"is_subagent":"true"}\'\nfi\nexit 0\n',
  { mode: 0o755 },
);

function runBlocked(filePath, extra) {
  return runHook(mkInput(filePath), { PATH: stubDir + ':' + process.env.PATH, ...extra });
}

// Stub curl: main session with no claim → blocks non-exempt paths
const stubDirMain = path.join(TMP, 'stub-main');
fs.mkdirSync(stubDirMain, { recursive: true });
fs.writeFileSync(
  path.join(stubDirMain, 'curl'),
  '#!/bin/bash\nU="${@: -1}"\nif [[ "$U" == *"/active-claim"* ]]; then\n  echo \'{"claimed":false}\'\nelif [[ "$U" == *"/session-info"* ]]; then\n  echo \'{"is_subagent":false}\'\nfi\nexit 0\n',
  { mode: 0o755 },
);

function runMainBlocked(filePath, extra) {
  return runHook(mkInput(filePath), { PATH: stubDirMain + ':' + process.env.PATH, ...extra });
}

// ── Test cases ──────────────────────────────────────────────────────────────

// 1. Native Claude TaskCreate path → exempt → exit 0
{
  const home = process.env.HOME || '/Users/x';
  const r = runBlocked(`${home}/.claude/tasks/abc-uuid-123/1.json`);
  ok('native task path ~/.claude/tasks/<uuid>/1.json → exit 0', r.status === 0);
}

// 2. File-drop task mint path → exempt → exit 0
{
  const home = process.env.HOME || '/Users/x';
  const r = runBlocked(`${home}/.claude/orchestrator/tasks/ws-abc/cursor/t1.json`);
  ok('filedrop task path ~/.claude/orchestrator/tasks/ws-abc/cursor/t1.json → exit 0', r.status === 0);
}

// 3. Regular source file → not exempt → subagent blocked → exit 2
{
  const r = runBlocked('/Users/x/proj/src.js');
  ok('regular source /Users/x/proj/src.js → exit 2 for unclaimed subagent', r.status === 2);
}


// 4. Regular source file → main session, no claim → exit 2 (zero-tolerance)
{
  const r = runMainBlocked('/Users/x/proj/src.js');
  ok('regular source /Users/x/proj/src.js → exit 2 for unclaimed main session', r.status === 2);
}

// ── Cleanup ─────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
