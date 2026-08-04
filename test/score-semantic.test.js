#!/usr/bin/env node
// Plain Node test (no framework; matches test/embed.test.js style) for scoreMatchesSemantic in
// daemon.js — the SEMANTIC scorer behind note auto-wiring. Run: node test/score-semantic.test.js —
// exits non-zero on any failed assertion.
//
// scoreMatchesSemantic(g, target, targetVec) scores each candidate by cosine(targetVec, x.vec) when
// BOTH carry a vector, and falls back PER-CANDIDATE to lexical token overlap when either vec is
// missing. We use SYNTHETIC vectors (no model needed — pure cosine math) so the test is fast and
// deterministic, asserting exactly the three regimes the design hinges on:
//   1. near-parallel target/candidate vecs  -> high semantic score, candidate kept (via=semantic)
//   2. orthogonal vecs                       -> cosine 0 -> candidate filtered out (no edge)
//   3. candidate MISSING a vec               -> lexical fallback for THAT candidate (via=lexical)
'use strict';
const { scoreMatchesSemantic, autowireNoteProvider, SEMANTIC_AUTOWIRE_THRESHOLD } = require('../daemon');
const ov = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Synthetic 4-dim vectors (cosine doesn't care about dimensionality). Unit basis + a tilt.
const eX = [1, 0, 0, 0];
const eY = [0, 1, 0, 0];
const nearX = [0.98, 0.20, 0, 0];   // ~11.5° off eX -> cosine ~0.98 (well above the semantic bar)
const tiltX = [0.80, 0.60, 0, 0];   // ~36.9° off eX -> cosine 0.80

// target note carries eX. Three candidates: near-parallel, orthogonal, and a vec-less one whose
// text strongly lexically overlaps the target (so the lexical fallback fires for it).
const targetVec = eX;
const TITLE = 'refund pipeline idempotency decision';
const SUMMARY = 'idempotent stripe refund keys so retries never double-refund';

const parallel  = { id: 's/par', label: 'unrelated words here', summary: 'totally different prose', status: 'ready', kind: 'task', vec: nearX, context_deps: [], deps: [] };
const orthog    = { id: 's/ortho', label: 'refund pipeline idempotency', summary: 'idempotent stripe refund keys', status: 'ready', kind: 'task', vec: eY, context_deps: [], deps: [] };
const tilted    = { id: 's/tilt', label: 'nothing in common', summary: 'no shared tokens at all', status: 'ready', kind: 'task', vec: tiltX, context_deps: [], deps: [] };
const novec     = { id: 's/lex', label: 'refund pipeline idempotency decision', summary: 'idempotent stripe refund keys retries', status: 'ready', kind: 'task', vec: null, context_deps: [], deps: [] };

const g = { tasks: [parallel, orthog, tilted, novec] };
const target = { id: 'note:t', label: TITLE, summary: SUMMARY, deps: [], context_deps: [] };
const scored = scoreMatchesSemantic(g, target, targetVec);
const by = (k) => scored.find((m) => m.key === k);

// 1. near-parallel: high semantic score, ranks top, via=semantic
ok('near-parallel candidate scored semantically', by('s/par') && by('s/par').via === 'semantic');
ok('near-parallel cosine ~0.98 (high)', by('s/par') && Math.abs(by('s/par').score - 0.98) < 0.02);
ok('near-parallel is the top match', scored[0] && scored[0].key === 's/par');

// 2. orthogonal: cosine 0 -> filtered out entirely (score > 0 filter drops it), DESPITE huge lexical overlap
ok('orthogonal candidate dropped (cosine 0, no edge) even with lexical overlap', !by('s/ortho'));

// 3. tilted: cosine 0.80 semantic, present
ok('tilted candidate scored semantically ~0.80', by('s/tilt') && by('s/tilt').via === 'semantic' && Math.abs(by('s/tilt').score - 0.80) < 0.02);

// 4. vec-less candidate: lexical fallback for THAT candidate, via=lexical, score > 0
ok('vec-less candidate falls back to lexical (via=lexical)', by('s/lex') && by('s/lex').via === 'lexical');
ok('vec-less candidate still scores > 0 (not dropped)', by('s/lex') && by('s/lex').score > 0);

// 5. targetVec null -> EVERY candidate falls back to lexical (no semantic anywhere)
const lexAll = scoreMatchesSemantic(g, target, null);
ok('null targetVec -> all candidates lexical', lexAll.length > 0 && lexAll.every((m) => m.via === 'lexical'));

// 6. autowireNoteProvider with these vecs at the semantic bar keeps only above-threshold matches.
{
  const overlay = ov.EMPTY();
  const added = autowireNoteProvider(overlay, g, 'note:t', TITLE, SUMMARY, targetVec, SEMANTIC_AUTOWIRE_THRESHOLD);
  const tos = new Set(overlay.edges.map((e) => e.to));
  ok('autowire keeps near-parallel (semantic >= bar)', tos.has('s/par'));
  ok('autowire drops orthogonal (cosine 0)', !tos.has('s/ortho'));
  ok('autowire: every edge is note->candidate, context', overlay.edges.every((e) => e.from === 'note:t' && e.kind === 'context'));
  // tilted at 0.80 is above the 0 bar (floor dropped) -> kept; novec lexical score also high -> kept; cap 5 not hit.
  ok('autowire keeps tilted (0.80 >= bar)', tos.has('s/tilt'));
}

// 7. P2 regression: sub-0.55 candidate is NOW seeded (floor dropped to 0; eager-judge arbitrates).
//    Before P2 the 0.55 floor silently filtered cosine=0.50 nodes; now they reach /judge/next.
//    halfX has cosine(eX, halfX) = 0.50 — sub-0.55 but > 0, so score>0 survives, floor=0 keeps it.
{
  const halfX = [0.5, 0.866, 0, 0];  // cosine(eX, halfX) = 0.50 — sub-0.55, above 0
  const subFloor = { id: 's/sub055', label: 'nothing in common', summary: 'no shared tokens at all', status: 'ready', kind: 'task', vec: halfX, context_deps: [], deps: [] };
  const gSub = { tasks: [subFloor] };
  // Verify cosine value is sub-0.55
  const scoredSub = scoreMatchesSemantic(gSub, target, targetVec);
  const subMatch = scoredSub.find((m) => m.key === 's/sub055');
  ok('sub-0.55 candidate has cosine between 0 and 0.55', subMatch && subMatch.score > 0 && subMatch.score < 0.55);

  // With old 0.55 floor: autowireNoteProvider(overlay, gSub, ..., 0.55) would seed 0 edges.
  const overlayOld = ov.EMPTY();
  const addedOld = autowireNoteProvider(overlayOld, gSub, 'note:t', TITLE, SUMMARY, targetVec, 0.55);
  ok('sub-0.55 candidate was filtered by old 0.55 floor (no edge seeded)', addedOld === 0);

  // With new floor=0 (SEMANTIC_AUTOWIRE_THRESHOLD): the candidate is seeded for the eager-judge.
  const overlayNew = ov.EMPTY();
  const addedNew = autowireNoteProvider(overlayNew, gSub, 'note:t', TITLE, SUMMARY, targetVec, SEMANTIC_AUTOWIRE_THRESHOLD);
  ok('sub-0.55 candidate NOW seeded with floor=0 (eager-judge arbitrates)', addedNew === 1);
  ok('seeded sub-0.55 edge is weight-0 (retrieval-invisible until judge)', overlayNew.edges.length === 1 && overlayNew.edges[0].weight === 0);
  ok('seeded sub-0.55 edge carries judged:false (surfaces on /judge/next)', overlayNew.edges[0].judged === false);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
