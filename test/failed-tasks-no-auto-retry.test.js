#!/usr/bin/env node
// Failed tasks should not silently re-enter the ready pool unless explicitly configured.
'use strict';

const daemon = require('../daemon.js');
const ovStore = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

{
  const ov = ovStore.EMPTY();
  ov.status['task/failed'] = 'failed';
  const changed = daemon.sweepFailedTasks('/tmp/nonexistent-zonoid-test-ws', ov);
  ok('default sweep does nothing', changed === false);
  ok('failed status is preserved', ov.status['task/failed'] === 'failed');
}

{
  const ov = ovStore.EMPTY();
  ov.config.auto_retry_failed = true;
  ov.status['task/failed'] = 'failed';
  ov.snapshots['task/failed'] = { subject: 'failed task', status: 'failed', blockedBy: [] };
  daemon.__setWorkspaceForTest('/tmp/nonexistent-zonoid-test-ws');
  daemon.__setOverlayForTest(ov);
  const changed = daemon.sweepFailedTasks('/tmp/nonexistent-zonoid-test-ws', ov);
  ok('explicit auto retry changes state', changed === true);
  ok('explicit auto retry clears status override', ov.status['task/failed'] === undefined);
  ok('explicit auto retry resets snapshot', ov.snapshots['task/failed'].status === 'pending');
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
