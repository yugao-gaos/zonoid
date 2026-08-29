#!/usr/bin/env node
'use strict';

const assert = require('assert');
const overlayStore = require('../lib/overlay');
const sessionRoute = require('../routes/session');

function harness() {
  const ov = overlayStore.EMPTY();
  const writes = [];
  let sent = null;
  const ctx = {
    send: (res, code, body) => { sent = { code, body }; },
    readBody: async (req) => req.body,
    notifyChange: () => {},
    buildGraph: () => ({ tasks: [] }),
    state: { sessions: {} },
    targetOverlay: () => ({ ws: '/ws', ov, save: () => {} }),
    resolveRepo: () => null,
    now: () => new Date().toISOString(),
    stopSignalFor: () => null,
    agentsArr: () => [],
    loops: new Map(),
    saveLoops: () => {},
    ESCALATION_DEFAULTS: () => ({}),
    OPTIMIZE_DEFAULTS: () => ({}),
    writeTaskStatus: (ws, key, status) => writes.push([ws, key, status]),
  };
  return { ov, writes, route: sessionRoute(ctx), sent: () => sent };
}

(async () => {
  {
    const h = harness();
    h.ov.status.work = 'failed';
    h.ov.reviews.work = { review_state: 'rejected', review_verdict: 'KICK_BACK', merge_state: 'blocked' };
    const id = overlayStore.addGuidance(h.ov, {
      question: 'Recover work?', severity: 'blocking', origin_task: 'work',
      action: { kind: 'task-recovery', task_key: 'work' },
    });
    await h.route('/guidance', 'GET', {}, {}, new URL('http://localhost/guidance'));
    assert.equal(h.sent().code, 200);
    assert.equal(h.sent().body.pending[0].action.kind, 'task-recovery',
      'the shared inbox receives the structured recovery controls');
    await h.route('/guidance/resolve', 'POST', { body: { id, decision: 'retry' } }, {}, new URL('http://localhost/guidance/resolve'));
    assert.equal(h.sent().code, 200);
    assert.equal(h.sent().body.retried_task_key, 'work');
    assert.equal(h.ov.status.work, undefined);
    assert.deepEqual(h.writes, [['/ws', 'work', 'pending']]);
    assert.equal(h.ov.guidance.find((item) => item.id === id).resolved, true);
  }

  {
    const h = harness();
    h.ov.status.held = 'not_ready';
    const id = overlayStore.addGuidance(h.ov, {
      question: 'Release hold?', severity: 'blocking', origin_task: 'held',
      action: { kind: 'user-hold', task_key: 'held' },
    });
    await h.route('/guidance/resolve', 'POST', { body: { id, decision: 'release' } }, {}, new URL('http://localhost/guidance/resolve'));
    assert.equal(h.sent().code, 200);
    assert.equal(h.sent().body.released, 'held');
    assert.equal(h.ov.status.held, undefined);
  }

  console.log('PASS  Needs You recovery and hold decisions resolve through the live route');
})().catch((error) => { console.error(error); process.exit(1); });
