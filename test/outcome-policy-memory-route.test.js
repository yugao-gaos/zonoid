'use strict';

const assert = require('assert');
const overlayStore = require('../lib/overlay');
const sessionRoute = require('../routes/session');

function harness() {
  const ov = overlayStore.EMPTY();
  let response = null;
  let saves = 0;
  const ctx = {
    state: {},
    loops: new Map(),
    saveLoops: () => {},
    notifyChange: () => {},
    send: (_res, code, body) => { response = { code, body }; },
    readBody: async (req) => req._body,
    buildGraph: () => ({ tasks: [] }),
    targetOverlay: () => ({
      ws: null,
      graph_repo: null,
      ov,
      save: () => { saves++; },
    }),
    resolveRepo: () => null,
    now: () => new Date().toISOString(),
    stopSignalFor: () => null,
    agentsArr: () => [],
    ESCALATION_DEFAULTS: () => ({}),
    OPTIMIZE_DEFAULTS: () => ({}),
  };
  return {
    ov,
    route: sessionRoute(ctx),
    response: () => response,
    saves: () => saves,
  };
}

async function post(route, path, body) {
  const req = { _body: body, method: 'POST' };
  await route(path, 'POST', req, {}, new URL(`http://localhost${path}`));
}

(async () => {
  // Workspace configuration exposes an explicit on/off gate and remains off until enabled.
  const h = harness();
  assert.strictEqual(h.ov.config.outcome_policy_memory, undefined);
  await post(h.route, '/config', { outcome_policy_memory: true });
  assert.strictEqual(h.response().code, 200);
  assert.strictEqual(h.ov.config.outcome_policy_memory, true);

  // Only an explicit correction field creates memory; the ordinary answer still resolves normally.
  const guidanceId = overlayStore.addGuidance(h.ov, {
    question: 'Which test command should be run?',
    origin_task: 'task/route-1',
    request_session: 'session-route',
  });
  await post(h.route, '/guidance/resolve', {
    id: guidanceId,
    answer: 'Use the focused test.',
    correction: 'Run the focused test before the full suite.',
    correction_scope: 'test-order',
  });
  const result = h.response();
  assert.strictEqual(result.code, 200);
  assert(result.body.outcome_policy.created);
  const note = h.ov.note_nodes[result.body.outcome_policy.created.id];
  assert.strictEqual(note.memory_lane, 'guidance');
  assert.strictEqual(note.source_role, 'user');
  assert.strictEqual(note.authority, 'directive');
  assert.deepStrictEqual(note.episode, {
    session_id: 'session-route',
    transcript_ref: `guidance:${guidanceId}`,
  });
  assert(h.ov.edges.some((edge) => edge.from === result.body.outcome_policy.created.key && edge.to === 'task/route-1'));

  // With the gate off, the same explicit field is reported as disabled and creates no note.
  const off = harness();
  const offId = overlayStore.addGuidance(off.ov, { question: 'Correction?', origin_task: 'task/off' });
  await post(off.route, '/guidance/resolve', { id: offId, answer: 'answer', correction: 'Do this next time.' });
  assert.strictEqual(off.response().body.outcome_policy.enabled, false);
  assert.strictEqual(Object.keys(off.ov.note_nodes).length, 0);

  assert(h.saves() >= 2);
  console.log('outcome-policy-memory-route: all tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
