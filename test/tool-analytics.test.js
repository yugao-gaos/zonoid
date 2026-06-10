#!/usr/bin/env node
// Plain Node test for lib/analytics.js (MCP tool-usage counters) — no framework; matches the
// style of test/graph-delta.test.js. Run: node test/tool-analytics.test.js
// Covers: record aggregation (total/errors/last_called/workspaces/day buckets), the rolling
// 7-day window prune, report() zero rows for never-called registry tools + registered:false for
// historical tools gone from the registry + sort order, load() resilience, debounced flush.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const a = require('../lib/analytics');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --- record: aggregation ---
const st = { tools: {} };
const NOW = new Date('2026-06-10T12:00:00Z');
a.record(st, 'start_task', false, '/ws/a', NOW);
a.record(st, 'start_task', true, '/ws/b', NOW);
a.record(st, 'start_task', false, '/ws/a', NOW);
const t = st.tools.start_task;
ok('total counted', t.total === 3);
ok('errors counted', t.errors === 1);
ok('last_called ISO', t.last_called === NOW.toISOString());
ok('per-workspace counts', t.workspaces['/ws/a'] === 2 && t.workspaces['/ws/b'] === 1);
ok('day bucket counted', t.days['2026-06-10'] === 3);

// --- rolling 7d window: an 8-day-old bucket is pruned on the next record ---
t.days['2026-06-02'] = 5;   // 8 days before NOW — outside the window
a.record(st, 'start_task', false, null, NOW);
ok('old day pruned', !('2026-06-02' in t.days));
ok('window keeps 7th day', (() => { t.days['2026-06-04'] = 1; a.record(st, 'start_task', false, null, NOW); return t.days['2026-06-04'] === 1; })());
ok('null workspace tolerated', Object.keys(t.workspaces).length === 2);

// --- report: zero rows + registry diff + sorting ---
a.record(st, 'get_full_graph', false, '/ws/a', NOW);
a.record(st, 'old_tool', false, '/ws/a', NOW);   // historical: no longer in the registry
const rows = a.report(st, ['start_task', 'get_full_graph', 'never_called'], NOW);
ok('all names present', rows.length === 4);
const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
ok('zero row for never-called', byName.never_called.total === 0 && byName.never_called.last_called === null && byName.never_called.last7d === 0);
ok('never-called still registered', byName.never_called.registered === true);
ok('removed tool flagged', byName.old_tool.registered === false && byName.old_tool.total === 1);
ok('sorted by total desc', rows[0].name === 'start_task');
ok('ties broken by name', rows.findIndex((r) => r.name === 'get_full_graph') < rows.findIndex((r) => r.name === 'old_tool'));
ok('last7d sums day buckets', byName.start_task.last7d === Object.values(st.tools.start_task.days).reduce((s, n) => s + n, 0));

// --- load: resilient to missing/garbage files ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-analytics-'));
const file = path.join(dir, 'tool-analytics.json');
ok('load missing -> empty', Object.keys(a.load(file).tools).length === 0);
fs.writeFileSync(file, 'not json');
ok('load garbage -> empty', Object.keys(a.load(file).tools).length === 0);

// --- flush: debounced single write persists state across a reload ---
const f = a.makeFlusher(file, st);
f.soon(); f.soon();           // coalesce
f.flush();                    // force (the timer path is the same fn)
const re = a.load(file);
ok('flush persists counts', re.tools.start_task.total === st.tools.start_task.total);
ok('flush persists days', re.tools.start_task.days['2026-06-10'] === st.tools.start_task.days['2026-06-10']);
fs.rmSync(dir, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
