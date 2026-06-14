#!/usr/bin/env node
// Plain Node test (no framework; matches test/autowire-note.test.js style). Run:
//   node test/autowire-weight0-promotion.test.js — exits non-zero on any failed assertion.
//
// Contract under test (task 091a4bf1.../1): autowire context edges are SEEDED at weight 0 so they are
// retrieval-INVISIBLE, and a judge keep-verdict PROMOTES them (judged:true + a real weight) so they
// re-enter ranked retrieval. The weight is a relevance MULTIPLIER: a weight-0 context edge contributes
// ZERO and is EXCLUDED from the context_deps payload (the DAG-tier injection + structural-rerank
// adjacency), not merely deprioritized. The edge stays in overlay.edges so the judge still sees it.
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');
const { autowireNewTask, autowireNoteProvider, DEFAULT_AUTOWIRE_THRESHOLD } = require('../daemon');
const TH = DEFAULT_AUTOWIRE_THRESHOLD;

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Reproduce the daemon's depRefs context-edge filter: weight is a relevance multiplier, so a weight-0
// context edge is EXCLUDED from the context_deps a consumer sees (retrieval-invisible). Blocking edges
// carry no weight and are never filtered. (daemon.js depRefs uses exactly this predicate.)
const contextDepsFor = (overlay, key) =>
  overlay.edges
    .filter((e) => e.to === key && !e.toWorkspace)
    .filter((e) => !(e.kind === 'context' && ov.edgeWeight(e) === 0))
    .filter((e) => e.kind === 'context')
    .map((e) => e.from);

// --- task->note/done autowire: seeded weight 0, EXCLUDED from ranked retrieval -------------------
{
  const overlay = ov.EMPTY();
  const done = { id: 's/1', label: 'stripe refund webhook reconciliation ledger', summary: 'reconcile stripe refund ledger entries', status: 'done', context_deps: [], deps: [] };
  const note = { id: 'note:abc', label: 'stripe refund idempotency decision', summary: 'idempotent stripe refund keys so retries never double-refund', kind: 'note', status: 'note', context_deps: [], deps: [] };
  const g = { tasks: [done, note] };
  const newTask = { id: 's/9', label: 'stripe refund pipeline retries', summary: 'idempotent stripe refund keys reconcile ledger', status: 'ready', context_deps: [], deps: [] };

  const added = autowireNewTask(overlay, g, newTask, TH);
  ok('autowire wired at least one edge', added >= 1);
  ok('every autowire edge seeded weight 0', overlay.edges.every((e) => e.weight === 0));
  ok('every autowire edge carries {by:autowire, judged:false}', overlay.edges.every((e) => e.by === 'autowire' && e.judged === false));
  ok('every autowire edge preserves recall score', overlay.edges.every((e) => typeof e.score === 'number' && e.score >= TH));

  // RETRIEVAL-INVISIBLE: weight-0 edges contribute nothing to context_deps.
  ok('weight-0 autowire edges EXCLUDED from ranked retrieval', contextDepsFor(overlay, 's/9').length === 0);
  // but JUDGE-VISIBLE: still present in overlay.edges and surfaced by the judge queue as unverified.
  const pending = overlay.edges.filter(judge.isUnverifiedEdge);
  ok('weight-0 autowire edges still visible to the judge', pending.length === overlay.edges.length && pending.length >= 1);

  // PROMOTION: a keep-verdict lifts the edge off weight 0 → it re-enters ranked retrieval.
  const e0 = overlay.edges[0];
  const promotedW = e0.score; // keepEdge seeds weight from the preserved recall score
  ok('keepEdge promotes the edge', judge.keepEdge(overlay, e0.from, e0.to));
  const promoted = overlay.edges.find((e) => e.from === e0.from && e.to === e0.to);
  ok('promoted edge is judged:true by judge', promoted.judged === true && promoted.by === 'judge');
  ok('promoted edge weight seeded from recall score', promoted.weight === promotedW && promoted.weight > 0);
  ok('promoted edge now APPEARS in ranked retrieval', contextDepsFor(overlay, 's/9').includes(e0.from));
}

// --- note->task autowire (autowireNoteProvider): same seed-0 → promote contract -----------------
{
  const overlay = ov.EMPTY();
  const openA = { id: 't/1', label: 'build payment refund pipeline', summary: 'stripe refund webhook handler', status: 'ready', context_deps: [], deps: [] };
  const g = { tasks: [openA] };
  const NOTE = 'note:refund-x';
  autowireNoteProvider(overlay, g, NOTE, 'refund pipeline idempotency decision', 'idempotent stripe refund keys retries', null, TH);

  ok('note-provider autowire seeded weight 0', overlay.edges.length >= 1 && overlay.edges.every((e) => e.weight === 0));
  ok('note-provider edge EXCLUDED from consumer retrieval', contextDepsFor(overlay, 't/1').length === 0);

  const e = overlay.edges.find((x) => x.to === 't/1');
  judge.keepEdge(overlay, e.from, e.to);
  ok('promoted note-provider edge APPEARS in consumer retrieval', contextDepsFor(overlay, 't/1').includes(NOTE));
}

// --- keepEdge fallback default when no recall score is preserved --------------------------------
{
  const overlay = ov.EMPTY();
  // Legacy/migrated unverified edge with weight 0 but NO preserved score.
  ov.addEdge(overlay, 'note:legacy', 'x/1', null, 'context', 0, { by: 'autowire', judged: false });
  ok('legacy unverified edge has no score field', overlay.edges[0].score === undefined);
  judge.keepEdge(overlay, 'note:legacy', 'x/1');
  ok('keepEdge falls back to a fixed promoted default (>0)', overlay.edges[0].weight > 0);
}

// --- hand-asserted edges are NOT zeroed (reasoned assertions keep their weight) -----------------
{
  const overlay = ov.EMPTY();
  ov.addEdge(overlay, 'note:asserted', 'y/1', null, 'context', 0.7); // add_dependency-style, explicit weight, no autowire meta
  ok('hand-asserted edge keeps its explicit weight', overlay.edges[0].weight === 0.7);
  ok('hand-asserted edge is retrieval-visible', contextDepsFor(overlay, 'y/1').includes('note:asserted'));
  ok('hand-asserted edge is NOT an unverified autowire edge', !judge.isUnverifiedEdge(overlay.edges[0]));
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
