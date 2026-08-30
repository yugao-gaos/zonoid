#!/usr/bin/env node
'use strict';

const assert = require('assert');
const zlib = require('zlib');
const { HARNESS_JUDGE_DRAIN_KEY } = require('../lib/harness-task');
const {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  buildDashboardSnapshot,
  createDashboardSnapshot,
  dashboardSnapshotText,
  renderDashboardSnapshotPng,
  sanitizeDisplayText,
  _internal,
} = require('../lib/dashboard-snapshot');

const NOW = '2026-08-30T17:45:00.000Z';
const OPAQUE = '019c3ac8-f971-7b80-9d14-1b34dfd3c9e9';
const MNT_PATH = '/mnt/zonoid/private/state.json';
const ETC_PATH = '/etc/zonoid/credentials';
const UNC_PATH = '\\\\fileserver\\workspace\\private.txt';
const MNT_PATH_WITH_SPACES = '/mnt/mobile dashboard/private state.json';
const ETC_PATH_WITH_SPACES = '/etc/zonoid/private config';
const UNC_PATH_WITH_SPACES = '\\\\fileserver\\Mobile Data\\private file.txt';

function task(id, label, status, extra = {}) {
  return { id, label, status, deps: [], context_deps: [], ...extra };
}

function pngChunks(png) {
  assert.deepStrictEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += length + 12;
  }
  return chunks;
}

const tasks = [
  task('codex/plan', 'Plan delivery', 'not_ready'),
  task('codex/ready', 'Wire delivery tool', 'ready'),
  task('codex/wip', `Ship mobile snapshot from ${UNC_PATH} with secret=render-secret`, 'in_progress', { lastChanged: '2026-08-30T17:00:00Z' }),
  task(OPAQUE, 'Recover renderer', 'in_progress', { lastChanged: '2026-08-30T16:00:00Z' }),
  task(`${OPAQUE}/42`, `${OPAQUE}/42`, 'not_ready'),
  task('codex/review', 'Review snapshot security', 'tested', { review_state: 'pending' }),
  task('codex/blocked', `Wait for delivery client at ${ETC_PATH} password=blocked-password`, 'not_ready', { deps: ['codex/ready'] }),
  task('codex/failed', `Fix token=super-secret-value in ${MNT_PATH} AWS_SECRET_ACCESS_KEY=aws-secret-value`, 'failed'),
  task('codex/done-old', 'Finish old renderer', 'done', { lastChanged: '2026-08-29T12:00:00Z' }),
  task('codex/done-new', `Clean ${UNC_PATH} secret=done-secret`, 'done', { lastChanged: '2026-08-30T12:00:00Z' }),
  task('codex/out-of-frontier-failed', 'Out-of-frontier failure', 'failed'),
  task('codex/historical-done', 'Historical completion outside frontier', 'done', { lastChanged: '2025-01-01T00:00:00Z' }),
  task(HARNESS_JUDGE_DRAIN_KEY, 'Judge drain', 'ready'),
  { id: 'note:internal', label: 'Internal note', kind: 'note', status: 'note', deps: [], context_deps: [] },
];
const frontierTaskIds = new Set(tasks
  .map((item) => item.id)
  .filter((id) => id !== 'codex/out-of-frontier-failed' && id !== 'codex/historical-done'));
const guidance = [
  {
    id: 'user-new',
    question: 'Approve publishing without http://localhost:8787/token=private?',
    severity: 'blocking',
    resolved: false,
    created_at: '2026-08-30T17:30:00Z',
    origin_task: 'codex/wip',
  },
  {
    id: 'user-old',
    question: 'Use sk-abcdefghijklmnopqrstuvwxyz for delivery?',
    severity: 'review',
    resolved: false,
    created_at: '2026-08-30T16:30:00Z',
    origin_task: 'codex/ready',
  },
  {
    id: 'internal',
    question: `Deduplicate ${OPAQUE}?`,
    severity: 'review',
    resolved: false,
    action: { kind: 'dup-cluster', keys: ['note:a', 'note:b'], task_key: 'codex/wip' },
  },
  {
    id: 'resolved',
    question: 'Old decision',
    severity: 'blocking',
    resolved: true,
    origin_task: 'codex/plan',
  },
  {
    id: 'out-of-scope',
    question: 'Decision for a task absent from the scoped task set',
    severity: 'blocking',
    resolved: false,
    origin_task: 'codex/missing',
  },
];

const snapshot = buildDashboardSnapshot({ tasks, frontierTaskIds, guidance, now: NOW });
assert.strictEqual(snapshot.version, 1);
assert.strictEqual(snapshot.scope, 'workspace');
assert.strictEqual(snapshot.generated_at, NOW);
assert.deepStrictEqual(snapshot.counts, { plan: 4, ready: 1, wip: 2, review: 1, needs_you: 2 });
assert.deepStrictEqual(snapshot.current_wip, ['Ship mobile snapshot from [local path] with [secret]', 'Recover renderer']);
assert.strictEqual(snapshot.user_decisions.length, 2);
assert(snapshot.user_decisions[0].includes('[local service]'));
assert(snapshot.user_decisions[1].includes('[secret]'));
assert.deepStrictEqual(snapshot.blocked_failed, [
  { title: 'Fix [secret] in [local path] [secret]', state: 'Failed' },
  { title: 'Wait for delivery client at [local path] [secret]', state: 'Blocked' },
]);
assert.deepStrictEqual(snapshot.recent_completions, ['Clean [local path] [secret]', 'Finish old renderer']);
assert(!snapshot.current_wip.includes(OPAQUE), 'opaque internal task keys never become visible titles');
assert(!snapshot.blocked_failed.some((item) => item.title === 'Out-of-frontier failure'),
  'failed tasks outside the exact Kanban scope must stay hidden');
assert(!snapshot.recent_completions.includes('Historical completion outside frontier'),
  'historical done tasks outside the exact Kanban scope must stay hidden');
assert(!snapshot.user_decisions.includes('Decision for a task absent from the scoped task set'),
  'decisions without a scoped task must stay hidden');

const serialized = JSON.stringify(snapshot);
for (const secret of [
  OPAQUE,
  MNT_PATH,
  ETC_PATH,
  UNC_PATH,
  'super-secret-value',
  'aws-secret-value',
  'blocked-password',
  'render-secret',
  'done-secret',
  'sk-abcdefghijklmnopqrstuvwxyz',
  'localhost:8787',
]) {
  assert(!serialized.includes(secret), `snapshot projection leaked ${secret}`);
}
assert(!serialized.includes(HARNESS_JUDGE_DRAIN_KEY), 'internal harness drains stay outside the snapshot');
assert(!serialized.includes('Deduplicate'), 'internal-only guidance stays outside Needs You');

const structuredSnapshot = buildDashboardSnapshot({
  tasks: [
    task('codex/structured-wip', `Credentials {"password":"hunter2"} at "${MNT_PATH_WITH_SPACES}"`, 'in_progress'),
    task('codex/structured-failed', `Inspect [${ETC_PATH_WITH_SPACES}] and <${UNC_PATH_WITH_SPACES}>`, 'failed'),
  ],
  frontierTaskIds: ['codex/structured-wip', 'codex/structured-failed'],
  guidance: [{
    id: 'structured-guidance',
    question: 'Use {"secret":"mobile-private"} with {"AWS_SECRET_ACCESS_KEY":"aws-value"}?',
    severity: 'blocking',
    resolved: false,
    origin_task: 'codex/structured-wip',
  }],
  now: NOW,
});
assert.deepStrictEqual(structuredSnapshot.current_wip, ['Credentials {[secret]} at [local path]']);
assert.deepStrictEqual(structuredSnapshot.blocked_failed,
  [{ title: 'Inspect [local path] and [local path]', state: 'Failed' }]);
assert.deepStrictEqual(structuredSnapshot.user_decisions, ['Use {[secret]} with {[secret]}?']);
for (const leaked of ['hunter2', 'mobile-private', 'aws-value', 'mobile dashboard', 'private config', 'fileserver', 'Mobile Data']) {
  assert(!JSON.stringify(structuredSnapshot).includes(leaked), `snapshot projection leaked structured value or path fragment ${leaked}`);
}

const fallback = dashboardSnapshotText(snapshot);
assert.match(fallback, /PLAN 4 \| READY 1 \| WIP 2 \| REVIEW 1 \| NEEDS YOU 2/);
for (const title of [
  ...snapshot.current_wip,
  ...snapshot.user_decisions,
  ...snapshot.blocked_failed.map((item) => `${item.state}: ${item.title}`),
  ...snapshot.recent_completions,
]) assert(fallback.includes(title), `accessible fallback omitted ${title}`);
for (const secret of [OPAQUE, MNT_PATH, ETC_PATH, UNC_PATH, 'super-secret-value', 'aws-secret-value', 'blocked-password', 'render-secret', 'done-secret', 'localhost:8787']) {
  assert(!fallback.includes(secret), `accessible fallback leaked ${secret}`);
}

const hostileSnapshot = {
  ...snapshot,
  counts: { ...snapshot.counts, plan: 'password=count-secret' },
  current_wip: ['Credentials {"password":"hunter2"} {"secret":"mobile-private"} {"AWS_SECRET_ACCESS_KEY":"aws-value"}'],
  user_decisions: [`Read [${MNT_PATH_WITH_SPACES}] and <${ETC_PATH_WITH_SPACES}>`],
  blocked_failed: [{ state: 'Blocked', title: `Open "${MNT_PATH_WITH_SPACES}"` }],
  recent_completions: [`Copy '${UNC_PATH_WITH_SPACES}'`],
  omitted: { ...snapshot.omitted, current_wip: 'AWS_SECRET_ACCESS_KEY=omitted-secret' },
};
const sanitizedHostileSnapshot = {
  ...hostileSnapshot,
  counts: { ...hostileSnapshot.counts, plan: 0 },
  current_wip: ['Credentials {[secret]} {[secret]} {[secret]}'],
  user_decisions: ['Read [local path] and [local path]'],
  blocked_failed: [{ state: 'Blocked', title: 'Open [local path]' }],
  recent_completions: ['Copy [local path]'],
  omitted: { ...hostileSnapshot.omitted, current_wip: 0 },
};
const hostileText = dashboardSnapshotText(hostileSnapshot);
assert.strictEqual(hostileText, dashboardSnapshotText(sanitizedHostileSnapshot),
  'accessible text must sanitize even caller-supplied snapshot fields');
for (const leaked of [
  'hunter2',
  'mobile-private',
  'aws-value',
  'mobile dashboard',
  'private config',
  'fileserver',
  'Mobile Data',
  'private file.txt',
]) assert(!hostileText.includes(leaked), `accessible fallback leaked structured value or path fragment ${leaked}`);
assert.deepStrictEqual(renderDashboardSnapshotPng(hostileSnapshot), renderDashboardSnapshotPng(sanitizedHostileSnapshot),
  'PNG render source must sanitize even caller-supplied snapshot fields');

const pngA = renderDashboardSnapshotPng(snapshot);
const pngB = renderDashboardSnapshotPng(snapshot);
assert.deepStrictEqual(pngA, pngB, 'identical snapshot input must produce identical PNG bytes');
assert.strictEqual(_internal.crc32(Buffer.from('123456789')), 0xcbf43926);
const chunks = pngChunks(pngA);
assert.deepStrictEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);
assert.strictEqual(chunks[0].data.readUInt32BE(0), DEFAULT_WIDTH);
assert.strictEqual(chunks[0].data.readUInt32BE(4), DEFAULT_HEIGHT);
const pixels = zlib.inflateSync(Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data)));
assert.strictEqual(pixels.length, (DEFAULT_WIDTH * 4 + 1) * DEFAULT_HEIGHT);
for (let row = 0; row < DEFAULT_HEIGHT; row++) assert.strictEqual(pixels[row * (DEFAULT_WIDTH * 4 + 1)], 0);
assert(!pngA.includes(Buffer.from('super-secret-value')), 'PNG must not carry secret text chunks');

const portable = createDashboardSnapshot({ tasks, frontierTaskIds, guidance }, { now: NOW });
assert(Buffer.isBuffer(portable.png));
assert.strictEqual(portable.mime_type, 'image/png');
assert.strictEqual(portable.width, DEFAULT_WIDTH);
assert.strictEqual(portable.height, DEFAULT_HEIGHT);
assert.deepStrictEqual(Buffer.from(portable.png_base64, 'base64'), portable.png);
assert.deepStrictEqual(portable.snapshot, snapshot);
assert.strictEqual(portable.text, fallback);

const reversed = buildDashboardSnapshot({
  tasks: [...tasks].reverse(),
  frontierTaskIds,
  guidance: [...guidance].reverse(),
  now: NOW,
});
assert.deepStrictEqual(reversed, snapshot, 'input order must not perturb portable snapshot output');

const empty = createDashboardSnapshot({}, { now: NOW });
assert.deepStrictEqual(empty.snapshot.counts, { plan: 0, ready: 0, wip: 0, review: 0, needs_you: 0 });
assert.match(empty.text, /CURRENT WIP\n- None/);
assert.deepStrictEqual(pngChunks(empty.png).map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);

const largeTasks = [];
const largeGuidance = [];
for (let index = 0; index < 20; index++) {
  largeTasks.push(task(`codex/wip-${String(index).padStart(2, '0')}`, `WIP ${String(index).padStart(2, '0')}`, 'in_progress'));
}
for (let index = 0; index < 8; index++) {
  largeTasks.push(task(`codex/blocked-${index}`, `Blocked ${index}`, 'not_ready', { deps: ['codex/wip-00'] }));
  largeTasks.push(task(`codex/done-${index}`, `Done ${index}`, 'done', { lastChanged: `2026-08-${String(20 + index).padStart(2, '0')}T00:00:00Z` }));
}
for (let index = 0; index < 10; index++) {
  largeGuidance.push({
    id: `guidance-${index}`,
    question: `Decision ${index}`,
    resolved: false,
    severity: 'blocking',
    origin_task: 'codex/wip-00',
  });
}
const largeIds = new Set(largeTasks.map((item) => item.id));
const large = createDashboardSnapshot({
  tasks: largeTasks,
  frontierTaskIds: largeIds,
  guidance: largeGuidance,
}, { now: NOW, limit: 4 });
assert.deepStrictEqual(large.snapshot.counts, { plan: 8, ready: 0, wip: 20, review: 0, needs_you: 10 });
assert.strictEqual(large.snapshot.current_wip.length, 4);
assert.strictEqual(large.snapshot.omitted.current_wip, 16);
assert.strictEqual(large.snapshot.omitted.user_decisions, 6);
assert.strictEqual(large.snapshot.omitted.blocked_failed, 4);
assert.strictEqual(large.snapshot.omitted.recent_completions, 4);
assert.match(large.text, /\+16 more/);
assert.deepStrictEqual(pngChunks(large.png).map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);

assert.strictEqual(
  sanitizeDisplayText(`Session ${OPAQUE} at file:///Users/imyu/repo with token=abc123secret`),
  'Session [private id] at [local path] with [secret]',
);
assert.strictEqual(
  sanitizeDisplayText(`Read ${MNT_PATH}, ${ETC_PATH}, and ${UNC_PATH}; password=hunter2 secret='quoted value' AWS_SECRET_ACCESS_KEY=aws-value`),
  'Read [local path], [local path], and [local path]; [secret] [secret] [secret]',
);
assert.strictEqual(
  sanitizeDisplayText('{"password":"hunter2"} {"secret":"mobile-private"} {"AWS_SECRET_ACCESS_KEY":"aws-value"}'),
  '{[secret]} {[secret]} {[secret]}',
);
assert.strictEqual(
  sanitizeDisplayText(`Read [${MNT_PATH_WITH_SPACES}], <${ETC_PATH_WITH_SPACES}>, "${MNT_PATH_WITH_SPACES}", and '${UNC_PATH_WITH_SPACES}'`),
  'Read [local path], [local path], [local path], and [local path]',
);

console.log('PASS  portable dashboard snapshot projection and deterministic PNG renderer');
