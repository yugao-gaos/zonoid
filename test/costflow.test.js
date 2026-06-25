#!/usr/bin/env node
// Plain Node test for lib/costflow.js (no framework; matches test/native-write.test.js style).
// Run: node test/costflow.test.js — exits non-zero on any failure.
//
// Covers the cost-flow attribution invariants:
//   - conservation: Σ results.T + Σ waste.trapped === Σ own (every token counted exactly once)
//   - merged components are sinks (claim T, pass 0 downstream)
//   - terminal non-merged components trap their T as named waste
//   - weighted distribution T·w/W along outgoing edges (blocking 1.0 vs context weights)
//   - SCC collapse: context-edge cycles condense into one component before the topo sort
//   - splitSessionTokens: tasks sharing one transcript divide its total by claim-window duration
//   - sessionCatchalls: per-session catch-all nodes own unclaimed transcript tokens, edge to the
//     session's outputs, trap as named waste when the session produced nothing — conservation holds
'use strict';
const { computeFlow, splitSessionTokens, sessionCatchalls, sccs } = require('../lib/costflow');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const conserved = (flow, total) => near(flow.totals.productive + flow.totals.trapped, total) && near(flow.totals.total, total);

// --- 1) chain into a merged sink claims everything --------------------------------------------
{
  const flow = computeFlow(
    [{ id: 'A', own: 100 }, { id: 'B', own: 0 }, { id: 'C', own: 50, merged: true }],
    [{ from: 'A', to: 'B', weight: 1 }, { from: 'B', to: 'C', weight: 1 }],
  );
  ok('chain: merged sink claims accumulated T (150)', flow.results.length === 1 && near(flow.results[0].T, 150));
  ok('chain: own/inherited split on the sink', near(flow.results[0].own, 50) && near(flow.results[0].inherited, 100));
  ok('chain: no waste', flow.waste.length === 0);
  ok('chain: conservation', conserved(flow, 150));
}

// --- 2) weighted split: blocking 1.0 vs context 0.5 -------------------------------------------
{
  const flow = computeFlow(
    [{ id: 'A', own: 90 }, { id: 'B', own: 0, merged: true }, { id: 'C', own: 0 }],
    [{ from: 'A', to: 'B', weight: 1 }, { from: 'A', to: 'C', weight: 0.5 }],
  );
  // W(A)=1.5 → B inherits 60, C traps 30
  ok('weights: merged consumer gets T·w/W (60)', near(flow.results[0].T, 60));
  ok('weights: terminal non-merged traps the rest (30)', flow.waste.length === 1 && near(flow.waste[0].trapped, 30));
  ok('weights: conservation', conserved(flow, 90));
}

// --- 3) terminal non-merged node = named waste; pass-throughs keep nothing ---------------------
{
  const flow = computeFlow(
    [{ id: 'A', own: 100 }, { id: 'B', own: 20 }],
    [{ from: 'A', to: 'B', weight: 1 }],
  );
  ok('waste: terminal non-merged traps all upstream cost', flow.results.length === 0 && flow.waste.length === 1 && near(flow.waste[0].trapped, 120));
  ok('waste: conservation', conserved(flow, 120));
}

// --- 4) SCC collapse: a context-edge cycle condenses, then flows into its consumer -------------
{
  const nodes = [{ id: 'X', own: 10 }, { id: 'Y', own: 20 }, { id: 'Z', own: 0, merged: true }];
  const edges = [
    { from: 'X', to: 'Y', weight: 0.5 }, { from: 'Y', to: 'X', weight: 0.5 }, // 2-cycle
    { from: 'X', to: 'Z', weight: 1 },
  ];
  const comps = sccs(['X', 'Y', 'Z'], new Map([['X', ['Y', 'Z']], ['Y', ['X']], ['Z', []]]));
  ok('scc: cycle collapses into one component', comps.some((c) => c.length === 2 && c.includes('X') && c.includes('Y')));
  const flow = computeFlow(nodes, edges);
  ok('scc: collapsed cycle flows its combined own (30) to the sink', flow.results.length === 1 && near(flow.results[0].T, 30));
  ok('scc: sink entry is a single-member component', flow.results[0].members.length === 1);
  ok('scc: conservation with a cycle present', conserved(flow, 30));
}

// --- 5) merged sink passes 0 downstream (reuse is free) ----------------------------------------
{
  const flow = computeFlow(
    [{ id: 'A', own: 100 }, { id: 'M', own: 0, merged: true }, { id: 'B', own: 5 }],
    [{ from: 'A', to: 'M', weight: 1 }, { from: 'M', to: 'B', weight: 1 }],
  );
  ok('sink: merged node claims 100 and passes 0', near(flow.results[0].T, 100));
  ok('sink: downstream of a sink traps only its own (5)', flow.waste.length === 1 && near(flow.waste[0].trapped, 5));
  ok('sink: conservation', conserved(flow, 105));
}

// --- 6) conservation on a messier graph (cycle + multiple sinks + dangling edges) --------------
{
  const nodes = [];
  for (let i = 0; i < 30; i++) nodes.push({ id: `n${i}`, own: (i * 37) % 11 * 100, merged: i % 7 === 3 });
  const edges = [];
  for (let i = 0; i < 30; i++) edges.push({ from: `n${i}`, to: `n${(i * 13 + 5) % 30}`, weight: i % 2 ? 1 : 0.5 });
  edges.push({ from: 'n2', to: 'n9', weight: 0.5 }, { from: 'n9', to: 'n2', weight: 0.5 }); // explicit cycle
  edges.push({ from: 'ghost:unknown', to: 'n1', weight: 1 });   // unknown endpoint → dropped
  edges.push({ from: 'n4', to: 'n4', weight: 1 });              // self-loop → dropped
  const total = nodes.reduce((s, n) => s + n.own, 0);
  const flow = computeFlow(nodes, edges);
  ok('messy: conservation holds (productive + trapped == total)', conserved(flow, total));
  ok('messy: results sorted desc by T', flow.results.every((r, i, a) => i === 0 || a[i - 1].T >= r.T));
}

// --- 7) splitSessionTokens: shared session divides by claim-window duration --------------------
{
  const usage = { '/t/shared.jsonl': { total: 1000 }, '/t/solo.jsonl': { total: 333 } };
  const tasks = [
    { id: 's/1', transcript: '/t/shared.jsonl', window: { start: '2026-06-10T10:00:00Z', end: '2026-06-10T10:30:00Z' } }, // 30 min
    { id: 's/2', transcript: '/t/shared.jsonl', window: { start: '2026-06-10T10:30:00Z', end: '2026-06-10T10:40:00Z' } }, // 10 min
    { id: 's/3', transcript: '/t/solo.jsonl', window: { start: '2026-06-10T10:00:00Z', end: '2026-06-10T10:01:00Z' } },
    { id: 's/4', transcript: null, window: null },
  ];
  const own = splitSessionTokens(tasks, (tp) => usage[tp]);
  ok('split: 30min/10min shares → 750/250', near(own.get('s/1'), 750) && near(own.get('s/2'), 250));
  ok('split: shared total conserved across its tasks', near(own.get('s/1') + own.get('s/2'), 1000));
  ok('split: dedicated transcript keeps its full total', near(own.get('s/3'), 333));
  ok('split: unknown transcript → 0', own.get('s/4') === 0);
  // zero-length / missing windows still split (equal 1ms floors), never divide by zero
  const own2 = splitSessionTokens([
    { id: 'a', transcript: '/t/shared.jsonl', window: { start: 'x', end: 'y' } },
    { id: 'b', transcript: '/t/shared.jsonl', window: null },
  ], (tp) => usage[tp]);
  ok('split: degenerate windows fall back to equal shares', near(own2.get('a'), 500) && near(own2.get('b'), 500));
}

// --- 8) sessionCatchalls: shape, ownership, edges ----------------------------------------------
{
  const sessions = [
    { id: 'S1', total: 1000, claimed: 0 },     // produced tasks via subagents — nothing claimed its own transcript
    { id: 'S2', total: 500, claimed: 500 },    // fully claimed by task splits, but created a task → zero-own contributor
    { id: 'S3', total: 800, claimed: 0 },      // produced NOTHING — trapped tokens, named waste
    { id: 'S4', total: 0, claimed: 0 },        // empty + no outputs → no node at all
    { id: 'S5', total: 300, claimed: 400 },    // over-claimed (float drift) → floors at 0, no outputs → dropped
  ];
  const tasks = [
    { id: 'S1/1', session: 'S1' }, { id: 'S1/2', session: 'S1' },
    { id: 'S2/1', session: 'S2' },
    { id: 'note:n1', session: null },          // notes carry no session — never edged
  ];
  const ca = sessionCatchalls(sessions, tasks, 0.5);
  const ids = ca.nodes.map((n) => n.id);
  ok('catchall: one node per accountable session', ids.length === 3 && ids.includes('session:S1') && ids.includes('session:S2') && ids.includes('session:S3'));
  ok('catchall: empty/zero sessions dropped', !ids.includes('session:S4') && !ids.includes('session:S5'));
  ok('catchall: own = total − claimed, floored', near(ca.nodes.find((n) => n.id === 'session:S1').own, 1000) && near(ca.nodes.find((n) => n.id === 'session:S2').own, 0));
  ok('catchall: every node flagged kind session', ca.nodes.every((n) => n.kind === 'session' && !n.merged));
  ok('catchall: context edges to the session outputs only', ca.edges.length === 3
    && ca.edges.filter((e) => e.from === 'session:S1').length === 2
    && ca.edges.every((e) => e.weight === 0.5)
    && !ca.edges.some((e) => e.from === 'session:S3'));
}

// --- 9) catch-alls in the flow: chat lands via merged outputs; barren sessions are named waste --
{
  // S1's task merged → S1's chat tokens become productive THROUGH the task.
  // S3 produced nothing → its 800 trap as waste under the session node itself.
  const sessions = [{ id: 'S1', total: 1000, claimed: 0 }, { id: 'S3', total: 800, claimed: 0 }];
  const tasks = [{ id: 'S1/1', session: 'S1', own: 200, merged: true }];
  const ca = sessionCatchalls(sessions, tasks);
  const flow = computeFlow(
    [...tasks.map((t) => ({ id: t.id, own: t.own, merged: t.merged })), ...ca.nodes],
    ca.edges,
  );
  ok('flow: merged output claims its session chat cost (200 own + 1000 inherited)', flow.results.length === 1 && near(flow.results[0].T, 1200));
  ok('flow: barren session traps as NAMED waste', flow.waste.length === 1 && flow.waste[0].task === 'session:S3' && near(flow.waste[0].trapped, 800));
  ok('flow: conservation incl. catch-alls (results + waste == total)', conserved(flow, 2000));
}

// --- 10) conservation with catch-alls on a mixed graph (claimed splits + unclaimed remainder) ---
{
  // One shared transcript: 600 of 1000 split to two tasks, 400 left for the catch-all.
  const usage = { '/t/s.jsonl': { total: 1000 } };
  const own = splitSessionTokens([
    { id: 'S/1', transcript: '/t/s.jsonl', window: { start: '2026-06-10T10:00:00Z', end: '2026-06-10T10:30:00Z' } },
    { id: 'S/2', transcript: '/t/s.jsonl', window: { start: '2026-06-10T10:30:00Z', end: '2026-06-10T10:40:00Z' } },
  ], (tp) => usage[tp]);
  const claimed = own.get('S/1') + own.get('S/2'); // == 1000: splits claim the whole transcript
  ok('catchall+split: splits claim the full shared transcript', near(claimed, 1000));
  const ca = sessionCatchalls([{ id: 'S', total: 1000, claimed }], [{ id: 'S/1', session: 'S' }, { id: 'S/2', session: 'S' }]);
  const nodes = [
    { id: 'S/1', own: own.get('S/1'), merged: true },
    { id: 'S/2', own: own.get('S/2') },
    ...ca.nodes,
  ];
  const flow = computeFlow(nodes, ca.edges);
  ok('catchall+split: conservation exact across splits + catch-all', conserved(flow, 1000));
  ok('catchall+split: zero-own catch-all adds nothing to waste', !flow.waste.some((w) => w.task.startsWith('session:') && w.trapped > 1e-6));
}

// --- 11) task-specific usage records in a shared transcript are not collapsed ------------------
{
  const tasks = [
    { id: 'T1', transcript: '/t/shared.jsonl', window: { start: '2026-06-10T10:00:00Z', end: '2026-06-10T10:10:00Z' } },
    { id: 'T2', transcript: '/t/shared.jsonl', window: { start: '2026-06-10T10:10:00Z', end: '2026-06-10T10:20:00Z' } },
  ];
  const taskSpecific = { T1: 100, T2: 300 };
  const own = splitSessionTokens(tasks, (tp, claim) => {
    if (claim && taskSpecific[claim.id]) return { total: taskSpecific[claim.id], task_specific: true };
    return { total: 1000 };
  });
  ok('split: per-task records sharing a transcript keep their own totals', own.get('T1') === 100 && own.get('T2') === 300);

  const mixed = splitSessionTokens(tasks, (tp, claim) => {
    if (claim && claim.id === 'T1') return { total: 100, task_specific: true };
    return { total: 1000 };
  });
  ok('split: unclaimed group remainder still splits to non-specific members', mixed.get('T1') === 100 && mixed.get('T2') === 900);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
