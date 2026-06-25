#!/usr/bin/env node
// Plain Node tests for note-decay sub-feature E — subsumption (FadeMem).
//
// When a new note is added and its embedding is available, notes that are:
//   - current (validTo == null)
//   - older than the new note (validFrom < new note's validFrom)
//   - semantically similar (cosine >= SUBSUMPTION_THRESHOLD)
// are considered subsumed and should be soft-retired (validTo, supersededBy set).
//
// Sections:
//   1. cosineSim           — unit tests (identical, orthogonal, edge cases)
//   2. findSubsumedNotes   — above threshold found, below skipped, already-retired skipped,
//                            newer-or-equal notes skipped, no-vec notes skipped, no vec guard
//   3. SUBSUMPTION_THRESHOLD export
//
// No daemon, no HTTP, no npm test. Run: node test/note-decay-subsumption.test.js
'use strict';

const { cosineSim, findSubsumedNotes, SUBSUMPTION_THRESHOLD } = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.error(`FAIL  ${label}`); fail++; }
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

// Minimal overlay for findSubsumedNotes tests.
function makeOverlay(noteNodes) {
  return { note_nodes: noteNodes || {} };
}

// Build a note node with a vec, older than `baseTime` by `olderByMs` ms.
function makeNote(id, baseTimeIso, olderByMs, opts = {}) {
  const baseMs = new Date(baseTimeIso).getTime();
  const validFrom = new Date(baseMs - olderByMs).toISOString();
  return {
    id,
    title: `note ${id}`,
    summary: `summary for ${id}`,
    validFrom,
    validTo: opts.validTo !== undefined ? opts.validTo : null,
    vec: opts.vec !== undefined ? opts.vec : null,
    vecs: opts.vecs !== undefined ? opts.vecs : null,
  };
}

// A simple unit vector: 1 in one slot, 0 elsewhere.
function unitVec(dim, size = 4) {
  const v = new Array(size).fill(0);
  v[dim] = 1;
  return v;
}

// A vec that is identical to `v` (same direction).
function identical(v) { return v.slice(); }

// A vec that is orthogonal to `v` (all zeros → NOT a valid zero-magnitude check, use distinct axes).
// For our tests we use unitVec to get proper orthogonal pairs.
const EMBED_DIMS = 384;
function embedVec(values) {
  const v = new Array(EMBED_DIMS).fill(0);
  values.forEach((x, i) => { v[i] = x; });
  return v;
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. cosineSim — unit tests
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== 1. cosineSim ===\n');

// 1a: identical vectors → 1.0
{
  const v = [0.5, 0.5, 0.5, 0.5];
  const sim = cosineSim(v, identical(v));
  ok('1a: identical vectors → 1.0', Math.abs(sim - 1.0) < 1e-9);
}

// 1b: orthogonal unit vectors → 0
{
  const a = unitVec(0);  // [1, 0, 0, 0]
  const b = unitVec(1);  // [0, 1, 0, 0]
  const sim = cosineSim(a, b);
  ok('1b: orthogonal vectors → 0', Math.abs(sim) < 1e-9);
}

// 1c: anti-parallel → -1
{
  const a = [1, 0, 0, 0];
  const b = [-1, 0, 0, 0];
  const sim = cosineSim(a, b);
  ok('1c: anti-parallel → -1', Math.abs(sim + 1.0) < 1e-9);
}

// 1d: zero vector → 0 (no division by zero)
{
  const a = [0, 0, 0, 0];
  const b = [1, 0, 0, 0];
  const sim = cosineSim(a, b);
  ok('1d: zero vector → 0 (safe)', sim === 0);
}

// 1e: both zero → 0
{
  const sim = cosineSim([0, 0, 0], [0, 0, 0]);
  ok('1e: both zero → 0', sim === 0);
}

// 1f: scaled identical → 1.0 (cosine is magnitude-invariant)
{
  const a = [1, 2, 3];
  const b = [2, 4, 6];
  const sim = cosineSim(a, b);
  ok('1f: scaled identical → 1.0', Math.abs(sim - 1.0) < 1e-9);
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. findSubsumedNotes
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2. findSubsumedNotes ===\n');

const NOW = new Date().toISOString();
const SEC = 1000;
const HOUR = 3600 * SEC;

// 2a: above threshold → found
{
  // Two nearly-identical vectors: dot ≈ 1.0 (all ones, same length)
  const newVec  = embedVec([1, 1, 1, 1]);
  const oldVec  = embedVec([1, 1, 1, 1]);  // identical → cosine 1.0, well above 0.92

  const oldNote = makeNote('old-1', NOW, HOUR, { vec: oldVec });
  const newNote = makeNote('new-1', NOW, 0);
  // new note has validFrom = NOW (not older than old)
  // Make new note's validFrom = NOW exactly; old note is 1 hour earlier

  const nn = { 'old-1': oldNote, 'new-1': { ...newNote, validFrom: NOW } };
  const overlay = makeOverlay(nn);
  const results = findSubsumedNotes('new-1', newVec, overlay);
  ok('2a: above-threshold older note found', results.length === 1);
  ok('2a: result carries noteId', results[0] && results[0].noteId === 'old-1');
  ok('2a: result carries similarity', results[0] && typeof results[0].similarity === 'number');
  ok('2a: similarity >= SUBSUMPTION_THRESHOLD', results[0] && results[0].similarity >= SUBSUMPTION_THRESHOLD);
}

// 2b: below threshold → skipped
{
  const newVec = unitVec(0, EMBED_DIMS);  // [1, 0, 0, 0, ...]
  // 45-degree vector → cosine = 1/sqrt(2) ≈ 0.707, below 0.92
  const oldVec = embedVec([1, 1, 0, 0]);
  const oldNote = makeNote('old-2', NOW, HOUR, { vec: oldVec });
  const nn = { 'old-2': oldNote, 'new-2': makeNote('new-2', NOW, 0) };
  nn['new-2'].validFrom = NOW;
  const overlay = makeOverlay(nn);
  const results = findSubsumedNotes('new-2', newVec, overlay);
  ok('2b: below-threshold note skipped', results.length === 0);
}

// 2c: already-retired note (validTo set) → skipped even if very similar
{
  const vec = embedVec([1, 1, 1, 1]);
  const retiredNote = makeNote('retired-1', NOW, HOUR, { vec, validTo: new Date(Date.now() - SEC).toISOString() });
  const nn = { 'retired-1': retiredNote, 'new-3': makeNote('new-3', NOW, 0) };
  nn['new-3'].validFrom = NOW;
  const overlay = makeOverlay(nn);
  const results = findSubsumedNotes('new-3', vec, overlay);
  ok('2c: already-retired note skipped', results.length === 0);
}

// 2d: newer-or-equal notes → skipped (subsumption only applies to older notes)
{
  const vec = embedVec([1, 1, 1, 1]);
  // Same validFrom as new note (not strictly older)
  const sameTime = makeNote('same-time', NOW, 0, { vec });
  sameTime.validFrom = NOW;
  const nn = { 'same-time': sameTime, 'new-4': makeNote('new-4', NOW, 0) };
  nn['new-4'].validFrom = NOW;
  const overlay = makeOverlay(nn);
  const results = findSubsumedNotes('new-4', vec, overlay);
  ok('2d: same-time note skipped', results.length === 0);
}

// 2e: note with no vec AND no vecs → skipped
{
  const vec = embedVec([1, 1, 1, 1]);
  const noVecNote = makeNote('no-vec', NOW, HOUR, { vec: null, vecs: null });
  const nn = { 'no-vec': noVecNote, 'new-5': makeNote('new-5', NOW, 0) };
  nn['new-5'].validFrom = NOW;
  const overlay = makeOverlay(nn);
  const results = findSubsumedNotes('new-5', vec, overlay);
  ok('2e: note with no vec skipped', results.length === 0);
}

// 2f: note with vecs[0] but no pooled vec → falls back to vecs[0]
{
  const newVec  = embedVec([1, 1, 1, 1]);
  const vecs0   = embedVec([1, 1, 1, 1]);  // identical → cosine 1.0
  const oldNote = makeNote('vecs-only', NOW, HOUR, { vec: null, vecs: [vecs0] });
  const nn = { 'vecs-only': oldNote, 'new-6': makeNote('new-6', NOW, 0) };
  nn['new-6'].validFrom = NOW;
  const overlay = makeOverlay(nn);
  const results = findSubsumedNotes('new-6', newVec, overlay);
  ok('2f: vecs[0] fallback: older note found via vecs[0]', results.length === 1);
  ok('2f: vecs[0] fallback: correct noteId', results[0] && results[0].noteId === 'vecs-only');
}

// 2g: newVec falsy → returns [] (guard)
{
  const oldNote = makeNote('old-g', NOW, HOUR, { vec: embedVec([1, 1, 1, 1]) });
  const nn = { 'old-g': oldNote, 'new-g': makeNote('new-g', NOW, 0) };
  nn['new-g'].validFrom = NOW;
  const overlay = makeOverlay(nn);
  const results = findSubsumedNotes('new-g', null, overlay);
  ok('2g: null newVec → [] (guard)', Array.isArray(results) && results.length === 0);
  const resultsEmpty = findSubsumedNotes('new-g', [], overlay);
  ok('2g: empty newVec → [] (guard)', Array.isArray(resultsEmpty) && resultsEmpty.length === 0);
}

// 2h: note missing validFrom → skipped (phantom note)
{
  const vec = embedVec([1, 1, 1, 1]);
  const phantom = makeNote('phantom', NOW, HOUR, { vec });
  phantom.validFrom = null;
  const nn = { 'phantom': phantom, 'new-h': makeNote('new-h', NOW, 0) };
  nn['new-h'].validFrom = NOW;
  const overlay = makeOverlay(nn);
  const results = findSubsumedNotes('new-h', vec, overlay);
  ok('2h: phantom note (null validFrom) skipped', results.length === 0);
}

// 2i: new note itself not returned in results
{
  const vec = embedVec([1, 1, 1, 1]);
  const nn = { 'self': makeNote('self', NOW, 0, { vec }) };
  nn['self'].validFrom = NOW;
  const overlay = makeOverlay(nn);
  const results = findSubsumedNotes('self', vec, overlay);
  ok('2i: new note itself excluded from results', results.length === 0);
}

// 2j: multiple older notes at/above threshold — all found
{
  const newVec = embedVec([1, 1, 1, 1]);
  const old1 = makeNote('multi-a', NOW, HOUR, { vec: embedVec([1, 1, 1, 1]) });
  const old2 = makeNote('multi-b', NOW, 2 * HOUR, { vec: embedVec([1, 1, 1, 1]) });
  const newNote = makeNote('new-multi', NOW, 0);
  newNote.validFrom = NOW;
  const overlay = makeOverlay({ 'multi-a': old1, 'multi-b': old2, 'new-multi': newNote });
  const results = findSubsumedNotes('new-multi', newVec, overlay);
  ok('2j: both older notes found', results.length === 2);
}

// 2k: custom threshold respected
{
  // cos([1,1,0,0], [1,1,0,0]) = 1.0 → above any threshold
  // cos([1,1,0,0], [1,0,0,0]) = 1/sqrt(2) ≈ 0.707
  const newVec = embedVec([1, 1, 0, 0]);
  const highSim = makeNote('high-sim', NOW, HOUR, { vec: embedVec([1, 1, 0, 0]) });  // sim=1.0
  const lowSim  = makeNote('low-sim',  NOW, HOUR, { vec: embedVec([1, 0, 0, 0]) });  // sim≈0.707
  const newNote = makeNote('new-k', NOW, 0);
  newNote.validFrom = NOW;
  const overlay = makeOverlay({ 'high-sim': highSim, 'low-sim': lowSim, 'new-k': newNote });

  // With default threshold (0.92): only high-sim found
  const def = findSubsumedNotes('new-k', newVec, overlay);
  ok('2k: default threshold: only high-sim found', def.length === 1 && def[0].noteId === 'high-sim');

  // With low threshold (0.5): both found
  const low = findSubsumedNotes('new-k', newVec, overlay, 0.5);
  ok('2k: low threshold: both found', low.length === 2);
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. SUBSUMPTION_THRESHOLD export
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. SUBSUMPTION_THRESHOLD ===\n');

ok('3a: SUBSUMPTION_THRESHOLD is a number', typeof SUBSUMPTION_THRESHOLD === 'number');
ok('3b: SUBSUMPTION_THRESHOLD is 0.92', SUBSUMPTION_THRESHOLD === 0.92);

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
