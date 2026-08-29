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
const apiReviewWorker = require('../scripts/api-review-worker');

const assignmentTool = TOOLS.find((tool) => tool.name === 'subconscious_assignment');

function makeHarness(workspace, overlay, keys) {
  let response = null;
  let requestBody = null;
  const opCache = new Map();
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
    sendOp: (res, body, status, payload) => {
      response = { status, body: payload };
      if (body && body.op_id) opCache.set(String(body.op_id), response);
    },
    readBody: async () => requestBody,
    targetOverlay: () => ({ ov: overlay, ws: workspace, save: () => {} }),
    buildGraph: graph,
    nodeExistsInGraph: (built, key) => built.tasks.some((task) => task.id === key),
    opReplay: (res, body) => {
      const replay = body && body.op_id ? opCache.get(String(body.op_id)) : null;
      if (!replay) return false;
      response = replay;
      return true;
    },
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

test('API review body reaches the real lifecycle route with replay-safe bounded recovery', async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-api-verdict-')));
  fs.mkdirSync(path.join(workspace, '.graph'), { recursive: true });
  const kickKey = 'task/api-kick-back';
  const approveKey = 'task/api-approve';
  const historicalKey = 'task/api-historical';
  const overlay = overlayStore.EMPTY();
  for (const key of [kickKey, approveKey]) {
    overlay.status[key] = 'tested';
    overlay.snapshots[key] = { subject: key, status: 'tested', blockedBy: [] };
    overlayStore.setReviewLifecycle(overlay, key, { review_state: 'requested', merge_state: 'review_pending' });
  }
  overlay.status[historicalKey] = 'done';
  overlay.snapshots[historicalKey] = { subject: historicalKey, status: 'done', blockedBy: [] };
  overlayStore.setReviewLifecycle(overlay, historicalKey, { review_state: 'requested', merge_state: 'review_pending' });
  const harness = makeHarness(workspace, overlay, [kickKey, approveKey, historicalKey]);

  const firstBody = apiReviewWorker.verdictStatusBody({
    verdict: 'KICK_BACK', reason: 'API review found a lifecycle defect', key: kickKey,
    workspace, agentId: 'api-reviewer', opId: 'api-kick-1',
  });
  assert.equal(firstBody.lifecycle_event, 'review_kick_back');
  assert.equal(firstBody.review, undefined);
  const first = await harness.call('POST', '/overlay/status', firstBody);
  assert.equal(apiReviewWorker.verdictApplyError({ status: 200, body: first }, firstBody.lifecycle_event), null);
  assert.equal(overlay.status[kickKey], 'failed');
  assert.equal(overlay.reviews[kickKey].review_state, 'rejected');
  assert.equal(overlay.reviews[kickKey].merge_state, 'blocked');
  assert.equal(overlay.retryConfig[kickKey].pendingKickBackRetry, true);

  const afterFirst = JSON.stringify({
    status: overlay.status[kickKey], review: overlay.reviews[kickKey], retry: overlay.retryConfig[kickKey],
  });
  const replay = await harness.call('POST', '/overlay/status', firstBody);
  assert.deepEqual(replay, first, 'same op_id replays the first success response');
  assert.equal(JSON.stringify({
    status: overlay.status[kickKey], review: overlay.reviews[kickKey], retry: overlay.retryConfig[kickKey],
  }), afterFirst, 'replay does not apply the lifecycle event twice');

  const duplicateBody = { ...firstBody, op_id: 'api-kick-duplicate' };
  const duplicate = await harness.call('POST', '/overlay/status', duplicateBody);
  assert.match(
    apiReviewWorker.verdictApplyError({ status: 200, body: duplicate }, duplicateBody.lifecycle_event),
    /already terminal/
  );
  assert.equal(JSON.stringify({
    status: overlay.status[kickKey], review: overlay.reviews[kickKey], retry: overlay.retryConfig[kickKey],
  }), afterFirst, 'a fresh duplicate cannot reopen or restamp the failed row');

  const retry = taskRecovery.reconcile(overlay, harness.graph().tasks);
  assert.equal(retry.actions[0].action, 'retry');
  assert.equal(overlay.retryConfig[kickKey].retryCount, 1);
  assert.equal(overlay.retryConfig[kickKey].pendingKickBackRetry, undefined);

  overlayStore.setStatus(overlay, kickKey, 'tested');
  overlayStore.applyLifecycleEvent(overlay, kickKey, 'review_request', { task_status: 'tested', rework: true });
  const secondBody = apiReviewWorker.verdictStatusBody({
    verdict: 'KICK_BACK', reason: 'API re-review still fails', key: kickKey,
    workspace, agentId: 'api-reviewer', opId: 'api-kick-2',
  });
  const second = await harness.call('POST', '/overlay/status', secondBody);
  assert.equal(apiReviewWorker.verdictApplyError({ status: 200, body: second }, secondBody.lifecycle_event), null);
  const exhausted = taskRecovery.reconcile(overlay, harness.graph().tasks);
  assert.equal(exhausted.actions[0].action, 'needs_guidance');
  assert.ok(overlay.guidance.some((item) => !item.resolved
    && item.action && item.action.kind === 'task-recovery' && item.action.task_key === kickKey));

  const approveBody = apiReviewWorker.verdictStatusBody({
    verdict: 'APPROVE', reason: 'API review passed', key: approveKey,
    workspace, agentId: 'api-reviewer', opId: 'api-approve-1',
  });
  const approved = await harness.call('POST', '/overlay/status', approveBody);
  assert.equal(apiReviewWorker.verdictApplyError({ status: 200, body: approved }, approveBody.lifecycle_event), null);
  const approvedRecord = JSON.stringify(overlay.reviews[approveKey]);
  const idempotentBody = { ...approveBody, op_id: 'api-approve-duplicate' };
  const idempotent = await harness.call('POST', '/overlay/status', idempotentBody);
  assert.equal(apiReviewWorker.verdictApplyError({ status: 200, body: idempotent }, idempotentBody.lifecycle_event), null);
  assert.equal(JSON.stringify(overlay.reviews[approveKey]), approvedRecord, 'same verdict with a new op_id is a legal no-op');
  assert.equal(
    judge.buildQueue(overlay).filter((item) => item.id === `decision:merge:${approveKey}`).length,
    1,
    'idempotent approval exposes one merge decision'
  );

  const historicalBody = apiReviewWorker.verdictStatusBody({
    verdict: 'APPROVE', reason: 'late API review', key: historicalKey,
    workspace, agentId: 'api-reviewer', opId: 'api-historical-approve',
  });
  const historicalBefore = JSON.stringify(overlay.reviews[historicalKey]);
  const historical = await harness.call('POST', '/overlay/status', historicalBody);
  assert.match(
    apiReviewWorker.verdictApplyError({ status: 200, body: historical }, historicalBody.lifecycle_event),
    /already terminal/
  );
  assert.equal(overlay.status[historicalKey], 'done');
  assert.equal(JSON.stringify(overlay.reviews[historicalKey]), historicalBefore);
  assert.equal(
    judge.buildQueue(overlay).some((item) => item.id === `decision:merge:${historicalKey}`),
    false,
    'late API approval cannot queue a historical merge'
  );

  fs.rmSync(workspace, { recursive: true, force: true });
});
