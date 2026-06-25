#!/usr/bin/env node
// Cursor adapter scheduler: armWakeup/cancelWakeup/writeScheduledTask via schedule-wakeup substrate.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cursor = require('../lib/adapters/cursor');
const claude = require('../lib/adapters/claude');
const codex = require('../lib/adapters/codex');
const stub = require('../lib/adapters/stub');
const sw = require('../lib/schedule-wakeup');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cursor-sched-'));
const prevData = process.env.ORCH_DATA;
process.env.ORCH_DATA = SANDBOX;

try {
  ok('cursor has armWakeup', typeof cursor.scheduler.armWakeup === 'function');
  ok('cursor has cancelWakeup', typeof cursor.scheduler.cancelWakeup === 'function');
  ok('cursor has writeScheduledTask', typeof cursor.scheduler.writeScheduledTask === 'function');

  const arm = cursor.scheduler.armWakeup({ session: 'cursor-sess', delaySeconds: 2, reason: 'idle', prompt: 'wake' });
  ok('cursor arm ok', arm.ok && typeof arm.pid === 'number');
  ok('cursor pidfile', fs.existsSync(sw.pidFile('cursor-sess')));

  const cancel = cursor.scheduler.cancelWakeup({ session: 'cursor-sess' });
  ok('cursor cancel ok', cancel.ok && cancel.canceled);
  ok('cursor pidfile gone', !fs.existsSync(sw.pidFile('cursor-sess')));

  const fireAt = Date.now() + 5000;
  const deferred = cursor.scheduler.writeScheduledTask({
    id: 'nightly-cursor-ab12',
    title: 'Nightly check',
    prompt: 'Check things.',
    taskKey: 'followup/nightly-cursor-ab12',
    when: '2027-06-11T01:30:00Z',
    fireAt,
    cwd: '/Users/x/proj',
    orchDir: SANDBOX,
  });
  ok('deferred write ok', deferred.ok && deferred.armed === false && !!deferred.note);
  ok('deferred note written', fs.existsSync(deferred.notePath));
  const note = fs.readFileSync(deferred.notePath, 'utf8');
  ok('note mentions task key', note.includes('followup/nightly-cursor-ab12'));

  const armed = cursor.scheduler.writeScheduledTask({
    id: 'armed-cursor-cd34',
    title: 'Armed follow-up',
    prompt: 'Run it.',
    taskKey: 'followup/armed-cursor-cd34',
    when: '2027-06-11T02:00:00Z',
    fireAt,
    cwd: '/Users/x/proj',
    session: 'cursor-arm-sess',
    orchDir: SANDBOX,
  });
  ok('armed write ok', armed.ok && armed.armed === true && typeof armed.pid === 'number');
  cursor.scheduler.cancelWakeup({ session: 'cursor-arm-sess' });

  ok('codex shares substrate', codex.scheduler.armWakeup === cursor.scheduler.armWakeup);
  ok('stub shares substrate', stub.scheduler.writeScheduledTask === cursor.scheduler.writeScheduledTask);
  ok('claude native arm', claude.scheduler.armWakeup().method === 'native');
  ok('claude native cancel', claude.scheduler.cancelWakeup().noop === true);
} finally {
  if (prevData === undefined) delete process.env.ORCH_DATA;
  else process.env.ORCH_DATA = prevData;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
