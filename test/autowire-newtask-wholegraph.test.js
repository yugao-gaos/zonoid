#!/usr/bin/env node
// Plain Node test (no framework; matches test/autowire-note.test.js style) for the CREATION-TIME
// whole-graph wiring recall — autowireNewTaskWholeGraph in daemon.js. Run:
//   node test/autowire-newtask-wholegraph.test.js   (exits non-zero on any failed assertion)
//
// THE GOAL: a brand-new anchor task that is semantically near BOTH an existing NOTE and an existing
// TASK gets weight-0, judged:false candidate edges to BOTH kinds — retrieval-invisible until the
// neighborhood-aware judge promotes them. Direction contract:
//   - NOTE candidate → note is PROVIDER ⇒ edge note -> anchor (mirrors autowireNoteProvider).
//   - TASK candidate → anchor is PROVIDER ⇒ edge anchor -> task (so the judge's taskTask path fires).
// DONE tasks are eligible providers. No lexical autowire edge: every seeded edge carries
// origin:'autowire-semantic' (by:'autowire', judged:false, weight 0). Fan-out capped per kind.
//
// These fixtures carry NO vecs, so scoreMatchesSemantic falls back PER-CANDIDATE to lexical token
// overlap — exactly what lets us assert wiring mechanics on a known scale. We thread an explicit
// lexical-scale bar (0.25), since the function's own default is the higher semantic cosine bar.
'use strict';
const ov = require('../lib/overlay');
const { autowireNewTaskWholeGraph } = require('../daemon');
const TH = 0.25; // lexical-scale bar for these vec-less fixtures

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Graph: an existing NOTE and an existing (DONE) TASK both about the SAME subject as the new anchor,
// plus an unrelated task that must stay below threshold.
const relatedNote = { id: 'note:refund-idem', label: 'refund pipeline idempotency decision', summary: 'use idempotent stripe refund keys so retries never double-refund', kind: 'note', status: 'note', context_deps: [], deps: [] };
const relatedDone = { id: 's/1', label: 'build stripe refund pipeline webhook', summary: 'refund pipeline stripe webhook handler', status: 'done', context_deps: [], deps: [] };
const relatedOpen = { id: 's/2', label: 'refund pipeline metrics dashboard', summary: 'stripe refund pipeline metrics widget', status: 'ready', context_deps: [], deps: [] };
const unrelated   = { id: 's/3', label: 'rotate database credentials quarterly', summary: 'vault rotation cron', status: 'ready', context_deps: [], deps: [] };

const g = { tasks: [relatedNote, relatedDone, relatedOpen, unrelated] };
const ANCHOR = 's/anchor';
const TITLE = 'refund pipeline retry safety task';
const SUMMARY = 'ensure stripe refund pipeline retries are idempotent and never double-refund';

// autowireNewTaskWholeGraph is async (it may await the cross-encoder when ORCH_RERANK is on; here
// the flag is unset so the sync cosine path runs, just returned via a Promise). Wrap in an async IIFE.
(async () => {
// --- anchor gets candidate edges to BOTH a note AND a task ---------------------------------------
{
  const overlay = ov.EMPTY();
  const added = await autowireNewTaskWholeGraph(overlay, g, ANCHOR, TITLE, SUMMARY, null, TH);
  ok('seeded at least 2 edges (note + task)', added >= 2);

  const noteEdge = overlay.edges.find((e) => e.from === 'note:refund-idem' && e.to === ANCHOR);
  ok('NOTE candidate: edge note -> anchor (note is provider)', !!noteEdge);

  const doneEdge = overlay.edges.find((e) => e.from === ANCHOR && e.to === 's/1');
  ok('TASK candidate: edge anchor -> done task (anchor is provider)', !!doneEdge);
  ok('DONE task IS an eligible provider', !!doneEdge);

  const openEdge = overlay.edges.find((e) => e.from === ANCHOR && e.to === 's/2');
  ok('TASK candidate: edge anchor -> open task', !!openEdge);

  // unrelated stays out (below threshold)
  ok('unrelated task NOT wired', !overlay.edges.some((e) => e.to === 's/3' || e.from === 's/3'));

  // EVERY seeded edge is a weight-0, judged:false, semantic-origin candidate (retrieval-invisible).
  ok('all edges kind:context', overlay.edges.every((e) => e.kind === 'context'));
  ok('all edges weight 0 (retrieval-invisible)', overlay.edges.every((e) => e.weight === 0));
  ok('all edges by:autowire', overlay.edges.every((e) => e.by === 'autowire'));
  ok('all edges judged:false (surface on /judge/next)', overlay.edges.every((e) => e.judged === false));
  ok('all edges origin:autowire-semantic (NO lexical autowire)', overlay.edges.every((e) => e.origin === 'autowire-semantic'));
  ok('NO edge tagged autowire-lexical', !overlay.edges.some((e) => e.origin === 'autowire-lexical'));
  ok('every edge preserves cosine in score', overlay.edges.every((e) => typeof e.score === 'number'));

  // The task->task candidate has the anchor as `from` and a task as `to` ⇒ the judge classifies
  // taskTask=true (neither endpoint is a note:) and runs the kind/dup path.
  const taskTaskEdges = overlay.edges.filter((e) => !String(e.from).startsWith('note:') && !String(e.to).startsWith('note:'));
  ok('task->task candidate exists for judge taskTask path', taskTaskEdges.length >= 1);
  ok('task->task candidate has anchor as provider (from)', taskTaskEdges.every((e) => e.from === ANCHOR));
}

// --- idempotent: a second run adds nothing (addEdge dedupes) --------------------------------------
{
  const overlay = ov.EMPTY();
  await autowireNewTaskWholeGraph(overlay, g, ANCHOR, TITLE, SUMMARY, null, TH);
  const before = overlay.edges.length;
  const addedAgain = await autowireNewTaskWholeGraph(overlay, g, ANCHOR, TITLE, SUMMARY, null, TH);
  ok('re-run is idempotent (0 new edges)', addedAgain === 0);
  ok('edge count unchanged on re-run', overlay.edges.length === before);
}

// --- fan-out cap per kind (5 notes + 5 tasks max) -------------------------------------------------
{
  const many = { tasks: [] };
  for (let i = 0; i < 8; i++) many.tasks.push({ id: 'note:n' + i, label: 'refund pipeline note ' + i, summary: 'stripe refund pipeline idempotency note ' + i, kind: 'note', status: 'note', context_deps: [], deps: [] });
  for (let i = 0; i < 8; i++) many.tasks.push({ id: 't/' + i, label: 'refund pipeline task ' + i, summary: 'stripe refund pipeline retry task ' + i, status: 'ready', context_deps: [], deps: [] });
  const overlay = ov.EMPTY();
  await autowireNewTaskWholeGraph(overlay, many, ANCHOR, TITLE, SUMMARY, null, TH);
  const noteEdges = overlay.edges.filter((e) => String(e.from).startsWith('note:'));
  const taskEdges = overlay.edges.filter((e) => e.from === ANCHOR);
  ok('note fan-out capped at 5', noteEdges.length <= 5);
  ok('task fan-out capped at 5', taskEdges.length <= 5);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
})();
