#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-opencode-wake-')));
process.env.ORCH_DATA = SANDBOX;
const sw = require('../packages/opencode-plugin/lib/schedule-wakeup');
const core = require('../lib/schedule-wakeup');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

try {
  ok('plugin re-exports core armWakeup', typeof sw.armWakeup === 'function');
  ok('plugin re-exports core cancelWakeup', typeof sw.cancelWakeup === 'function');
  const arm = sw.armWakeup({ session: 'oc-sess', delaySeconds: 1, reason: 'idle', prompt: 'tick' });
  ok('arm ok', arm.ok && typeof arm.pid === 'number');
  ok('same wake dir as core', sw.resolveWakeDir() === core.resolveWakeDir());
  const cancel = sw.cancelWakeup('oc-sess');
  ok('cancel ok', cancel.ok && cancel.canceled);
  console.log(`\n${pass}/${pass + fail} assertions passed`);
  if (fail) process.exit(1);
} finally {
  const prev = process.env.ORCH_DATA;
  if (prev === undefined) delete process.env.ORCH_DATA;
  else process.env.ORCH_DATA = prev;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}
