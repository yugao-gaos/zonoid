#!/usr/bin/env node
// Plain Node test for the periodic orphan-note sweep in daemon.js (no framework; matches
// test/autowire-note.test.js / test/self-heal.test.js style). Run: node test/orphan-sweep.test.js —
// exits non-zero on any failed assertion.
//
// sweepOrphanNotes() itself reads daemon `state` (workspace overlay + buildGraph), so this test
// exercises its PURE core — the orphan-selection predicate + the per-orphan autowireNoteProvider
// replay — over a synthetic (overlay, graph). This is the same modeling approach self-heal.test.js
// uses for the liveness sweeps. The property under test, per the design: RE-CHECK every CURRENT
// note that sits in ZERO overlay edges; an orphan with a >=0.25 neighbor gains exactly one edge,
// a truly-independent orphan gains none and triggers no write.
'use strict';
const ov = require('../lib/overlay');
const { autowireNoteProvider, DEFAULT_AUTOWIRE_THRESHOLD } = require('../daemon');
const TH = DEFAULT_AUTOWIRE_THRESHOLD; // these fixtures carry no vecs ⇒ lexical fallback ⇒ lexical bar

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// The sweep's exact selection + replay, factored as a pure function over (overlay, g) so it can be
// asserted without daemon state. Mirrors sweepOrphanNotes: CURRENT notes (kind==='note', validTo
// null) with zero edges (neither from nor to) are replayed through autowireNoteProvider; total
// edges added is returned; the caller persists IFF total > 0. Live sweepOrphanNotes passes node.vec
// and the semantic default threshold; here the fixtures have no vecs (lexical fallback), so we pass
// the lexical-scale DEFAULT_AUTOWIRE_THRESHOLD to exercise the selection mechanics on that scale.
function sweepCore(overlay, g) {
  const touched = new Set();
  for (const e of overlay.edges) { touched.add(e.from); touched.add(e.to); }
  let added = 0;
  for (const node of g.tasks) {
    if (node.kind !== 'note' || node.validTo != null) continue;
    if (touched.has(node.id)) continue;
    added += autowireNoteProvider(overlay, g, node.id, node.label, node.summary, node.vec, TH);
  }
  return added;
}

// Graph: one open task the note overlaps (the future neighbor), plus the two note nodes themselves.
const openTask  = { id: 's/1', label: 'build payment refund pipeline', summary: 'stripe refund webhook handler', status: 'ready', context_deps: [], deps: [] };
// orphanWithNeighbor overlaps openTask strongly (>=0.25) — should gain exactly one edge this sweep.
const orphanNbr = { id: 'note:nbr', label: 'refund pipeline idempotency decision', summary: 'use idempotent stripe refund keys so retries never double-refund', kind: 'note', status: 'note', validTo: null, context_deps: [], deps: [] };
// orphanIndependent overlaps nothing — should stay orphaned, zero edges, zero writes.
const orphanInd = { id: 'note:ind', label: 'airline mileage redemption portal', summary: 'frequent flyer kiosk theme', kind: 'note', status: 'note', validTo: null, context_deps: [], deps: [] };

// --- mixed sweep: neighbor-orphan wires once, independent-orphan wires nothing -----------------
{
  const overlay = ov.EMPTY();
  const g = { tasks: [openTask, orphanNbr, orphanInd] };
  const added = sweepCore(overlay, g);
  ok('sweep adds exactly one edge (only the orphan with a neighbor)', added === 1);
  ok('the edge is note:nbr -> s/1, context', overlay.edges.length === 1 && overlay.edges[0].from === 'note:nbr' && overlay.edges[0].to === 's/1' && overlay.edges[0].kind === 'context');
  ok('independent orphan wired nothing (no edge touches note:ind)', !overlay.edges.some((e) => e.from === 'note:ind' || e.to === 'note:ind'));

  // re-check is idempotent: note:nbr now has an edge ⇒ no longer an orphan; note:ind re-checked, still 0.
  const added2 = sweepCore(overlay, g);
  ok('second sweep adds zero edges (wired note skipped, independent stays 0)', added2 === 0 && overlay.edges.length === 1);
}

// --- truly-independent-only sweep performs no write (added === 0) ------------------------------
{
  const overlay = ov.EMPTY();
  const g = { tasks: [openTask, orphanInd] };
  const added = sweepCore(overlay, g);
  ok('independent-only sweep returns 0 (caller skips save)', added === 0 && overlay.edges.length === 0);
}

// --- a SUPERSEDED note (validTo set) is NOT re-wired even if orphaned ---------------------------
{
  const overlay = ov.EMPTY();
  const retired = { ...orphanNbr, id: 'note:old', validTo: '2026-01-01T00:00:00.000Z' };
  const g = { tasks: [openTask, retired] };
  const added = sweepCore(overlay, g);
  ok('superseded (validTo!=null) orphan note is skipped', added === 0 && overlay.edges.length === 0);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
