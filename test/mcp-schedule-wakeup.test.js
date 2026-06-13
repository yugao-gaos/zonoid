#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { handleRpc } = require('../lib/mcp-core');
const { extraToolsForClient, NOTIFY_PATTERN } = require('../lib/mcp-harness-tools');
const sw = require('../lib/schedule-wakeup');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mcp-wake-'));
const prevData = process.env.ORCH_DATA;
process.env.ORCH_DATA = SANDBOX;
const SESSION = 'mcp-wake-sess';
const ctx = { session: SESSION };

let pass = 0, fail = 0;
const ok = (l, c) => { if (c) { console.log('PASS  ' + l); pass++; } else { console.log('FAIL  ' + l); fail++; } };

(async () => {
  try {
    const cursorExtra = extraToolsForClient('cursor', '/tmp/ws', ctx);
    ok('cursor adds ScheduleWakeup only', cursorExtra.length === 1 && cursorExtra[0].name === 'ScheduleWakeup');
    ok('claude extraTools empty', extraToolsForClient('claude', '/tmp/ws', ctx).length === 0);
    const codexExtra = extraToolsForClient('codex', '/tmp/ws', ctx);
    ok('codex adds create_task + ScheduleWakeup', codexExtra.length === 2);
    ok('codex ScheduleWakeup schema', codexExtra[1].inputSchema.required.join(',') === 'delaySeconds,reason,prompt');

    const tool = cursorExtra[0];
    const out = await tool.run({ delaySeconds: 1, reason: 'idle', prompt: 'wake me' });
    ok('tool ok', out.ok === true && out.armed === true);
    ok('notify_pattern', out.notify_pattern === NOTIFY_PATTERN);
    ok('command tails fire file', out.command === `tail -n0 -F ${JSON.stringify(sw.fireFile(SESSION))}`);
    ok('pidfile armed', fs.existsSync(sw.pidFile(SESSION)));

    const noSession = extraToolsForClient('cursor', '/tmp/ws', {})[0];
    const err = await noSession.run({ delaySeconds: 1, reason: 'x', prompt: 'y' });
    ok('missing session errors', err.ok === false && /session required/.test(err.error));

    await sw.cancelWakeup(SESSION);
  } finally {
    if (prevData === undefined) delete process.env.ORCH_DATA; else process.env.ORCH_DATA = prevData;
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }
  console.log('-----');
  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
