#!/usr/bin/env node
// Plain Node test (no framework; matches test/ingest-node.test.js style) for the FOLLOW-UP born-path
// reroute — BUILD3 of the node-lifecycle unification (design note:note-mqeapqae6jf). Run:
//   node test/followup-ingest.test.js   (exits non-zero on any failed assertion)
//
// THE BUG IT GUARDS: follow-up nodes are born in lib/followups.js apply() on the snapshot substrate
// (setSnapshot + a parent->child context edge). Pre-BUILD3 that lane stopped there — no vec, no
// candidate edges, no eager mark — so a `ready` follow-up reached dispatch with judging:false and the
// judging->ready D-gate was a no-op for it (exactly the native/file-drop bypass BUILD1 closed). BUILD3
// routes each minted follow-up node through the shared ingestNode funnel in routes/overlay.js right
// after apply(). This test reproduces that call sequence (apply -> ingestNode per result key) and
// asserts the rerouted lane produces the SAME birth artifacts as the native lane:
//   vec persisted via setTaskVec + weight-0 / judged:false / autowire-semantic candidate edge + eager mark.
//
// Offline + deterministic: a stub embed (same construction as ingest-node.test.js) is installed into
// require.cache BEFORE daemon loads so the vec is reproducible and the related task wires while the
// unrelated one stays below threshold. The assertion is funnel mechanics, not embedding quality.
'use strict';

// --- deterministic embed stub (installed into require.cache BEFORE daemon loads) -----------------
const DIMS = 384;
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
const followups = require('../lib/followups');
const { ingestNode } = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Graph: a related TASK the new follow-up should wire to (follow-up is the new anchor / consumer, so
// the related task is a candidate the autowire seeds toward), plus an unrelated task below threshold.
const relatedTask = { id: 's/refund-handler', label: 'refund pipeline retry handler', summary: 'refund pipeline idempotent retry', status: 'ready', context_deps: [], deps: [], vec: stubEmbed('refund pipeline idempotent retry') };
const unrelated   = { id: 's/9', label: 'database rotation', summary: 'database rotation vault', status: 'ready', context_deps: [], deps: [], vec: stubEmbed('database rotation vault') };
const g = { tasks: [relatedTask, unrelated] };

(async () => {
  // --- the BUILD3 reroute: apply() mints the node, then the route runs it through ingestNode -------
  {
    const overlay = ov.EMPTY();
    const PARENT = 's/parent';
    // Parent must exist so the parent->child context edge apply() writes has a real endpoint.
    overlay.snapshots[PARENT] = { subject: 'parent task', description: '', status: 'pending', blockedBy: [] };

    const FOLLOW = { title: 'refund pipeline retry idempotent', prompt: 'make the refund pipeline retry idempotent' };
    const results = followups.apply(overlay, PARENT, [FOLLOW]);
    ok('apply() minted exactly one follow-up', results.length === 1);
    const key = results[0].key;
    ok('minted key is on the followup/ substrate', typeof key === 'string' && key.startsWith('followup/'));
    ok('apply() set the snapshot (node born)', !!(overlay.snapshots && overlay.snapshots[key]));
    ok('apply() wrote parent->child context edge', overlay.edges.some((e) => e.from === PARENT && e.to === key && e.kind === 'context'));
    ok('apply() routed it ready (no when/disruptive)', results[0].routing === 'ready');
    // Pre-ingest: the bypass state the bug left — no vec, no autowire edge, no eager mark.
    ok('pre-ingest: NO vec (the bypass state)', !(overlay.taskVecs && overlay.taskVecs[key]));
    ok('pre-ingest: NO eager mark (the bypass state)', !(overlay.eagerJudge && key in overlay.eagerJudge));

    // BUILD3: route the minted node through the shared funnel (mirrors routes/overlay.js after apply()).
    const r = await ingestNode(overlay, g, key, { title: results[0].title, summary: results[0].prompt });

    ok('ingest returns a vec', Array.isArray(r.vec) && r.vec.length === DIMS);
    ok('vec persisted via setTaskVec (same lane as native)', Array.isArray(overlay.taskVecs[key]) && Array.isArray(overlay.taskVecs[key][0]) && overlay.taskVecs[key][0].length === DIMS);
    ok('seeded >= 1 candidate edge', r.seeded >= 1);

    const candEdge = overlay.edges.find((e) => (e.from === key && e.to === 's/refund-handler') || (e.from === 's/refund-handler' && e.to === key));
    ok('candidate edge to related task seeded', !!candEdge);
    ok('candidate edge weight-0 / judged:false / autowire-semantic (same as native lane)',
      candEdge && candEdge.weight === 0 && candEdge.judged === false && candEdge.origin === 'autowire-semantic');
    ok('unrelated task NOT wired (below threshold)', !overlay.edges.some((e) => e.to === 's/9' || e.from === 's/9'));

    ok('markEagerJudge stamped (marked) — D-gate now covers this lane', r.marked === true);
    ok('eagerJudge flag set on the follow-up node', !!(overlay.eagerJudge && key in overlay.eagerJudge));
    ok('judgingSince stamped (wall-clock anchor for the D-gate)', typeof (overlay.judgingSince || {})[key] === 'number');
  }

  // --- a held follow-up (scheduled / not_ready) is STILL ingested — ingest is birth, not readiness --
  {
    const overlay = ov.EMPTY();
    const PARENT = 's/parent2';
    overlay.snapshots[PARENT] = { subject: 'parent task 2', description: '', status: 'pending', blockedBy: [] };
    const future = new Date(Date.now() + 3600_000).toISOString();
    const FOLLOW = { title: 'refund pipeline idempotent retry later', prompt: 'refund pipeline idempotent retry deferred', when: future };
    const results = followups.apply(overlay, PARENT, [FOLLOW]);
    const key = results[0].key;
    ok('scheduled follow-up routed not_ready', results[0].routing === 'scheduled' && overlay.status[key] === 'not_ready');

    const r = await ingestNode(overlay, g, key, { title: results[0].title, summary: results[0].prompt });
    ok('held follow-up still gets a vec', Array.isArray(r.vec) && r.vec.length === DIMS);
    ok('held follow-up still seeds candidate edges + eager mark', r.seeded >= 1 && r.marked === true);
    ok('held follow-up status unchanged by ingest (still not_ready)', overlay.status[key] === 'not_ready');
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
