#!/usr/bin/env node
// Unit tests for seedBlockingDepContext (task d42ebe37-ee9f-46b6-ae21-f6f82464d482/15).
// Verifies that blocking-dep prerequisite knowledge auto-seeds as low-weight context edges,
// with gate-transparent logic: gate→A → seed gate's predecessors→A instead.
//
// Run: node test/blocking-dep-context-seed.test.js
// No framework; no port binding; no daemon spawn.
'use strict';

// --- embed stub (avoids sidecar dependency when daemon.js loads) ---------------------------------
const DIMS = 384;
const embedStub = {
  embed: async () => null,
  cosine: () => 0,
  nodeVecs: () => [],
  maxCosine: () => 0,
  embedStatus: () => ({ ready: false, disabled: true }),
  ping: async () => ({ ok: false }),
  MODEL: 'stub',
  DIMS,
};
const embedPath = require.resolve('../lib/embed');
require.cache[embedPath] = { id: embedPath, filename: embedPath, loaded: true, exports: embedStub };

const ov = require('../lib/overlay');
const { seedBlockingDepContext } = require('../daemon');

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
}

// ── SECTION 1: Basic blocking-dep seed (A blocked_by B → context edge B→A) ─────────────────────
{
  const overlay = ov.EMPTY();

  // Tasks: B (prerequisite) and A (blocked task)
  const g = {
    tasks: [
      { id: 'sess/B', label: 'Task B', status: 'done', kind: undefined, deps: [], context_deps: [] },
      { id: 'sess/A', label: 'Task A', status: 'pending', kind: undefined, deps: [], context_deps: [] },
    ],
  };

  // Add blocking edge B→A to the overlay
  ov.addEdge(overlay, 'sess/B', 'sess/A', null, 'blocking', null, { origin: 'asserted' });

  // Call seedBlockingDepContext with the pre-built graph
  seedBlockingDepContext(overlay, '/fake/ws', 'sess/A', g);

  // Expect a context edge B→A with weight 0, judged:false, origin:'blocking-dep-seed'
  const ctxEdges = overlay.edges.filter((e) => e.kind === 'context' && e.from === 'sess/B' && e.to === 'sess/A');
  ok('1.1: context edge B→A was seeded', ctxEdges.length === 1);
  ok('1.2: seeded edge has weight 0', ctxEdges[0] && ctxEdges[0].weight === 0);
  ok('1.3: seeded edge has judged:false', ctxEdges[0] && ctxEdges[0].judged === false);
  ok('1.4: seeded edge has origin:blocking-dep-seed', ctxEdges[0] && ctxEdges[0].origin === 'blocking-dep-seed');
  ok('1.5: seeded edge has by:autowire-blockdep', ctxEdges[0] && ctxEdges[0].by === 'autowire-blockdep');
}

// ── SECTION 2: Idempotency — calling seed twice does not duplicate the edge ──────────────────────
{
  const overlay = ov.EMPTY();

  const g = {
    tasks: [
      { id: 'sess/B', label: 'Task B', status: 'done', kind: undefined, deps: [], context_deps: [] },
      { id: 'sess/A', label: 'Task A', status: 'pending', kind: undefined, deps: [], context_deps: [] },
    ],
  };

  ov.addEdge(overlay, 'sess/B', 'sess/A', null, 'blocking', null, { origin: 'asserted' });
  seedBlockingDepContext(overlay, '/fake/ws', 'sess/A', g);
  const countAfter1 = overlay.edges.filter((e) => e.kind === 'context').length;
  seedBlockingDepContext(overlay, '/fake/ws', 'sess/A', g);
  const countAfter2 = overlay.edges.filter((e) => e.kind === 'context').length;

  ok('2.1: second call does not duplicate context edge (addEdge dedupes)', countAfter1 === countAfter2);
}

// ── SECTION 3: Gate-transparent — A blocked_by gate, gate blocked_by B → B→A (no gate→A) ────────
{
  const overlay = ov.EMPTY();

  // Tasks: real dep B, gate G (kind='gate'), and target A
  const g = {
    tasks: [
      { id: 'sess/B',   label: 'Task B',   status: 'done',    kind: 'task', deps: [], context_deps: [] },
      { id: 'gate:G',   label: 'Gate G',   status: 'pending', kind: 'gate', deps: [], context_deps: [] },
      { id: 'sess/A',   label: 'Task A',   status: 'pending', kind: 'task', deps: [], context_deps: [] },
    ],
  };

  // Blocking structure: B→gate:G→A (A is blocked by gate, gate is blocked by B)
  ov.addEdge(overlay, 'sess/B',  'gate:G', null, 'blocking', null, { origin: 'asserted' });
  ov.addEdge(overlay, 'gate:G',  'sess/A', null, 'blocking', null, { origin: 'asserted' });

  seedBlockingDepContext(overlay, '/fake/ws', 'sess/A', g);

  const ctxEdgesBA = overlay.edges.filter((e) => e.kind === 'context' && e.from === 'sess/B' && e.to === 'sess/A');
  const ctxEdgesGA = overlay.edges.filter((e) => e.kind === 'context' && e.from === 'gate:G' && e.to === 'sess/A');

  ok('3.1: gate-transparent: B→A context edge is seeded', ctxEdgesBA.length === 1);
  ok('3.2: gate-transparent: no gate→A context edge (gate is skipped)', ctxEdgesGA.length === 0);
  ok('3.3: gate-transparent: B→A edge has correct origin', ctxEdgesBA[0] && ctxEdgesBA[0].origin === 'blocking-dep-seed');
}

// ── SECTION 4: Gate tasks themselves do not receive context seeds ─────────────────────────────────
{
  const overlay = ov.EMPTY();

  const g = {
    tasks: [
      { id: 'sess/B', label: 'Task B', status: 'done', kind: 'task', deps: [], context_deps: [] },
      { id: 'gate:G', label: 'Gate G', status: 'pending', kind: 'gate', deps: [], context_deps: [] },
    ],
  };

  // B blocks gate:G — but gate should NOT receive a seed
  ov.addEdge(overlay, 'sess/B', 'gate:G', null, 'blocking', null, { origin: 'asserted' });

  seedBlockingDepContext(overlay, '/fake/ws', 'gate:G', g);

  const ctxEdges = overlay.edges.filter((e) => e.kind === 'context');
  ok('4.1: gate tasks do not receive context seeds', ctxEdges.length === 0);
}

// ── SECTION 5: Multiple blocking deps → multiple context edges seeded ─────────────────────────────
{
  const overlay = ov.EMPTY();

  const g = {
    tasks: [
      { id: 'sess/B1', label: 'Task B1', status: 'done',    kind: 'task', deps: [], context_deps: [] },
      { id: 'sess/B2', label: 'Task B2', status: 'done',    kind: 'task', deps: [], context_deps: [] },
      { id: 'sess/A',  label: 'Task A',  status: 'pending', kind: 'task', deps: [], context_deps: [] },
    ],
  };

  ov.addEdge(overlay, 'sess/B1', 'sess/A', null, 'blocking', null, { origin: 'asserted' });
  ov.addEdge(overlay, 'sess/B2', 'sess/A', null, 'blocking', null, { origin: 'asserted' });

  seedBlockingDepContext(overlay, '/fake/ws', 'sess/A', g);

  const ctxEdges = overlay.edges.filter((e) => e.kind === 'context' && e.to === 'sess/A');
  ok('5.1: both B1→A and B2→A context edges seeded', ctxEdges.length === 2);
  ok('5.2: B1→A edge present', ctxEdges.some((e) => e.from === 'sess/B1'));
  ok('5.3: B2→A edge present', ctxEdges.some((e) => e.from === 'sess/B2'));
}

// ── SECTION 6: Guard — null overlay or empty taskId returns without throwing ──────────────────────
{
  let threw = false;
  try { seedBlockingDepContext(null, '/fake/ws', 'sess/A', { tasks: [] }); } catch { threw = true; }
  ok('6.1: null overlay does not throw', !threw);

  threw = false;
  try { seedBlockingDepContext(ov.EMPTY(), '/fake/ws', '', { tasks: [] }); } catch { threw = true; }
  ok('6.2: empty taskId does not throw', !threw);

  threw = false;
  try { seedBlockingDepContext(ov.EMPTY(), '/fake/ws', null, { tasks: [] }); } catch { threw = true; }
  ok('6.3: null taskId does not throw', !threw);
}

// ── SECTION 7: Task not found in graph — no seeds, no throw ──────────────────────────────────────
{
  const overlay = ov.EMPTY();
  const g = { tasks: [] }; // empty graph — taskId not in it

  ov.addEdge(overlay, 'sess/B', 'sess/A', null, 'blocking', null, { origin: 'asserted' });

  let threw = false;
  try { seedBlockingDepContext(overlay, '/fake/ws', 'sess/A', g); } catch { threw = true; }

  const ctxEdges = overlay.edges.filter((e) => e.kind === 'context');
  ok('7.1: unknown taskId does not throw', !threw);
  ok('7.2: unknown taskId seeds no context edges', ctxEdges.length === 0);
}

// ── Summary ──────────────────────────────────────────────────────────────────────────────────────
console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
