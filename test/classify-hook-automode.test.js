#!/usr/bin/env node
// Tests that hooks/classify.sh forwards the auto-mode signal to POST /classify:
//   - permission_mode from the UserPromptSubmit payload
//   - auto_mode:true when ORCH_AUTO_LOOP=1 (env fallback)
//   - opted-out sessions ('orch off') never relay at all (case d)
// Uses a stub curl that echoes the request body back so we can assert what was forwarded.
// Run: node test/classify-hook-automode.test.js
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeCurlStub, hookEnv } = require('./helpers/curl-stub');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'classify.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-automode-'));
const SESSION_DIR = path.join(TMP, 'sessions');
fs.mkdirSync(SESSION_DIR, { recursive: true });

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
}

// Stub curl: capture the -d body to a file and return a minimal classify payload so the hook emits.
const stubDir = path.join(TMP, 'stub-curl');
const BODY_OUT = path.join(TMP, 'last-body.json');
writeCurlStub(
  stubDir,
  `prev=""
for a in "$@"; do
  if [ "$prev" = "-d" ]; then printf '%s' "$a" > "${BODY_OUT.replace(/\\/g, '/')}"; fi
  prev="$a"
done
echo '{"additional_context":"[Model routing] stub"}'
exit 0
`,
);

function runHook(input, extraEnv = {}) {
  const env = hookEnv([stubDir], {
    CLAUDE_PLUGIN_DATA: path.dirname(SESSION_DIR),
    ...extraEnv,
  });
  if (fs.existsSync(BODY_OUT)) fs.rmSync(BODY_OUT);
  const r = spawnSync('bash', [HOOK], { input, encoding: 'utf8', env });
  let body = null;
  if (fs.existsSync(BODY_OUT)) {
    try { body = JSON.parse(fs.readFileSync(BODY_OUT, 'utf8')); } catch { body = null; }
  }
  return { status: r.status, stdout: r.stdout || '', body };
}

// (1) permission_mode forwarded from payload
{
  const { body } = runHook(JSON.stringify({
    prompt: 'do the work', session_id: 'pm-sid', permission_mode: 'bypassPermissions',
  }));
  ok('permission_mode forwarded to /classify body', body && body.permission_mode === 'bypassPermissions');
}

// (2) acceptEdits forwarded verbatim (composer decides auto-ness)
{
  const { body } = runHook(JSON.stringify({
    prompt: 'do the work', session_id: 'pm-sid2', permission_mode: 'acceptEdits',
  }));
  ok('acceptEdits forwarded verbatim', body && body.permission_mode === 'acceptEdits');
}

// (3) absent permission_mode → field omitted, no auto_mode
{
  const { body } = runHook(JSON.stringify({ prompt: 'do the work', session_id: 'pm-sid3' }));
  ok('no permission_mode in payload → field omitted', body && body.permission_mode === undefined);
  ok('no env → auto_mode omitted', body && body.auto_mode === undefined);
}

// (4) ORCH_AUTO_LOOP=1 env fallback → auto_mode:true
{
  const { body } = runHook(JSON.stringify({ prompt: 'do the work', session_id: 'env-sid' }), {
    ORCH_AUTO_LOOP: '1',
  });
  ok('ORCH_AUTO_LOOP=1 → auto_mode:true forwarded', body && body.auto_mode === true);
}

// (d) opted-out session never relays (no curl body written, silent output)
{
  const sid = 'opted-out-sid';
  runHook(JSON.stringify({ prompt: 'orch off', session_id: sid }));
  const r = runHook(JSON.stringify({
    prompt: 'do the work', session_id: sid, permission_mode: 'bypassPermissions',
  }));
  ok('opted-out → no relay (no body forwarded)', r.body === null);
  ok('opted-out → silent output', r.stdout.trim() === '');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
