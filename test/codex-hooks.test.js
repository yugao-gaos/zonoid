#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { writeCurlStub, hookEnv } = require('./helpers/curl-stub');
const codexSessionBridge = require('../lib/codex-session-bridge');

const HOOK = path.join(__dirname, '..', 'adapters', 'codex', 'hooks', 'agent-done.sh');
const SESSION_START = path.join(__dirname, '..', 'hooks', 'start-daemon.js');
const CODEX_SESSION_START = path.join(__dirname, '..', 'adapters', 'codex', 'hooks', 'session-start.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-'));

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

function waitForFile(file, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (fs.existsSync(file)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return false;
}

try {
  const codexHome = path.join(TMP, 'codex-home');
  const sessions = path.join(codexHome, 'sessions', '2026', '06', '16');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'rollout-test.jsonl'), [
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 300,
            output_tokens: 50,
          },
        },
      },
    }),
    '',
  ].join('\n'));

  const capture = path.join(TMP, 'curl-args.txt');
  const stubDir = path.join(TMP, 'bin');
  writeCurlStub(stubDir, [
    `printf '%s\\n' "$@" >> ${JSON.stringify(capture)}`,
    'exit 0',
    '',
  ].join('\n'));

  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ agent_id: 'codex-hook-agent' }),
    encoding: 'utf8',
    env: hookEnv(stubDir, { CODEX_HOME: codexHome }),
  });

  ok('agent-done exits 0', r.status === 0);
  ok('agent-done emits Codex continue JSON', /"continue"\s*:\s*true/.test(r.stdout));
  const args = fs.readFileSync(capture, 'utf8');
  ok('agent-done forwards reported_usage from rollout fallback', args.includes('reported_usage'));
  ok('agent-done normalizes uncached input tokens', args.includes('"input_tokens":700'));
  ok('agent-done forwards output tokens', args.includes('"output_tokens":50'));

  const skippedBridgePath = path.join(TMP, 'adapters', 'codex', 'session-bridge.json');
  const skipStart = spawnSync('bash', [CODEX_SESSION_START], {
    input: JSON.stringify({
      cwd: TMP,
      session_id: 'headless-drain-session',
      transcript_path: '/tmp/headless-drain-session.jsonl',
    }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: TMP, ORCH_PORT: '9', ZONOID_HEADLESS_DRAIN: '1' },
  });
  ok('Codex SessionStart skips headless drain children', skipStart.status === 0);
  ok('Codex SessionStart skip does not write session bridge', !fs.existsSync(skippedBridgePath));

  const daemonSkip = spawnSync(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PLUGIN_DATA: TMP, ORCH_PORT: '18889', ZONOID_HEADLESS_DRAIN: '1' },
  });
  ok('daemon exits under headless drain children', daemonSkip.status === 0 && !daemonSkip.stdout.includes('orchestrator daemon on'));

  const configPath = path.join(TMP, 'hook-stub-config.json');
  const readyPath = path.join(TMP, 'hook-stub-ready.json');
  fs.writeFileSync(configPath, JSON.stringify({}));
  const stub = spawn(process.execPath, [path.join(__dirname, 'support', 'hook-http-stub-child.js'), configPath, readyPath], {
    stdio: 'ignore',
  });
  try {
    ok('hook HTTP stub ready', waitForFile(readyPath));
    const port = JSON.parse(fs.readFileSync(readyPath, 'utf8')).port;
    const ws = path.join(TMP, 'repo');
    fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
    const start = spawnSync(process.execPath, [SESSION_START], {
      input: JSON.stringify({
        cwd: ws,
        session_id: 'codex-hook-session',
        transcript_path: '/tmp/codex-hook-session.jsonl',
        harness: 'codex',
      }),
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PLUGIN_DATA: TMP, ORCH_PORT: String(port) },
    });
    const bridgePath = path.join(TMP, 'adapters', 'codex', 'session-bridge.json');
    const bridged = codexSessionBridge.latestSession({ workspace: ws }, bridgePath);
    ok('SessionStart exits 0', start.status === 0);
    ok('SessionStart writes Codex adapter bridge path', fs.existsSync(bridgePath));
    ok('SessionStart writes Codex session bridge', bridged && bridged.session_id === 'codex-hook-session' && bridged.workspace === path.resolve(ws));
  } finally {
    stub.kill();
  }
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
