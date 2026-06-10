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

// --- frontierKeep: seeds + neighbors + ancestry ---
{
  // a(ready) -> blocks on b(done) -> blocks on c(done) -> blocks on d(done): blocking ancestry to root.
  // a has context deps: hi(weight .9), lo(weight .1) + third(no weight) — lo is kept only via top-3.
  // far(done) is connected to nothing live — dropped.
  const tasks = [
    T('a', 'ready', { deps: ['b'], context_deps: ['hi', 'lo'], context_weights: { hi: 0.9, lo: 0.1 } }),
    T('b', 'done', { deps: ['c'] }),
    T('c', 'done', { deps: ['d'] }),
    T('d', 'done'),
    T('hi', 'done'), T('lo', 'done'),
    T('far', 'done'),
  ];
  const keep = F.frontierKeep(tasks);
  ok('live seed kept', keep.has('a'));
  ok('blocking ancestry walks to root', keep.has('b') && keep.has('c') && keep.has('d'));
  ok('important context dep kept', keep.has('hi'));
  ok('low-weight context dep still top-3 kept', keep.has('lo'));
  ok('unconnected done node dropped', !keep.has('far'));
}
{
  // Low-weight context dep beyond top-3 is NOT walked from a non-seed hop.
  const cw = { c1: 0.9, c2: 0.8, c3: 0.7, c4: 0.1 };
  const tasks = [
    T('seed', 'in_progress', { deps: ['mid'] }),
    T('mid', 'done', { context_deps: ['c1', 'c2', 'c3', 'c4'], context_weights: cw }),
    T('c1', 'done'), T('c2', 'done'), T('c3', 'done'), T('c4', 'done'),
  ];
  const keep = F.frontierKeep(tasks);
  ok('important context of ancestor kept', keep.has('c1') && keep.has('c2') && keep.has('c3'));
  ok('unimportant beyond-top-3 context dropped', !keep.has('c4'));
}
{
  // 1-hop neighbors kept in EITHER direction: a done dependent of a live node stays.
  const tasks = [
    T('seed', 'ready'),
    T('dependent', 'done', { deps: ['seed'] }),
  ];
  const keep = F.frontierKeep(tasks);
  ok('1-hop downstream neighbor kept', keep.has('dependent'));
}
{
  // No live seeds: fall back to the 15 most recently changed.
  const tasks = [];
  for (let i = 0; i < 20; i++) tasks.push(T(`t${i}`, 'done', { lastChanged: iso(i) }));
  const keep = F.frontierKeep(tasks);
  ok('fallback keeps 15 when nothing live', keep.size === 15);
  ok('fallback keeps most recent', keep.has('t0') && !keep.has('t19'));
}
{
  // Ghost refs never crash and are not kept as nodes.
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
