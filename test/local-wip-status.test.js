#!/usr/bin/env node
// Regression: the dashboard's WIP badge is local activity, not every persisted in_progress task.
// Run: node test/local-wip-status.test.js
'use strict';
const ov = require('../lib/overlay');

const DIMS = 384;
const embedPath = require.resolve('../lib/embed');
require.cache[embedPath] = { id: embedPath, filename: embedPath, loaded: true, exports: {
  embed: async () => null,
  cosine: () => 0,
  nodeVecs: () => [],
  maxCosine: () => 0,
  embedStatus: () => ({ ready: false, disabled: true }),
  ping: async () => ({ ok: false }),
  MODEL: 'stub',
  DIMS,
} };

const { localInProgressCount } = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const NOW = Date.parse('2026-06-10T12:00:00Z');
const BOOT = NOW - 20 * 60_000;
const overlay = ov.EMPTY();
overlay.config.stale_minutes = 10;
overlay.assignee['local/live'] = 'live-worker';
overlay.assignee['remote/inherited'] = 'remote-worker';
overlay.assignee['local/stale'] = 'stale-worker';

const tasks = [
  { id: 'local/live', label: 'local live', status: 'in_progress' },
  { id: 'remote/inherited', label: 'remote inherited', status: 'in_progress' },
  { id: 'local/stale', label: 'local stale', status: 'in_progress' },
  { id: 'local/ready', label: 'ready', status: 'ready' },
  { id: 'note:x', kind: 'note', label: 'note', status: 'note' },
];

const agents = {
  'live-worker': { agent_id: 'live-worker', state: 'running', startedAt: new Date(NOW).toISOString(), lastSeen: new Date(NOW).toISOString() },
  'stale-worker': { agent_id: 'stale-worker', state: 'running', startedAt: new Date(NOW - 3600_000).toISOString(), lastSeen: new Date(NOW - 3600_000).toISOString() },
};

ok('only locally vouched in_progress tasks count as local WIP', localInProgressCount(tasks, overlay, agents, NOW, BOOT) === 1);
ok('inherited in_progress without a local agent does not count', !agents[overlay.assignee['remote/inherited']]);
ok('stale local running record does not count after boot grace', localInProgressCount(tasks.filter((t) => t.id === 'local/stale'), overlay, agents, NOW, BOOT) === 0);

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
