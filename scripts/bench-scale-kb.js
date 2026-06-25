#!/usr/bin/env node
// bench-scale-kb.js — inflate a workspace's .graph note KB with synthetic near-duplicate distractors
// so the retrieval bench can measure precision/recall at ~Nx corpus size. Tests the premise
// (note-mqg27k7p71f): a tight cosine floor only hurts when the corpus is large enough to hold
// relevant-but-low-cosine notes, and the cross-encoder's head-precision gain should amplify with
// distractor density. Builds the corpus WITHOUT re-embedding 30k notes: each synthetic note copies a
// real note's text (+ a unique marker so titles differ) and a PERTURBED vector (source vec + gaussian
// noise, renormalized) — hard distractors in BOTH stages (cosine near-neighbors AND near-duplicate
// text the cross-encoder must reject) at ~0 cost.
//
// Writes real `note_created` events via the graph-store API (correct id→file mapping) then compacts
// into the checkpoint so the bench daemon loads fast. Real notes (incl. every eval anchor) are left
// verbatim. Synthetic notes carry id prefix 'note:synth-' so they're trivially identifiable.
//
//   node scripts/bench-scale-kb.js --ws <workspace> --factor 100 [--noise 0.06] [--seed 42]
'use strict';
const path = require('path');
const graphStore = require('../lib/graph-store');

const arg = (name, def) => { const i = process.argv.indexOf(name); return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def; };
const WS = path.resolve(arg('--ws', path.join(__dirname, '..', 'bench', 'snapshot')));
const FACTOR = Math.max(1, parseInt(arg('--factor', '100'), 10) || 100);
const NOISE = parseFloat(arg('--noise', '0.06')) || 0.06;
let seed = parseInt(arg('--seed', '42'), 10) || 42;

function rng() { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
function gauss() { let u = 0, v = 0; while (u === 0) u = rng(); while (v === 0) v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function perturbVec(vec) {
  const out = new Array(vec.length); let norm = 0;
  for (let i = 0; i < vec.length; i++) { const x = vec[i] + NOISE * gauss(); out[i] = x; norm += x * x; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] = Math.round((out[i] / norm) * 1e6) / 1e6;
  return out;
}

const store = graphStore.open(path.join(WS, '.graph'));
const { nodes } = graphStore.loadGraph(store);
const reals = Object.entries(nodes)
  .filter(([id, n]) => n && n.kind === 'note' && Array.isArray(n.vec) && n.vec.length && !id.startsWith('note:synth-'));

const copies = FACTOR - 1;
const iso = new Date().toISOString();
let made = 0;
for (const [, node] of reals) {
  for (let i = 0; i < copies; i++) {
    const id = `note:synth-${made}`;
    graphStore.appendEvent(store, id, {
      evt: 'note_created',
      actor: 'bench-scale-kb',
      title: `${node.label || node.summary || id} [d${i}]`,
      summary: node.summary || '',
      vec: perturbVec(node.vec),
      created_by: 'bench-scale-kb',
      valid_from: iso,
      workspace: node.workspace || WS,
    });
    made++;
  }
}
graphStore.compact(store);

const after = graphStore.loadGraph(store);
const noteCount = Object.values(after.nodes).filter((n) => n.kind === 'note' && Array.isArray(n.vec)).length;
console.log(JSON.stringify({ ws: WS, factor: FACTOR, noise: NOISE, realNotes: reals.length, synthCreated: made, totalNotesWithVec: noteCount }, null, 2));
