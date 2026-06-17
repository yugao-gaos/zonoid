#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.join(__dirname, '..', 'adapters', 'codex', 'hooks', 'agent-done.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hooks-'));

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

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
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'curl'), [
    '#!/bin/bash',
    `printf '%s\\n' "$@" >> ${JSON.stringify(capture)}`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });

  const r = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ agent_id: 'codex-hook-agent' }),
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, CODEX_HOME: codexHome },
  });

  ok('agent-done exits 0', r.status === 0);
  ok('agent-done emits Codex continue JSON', /"continue"\s*:\s*true/.test(r.stdout));
  const args = fs.readFileSync(capture, 'utf8');
  ok('agent-done forwards reported_usage from rollout fallback', args.includes('reported_usage'));
  ok('agent-done normalizes uncached input tokens', args.includes('"input_tokens":700'));
  ok('agent-done forwards output tokens', args.includes('"output_tokens":50'));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
