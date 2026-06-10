#!/usr/bin/env node
// Plain Node test for auto-wiring a NOTE as a context PROVIDER in daemon.js (no framework; matches
// test/autowire.test.js style). Run: node test/autowire-note.test.js — exits non-zero on any failed
// assertion. Covers: a new note overlapping open tasks gets note->neighbor context edges (weight ==
// relevance score); `done` neighbors are skipped; note->note IS allowed (a note may receive an
// incoming edge from another note — the knowledge-web rule); the note is always `from`; fan-out is
// capped at 5; re-wiring is idempotent; the threshold knob suppresses weak matches.
//
// Scoring is now SEMANTIC (scoreMatchesSemantic) but falls back PER-CANDIDATE to lexical token
// overlap when a vec is missing. These fixtures carry NO vecs, so every score here is the lexical
// fallback — which is exactly what lets us assert the wiring mechanics on the lexical scale. We
// thread the lexical-scale DEFAULT_AUTOWIRE_THRESHOLD (0.25) explicitly, since the function's own
// default is now the higher semantic bar (SEMANTIC_AUTOWIRE_THRESHOLD) tuned for cosine scores.
'use strict';
const ov = require('../lib/overlay');
const { scoreMatchesSemantic, autowireNoteProvider, DEFAULT_AUTOWIRE_THRESHOLD } = require('../daemon');
const TH = DEFAULT_AUTOWIRE_THRESHOLD; // 0.25 lexical-scale bar for these vec-less fixtures

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// A graph with: two OPEN tasks overlapping the note (must be auto-wired as consumers), one DONE task
// overlapping (must be SKIPPED — feeding context into finished work is useless), one unrelated task.
const openA     = { id: 's/1', label: 'build payment refund pipeline', summary: 'stripe refund webhook handler', status: 'ready', context_deps: [], deps: [] };
const openB     = { id: 's/2', label: 'payment refund dashboard widget', summary: 'refund pipeline metrics', status: 'in_progress', context_deps: [], deps: [] };
const doneTask  = { id: 's/3', label: 'refund pipeline reconciliation job', summary: 'reconcile stripe refund ledger', status: 'done', context_deps: [], deps: [] };
const unrelated = { id: 's/4', label: 'rotate database credentials quarterly', summary: 'vault rotation cron', status: 'ready', context_deps: [], deps: [] };
// Another NOTE overlapping the target — now ALLOWED as a target: a note MAY receive an incoming
// context edge from another note (notes knit into a navigable knowledge web). The note is still the
// PROVIDER/`from`; this asserts the reversed rule (incoming edges onto notes are permitted).
const otherNote = { id: 'note:other', label: 'refund pipeline retry policy', summary: 'idempotent stripe refund keys decision', kind: 'note', status: 'note', context_deps: [], deps: [] };

const g = { tasks: [openA, openB, doneTask, unrelated, otherNote] };
const NOTE = 'note:refund-x';
const TITLE = 'refund pipeline idempotency decision';
const SUMMARY = 'use idempotent stripe refund keys so retries never double-refund';

// --- note auto-wires as a PROVIDER: note -> neighbor context edges (weight == score) -------------
{
  const overlay = ov.EMPTY();
  const matches = scoreMatchesSemantic(g, { id: NOTE, label: TITLE, summary: SUMMARY, deps: [], context_deps: [] }, null);
  const added = autowireNoteProvider(overlay, g, NOTE, TITLE, SUMMARY, null, TH);
  ok('note auto-wired at least one provider edge', added >= 1);

  // EVERY edge is note -> neighbor (note is `from`), context kind. The note never receives an edge
  // INTO ITSELF, but it MAY now point AT another note (note->note).
  ok('all auto edges are context', overlay.edges.every((e) => e.kind === 'context'));
  ok('all auto edges originate FROM the note', overlay.edges.every((e) => e.from === NOTE));
  ok('no edge points INTO the target note itself', !overlay.edges.some((e) => e.to === NOTE));

  const tos = new Set(overlay.edges.map((e) => e.to));
  ok('open task A wired as consumer', tos.has('s/1'));
  ok('open task B wired as consumer', tos.has('s/2'));
  ok('DONE task skipped (no note->done edge)', !tos.has('s/3'));
  ok('unrelated task NOT wired (below threshold)', !tos.has('s/4'));
  ok('other NOTE wired as consumer (note->note now allowed)', tos.has('note:other'));

  // weight stored on each edge equals that match's relevance score
  const scoreOf = (key) => matches.find((m) => m.key === key).score;
  ok('edge weight == relevance score', overlay.edges.every((e) => e.weight === scoreOf(e.to)));
  ok('every auto edge weight >= threshold', overlay.edges.every((e) => e.weight >= TH));

  // --- idempotent: re-wiring adds no new edges ---
  const before = overlay.edges.length;
  const added2 = autowireNoteProvider(overlay, g, NOTE, TITLE, SUMMARY, null, TH);
  ok('re-wiring adds zero edges', added2 === 0);
  ok('edge count unchanged after re-wire', overlay.edges.length === before);
}

// --- a note with no token overlap wires nothing ---
{
  const overlay = ov.EMPTY();
  const added = autowireNoteProvider(overlay, g, 'note:novel', 'airline mileage redemption portal', 'frequent flyer kiosk theme', null, TH);
  ok('novel note wires nothing', added === 0 && overlay.edges.length === 0);
}

// --- threshold knob suppresses weak matches ---
{
  const overlay = ov.EMPTY();
  const added = autowireNoteProvider(overlay, g, NOTE, TITLE, SUMMARY, null, 0.99);
  ok('threshold=0.99 suppresses all auto edges', added === 0 && overlay.edges.length === 0);
}

// --- fan-out cap: a note overlapping many open tasks wires at most 5 ---
{
  const overlay = ov.EMPTY();
  const many = [];
  for (let i = 0; i < 12; i++) many.push({ id: `m/${i}`, label: 'refund pipeline stripe webhook handler', summary: 'refund idempotent keys retries', status: 'ready', context_deps: [], deps: [] });
  const gMany = { tasks: many };
  const added = autowireNoteProvider(overlay, gMany, NOTE, TITLE, SUMMARY, null, TH);
  ok('fan-out capped at 5', added === 5 && overlay.edges.length === 5);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
