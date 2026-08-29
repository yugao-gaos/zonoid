#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const overlayStore = require('../lib/overlay');
const overlayDisk = require('../lib/overlay/store');
const recovery = require('../lib/task-recovery');

const task = (id, status, extra = {}) => ({ id, label: id, status, deps: [], ...extra });

{
  const overlay = overlayStore.EMPTY();
  overlay.status.landed = 'failed';
  overlay.git.landed = { merged: true, merge_sha: 'abc' };
  const result = recovery.reconcile(overlay, [task('landed', 'failed')]);
  assert.equal(overlay.status.landed, 'done');
  assert.equal(result.actions[0].action, 'normalize_merged');
  assert.equal(recovery.reconcile(overlay, [task('landed', 'done')]).changed, false,
    'already-landed tasks do not create a save/rebuild loop');
}

{
  const overlay = overlayStore.EMPTY();
  overlay.status.landed = 'tested';
  overlay.snapshots.landed = { subject: 'landed', status: 'pending', blockedBy: [] };
  overlay.reviews.landed = {
    review_state: 'landed', review_verdict: 'KICK_BACK', merge_state: 'conflict',
  };
  const writes = [];
  const result = recovery.reconcile(overlay, [task('landed', 'tested')], {
    writeTaskStatus: (key, status) => writes.push([key, status]),
  });
  assert.equal(overlay.status.landed, 'done', 'landed lifecycle wins over a stale tested row');
  assert.equal(overlay.snapshots.landed.status, 'done');
  assert.deepEqual(overlay.reviews.landed, {
    review_state: 'landed', review_verdict: 'APPROVE', merge_state: 'closed',
  });
  assert.deepEqual(writes, [['landed', 'done']]);
  assert.equal(result.actions[0].action, 'normalize_landed');
}

{
  const overlay = overlayStore.EMPTY();
  overlay.snapshots.old = { subject: 'old', status: 'pending', blockedBy: [] };
  overlay.reviews.old = { review_state: 'canceled', merge_state: 'closed' };
  overlay.notes.old = 'canceled by judge/1: superseded';
  const writes = [];
  recovery.reconcile(overlay, [task('old', 'ready')], {
    writeTaskStatus: (key, status) => writes.push([key, status]),
  });
  assert.equal(overlay.status.old, 'canceled', 'canceled lifecycle wins over a stale ready row');
  assert.equal(overlay.snapshots.old.status, 'canceled');
  assert.deepEqual(writes, [['old', 'canceled']]);
  assert.equal(overlay.judgedTaskDecisions['decision:cancel:old'], true,
    'the already-terminal cancel is not re-enqueued as judge work');
}

{
  const overlay = overlayStore.EMPTY();
  overlay.status.old = 'failed';
  overlay.edges.push({ from: 'old', to: 'replacement', kind: 'supersede' });
  const result = recovery.reconcile(overlay, [task('old', 'failed'), task('replacement', 'ready')]);
  assert.equal(overlay.status.old, 'canceled');
  assert.equal(result.actions[0].replacement, 'replacement');
  assert.equal(recovery.reconcile(overlay, [task('old', 'canceled'), task('replacement', 'ready')]).changed, false,
    'already-retired tasks do not create a save/rebuild loop');
  const statuses = { old: 'canceled', replacement: 'tested' };
  assert.equal(recovery.dependencyStatus(overlay, 'old', (key) => statuses[key]), 'tested',
    'dependents follow the explicit replacement status');
}

{
  const overlay = overlayStore.EMPTY();
  overlay.status.old = 'canceled';
  overlay.snapshots.old = { subject: 'old', status: 'pending', blockedBy: [] };
  overlay.reviews.old = { review_state: 'rejected', review_verdict: 'KICK_BACK', merge_state: 'blocked' };
  overlay.edges.push({ from: 'old', to: 'replacement', kind: 'supersede' });
  const result = recovery.reconcile(overlay, [task('old', 'canceled'), task('replacement', 'done')]);
  assert.equal(result.actions[0].action, 'normalize_superseded');
  assert.equal(overlay.snapshots.old.status, 'canceled');
  assert.equal(overlay.reviews.old.review_state, 'canceled');
  assert.equal(overlay.reviews.old.review_verdict, null);
  assert.equal(overlay.reviews.old.merge_state, 'closed');
}

{
  const overlay = overlayStore.EMPTY();
  overlay.edges.push({ from: 'note:old', to: 'note:new', kind: 'supersede' });
  const result = recovery.reconcile(overlay, [
    task('note:old', 'note', { kind: 'note' }),
    task('note:new', 'note', { kind: 'note' }),
  ]);
  assert.equal(result.changed, false, 'knowledge nodes never enter operational recovery');
  assert.equal(overlay.status['note:old'], undefined, 'superseded notes do not create task-status churn');
}

{
  const overlay = overlayStore.EMPTY();
  overlay.status.work = 'failed';
  overlay.reviews.work = { review_state: 'rejected', review_verdict: 'KICK_BACK', merge_state: 'blocked' };
  overlay.snapshots.work = { subject: 'work', status: 'failed', blockedBy: [] };
  const writes = [];
  recovery.reconcile(overlay, [task('work', 'failed')], { writeTaskStatus: (key, status) => writes.push([key, status]) });
  assert.equal(overlay.status.work, undefined, 'first failure is automatically requeued');
  assert.equal(overlay.snapshots.work.status, 'pending');
  assert.deepEqual(writes, [['work', 'pending']]);
  assert.equal(overlay.retryConfig.work.retryCount, 1);
  assert.equal(overlay.reviews.work.review_state, null, 'retry clears the rejected lifecycle');

  overlay.status.work = 'failed';
  overlay.reviews.work = { review_state: 'rejected', review_verdict: 'KICK_BACK', merge_state: 'blocked', review_reason: 'tests still fail' };
  const second = recovery.reconcile(overlay, [task('work', 'failed'), task('child', 'not_ready', { deps: ['work'] })]);
  assert.equal(second.actions[0].action, 'needs_guidance');
  assert.equal(overlay.status.work, 'failed', 'exhausted retry stays visible');
  const gate = overlay.guidance.find((item) => !item.resolved && item.action && item.action.kind === 'task-recovery');
  assert.ok(gate);
  assert.deepEqual(gate.action.dependents, ['child']);
  assert.equal(overlay.judgedTaskDecisions['decision:kick_back:work'], true,
    'the user recovery gate supersedes duplicate kick-back judge work');

  const repeated = recovery.reconcile(overlay, [task('work', 'failed')]);
  assert.equal(overlay.guidance.filter((item) => !item.resolved && item.action && item.action.kind === 'task-recovery').length, 1,
    'recovery guidance is deduplicated');
  assert.equal(repeated.changed, false, 'an existing recovery decision does not create a dirty save loop');

  const resolved = recovery.resolveRecovery(overlay, gate.action, 'retry');
  assert.equal(resolved.retried_task_key, 'work');
  assert.equal(overlay.status.work, undefined);
}

{
  const overlay = overlayStore.EMPTY();
  overlay.reviews.work = { review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'blocked' };
  const writes = [];
  recovery.reconcile(overlay, [task('work', 'tested')], {
    writeTaskStatus: (key, status) => writes.push([key, status]),
  });
  assert.equal(overlay.status.work, undefined, 'a merge-blocked attempt receives the bounded retry');
  assert.equal(overlay.reviews.work.review_state, null);
  assert.deepEqual(writes, [['work', 'pending']]);
}

{
  const overlay = overlayStore.EMPTY();
  overlay.status.blocked = 'failed';
  overlay.blocked.blocked = 'external data required';
  recovery.reconcile(overlay, [task('blocked', 'failed')]);
  assert.equal(overlay.status.blocked, 'failed', 'an explicit block is never silently cleared');
  assert.ok(overlay.guidance.some((item) => item.action && item.action.kind === 'task-recovery'));
}

{
  const workspace = `/tmp/zonoid-retry-config-${process.pid}-${Date.now()}`;
  const overlay = overlayStore.EMPTY();
  overlay.retryConfig.work = { retryCount: 1, maxRetries: 1 };
  overlayDisk.writeLocalOverlay(workspace, overlay);
  const reloaded = overlayDisk.readLocalOverlay(workspace);
  assert.deepEqual(reloaded.retryConfig.work, overlay.retryConfig.work,
    'retry budget survives the local overlay round-trip');
  fs.unlinkSync(overlayDisk.fileFor(workspace));
}

console.log('PASS  automatic task recovery and genuine user escalation');
