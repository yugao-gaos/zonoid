#!/usr/bin/env node
// 'orch auto' / 'orch auto off' conversation toggle in BOTH classify hook entrypoints:
//   - hooks/classify.js (Node, wired by settings.sample.json): tested against a stub daemon
//     HTTP server on a random ORCH_PORT that captures the POST /config body.
//   - hooks/classify.sh (bash, wired by .claude/settings.sample.json + the Codex adapter):
//     tested with the shared curl-stub harness, same pattern as classify-hook-automode.test.js.
//
// Asserts the atomic contract: the hook POSTs /config { workspace, auto:true|false } (server-side
// expansion to self_plan+automode+headless_driver — one code path for every surface), and the
// confirmation line names the three flags and the budget caps.
//
// Run: node test/classify-hook-orch-auto.test.js
'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { writeCurlStub, hookEnv } = require('./helpers/curl-stub');
const { bashExe } = require('./helpers/bash');

const HOOK_JS = path.resolve(__dirname, '..', 'hooks', 'classify.js');
const HOOK_SH = path.resolve(__dirname, '..', 'hooks', 'classify.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-orch-auto-'));
fs.mkdirSync(path.join(TMP, 'sessions'), { recursive: true });
// A fake workspace repo: repoRoot() resolves cwd → this dir via its .graph marker.
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'classify-orch-auto-ws-')));
fs.mkdirSync(path.join(WS, '.graph'), { recursive: true });

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
}

// ---- part A: hooks/classify.js against a stub daemon --------------------------------------------

const captured = [];
const CONFIG_RESP = { ok: true, workspace: WS, config: { self_plan: true, automode: true, headless_driver: true } };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = null; }
    captured.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/config') {
      const cfg = body && body.auto === false
        ? { self_plan: false, automode: false, headless_driver: false }
        : CONFIG_RESP.config;
      res.end(JSON.stringify({ ...CONFIG_RESP, config: cfg }));
    } else {
      res.end(JSON.stringify({ additional_context: '' }));
    }
  });
});

// ASYNC spawn (not spawnSync): the stub daemon server lives in THIS process, so a synchronous
// child wait would block the parent's event loop and deadlock every hook→daemon HTTP call.
function runJsHook(input, extraEnv = {}) {
  captured.length = 0;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK_JS], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: TMP, ...extraEnv },
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ status: code, stdout: out }));
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}
const emitted = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.additionalContext; } catch { return ''; } };

(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const PORT = String(server.address().port);
  const env = { ORCH_PORT: PORT };

  // (A1) 'orch auto' → POST /config { workspace, auto:true } + confirmation names flags + caps
  {
    const r = await runJsHook({ prompt: 'orch auto', session_id: 'ja-1', cwd: WS }, env);
    const cfgCall = captured.find((c) => c.path === '/config');
    ok('js: orch auto POSTs /config', !!cfgCall);
    ok('js: body carries auto:true', cfgCall && cfgCall.body.auto === true);
    ok('js: body carries the cwd workspace', cfgCall && cfgCall.body.workspace === WS);
    const msg = emitted(r);
    ok('js: confirmation says autonomy ON', /Full autonomy ON/.test(msg));
    ok('js: confirmation names all three flags',
      /self_plan=true/.test(msg) && /automode=true/.test(msg) && /headless_driver=true/.test(msg));
    ok('js: confirmation names loop budget caps (AUTOSTART_CONFIG)', /5000000 tokens/.test(msg) && /6250 iterations/.test(msg));
    ok('js: confirmation names drain governor caps', /200000 tokens per daemon boot/.test(msg) && /2 concurrent drain children/.test(msg));
  }

  // (A2) 'orch auto off' → auto:false + OFF confirmation
  {
    const r = await runJsHook({ prompt: 'orch auto off', session_id: 'ja-2', cwd: WS }, env);
    const cfgCall = captured.find((c) => c.path === '/config');
    ok('js: orch auto off POSTs auto:false', cfgCall && cfgCall.body.auto === false);
    const msg = emitted(r);
    ok('js: confirmation says autonomy OFF', /Full autonomy OFF/.test(msg));
    ok('js: OFF confirmation reports cleared flags', /self_plan=false/.test(msg) && /headless_driver=false/.test(msg));
  }

  // (A3) '@orch auto' prefix form matches; embedded 'orch autopilot' does NOT toggle
  {
    await runJsHook({ prompt: '@orch auto', session_id: 'ja-3', cwd: WS }, env);
    ok('js: @orch auto matches', captured.some((c) => c.path === '/config' && c.body.auto === true));
    await runJsHook({ prompt: 'please fix orch autopilot mode', session_id: 'ja-4', cwd: WS }, env);
    ok('js: "orch autopilot" does NOT toggle (falls through to /classify)',
      !captured.some((c) => c.path === '/config') && captured.some((c) => c.path === '/classify'));
  }

  // (A4) cwd outside any repo → honest no-op message, no /config call
  {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'classify-orch-auto-norepo-'));
    const r = await runJsHook({ prompt: 'orch auto', session_id: 'ja-5', cwd: bare }, env);
    ok('js: non-repo cwd → nothing toggled', !captured.some((c) => c.path === '/config'));
    ok('js: non-repo cwd → honest message', /nothing toggled/.test(emitted(r)));
    fs.rmSync(bare, { recursive: true, force: true });
  }

  server.close();

  // (A5) daemon unreachable → honest FAILED message
  {
    const r = await runJsHook({ prompt: 'orch auto', session_id: 'ja-6', cwd: WS }, { ORCH_PORT: '1' });
    ok('js: daemon down → FAILED message, config unchanged', /FAILED/.test(emitted(r)) && /config unchanged/.test(emitted(r)));
  }

  // ---- part B: hooks/classify.sh via the curl stub (existing classify-hook test pattern) --------
  const stubDir = path.join(TMP, 'stub-curl');
  const BODY_OUT = path.join(TMP, 'last-body.json');
  writeCurlStub(
    stubDir,
    `prev=""
for a in "$@"; do
  if [ "$prev" = "-d" ]; then printf '%s' "$a" > "${BODY_OUT.replace(/\\/g, '/')}"; fi
  prev="$a"
done
echo '{"ok":true,"workspace":"/ws/repo","config":{"self_plan":true,"automode":true,"headless_driver":true}}'
exit 0
`,
  );
  function runShHook(input) {
    if (fs.existsSync(BODY_OUT)) fs.rmSync(BODY_OUT);
    const r = spawnSync(bashExe(), [HOOK_SH], {
      input, encoding: 'utf8',
      env: hookEnv([stubDir], { CLAUDE_PLUGIN_DATA: TMP }),
    });
    let body = null;
    if (fs.existsSync(BODY_OUT)) {
      try { body = JSON.parse(fs.readFileSync(BODY_OUT, 'utf8')); } catch { body = null; }
    }
    return { status: r.status, stdout: r.stdout || '', body };
  }

  // (B1) 'orch auto' → /config body { workspace, auto:true } + ON confirmation
  // cwd uses the native WS path: a POSIX-looking literal like '/ws/repo' would get MSYS2
  // path-converted when the hook's bash calls the native jq.exe on Windows (test artifact only —
  // real harnesses pass native cwds).
  {
    const r = runShHook(JSON.stringify({ prompt: 'orch auto', session_id: 'sa-1', cwd: WS }));
    ok('sh: orch auto POSTs auto:true', r.body && r.body.auto === true);
    ok('sh: body carries the cwd workspace', r.body && r.body.workspace === WS);
    ok('sh: confirmation says autonomy ON', /Full autonomy ON/.test(r.stdout));
    ok('sh: confirmation names all three flags',
      /self_plan=true/.test(r.stdout) && /automode=true/.test(r.stdout) && /headless_driver=true/.test(r.stdout));
    ok('sh: confirmation names budget caps', /5000000 tokens/.test(r.stdout) && /2 concurrent drain children/.test(r.stdout));
  }

  // (B2) 'orch auto off' → auto:false + OFF confirmation
  {
    const r = runShHook(JSON.stringify({ prompt: 'orch auto off', session_id: 'sa-2', cwd: WS }));
    ok('sh: orch auto off POSTs auto:false', r.body && r.body.auto === false);
    ok('sh: confirmation says autonomy OFF', /Full autonomy OFF/.test(r.stdout));
  }

  // (B3) 'orch off' still opts the session out (no regression beside the new branch)
  {
    const r = runShHook(JSON.stringify({ prompt: 'orch off', session_id: 'sa-3', cwd: WS }));
    ok('sh: orch off still disables the conversation', /Disabled for this conversation/.test(r.stdout));
    ok('sh: orch off does not hit /config', r.body === null);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.rmSync(WS, { recursive: true, force: true });
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
