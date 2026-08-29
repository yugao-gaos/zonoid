#!/usr/bin/env node
// Failed tasks receive one bounded autonomous retry, then surface a durable user recovery gate.
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
  ov.snapshots['task/failed'] = { subject: 'failed task', status: 'failed', blockedBy: [] };
  daemon.__setWorkspaceForTest('/tmp/nonexistent-zonoid-test-ws');
  daemon.__setOverlayForTest(ov);
  const changed = daemon.sweepFailedTasks('/tmp/nonexistent-zonoid-test-ws', ov);
  ok('default sweep performs one bounded retry', changed === true);
  ok('failed status re-enters the pending pipeline', ov.status['task/failed'] === undefined);
  ok('default retry budget is recorded', ov.retryConfig['task/failed'].retryCount === 1);
}

{
  const ov = ovStore.EMPTY();
  ov.retryConfig = { 'task/failed': { retryCount: 1, maxRetries: 1 } };
  ov.status['task/failed'] = 'failed';
  ov.snapshots['task/failed'] = { subject: 'failed task', status: 'failed', blockedBy: [] };
  daemon.__setWorkspaceForTest('/tmp/nonexistent-zonoid-test-ws');
  daemon.__setOverlayForTest(ov);
  const changed = daemon.sweepFailedTasks('/tmp/nonexistent-zonoid-test-ws', ov);
  ok('exhausted retry budget creates a user decision', changed === true);
  ok('exhausted failure remains visible', ov.status['task/failed'] === 'failed');
  ok('recovery guidance is actionable', ov.guidance.some((g) => !g.resolved && g.action && g.action.kind === 'task-recovery'));
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
