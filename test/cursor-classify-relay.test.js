#!/usr/bin/env node
// Cursor beforeSubmitPrompt → adapters/cursor/classify.sh relay (CI-safe stub curl).
// Run: node test/cursor-classify-relay.test.js
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const HOOK = path.join(REPO, 'adapters', 'cursor', 'classify.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-classify-relay-'));
const SESSION_DIR = path.join(TMP, 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
}

function runHook(input, extraEnv = {}) {
  const env = {
    ...process.env,
    ZONOID_ROOT: REPO,
    CLAUDE_PLUGIN_DATA: path.dirname(SESSION_DIR),
    ...extraEnv,
  };
  const r = spawnSync('bash', [HOOK], { input, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function parseOut(stdout) {
  try { return JSON.parse(stdout); } catch { return null; }
}

const stubDir = path.join(TMP, 'stub-curl');
fs.mkdirSync(stubDir, { recursive: true });
const stubPayload = { additional_context: '[Model routing] cursor-stub\n[Orchestrator heartbeat] cursor-stub' };
fs.writeFileSync(path.join(stubDir, 'classify.json'), JSON.stringify(stubPayload));
fs.writeFileSync(
  path.join(stubDir, 'curl'),
  `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
prev=""
for arg in "$@"; do
  if [ "$prev" = "-d" ]; then
    printf '%s' "$arg" > "$DIR/last-body.json"
  fi
  prev="$arg"
done
if printf "%s" "$*" | grep -q "/classify"; then
  cat "$DIR/classify.json"
else
  echo '{}'
fi
exit 0
`,
  { mode: 0o755 },
);

const CONV_ID = 'cursor-conv-relay-abc123';
const cursorInput = JSON.stringify({
  conversation_id: CONV_ID,
  prompt: 'fix the login button',
  workspace_roots: [path.join(TMP, 'ws')],
});

{
  const r = runHook(cursorInput, { PATH: stubDir + ':' + process.env.PATH });
  ok('relay exit 0', r.status === 0);
  const body = JSON.parse(fs.readFileSync(path.join(stubDir, 'last-body.json'), 'utf8'));
  ok('conversation_id → session_id in /classify body', body.session_id === CONV_ID);
  ok('/classify body includes prompt', body.prompt === 'fix the login button');

  const out = parseOut(r.stdout);
  ok('output has hookSpecificOutput', out && out.hookSpecificOutput);
  ok('hookEventName is beforeSubmitPrompt', out && out.hookSpecificOutput.hookEventName === 'beforeSubmitPrompt');
  ok('additionalContext from stub', out && out.hookSpecificOutput.additionalContext.includes('[Model routing] cursor-stub'));
}

{
  const sid = 'cursor-orch-off-conv';
  runHook(JSON.stringify({ conversation_id: sid, prompt: 'orch off' }));
  const r = runHook(JSON.stringify({ conversation_id: sid, prompt: 'hello after off' }), {
    PATH: stubDir + ':' + process.env.PATH,
  });
  ok('orch off via conversation_id → silent', r.stdout.trim() === '');
  ok('orch off → exit 0', r.status === 0);
}

{
  const r = runHook(JSON.stringify({ conversation_id: 'cursor-user-msg', user_message: 'audit auth module' }), {
    PATH: stubDir + ':' + process.env.PATH,
  });
  const body = JSON.parse(fs.readFileSync(path.join(stubDir, 'last-body.json'), 'utf8'));
  ok('user_message maps to prompt', body.prompt === 'audit auth module');
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
