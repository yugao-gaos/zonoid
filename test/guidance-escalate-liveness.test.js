#!/usr/bin/env node
// Plain Node test for the escalate-liveness work (EL-1): origin binding (A), the staleness-sweep
// predicate (B), and plain-escalation dedup (C). Modeled over the pure overlay primitives the seam +
// daemon use (so it tests the real logic without binding a port) — mirrors guidance-resolve.test.js.
// Run: node test/guidance-escalate-liveness.test.js.
'use strict';
const ov = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Faithful re-implementation of daemon.js staleGuidanceReason (the sweep predicate). MUST mirror the
// daemon: origin task done/merged → stale; any origin note superseded → stale; neither bound → never.
function noteSuperseded(o, key) {
  const id = String(key).replace(/^note:/, '');
  const n = (o.note_nodes || {})[id];
  return !!(n && (n.supersededBy || n.validTo));
}
function staleGuidanceReason(o, g) {
  const hasTask = g.origin_task != null && g.origin_task !== '';
  const notes = Array.isArray(g.origin_notes) ? g.origin_notes : [];
  if (!hasTask && notes.length === 0) return null;
  if (hasTask) {
    const st = o.status[g.origin_task];
    const git = (o.git || {})[g.origin_task];
    if (st === 'done' || (git && git.merged)) return 'auto-stale: origin task completed';
  }
  if (notes.some((k) => noteSuperseded(o, k))) return 'auto-stale: triggering note superseded';
  return null;
}

// --- (A) ORIGIN BINDING: addGuidance stamps origin_task + origin_notes ------------------------
{
  const o = ov.EMPTY();
  const id = ov.addGuidance(o, { question: 'merge to main?', origin_task: '7', origin_notes: ['note-a', 'note-b'] });
  const it = o.guidance.find((g) => g.id === id);
  ok('addGuidance stamps origin_task', it.origin_task === '7');
  ok('addGuidance stamps origin_notes', Array.isArray(it.origin_notes) && it.origin_notes.length === 2);
  const id2 = ov.addGuidance(o, { question: 'unbound?' });
  const it2 = o.guidance.find((g) => g.id === id2);
  ok('absent origins default to null/[] (back-compat)', it2.origin_task === null && it2.origin_notes.length === 0);
}

// --- (C) PLAIN-ESCALATION DEDUP ---------------------------------------------------------------
{
  const o = ov.EMPTY();
  const id1 = ov.addGuidance(o, { question: 'Ship to prod?', origin_task: '7' });
  // Same origin_task, same question up to case/punctuation/whitespace → collapses onto the open row.
  const id2 = ov.addGuidance(o, { question: 'ship to   prod??', origin_task: '7' });
  ok('plain escalation dedups on origin_task + normalized question', id1 === id2);
  ok('only one pending row after dedup', o.guidance.filter((g) => !g.resolved).length === 1);
  // Different origin_task → distinct row (the same question from another task is its own decision).
  const id3 = ov.addGuidance(o, { question: 'Ship to prod?', origin_task: '8' });
  ok('different origin_task does NOT dedup', id3 !== id1);
  // Different question, same task → distinct row.
  const id4 = ov.addGuidance(o, { question: 'Roll back?', origin_task: '7' });
  ok('different question does NOT dedup', id4 !== id1);
  // No origin_task → never dedups (no binding to match on).
  const a = ov.addGuidance(o, { question: 'unbound q?' });
  const b = ov.addGuidance(o, { question: 'unbound q?' });
  ok('unbound plain escalations do NOT dedup', a !== b);
  // A resolved row is not reused.
  ov.resolveGuidance(o, id1, 'yes');
  const id5 = ov.addGuidance(o, { question: 'Ship to prod?', origin_task: '7' });
  ok('resolved row is not reused for dedup', id5 !== id1);
}

// --- (B) STALENESS SWEEP PREDICATE ------------------------------------------------------------
{
  // origin_task done → resolves.
  const o = ov.EMPTY();
  o.status['7'] = 'done';
  const g = { origin_task: '7', origin_notes: [] };
  ok('origin_task done → stale', staleGuidanceReason(o, g) === 'auto-stale: origin task completed');
}
{
  // origin_task merged (git.merged) → resolves even without status done.
  const o = ov.EMPTY();
  o.git['7'] = { merged: true };
  ok('origin_task merged → stale', staleGuidanceReason(o, { origin_task: '7', origin_notes: [] }) === 'auto-stale: origin task completed');
}
{
  // superseded origin_note → resolves.
  const o = ov.EMPTY();
  o.note_nodes['note-old'] = { id: 'note-old', validTo: '2026-06-10T16:00:00Z', supersededBy: 'note-new' };
  o.note_nodes['note-new'] = { id: 'note-new', validTo: null };
  ok('superseded origin_note → stale', staleGuidanceReason(o, { origin_task: null, origin_notes: ['note-old'] }) === 'auto-stale: triggering note superseded');
  ok('note key tolerates note: prefix', staleGuidanceReason(o, { origin_task: null, origin_notes: ['note:note-old'] }) === 'auto-stale: triggering note superseded');
  ok('current origin_note (still valid) → NOT stale', staleGuidanceReason(o, { origin_task: null, origin_notes: ['note-new'] }) === null);
}
{
  // origin_task still in flight, notes current → stays pending.
  const o = ov.EMPTY();
  o.status['7'] = 'in_progress';
  o.note_nodes['note-x'] = { id: 'note-x', validTo: null };
  ok('in-flight task + current note → NOT stale', staleGuidanceReason(o, { origin_task: '7', origin_notes: ['note-x'] }) === null);
}
{
  // NEITHER origin_task NOR origin_notes → never auto-resolve.
  const o = ov.EMPTY();
  ok('no origins → never stale', staleGuidanceReason(o, { origin_task: null, origin_notes: [] }) === null);
  ok('empty-string origin_task with no notes → never stale', staleGuidanceReason(o, { origin_task: '', origin_notes: [] }) === null);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
