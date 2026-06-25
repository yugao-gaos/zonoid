#!/usr/bin/env node
// Plain Node test (no framework; matches test/autowire-newtask-wholegraph.test.js style) for the
// UNIFIED INGEST FUNNEL — ingestNode() in daemon.js (BUILD1 of the node-lifecycle unification,
// design note:note-mqeapqae6jf). Run:
//   node test/ingest-node.test.js   (exits non-zero on any failed assertion)
//
// THE GOAL: ingestNode is the ONE path a node passes through at BIRTH — embed → setTaskVec →
// autowireNewTaskWholeGraph (seed weight-0 candidate edges) → markEagerJudge (stamp judgingSince).
// Previously these four steps fired ONLY lazily inside /overlay/status on the first vec, so a native
// task could reach ready/dispatch with NO vec, NO candidate edges, and NO eager mark. ingestNode makes
// the funnel callable at creation time so the judging→ready D-gate covers every lane uniformly.
//
// We pre-seed require.cache for lib/embed with a DETERMINISTIC stub so the test is offline (no sidecar)
// and the vec is reproducible — the assertion is about the FUNNEL mechanics (vec set + candidate edges
// + eager mark), not about embedding quality. A unit-vector keyed on token overlap gives the related
// note a high cosine and the unrelated task a low one, so autowire seeds exactly the expected edge.
'use strict';
const path = require('path');

// --- deterministic embed stub (installed into require.cache BEFORE daemon loads) -----------------
const DIMS = 384;
// Map a small vocabulary to basis dimensions; embed() returns the L2-normalized bag-of-words vector.
const VOCAB = ['refund', 'pipeline', 'idempotent', 'retry', 'database', 'rotation', 'vault'];
function stubEmbed(text) {
  if (!text || typeof text !== 'string') return null;
  const v = new Array(DIMS).fill(0);
  const toks = text.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  let any = false;
  for (const t of toks) { const i = VOCAB.indexOf(t); if (i >= 0) { v[i] += 1; any = true; } }
  if (!any) return null;
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
const embedStub = {
  embed: async (t) => stubEmbed(t),
  cosine,
  nodeVecs: () => [],
  maxCosine: () => 0,
  embedStatus: () => ({ ready: true, disabled: false }),
  ping: async () => ({ ok: true }),
  MODEL: 'stub',
  DIMS,
};
const embedPath = require.resolve('../lib/embed');
require.cache[embedPath] = { id: embedPath, filename: embedPath, loaded: true, exports: embedStub };

const ov = require('../lib/overlay');
const { ingestNode } = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Graph: a related NOTE (about refund-pipeline idempotency) the new anchor should wire to, plus an
// unrelated task that must stay below the autowire threshold.
const relatedNote = { id: 'note:refund-idem', label: 'refund pipeline idempotent', summary: 'refund pipeline idempotent retry', kind: 'note', status: 'note', context_deps: [], deps: [], vec: stubEmbed('refund pipeline idempotent retry') };
const unrelated   = { id: 's/9', label: 'database rotation', summary: 'database rotation vault', status: 'ready', context_deps: [], deps: [], vec: stubEmbed('database rotation vault') };
const g = { tasks: [relatedNote, unrelated] };

const KEY = 's/anchor';
const TITLE = 'refund pipeline retry';
const SUMMARY = 'refund pipeline idempotent retry';

(async () => {
  // --- happy path: vec set + candidate edge seeded + eager mark stamped --------------------------
  {
    const overlay = ov.EMPTY();
    const r = await ingestNode(overlay, g, KEY, { title: TITLE, summary: SUMMARY });

    ok('returns a vec', Array.isArray(r.vec) && r.vec.length === DIMS);
    // setTaskVec stores the multi-vec schema: taskVecs[key] = [vec] (array of dense vectors).
    ok('vec persisted via setTaskVec', Array.isArray(overlay.taskVecs[KEY]) && Array.isArray(overlay.taskVecs[KEY][0]) && overlay.taskVecs[KEY][0].length === DIMS);
    ok('seeded >= 1 candidate edge', r.seeded >= 1);

    const noteEdge = overlay.edges.find((e) => e.from === 'note:refund-idem' && e.to === KEY);
    ok('candidate edge note -> anchor (note is provider)', !!noteEdge);
    ok('candidate edge is weight-0 / judged:false / autowire-semantic',
      noteEdge && noteEdge.weight === 0 && noteEdge.judged === false && noteEdge.origin === 'autowire-semantic');

    ok('unrelated task NOT wired (below threshold)', !overlay.edges.some((e) => e.to === 's/9' || e.from === 's/9'));

    ok('markEagerJudge stamped (marked)', r.marked === true);
    // markEagerJudge stores eagerJudge[key] = epoch (0 on a fresh overlay) — assert presence, not truthiness.
    ok('eagerJudge flag set on the node', !!(overlay.eagerJudge && KEY in overlay.eagerJudge));
    ok('judgingSince stamped (wall-clock anchor for the D-gate)', typeof (overlay.judgingSince || {})[KEY] === 'number');
  }

  // --- idempotent: a second ingest seeds no NEW edges and does not throw --------------------------
  {
    const overlay = ov.EMPTY();
    await ingestNode(overlay, g, KEY, { title: TITLE, summary: SUMMARY });
    const edgesAfter1 = overlay.edges.length;
    const r2 = await ingestNode(overlay, g, KEY, { title: TITLE, summary: SUMMARY });
    ok('re-ingest seeds 0 new edges (addEdge dedupes)', r2.seeded === 0);
    ok('edge count unchanged on re-ingest', overlay.edges.length === edgesAfter1);
  }

  // --- null-safe: no vec (empty text) ⇒ no setTaskVec, no autowire, no mark -----------------------
  {
    const overlay = ov.EMPTY();
    const r = await ingestNode(overlay, g, 's/novec', { title: '', summary: '' });
    ok('no vec when embed returns null', r.vec === null);
    ok('no taskVec written when embed null', !(overlay.taskVecs && overlay.taskVecs['s/novec']));
    ok('no edges seeded when embed null', r.seeded === 0 && overlay.edges.length === 0);
    ok('not marked when embed null', r.marked === false && !(overlay.eagerJudge && overlay.eagerJudge['s/novec']));
  }

  // --- guard: missing overlay/key returns a benign zero result, never throws ----------------------
  {
    const r = await ingestNode(null, g, KEY, { title: TITLE, summary: SUMMARY });
    ok('null overlay ⇒ benign zero result', r && r.vec === null && r.seeded === 0 && r.marked === false);
    const overlay = ov.EMPTY();
    const r2 = await ingestNode(overlay, g, '', { title: TITLE, summary: SUMMARY });
    ok('empty key ⇒ benign zero result', r2 && r2.vec === null && r2.seeded === 0);
  }

  // --- note born-path: note key uses vec from note_nodes, calls autowireNoteProvider direction ----
  // A new note about refund-pipeline idempotency should wire note -> related open task (not into taskVecs).
  {
    const NOTE_KEY = 'note:new-idem-decision';
    const NOTE_BARE = 'new-idem-decision';
    const NOTE_TITLE = 'refund pipeline idempotent decision';
    const NOTE_SUMMARY = 'refund pipeline idempotent retry policy';
    const relatedTask = { id: 's/task-refund', label: 'refund pipeline retry handler', summary: 'refund retry idempotent', status: 'ready', context_deps: [], deps: [], vec: stubEmbed('refund pipeline idempotent retry') };
    const gNote = { tasks: [relatedTask, unrelated] };

    const overlay = ov.EMPTY();
    // Simulate addNoteNode: store note with its vec pre-set (as the route handler does before calling ingestNode)
    if (!overlay.note_nodes) overlay.note_nodes = {};
    overlay.note_nodes[NOTE_BARE] = { id: NOTE_BARE, title: NOTE_TITLE, summary: NOTE_SUMMARY, vec: stubEmbed(`${NOTE_TITLE} ${NOTE_SUMMARY}`) };

    const r = await ingestNode(overlay, gNote, NOTE_KEY, { title: NOTE_TITLE, summary: NOTE_SUMMARY });

    ok('note ingest returns a vec (from note_nodes)', Array.isArray(r.vec) && r.vec.length === DIMS);
    ok('note ingest does NOT write taskVecs (notes use .vec on node)', !(overlay.taskVecs && overlay.taskVecs[NOTE_KEY]));
    ok('note ingest seeds >= 1 candidate edge (note -> task direction)', r.seeded >= 1);

    // autowireNoteProvider direction: note is PROVIDER (from=note:..., to=task)
    const noteEdge = overlay.edges.find((e) => e.from === NOTE_KEY && e.to === 's/task-refund');
    ok('note -> related task edge seeded (provider direction)', !!noteEdge);
    ok('note candidate edge weight-0 / judged:false / autowire-semantic',
      noteEdge && noteEdge.weight === 0 && noteEdge.judged === false && noteEdge.origin === 'autowire-semantic');
    ok('unrelated task NOT wired from note', !overlay.edges.some((e) => e.to === 's/9' || e.from === 's/9'));
    ok('note ingest stamps markEagerJudge', r.marked === true && !!(overlay.eagerJudge && NOTE_KEY in overlay.eagerJudge));
  }

  // --- note ingest: no vec in note_nodes (embed failed) → benign zero result ----------------------
  {
    const NOTE_KEY = 'note:novec-note';
    const NOTE_BARE = 'novec-note';
    const overlay = ov.EMPTY();
    if (!overlay.note_nodes) overlay.note_nodes = {};
    overlay.note_nodes[NOTE_BARE] = { id: NOTE_BARE, title: '', summary: '', vec: null }; // no vec
    const r = await ingestNode(overlay, g, NOTE_KEY, { title: '', summary: '' });
    ok('note with no vec returns zero result', r.vec === null && r.seeded === 0 && r.marked === false);
    ok('no edges seeded for vec-less note', overlay.edges.length === 0);
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
