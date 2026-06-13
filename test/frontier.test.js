#!/usr/bin/env node
// Plain Node test for lib/frontier.js (frontier-scoped /state projection + archival sweep) — no
// framework; matches the style of test/graph-delta.test.js. Run: node test/frontier.test.js
// Pure-lib assertions only: frontierKeep seed/neighbor/ancestry selection, archivedIds windowing,
// slimNode projection, and projectFrontier payload filtering (the /state route is a thin wrapper).
'use strict';
const F = require('../lib/frontier');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const NOW = Date.parse('2026-06-10T12:00:00Z');
const DAY = 864e5;
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const T = (id, status, extra = {}) => ({ id, label: id, status, deps: [], context_deps: [], context_weights: {}, ...extra });

// --- frontierKeep: seeds always kept ---
{
  const tasks = [T('a', 'ready'), T('far', 'done')];
  const keep = F.frontierKeep(tasks);
  ok('live seed kept', keep.has('a'));
  ok('unconnected done node dropped', !keep.has('far'));
}

// --- frontierKeep: hop-weight formula (blocking) ---
{
  // depth 1 blocking dep (weight=1.0 >= 0.30): kept
  // depth 2 blocking dep (weight=1.0 >= 0.60): kept
  // depth 3 blocking dep (weight=1.0 >= 0.90): kept
  // depth 4 blocking dep (weight=1.0 >= 1.20): NOT kept (1.0 < 1.20)
  const tasks = [
    T('seed', 'ready', { deps: ['b1'] }),
    T('b1', 'done', { deps: ['b2'] }),
    T('b2', 'done', { deps: ['b3'] }),
    T('b3', 'done', { deps: ['b4'] }),
    T('b4', 'done', { deps: ['b5'] }),
    T('b5', 'done'),
  ];
  const keep = F.frontierKeep(tasks);
  ok('blocking dep at depth 1 kept', keep.has('b1'));
  ok('blocking dep at depth 2 kept', keep.has('b2'));
  ok('blocking dep at depth 3 kept', keep.has('b3'));
  ok('blocking dep at depth 3 kept (1.0 >= 0.90)', keep.has('b3'));
  ok('blocking dep at depth 4 NOT kept (1.0 < 1.20)', !keep.has('b4'));
}

// --- frontierKeep: hop-weight formula (context) ---
{
  // depth 1, weight 0.3 (>= 0.25): kept
  const tasks = [
    T('seed', 'ready', { context_deps: ['c'], context_weights: { c: 0.3 } }),
    T('c', 'done'),
  ];
  ok('context dep depth 1 weight 0.3 kept (0.3 >= 0.30 boundary)', F.frontierKeep(tasks).has('c'));
}
{
  // depth 2, weight 0.3 (< 0.50): NOT kept
  const tasks = [
    T('seed', 'ready', { deps: ['mid'] }),
    T('mid', 'done', { context_deps: ['c'], context_weights: { c: 0.3 } }),
    T('c', 'done'),
  ];
  ok('context dep depth 2 weight 0.3 NOT kept (0.3 < 0.60)', !F.frontierKeep(tasks).has('c'));
}
{
  // depth 2, weight 0.6 (>= 0.50): kept
  const tasks = [
    T('seed', 'ready', { deps: ['mid'] }),
    T('mid', 'done', { context_deps: ['c'], context_weights: { c: 0.6 } }),
    T('c', 'done'),
  ];
  ok('context dep depth 2 weight 0.6 kept (0.6 >= 0.60 boundary)', F.frontierKeep(tasks).has('c'));
}
{
  // depth 3, blocking (weight=1.0 >= 0.75): kept (already covered by blocking test above; here via context chain)
  // depth 4, weight 0.9 (< 1.00): NOT kept
  const tasks = [
    T('seed', 'ready', { deps: ['b1'] }),
    T('b1', 'done', { deps: ['b2'] }),
    T('b2', 'done', { deps: ['b3'] }),
    T('b3', 'done', { context_deps: ['c'], context_weights: { c: 0.9 } }),
    T('c', 'done'),
  ];
  const keep = F.frontierKeep(tasks);
  ok('blocking dep at depth 3 kept (1.0 >= 0.90)', keep.has('b3'));
  ok('context dep depth 4 weight 0.9 NOT kept (0.9 < 1.20)', !keep.has('c'));
}

// --- frontierKeep: default context weight (0.5) ---
{
  // depth 1: 0.5 >= 0.25 → kept
  const tasksD1 = [
    T('seed', 'ready', { context_deps: ['c'] }),
    T('c', 'done'),
  ];
  ok('context dep depth 1 default weight 0.5 kept', F.frontierKeep(tasksD1).has('c'));

  // depth 2: 0.5 < 0.60 → NOT kept (default weight cut at depth 2 with 0.30 coefficient)
  const tasksD2 = [
    T('seed', 'ready', { deps: ['mid'] }),
    T('mid', 'done', { context_deps: ['c'] }),
    T('c', 'done'),
  ];
  ok('context dep depth 2 default weight 0.5 NOT kept (0.5 < 0.60)', !F.frontierKeep(tasksD2).has('c'));

  // depth 3: 0.5 < 0.75 → NOT kept
  const tasksD3 = [
    T('seed', 'ready', { deps: ['b1'] }),
    T('b1', 'done', { deps: ['b2'] }),
    T('b2', 'done', { context_deps: ['c'] }),
    T('c', 'done'),
  ];
  ok('context dep depth 3 default weight 0.5 NOT kept (0.5 < 0.75)', !F.frontierKeep(tasksD3).has('c'));
}

// --- frontierKeep: reverse direction (live dependent of seed) ---
{
  const tasks = [
    T('seed', 'ready'),
    T('live-dep', 'not_ready', { deps: ['seed'] }),
    T('done-dep', 'done', { deps: ['seed'] }),
  ];
  const keep = F.frontierKeep(tasks);
  ok('live downstream dependent of seed kept via reverse scan', keep.has('live-dep'));
  ok('done downstream dependent of seed NOT kept via reverse scan', !keep.has('done-dep'));
}

// --- frontierKeep: no live seeds fallback ---
{
  const tasks = [];
  for (let i = 0; i < 20; i++) tasks.push(T(`t${i}`, 'done', { lastChanged: iso(i) }));
  const keep = F.frontierKeep(tasks);
  ok('fallback keeps 15 when nothing live', keep.size === 15);
  ok('fallback keeps most recent', keep.has('t0') && !keep.has('t19'));
}

// --- frontierKeep: ghost refs safely skipped ---
{
  const tasks = [T('a', 'ready', { deps: ['ghost:other|x'] })];
  const keep = F.frontierKeep(tasks);
  ok('ghost dep skipped safely', keep.has('a') && keep.size === 1);
}

// --- archivedIds: window + status + keep exemption ---
{
  const tasks = [
    T('old-done', 'done', { lastChanged: iso(30) }),
    T('new-done', 'done', { lastChanged: iso(2) }),
    T('old-canceled', 'canceled', { lastChanged: iso(30) }),
    T('old-failed', 'failed', { lastChanged: iso(30) }),     // failed is live, never archived
    T('old-ready', 'ready', { lastChanged: iso(30) }),       // non-terminal, never archived
    { id: 'note:sup', kind: 'note', status: 'note', label: 'n', deps: [], context_deps: [], supersededBy: 'note:x', validTo: iso(30) },
    { id: 'note:cur', kind: 'note', status: 'note', label: 'n', deps: [], context_deps: [], created_at: iso(30) },
    { id: 'note:fresh', kind: 'note', status: 'note', label: 'n', deps: [], context_deps: [], supersededBy: 'note:y', validTo: iso(1) },
  ];
  const arch = F.archivedIds(tasks, { now: NOW, windowMs: 14 * DAY });
  ok('stale done archived', arch.has('old-done'));
  ok('recent done NOT archived', !arch.has('new-done'));
  ok('stale canceled archived', arch.has('old-canceled'));
  ok('failed never archived', !arch.has('old-failed'));
  ok('non-terminal never archived', !arch.has('old-ready'));
  ok('stale superseded note archived', arch.has('note:sup'));
  ok('current (non-superseded) note NOT archived', !arch.has('note:cur'));
  ok('recently superseded note NOT archived', !arch.has('note:fresh'));
  const kept = F.archivedIds(tasks, { now: NOW, windowMs: 14 * DAY, keep: new Set(['old-done']) });
  ok('keep-set exempts from archival', !kept.has('old-done') && kept.has('old-canceled'));
  ok('Infinity window archives nothing', F.archivedIds(tasks, { now: NOW, windowMs: Infinity }).size === 0);
  ok('missing timestamps never archive', F.archivedIds([T('x', 'done')], { now: NOW, windowMs: 14 * DAY }).size === 0);
}

// --- slimNode: structural fields + clipped summary, heavy fields dropped ---
{
  const s = F.slimNode({ id: 'a', label: 'L', status: 'done', deps: ['b'], context_deps: ['c'], context_weights: { c: 0.7 }, agent_id: 'w1', summary: 'x'.repeat(500), note: 'big', tokens: 123, git: {}, session: 's' });
  ok('slim keeps structure', s.id === 'a' && s.deps[0] === 'b' && s.context_deps[0] === 'c' && s.context_weights.c === 0.7 && s.assignee === 'w1');
  ok('slim clips summary', s.summary.length === 281 && s.summary.endsWith('…'));
  ok('slim drops heavy fields', !('note' in s) && !('tokens' in s) && !('git' in s) && !('session' in s));
  const n = F.slimNode(T('b', 'ready'));
  ok('slim omits empty weight/summary/assignee', !('context_weights' in n) && !('summary' in n) && !('assignee' in n));
}

// --- archivedSlimNode + archivedTaskList: lean /state archived_tasks projection ---
{
  const tasks = [
    T('old-done', 'done', { lastChanged: iso(30) }),
    T('new-done', 'done', { lastChanged: iso(2) }),
    { id: 'note:sup', kind: 'note', status: 'note', label: 'n', deps: [], context_deps: [], supersededBy: 'note:x', validTo: iso(30) },
  ];
  const arch = F.archivedIds(tasks, { now: NOW, windowMs: 14 * DAY });
  const list = F.archivedTaskList(tasks, arch);
  const ids = new Set(list.map((t) => t.id));
  ok('archivedTaskList returns stale terminal ids', ids.has('old-done') && ids.has('note:sup') && !ids.has('new-done'));
  ok('archived slim shape is lean', list.every((t) => t.id && t.label && t.status && !('deps' in t) && !('summary' in t)));
  ok('archived slim includes lastChanged when present', list.find((t) => t.id === 'old-done').lastChanged === iso(30));
  ok('archived slim includes kind for notes', list.find((t) => t.id === 'note:sup').kind === 'note');
  ok('archivedTaskList empty for empty arch set', F.archivedTaskList(tasks, new Set()).length === 0);
}

// --- projectFrontier: payload filtering (tasks/edges/ghosts) + archived count ---
{
  const tasks = [
    T('a', 'ready', { deps: ['b', 'ghost:other|x'], summary: 'live' }),
    T('b', 'done', { summary: 'dep summary' }),
    T('far', 'done', { lastChanged: iso(30) }),    // outside frontier AND stale ⇒ archived
    T('meh', 'done', { lastChanged: iso(1) }),     // outside frontier, recent ⇒ just not in digest
  ];
  const ghosts = [{ workspace: 'other', key: 'x', label: 'gx', status: 'done' }, { workspace: 'other', key: 'y', label: 'gy', status: 'done' }];
  const edges = [
    { from: 'b', to: 'a', kind: 'context', weight: 0.8 },
    { from: 'far', to: 'meh', kind: 'context', weight: 0.9 },
  ];
  const f = F.projectFrontier(tasks, ghosts, edges, { now: NOW, windowMs: 14 * DAY });
  const ids = new Set(f.tasks.map((t) => t.id));
  ok('digest keeps frontier only', ids.has('a') && ids.has('b') && !ids.has('far') && !ids.has('meh'));
  ok('digest filters edges to kept nodes', f.edges.length === 1 && f.edges[0].from === 'b');
  ok('digest keeps only referenced ghosts', f.ghosts.length === 1 && f.ghosts[0].key === 'x');
  ok('digest reports archived count', f.archived === 1);
  ok('digest nodes are slim', !('tokens' in f.tasks[0]) && !('note' in f.tasks[0]));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
