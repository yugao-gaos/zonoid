#!/usr/bin/env node
// Tests hooks/classify.sh as a dumb relay to POST /classify.
// Run: node test/classify-hook-relay.test.js
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeCurlStub, hookEnv } = require('./helpers/curl-stub');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'classify.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-hook-relay-'));
const SESSION_DIR = path.join(TMP, 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
}

function runHook(input, extraEnv = {}, stubDirs = []) {
  const env = hookEnv(stubDirs, {
    CLAUDE_PLUGIN_DATA: path.dirname(SESSION_DIR),
    ...extraEnv,
  });
  const r = spawnSync('bash', [HOOK], { input, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function extractCtx(stdout) {
  try {
    const obj = JSON.parse(stdout);
    return obj.hookSpecificOutput && obj.hookSpecificOutput.additionalContext || '';
  } catch {
    return '';
  }
}

const stubDir = path.join(TMP, 'stub-curl');
fs.mkdirSync(stubDir, { recursive: true });
const stubPayload = { additional_context: '[Model routing] stub\n[Orch gate] stub\n[Orchestrator heartbeat] stub' };
fs.writeFileSync(path.join(stubDir, 'classify.json'), JSON.stringify(stubPayload));
writeCurlStub(
  stubDir,
  `DIR="$(cd "$(dirname "$0")" && pwd)"
ARGS="$*"
if printf "%s" "$ARGS" | grep -q "/classify"; then
  cat "$DIR/classify.json"
else
  echo '{}'
fi
exit 0
`,
);

{
  const sid = 'relay-on-sid';
  const r = runHook(JSON.stringify({ prompt: 'orch on', session_id: sid }));
  const ctx = extractCtx(r.stdout);
  ok('orch on → enabled message', ctx.includes('Enabled (default)'));
  ok('orch on → exit 0', r.status === 0);
}

{
  const sid = 'relay-off-sid';
  runHook(JSON.stringify({ prompt: 'orch off', session_id: sid }));
  const r = runHook(JSON.stringify({ prompt: 'hello after off', session_id: sid }));
  ok('orch off → subsequent prompt silent', r.stdout.trim() === '');
  ok('orch off → exit 0', r.status === 0);
}

{
  const r = runHook(JSON.stringify({ prompt: 'fix the bug', session_id: 'relay-classify' }), {}, [stubDir]);
  const ctx = extractCtx(r.stdout);
  ok('relay → model routing from stub', ctx.includes('[Model routing] stub'));
  ok('relay → heartbeat from stub', ctx.includes('[Orchestrator heartbeat] stub'));
}

{
  const r = runHook(JSON.stringify({ prompt: 'fix typo', sessionId: 'relay-sessionId-fallback' }), {}, [stubDir]);
  ok('sessionId fallback → hook outputs context', extractCtx(r.stdout).includes('[Model routing] stub'));
}

{
  const emptyDir = path.join(TMP, 'stub-empty');
  writeCurlStub(emptyDir, 'echo "{}"\nexit 0\n');
  const r = runHook(JSON.stringify({ prompt: 'hello', session_id: 'empty' }), {}, [emptyDir]);
  ok('empty classify → no output', r.stdout.trim() === '');
  ok('empty classify → exit 0', r.status === 0);
}

fs.rmSync(TMP, { recursive: true, force: true });

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
