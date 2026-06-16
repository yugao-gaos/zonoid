#!/usr/bin/env node
// Plain Node test (no framework; matches test/embed.test.js style) for Step 0 of the retrieval-recall
// ladder: TASK nodes now carry embeddings under the MULTI-VECTOR schema (`.vecs` = array of 384-dim
// vectors, scored MAX cosine), while legacy NOTE nodes stay on a single `.vec`. Run:
//   node test/task-embed-multivec.test.js — exits non-zero on any failed assertion.
//
// Proves:
//   1. nodeVecs() reads BOTH schemas: .vecs (tasks) and .vec (notes), preferring .vecs.
//   2. maxCosine() takes the MAX cosine over a node's vector set, and for a single-vector node is
//      bit-identical to cosine(q, node.vec) — so a NOTE's score is UNCHANGED vs the old single-.vec path.
//   3. setTaskVec stores a one-element vecs ARRAY (lands the multi-vec shape now).
//   4. taskEmbedText embeds title+summary only, bounding the summary (no silent token-window overflow),
//      and excludes category/tags.
//   5. With a REAL embed: a task gets a vec; scoreMatchesSemantic does max-cosine over vecs[]; and a
//      note scored via the multi-vec path equals its old single-.vec cosine.
'use strict';

const { cosine, nodeVecs, maxCosine, embed, DIMS } = require('../lib/embed');
const { taskEmbedText, noteFieldTexts } = require('../lib/node-tags');
const overlayStore = require('../lib/overlay');
const { scoreMatchesSemantic } = require('../daemon');

let pass = 0, fail = 0, skip = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const skipped = (label, why) => { console.log(`SKIP  ${label} (${why})`); skip++; };

(async () => {
  // ---- 1. nodeVecs reads both schemas -------------------------------------------------------
  const v1 = [1, 0, 0], v2 = [0, 1, 0];
  ok('nodeVecs reads .vecs (task schema)', JSON.stringify(nodeVecs({ vecs: [v1, v2] })) === JSON.stringify([v1, v2]));
  ok('nodeVecs wraps legacy .vec (note schema)', JSON.stringify(nodeVecs({ vec: v1 })) === JSON.stringify([v1]));
  ok('nodeVecs prefers .vecs over .vec', JSON.stringify(nodeVecs({ vecs: [v2], vec: v1 })) === JSON.stringify([v2]));
  ok('nodeVecs empty for vectorless node', nodeVecs({}).length === 0 && nodeVecs(null).length === 0);

  // ---- 2. maxCosine = max over set; single-vec identical to plain cosine ---------------------
  const q = [0.6, 0.8, 0];
  // max over a 2-vec set picks the closer one.
  const multi = { vecs: [v1, v2] };           // q=[.6,.8,0]: closer to v2=[0,1,0] (cos .8) than v1=[1,0,0] (cos .6)
  ok('maxCosine takes the MAX over the vec set', Math.abs(maxCosine(q, multi) - cosine(q, v2)) < 1e-12 && cosine(q, v2) > cosine(q, v1));
  // BACK-COMPAT: a single-vector node scored via maxCosine == cosine(q, node.vec) exactly.
  const noteNode = { vec: v2 };
  ok('maxCosine(single-vec) === cosine(q, vec) (note score UNCHANGED)', maxCosine(q, noteNode) === cosine(q, noteNode.vec));
  ok('maxCosine empty query/empty set === 0', maxCosine([], multi) === 0 && maxCosine(q, {}) === 0);

  // ---- 3. setTaskVec stores a one-element array (multi-vec shape) ----------------------------
  {
    const ov = overlayStore.EMPTY();
    overlayStore.setTaskVec(ov, 'sess/1', v1);
    ok('setTaskVec stores a vecs ARRAY (length 1)', Array.isArray(ov.taskVecs['sess/1']) && ov.taskVecs['sess/1'].length === 1);
    ok('setTaskVec array element is the vector', JSON.stringify(ov.taskVecs['sess/1'][0]) === JSON.stringify(v1));
    overlayStore.setTaskVec(ov, 'sess/1', null);
    ok('setTaskVec(null) clears the entry', !('sess/1' in ov.taskVecs));
  }

  // ---- 4. taskEmbedText: title+summary only, summary bounded, no category/tags --------------
  {
    const longSummary = 'x'.repeat(5000);
    const text = taskEmbedText({ title: 'Embed tasks', summary: longSummary, category: 'retrieval', tags: ['embed', 'recall'] });
    ok('taskEmbedText keeps the title', text.startsWith('Embed tasks '));
    ok('taskEmbedText bounds the summary (< full length)', text.length < 'Embed tasks '.length + 5000);
    ok('taskEmbedText excludes category', !/retrieval/.test(text));
    ok('taskEmbedText excludes tags', !/recall/.test(text));
  }

  // ---- 4b. noteFieldTexts: [title, summary, ...knowledge[]]; addNoteNode stores .vecs -----------
  {
    const note = {
      title: 'Multivec note',
      summary: 'Field-level vectors land in note.vecs.',
      knowledge: [
        'Pooled vec stays the gate/dedup vector.',
        'Each knowledge entry becomes its own vector.',
      ],
    };
    const texts = noteFieldTexts(note);
    ok('noteFieldTexts is [title, summary, ...knowledge[]] (count)', texts.length === note.knowledge.length + 2);
    ok('noteFieldTexts[0] is the title', texts[0] === note.title);
    ok('noteFieldTexts[1] is the summary', texts[1] === note.summary);
    ok('noteFieldTexts INCLUDES each knowledge[] entry', note.knowledge.every((k) => texts.includes(k)));
    ok('noteFieldTexts drops empty fields', noteFieldTexts({ title: 'only title', summary: '', knowledge: ['', null, 'kept'] }).length === 2);
    // Structured knowledge items are flattened, not dropped.
    ok('noteFieldTexts flattens object knowledge items',
      noteFieldTexts({ title: 't', summary: 's', knowledge: [{ title: 'k-title', summary: 'k-sum' }] }).length === 3);

    // addNoteNode stores a supplied .vecs ARRAY on the note (and leaves .vec as the pooled vector).
    const fakeVecs = texts.map((_, i) => [i, i + 1, i + 2]);
    const ov2 = overlayStore.EMPTY();
    const id = overlayStore.addNoteNode(ov2, { ...note, vec: [9, 9, 9], vecs: fakeVecs });
    const stored = ov2.note_nodes[id];
    ok('addNoteNode stores note.vecs (array)', Array.isArray(stored.vecs) && stored.vecs.length === texts.length);
    ok('addNoteNode keeps the pooled note.vec', JSON.stringify(stored.vec) === JSON.stringify([9, 9, 9]));
    ok('addNoteNode .vecs has one vector per knowledge[] entry (+title +summary)',
      stored.vecs.length === note.knowledge.length + 2);
    // nodeVecs prefers .vecs, so corpus scoring upgrades automatically.
    ok('nodeVecs(note) returns the .vecs set (prefers .vecs over .vec)',
      JSON.stringify(nodeVecs(stored)) === JSON.stringify(fakeVecs));
    // No .vecs supplied ⇒ stays null (back-compat single-.vec shape).
    const id2 = overlayStore.addNoteNode(ov2, { title: 't', summary: 's', vec: [1, 2, 3] });
    ok('addNoteNode leaves .vecs null when none supplied', ov2.note_nodes[id2].vecs === null);
  }

  // ---- 5. REAL embed: task gets a vec; scoreMatchesSemantic does max-cosine; note unchanged ---
  const probe = await embed('hello world');
  if (!Array.isArray(probe)) {
    skipped('task gets a 384-dim vec', 'model unavailable');
    skipped('scoreMatchesSemantic max-cosine over task vecs[]', 'model unavailable');
    skipped('note score via multi-vec path == single-.vec cosine', 'model unavailable');
    skipped('note.vecs built from noteFieldTexts (one per knowledge entry)', 'model unavailable');
  } else {
    const taskVec = await embed(taskEmbedText({ title: 'database migration rollback', summary: 'steps to roll back a failed schema change' }));
    ok('task gets a 384-dim vec', Array.isArray(taskVec) && taskVec.length === DIMS);

    // Build a tiny graph: one candidate TASK carrying .vecs, scored against a target query vec.
    const targetVec = await embed('how do I undo a broken database migration');
    const g = { tasks: [
      { id: 'sess/cand', label: 'database migration rollback', summary: 'steps to roll back a failed schema change', status: 'ready', kind: 'task', vecs: [taskVec] },
    ] };
    const target = { id: 'sess/target', label: 'undo migration', summary: '', deps: [], context_deps: [] };
    const out = scoreMatchesSemantic(g, target, targetVec);
    const hit = out.find((m) => m.key === 'sess/cand');
    ok('scoreMatchesSemantic scores a .vecs task semantically', hit && hit.via === 'semantic');
    ok('scoreMatchesSemantic score === max-cosine over task vecs[]', hit && Math.abs(hit.score - Math.round(maxCosine(targetVec, { vecs: [taskVec] }) * 1000) / 1000) < 1e-9);

    // A NOTE candidate on legacy .vec scored via the SAME path must equal cosine(target, note.vec).
    const noteVec = await embed('rolling back a database migration safely');
    const g2 = { tasks: [ { id: 'note:n1', label: 'migration rollback', summary: 'rolling back a database migration safely', status: 'note', kind: 'note', vec: noteVec } ] };
    const out2 = scoreMatchesSemantic(g2, target, targetVec);
    const nhit = out2.find((m) => m.key === 'note:n1');
    ok('note scored via multi-vec path == single-.vec cosine (UNCHANGED)',
      nhit && nhit.score === Math.round(cosine(targetVec, noteVec) * 1000) / 1000);

    // Build a note's field-level .vecs the same way the route does, and assert one vector per
    // knowledge[] entry (+title +summary). Then a corpus-side note carrying .vecs scores via the
    // MAX-cosine path against the closest field vector (knowledge entries become independently hittable).
    const noteFields = {
      title: 'migration rollback',
      summary: 'general notes on schema changes',
      knowledge: [
        'undo a broken database migration by restoring the prior schema',
        'unrelated: tune the embedding cache TTL',
      ],
    };
    const fieldTexts = noteFieldTexts(noteFields);
    const noteVecs = (await Promise.all(fieldTexts.map(embed))).filter(Boolean);
    ok('note.vecs has one vector per field (title+summary+each knowledge entry)',
      noteVecs.length === noteFields.knowledge.length + 2 && fieldTexts.length === noteFields.knowledge.length + 2);
    ok('note.vecs vectors are 384-dim', noteVecs.every((v) => Array.isArray(v) && v.length === DIMS));
    // The migration-rollback query should hit the dedicated knowledge field vector at least as well as
    // the pooled-ish title/summary vectors — multi-vec max-cosine >= the title-only cosine.
    const mc = maxCosine(targetVec, { vecs: noteVecs });
    ok('maxCosine over note.vecs >= cosine to the title vec (knowledge field is hittable)',
      mc >= cosine(targetVec, noteVecs[0]) - 1e-9);
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed${skip ? `, ${skip} skipped` : ''}`);
  process.exit(fail === 0 ? 0 : 1);
})();
