'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.ZONOID_SKIP_LIVE = '1';

const overlayStore = require('../lib/overlay');
const activityRoute = require('../routes/activity');

test('status reports only actionable lifecycle rows in operational lanes', async () => {
  const workspace = '/ws/lifecycle-status';
  const overlay = overlayStore.EMPTY();
  overlay.config = { automode: true, self_plan: true, headless_driver: true };
  overlayStore.setReviewLifecycle(overlay, 'task/review', {
    review_state: 'requested', merge_state: 'review_pending',
  });
  overlayStore.setReviewLifecycle(overlay, 'task/canceled', {
    review_state: 'canceled', merge_state: 'closed',
  });
  overlayStore.setBlocked(overlay, 'task/canceled', 'stale historical hold');
  overlayStore.addGuidance(overlay, {
    question: 'Retry or cancel the failed task?',
    trigger: 'repeated_failure',
    severity: 'blocking',
    action: { kind: 'task-recovery', task_key: 'task/failed' },
  });
  const graph = { tasks: [
    { id: 'task/review', label: 'Review', status: 'tested', deps: [] },
    { id: 'task/canceled', label: 'Canceled', status: 'canceled', deps: [] },
    { id: 'task/failed', label: 'Failed', status: 'failed', deps: [] },
  ] };
  let sent = null;
  const ctx = {
    send: (_res, code, body) => { sent = { code, body }; },
    targetOverlay: () => ({ ws: workspace, ov: overlay }),
    buildGraph: () => graph,
    loops: new Map(),
    daemonLog: { logPath: () => null },
  };
  const url = new URL(`http://localhost:8787/status?workspace=${encodeURIComponent(workspace)}`);

  const handled = await activityRoute(ctx)(url.pathname, 'GET', {}, {}, url);

  assert.equal(handled, true);
  assert.equal(sent.code, 200);
  assert.equal(sent.body.reviews_pending, 1);
  assert.equal(sent.body.lanes.lanes.work.count, 1,
    'only the tested review remains operational work');
  assert.equal(sent.body.lanes.lanes.user_gate.count, 1,
    'exhausted failure guidance remains visible in Needs You');
});
