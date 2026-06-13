#!/usr/bin/env node
// Tests for standing harness drain auto-requeue after complete_task.
// Run: node test/harness-requeue.test.js
'use strict';
const overlayStore = require('../lib/overlay');
const judgeRoute = require('../routes/judge');
const labelRoute = require('../routes/label');
const {
  HARNESS_JUDGE_DRAIN_KEY,
  HARNESS_LABEL_DRAIN_KEY,
  DAEMON_RESTART_KEY,
  isStandingHarnessTask,
  requeueStandingHarness,
} = require('../lib/harness-task');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

// ── isStandingHarnessTask: judge/label drain snapshots ─────────────────────────
{
  const ov = overlayStore.EMPTY();
  judgeRoute.ensureHarnessJudgeDrainTask(ov, () => {});
  labelRoute.ensureHarnessLabelDrainTask(ov, () => {});
  ok('judge drain: standing harness', isStandingHarnessTask(ov, HARNESS_JUDGE_DRAIN_KEY));
  ok('label drain: standing harness', isStandingHarnessTask(ov, HARNESS_LABEL_DRAIN_KEY));
}

// ── isStandingHarnessTask: metadata.harness on arbitrary key ───────────────────
{
  const ov = overlayStore.EMPTY();
  overlayStore.setSnapshot(ov, 'followup/harness-custom', {
    subject: 'harness: custom',
    status: 'pending',
    metadata: { harness: true },
  });
  ok('metadata.harness: standing harness', isStandingHarnessTask(ov, 'followup/harness-custom'));
}

// ── isStandingHarnessTask: false for non-standing tasks ────────────────────────
{
  const ov = overlayStore.EMPTY();
  overlayStore.setSnapshot(ov, 'followup/some-user-task', {
    subject: 'user task',
    status: 'pending',
  });
  ok('random followup: not standing harness', !isStandingHarnessTask(ov, 'followup/some-user-task'));
  ok('daemon-restart: not standing harness', !isStandingHarnessTask(ov, DAEMON_RESTART_KEY));
  overlayStore.setSnapshot(ov, DAEMON_RESTART_KEY, {
    subject: 'Restart orchestrator daemon',
    status: 'pending',
  });
  ok('daemon-restart snapshot: still not standing harness', !isStandingHarnessTask(ov, DAEMON_RESTART_KEY));
}

// ── requeueStandingHarness: sets ready, clears assignee, resets snapshot ───────
{
  const ov = overlayStore.EMPTY();
  judgeRoute.ensureHarnessJudgeDrainTask(ov, () => {});
  ov.status[HARNESS_JUDGE_DRAIN_KEY] = 'done';
  ov.assignee[HARNESS_JUDGE_DRAIN_KEY] = 'judge-drain-prev';
  ov.snapshots[HARNESS_JUDGE_DRAIN_KEY].status = 'completed';

  const requeued = requeueStandingHarness(ov, HARNESS_JUDGE_DRAIN_KEY, 'pass complete');
  ok('requeue returns true', requeued);
  ok('status set to ready', ov.status[HARNESS_JUDGE_DRAIN_KEY] === 'ready');
  ok('assignee cleared', ov.assignee[HARNESS_JUDGE_DRAIN_KEY] === undefined);
  ok('snapshot status reset to pending', ov.snapshots[HARNESS_JUDGE_DRAIN_KEY].status === 'pending');
  ok('timestamps lastStatus is ready', ov.timestamps[HARNESS_JUDGE_DRAIN_KEY].lastStatus === 'ready');
  ok('note stored', ov.notes[HARNESS_JUDGE_DRAIN_KEY] === 'pass complete');
}

// ── requeueStandingHarness: no-op for non-standing tasks ───────────────────────
{
  const ov = overlayStore.EMPTY();
  ov.status['followup/some-user-task'] = 'done';
  ok('non-standing: requeue returns false', !requeueStandingHarness(ov, 'followup/some-user-task'));
  ok('non-standing: status stays done', ov.status['followup/some-user-task'] === 'done');
}

// ── CAS: ready status does not conflict on next start_task ─────────────────────
{
  const ov = overlayStore.EMPTY();
  ov.status[HARNESS_LABEL_DRAIN_KEY] = 'ready';
  ov.assignee[HARNESS_LABEL_DRAIN_KEY] = 'label-drain-prev';
  const cur = ov.status[HARNESS_LABEL_DRAIN_KEY];
  const newAgent = 'label-drain-next';
  const conflict = cur === 'in_progress' && ov.assignee[HARNESS_LABEL_DRAIN_KEY] !== newAgent;
  ok('ready status: no CAS conflict for next agent', !conflict);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
