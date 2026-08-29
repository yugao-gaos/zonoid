#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TOOLS } = require('../lib/mcp-core');
const overlayStore = require('../lib/overlay');
const overlayRoute = require('../routes/overlay');
const taskRecovery = require('../lib/task-recovery');
const judge = require('../lib/judge');

const assignmentTool = TOOLS.find((tool) => tool.name === 'subconscious_assignment');

function makeHarness(workspace, overlay, keys) {
  let response = null;
  let requestBody = null;
  const graph = () => ({
    tasks: keys.map((key) => ({
      id: key,
      label: key,
      status: overlay.status[key] || overlayStore.lifecycleDerivedStatus(overlay, key) || 'tested',
      deps: [],
      context_deps: [],
    })),
  });
  const ctx = {
    state: { agents: {} },
    ALL_STATUSES: ['not_ready', 'ready', 'in_progress', 'tested', 'done', 'failed', 'canceled'],
    send: (res, status, body) => { response = { status, body }; },
    sendOp: (res, body, status, payload) => { response = { status, body: payload }; },
    readBody: async () => requestBody,
    targetOverlay: () => ({ ov: overlay, ws: workspace, save: () => {} }),
    buildGraph: graph,
    nodeExistsInGraph: (built, key) => built.tasks.some((task) => task.id === key),
    opReplay: () => false,
    notifyChange: () => {},
    now: () => new Date().toISOString(),
    embed: async () => null,
    knowledgeText: () => '',
    snapshotNative: () => {},
    suggestToks: () => new Set(),
    scoreNodeAgainstTokens: () => ({ score: 0 }),
    SUGGEST_DUP_THRESHOLD: 0.6,
    DIMS: 384,
    followups: { validate: () => null, apply: () => [], onBucketComplete: () => null },
    verdicts: {
      validate: () => null,
      apply: () => [],
      sweepStaleHolds: () => ({ released: [], flagged: [] }),
      lintProse: () => null,
    },
    agentsArr: () => [],
    saveAgents: () => {},
    cache: { agg: new Map(), aggAt: new Map() },
    judge: { judgingState: () => ({ judging: false, timedOut: false }) },
    resolveRepo: () => workspace,
    git: { currentBranch: () => null },
    touchAgent: () => {},
    writeTaskStatus: () => {},
    ingestNode: async () => ({ seeded: 0, vec: null }),
    readNativeTask: () => null,
    harness: { scheduler: { writeScheduledTask: () => ({ armed: false }) } },
  };
  const route = overlayRoute(ctx);
  const call = async (method, routePath, body) => {
    assert.equal(method, 'POST');
    assert.equal(routePath, '/overlay/status');
    requestBody = body;
    response = null;
    await route(routePath, method, { headers: {} }, {}, { searchParams: { get: () => null } }, null);
    assert.ok(response);
    return response.body;
  };
  return { call, graph };
}

test('subconscious KICK_BACK is ordered atomically, retries once, then reaches Needs You', async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-sub-verdict-')));
  fs.mkdirSync(path.join(workspace, '.graph'), { recursive: true });
  const key = 'task/kick-back';
  const historical = 'task/historical';
  const overlay = overlayStore.EMPTY();
  overlay.status[key] = 'tested';
  overlay.snapshots[key] = { subject: key, status: 'tested', blockedBy: [] };
  overlayStore.setReviewLifecycle(overlay, key, { review_state: 'requested', merge_state: 'review_pending' });
  overlay.status[historical] = 'done';
  overlay.snapshots[historical] = { subject: historical, status: 'done', blockedBy: [] };
  overlayStore.setReviewLifecycle(overlay, historical, { review_state: 'requested', merge_state: 'review_pending' });
  const harness = makeHarness(workspace, overlay, [key, historical]);

  const first = await assignmentTool.run({
    action: 'submit_verdict', verdict: 'KICK_BACK', workspace, task_key: key, reason: 'tests failed',
  }, harness.call);
  assert.equal(first.ok, true);
  assert.equal(overlay.status[key], 'failed');
  assert.equal(overlay.reviews[key].review_state, 'rejected');
  assert.equal(overlay.reviews[key].review_verdict, 'KICK_BACK');
  assert.equal(overlay.reviews[key].merge_state, 'blocked');
  assert.equal(overlay.retryConfig[key].pendingKickBackRetry, true);

  const retry = taskRecovery.reconcile(overlay, harness.graph().tasks);
  assert.equal(retry.actions[0].action, 'retry');
  assert.equal(overlay.status[key], undefined);
  assert.equal(overlay.retryConfig[key].retryCount, 1);
  assert.equal(overlay.retryConfig[key].pendingKickBackRetry, undefined);

  overlayStore.setStatus(overlay, key, 'tested');
  overlayStore.applyLifecycleEvent(overlay, key, 'review_request', { task_status: 'tested', rework: true });
  const second = await assignmentTool.run({
    action: 'submit_verdict', verdict: 'KICK_BACK', workspace, task_key: key, reason: 'tests still fail',
  }, harness.call);
  assert.equal(second.ok, true);
  assert.equal(overlay.reviews[key].review_state, 'rejected');
  assert.equal(overlay.reviews[key].merge_state, 'blocked');

  const exhausted = taskRecovery.reconcile(overlay, harness.graph().tasks);
  assert.equal(exhausted.actions[0].action, 'needs_guidance');
  assert.equal(overlay.status[key], 'failed');
  assert.equal(overlay.retryConfig[key].retryCount, 1);
  assert.equal(overlay.retryConfig[key].pendingKickBackRetry, undefined);
  assert.ok(overlay.guidance.some((item) => !item.resolved
    && item.action && item.action.kind === 'task-recovery' && item.action.task_key === key));

  const beforeHistorical = JSON.stringify(overlay.reviews[historical]);
  const late = await assignmentTool.run({
    action: 'submit_verdict', verdict: 'APPROVE', workspace, task_key: historical, reason: 'late review',
  }, harness.call);
  assert.equal(late.ok, false);
  assert.equal(late.lifecycle_refused.code, 'already_terminal');
  assert.equal(overlay.status[historical], 'done');
  assert.equal(JSON.stringify(overlay.reviews[historical]), beforeHistorical);
  assert.equal(judge.buildQueue(overlay).some((item) => item.id === `decision:merge:${historical}`), false);

  fs.rmSync(workspace, { recursive: true, force: true });
});
