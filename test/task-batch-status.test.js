#!/usr/bin/env node
'use strict';

const taskRoute = require('../routes/task');
const { effectiveTaskStatuses } = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, condition) => {
  if (condition) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const graphs = {
  '/workspace/a': {
    tasks: [
      { id: 'alpha/1', status: 'done' },
      { id: 'extra/1', status: 'ready' },
    ],
  },
  '/workspace/b': { tasks: [{ id: 'alpha/1', status: 'failed' }] },
};
let sent = null;
let buildCalls = [];
let statusCalls = [];
const ctx = {
  send(_res, status, body) { sent = { status, body }; },
  readBody: async (req) => req.body,
  targetOverlay(body) {
    const ws = body.graph_repo || body.workspace || null;
    return { ws, ov: {}, save: () => {} };
  },
  buildGraph(ws) {
    buildCalls.push(ws);
    return graphs[ws] || { tasks: [] };
  },
  effectiveTaskStatuses(ws, keys) {
    statusCalls.push({ ws, keys });
    const byId = new Map((graphs[ws] || { tasks: [] }).tasks.map((task) => [task.id, task.status]));
    return Object.fromEntries(keys.map((key) => [key, byId.get(key) || null]));
  },
};
const route = taskRoute(ctx);
const u = { searchParams: { get: () => null } };

async function call(body) {
  sent = null;
  buildCalls = [];
  statusCalls = [];
  await route('/task/status-batch', 'POST', { body }, {}, u, null);
  return sent;
}

(async () => {
  let result = await call({ graph_repo: '/workspace/a', keys: [' alpha/1 ', 'alpha/1', 'missing/1', ''] });
  ok('batch status: valid request returns 200', result && result.status === 200);
  ok('batch status: effective-status helper is called exactly once', statusCalls.length === 1);
  ok('batch status: graph projection is never built', buildCalls.length === 0);
  ok('batch status: graph_repo scopes the status lookup', statusCalls[0].ws === '/workspace/a');
  ok('batch status: normalized keys are passed to the status lookup',
    JSON.stringify(statusCalls[0].keys) === JSON.stringify(['alpha/1', 'missing/1']));
  ok('batch status: keys are trimmed and deduplicated',
    JSON.stringify(Object.keys(result.body.statuses)) === JSON.stringify(['alpha/1', 'missing/1']));
  ok('batch status: known status is returned', result.body.statuses['alpha/1'] === 'done');
  ok('batch status: unknown key is explicit null', result.body.statuses['missing/1'] === null);
  ok('batch status: unrequested graph tasks are omitted', !Object.hasOwn(result.body.statuses, 'extra/1'));

  result = await call({ workspace: '/workspace/b', keys: ['alpha/1'] });
  ok('batch status: workspace alias scopes independently',
    result.status === 200 && statusCalls[0].ws === '/workspace/b' && result.body.statuses['alpha/1'] === 'failed');

  result = await call({ workspace: '/workspace/a', keys: 'alpha/1' });
  ok('batch status: non-array keys are rejected', result.status === 400 && /array/.test(result.body.error));
  ok('batch status: invalid array does no status work', statusCalls.length === 0 && buildCalls.length === 0);

  result = await call({ workspace: '/workspace/a', keys: ['alpha/1', 42] });
  ok('batch status: non-string entries are rejected', result.status === 400 && /strings/.test(result.body.error));
  ok('batch status: invalid entries do no status work', statusCalls.length === 0 && buildCalls.length === 0);

  result = await call({ workspace: '/workspace/a', keys: Array.from({ length: 5001 }, (_, i) => `task/${i}`) });
  ok('batch status: excess keys fail clearly',
    result.status === 413 && result.body.max_keys === 5000 && /maximum/.test(result.body.error));
  ok('batch status: excess request does no status work', statusCalls.length === 0 && buildCalls.length === 0);

  result = await call({ keys: ['alpha/1'] });
  ok('batch status: workspace is required', result.status === 400 && /workspace required/.test(result.body.error));
  ok('batch status: missing workspace does no status work', statusCalls.length === 0 && buildCalls.length === 0);

  let loads = 0;
  const resolver = {
    loadWs(ws) { loads++; ok('effective status seam: workspace is loaded for the requested scope', ws === '/workspace/a'); },
    exists(_ws, key) { return key === 'alpha/1'; },
    effective(_ws, key) { return key === 'alpha/1' ? 'not_ready' : 'wrong'; },
  };
  const statuses = effectiveTaskStatuses('/workspace/a', ['alpha/1', 'missing/1'], resolver);
  ok('effective status seam: resolver workspace is loaded once', loads === 1);
  ok('effective status seam: effective resolver status is preserved', statuses['alpha/1'] === 'not_ready');
  ok('effective status seam: unknown task is explicit null', statuses['missing/1'] === null);

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error && (error.stack || error.message));
  process.exit(1);
});
