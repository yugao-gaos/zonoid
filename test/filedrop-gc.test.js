#!/usr/bin/env node
// Unit tests for lib/filedrop-gc.js
// Run: node test/filedrop-gc.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fdgc-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const filedrop = require('../lib/filedrop-tasks');
const overlayStore = require('../lib/overlay');
const gc = require('../lib/filedrop-gc');

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-fdgc-ws-')));

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

function dropStub(harness, id, extra = {}) {
  const dir = path.join(filedrop.dirFor(WS), harness);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, subject: `stub ${id}`, ...extra }, null, 2));
}

try {
  const ov = overlayStore.load(WS);

  dropStub('local', 'adopt-me');
  ok('adoptStubIfNeeded creates snapshot', gc.adoptStubIfNeeded(ov, WS, 'local/adopt-me'));
  ok('snapshot has subject', ov.snapshots['local/adopt-me'].subject === 'stub adopt-me');
  ok('adopt idempotent', !gc.adoptStubIfNeeded(ov, WS, 'local/adopt-me'));

  dropStub('local', 'no-snap');
  ok('removeStubIfSnapshotted refuses without snapshot', !gc.removeStubIfSnapshotted(WS, 'local/no-snap', ov));

  dropStub('local', 'terminal');
  gc.adoptStubIfNeeded(ov, WS, 'local/terminal');
  ov.status['local/terminal'] = 'done';
  ok('removeStubIfSnapshotted removes when snapshot + terminal overlay', gc.removeStubIfSnapshotted(WS, 'local/terminal', ov));
  ok('stub file gone after remove', !filedrop.readStub(WS, 'local/terminal'));

  dropStub('local', 'done-stub');
  dropStub('local', 'active-stub');
  gc.adoptStubIfNeeded(ov, WS, 'local/done-stub');
  gc.adoptStubIfNeeded(ov, WS, 'local/active-stub');
  ov.status['local/done-stub'] = 'done';
  ov.status['local/active-stub'] = 'in_progress';
  const sweep = gc.sweepWorkspaceStubs(WS, ov, { dryRun: false });
  ok('sweep removes terminal stub', sweep.removed.includes('local/done-stub'));
  ok('sweep keeps in_progress stub', filedrop.readStub(WS, 'local/active-stub'));
  ok('sweep skipped in_progress key', sweep.skipped.includes('local/active-stub') || !sweep.removed.includes('local/active-stub'));

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
} finally {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
}
process.exit(fail === 0 ? 0 : 1);
