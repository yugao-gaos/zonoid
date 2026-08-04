#!/usr/bin/env node
'use strict';

const daemon = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log('PASS  ' + label); pass++; }
  else { console.log('FAIL  ' + label); fail++; }
};

function resolver({ deps = [], statuses = {}, exists = {}, explicit = {} } = {}) {
  return {
    depRefs(_ws, key) { return deps[key] || []; },
    effective(_ws, key) { return statuses[key] || 'ready'; },
    exists(_ws, key) { return exists[key] !== false; },
    explicitStatus(_ws, key) { return explicit[key] || null; },
  };
}

const detail = daemon.__readinessDetailForTest;

{
  const R = resolver({
    deps: { task: [{ ws: 'w', key: 'missing', kind: 'blocking' }] },
    exists: { missing: false },
  });
  ok('missing blocking dependency is classified', detail(R, 'w', 'task', { status: 'not_ready' }).kind === 'missing_dependency');
}
{
  const R = resolver({
    deps: { task: [{ ws: 'w', key: 'dep', kind: 'blocking' }] },
    statuses: { dep: 'canceled' },
  });
  ok('canceled dependency is classified', detail(R, 'w', 'task', { status: 'not_ready' }).kind === 'canceled_dependency');
}
{
  const R = resolver({
    deps: { task: [{ ws: 'w', key: 'dep', kind: 'blocking' }] },
    statuses: { dep: 'not_ready' },
  });
  const d = detail(R, 'w', 'task', { status: 'not_ready' });
  ok('not-ready dependency is classified as normal wait', d.kind === 'waiting_dependency' && d.dependency_status === 'not_ready');
}
{
  const R = resolver();
  ok('judging hold is classified after satisfied deps', detail(R, 'w', 'task', { status: 'not_ready', judging: true }).kind === 'judging_hold');
}
{
  const R = resolver({ explicit: { task: 'not_ready' } });
  ok('explicit not_ready hold is classified', detail(R, 'w', 'task', { status: 'not_ready', note: 'held by user' }).kind === 'explicit_hold');
}
{
  const R = resolver();
  ok('bare not_ready fallback is stale projection', detail(R, 'w', 'task', { status: 'not_ready' }).kind === 'stale_projection');
}
{
  const R = resolver();
  ok('ready task has no readiness detail', detail(R, 'w', 'task', { status: 'ready' }) === null);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
