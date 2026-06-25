#!/usr/bin/env node
// P9-HB6: cross-harness ScheduleWakeup contract smoke — substrate, MCP, OpenCode, adapters.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { HEARTBEAT } = require('../lib/classify-assemble');
const { extraToolsForClient, NOTIFY_PATTERN } = require('../lib/mcp-harness-tools');
const sw = require('../lib/schedule-wakeup');
const ocSw = require('../packages/opencode-plugin/lib/schedule-wakeup');
const cursor = require('../lib/adapters/cursor');
const claude = require('../lib/adapters/claude');
const codex = require('../lib/adapters/codex');
const opencode = require('../lib/adapters/opencode');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sw-contract-'));
const prevData = process.env.ORCH_DATA;
process.env.ORCH_DATA = SANDBOX;
const SESSION = 'contract-sess';
const ctx = { session: SESSION };

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

(async () => {
  try {
    ok('HEARTBEAT mentions ScheduleWakeup', HEARTBEAT.includes('ScheduleWakeup'));
    ok('HEARTBEAT delaySeconds=7200', HEARTBEAT.includes('delaySeconds=7200'));
    ok('HEARTBEAT autonomous-loop prompt', HEARTBEAT.includes('<<autonomous-loop-dynamic>>'));

    const arm1 = sw.armWakeup({ session: SESSION, delaySeconds: 30, reason: 'idle', prompt: 'a' });
    ok('arm ok', arm1.ok && typeof arm1.pid === 'number');
    ok('pidfile exists', fs.existsSync(sw.pidFile(SESSION)));
    ok('arm creates fire file for supervisors', fs.existsSync(sw.fireFile(SESSION)));
    const arm2 = sw.armWakeup({ session: SESSION, delaySeconds: 60, reason: 're', prompt: 'b' });
    ok('re-arm replaces pid', arm2.ok && arm2.pid !== arm1.pid);
    const cancel = sw.cancelWakeup(SESSION);
    ok('cancel ok', cancel.ok && cancel.canceled);

    ok('claude MCP has no ScheduleWakeup', extraToolsForClient('claude', '/tmp/ws', ctx).length === 0);
    const cursorTool = extraToolsForClient('cursor', '/tmp/ws', ctx)[0];
    ok('cursor exposes ScheduleWakeup', cursorTool && cursorTool.name === 'ScheduleWakeup');
    ok('codex exposes ScheduleWakeup', extraToolsForClient('codex', '/tmp/ws', ctx).some((t) => t.name === 'ScheduleWakeup'));
    const mcpOut = await cursorTool.run({ delaySeconds: 1, reason: 'idle', prompt: 'tick' });
    ok('MCP run ok', mcpOut.ok && mcpOut.armed === true);
    ok('MCP notify_pattern', mcpOut.notify_pattern === NOTIFY_PATTERN);
    await sw.cancelWakeup(SESSION);

    ok('opencode armWakeup', typeof ocSw.armWakeup === 'function');
    ok('opencode same wake dir', ocSw.resolveWakeDir() === sw.resolveWakeDir());
    ocSw.cancelWakeup('oc');

    ok('cursor adapter arm', cursor.scheduler.armWakeup({ session: 'adapt', delaySeconds: 2, reason: 'x', prompt: 'y' }).ok);
    ok('codex shares armWakeup', codex.scheduler.armWakeup === cursor.scheduler.armWakeup);
    ok('opencode shares armWakeup', opencode.scheduler.armWakeup === cursor.scheduler.armWakeup);
    ok('opencode has writeScheduledTask', typeof opencode.scheduler.writeScheduledTask === 'function');
    ok('claude native arm', claude.scheduler.armWakeup().method === 'native');

    const origCodexSupervise = codex.wakeDelivery.superviseCodexSession;
    const supervised = [];
    codex.wakeDelivery.superviseCodexSession = (session) => {
      supervised.push(session);
      return { ok: true, supervised: true };
    };
    try {
      const started = codex.usage.onSessionStart({ session: 'codex-real-contract-session', port: 1 });
      ok('codex sessionStart arms wake', started && started.ok === true);
      ok('codex sessionStart starts wake delivery supervision', supervised[0] === 'codex-real-contract-session');
      codex.scheduler.cancelWakeup({ session: 'codex-real-contract-session' });
    } finally {
      codex.wakeDelivery.superviseCodexSession = origCodexSupervise;
    }
  } finally {
    if (prevData === undefined) delete process.env.ORCH_DATA;
    else process.env.ORCH_DATA = prevData;
    fs.rmSync(SANDBOX, { recursive: true, force: true });
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
