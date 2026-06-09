#!/usr/bin/env node
// Plain Node test for auto-wiring new tasks in daemon.js (no framework; matches
// test/weighted-edges.test.js style). Run: node test/autowire.test.js — exits non-zero on any
// failed assertion. Covers: a new task overlapping a done/note node auto-gets a weighted context
// edge (weight == relevance score); a novel task gets none; blocking-eligible matches are never
// auto-wired; re-seeing a task doesn't duplicate the edge.
'use strict';
const ov = require('../lib/overlay');
const { scoreMatches, autowireNewTask, DEFAULT_AUTOWIRE_THRESHOLD } = require('../daemon');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// A graph with: one DONE provider sharing tokens with `newTask`, one OPEN task also overlapping
// (must NOT be auto-wired — it's blocking-eligible), one NOTE node overlapping, and one unrelated
// DONE task. `newTask` is the genuinely-new node we auto-wire.
const doneProvider = { id: 's/1', label: 'build payment refund pipeline', summary: 'stripe refund webhook handler', status: 'done', context_deps: [], deps: [] };
const openTask     = { id: 's/2', label: 'payment refund dashboard widget', summary: 'refund pipeline metrics', status: 'ready', context_deps: [], deps: [] };
const noteNode     = { id: 'note:abc', label: 'refund pipeline retry decision', summary: 'idempotent refund keys', kind: 'note', status: 'note', context_deps: [], deps: [] };
const unrelated    = { id: 's/3', label: 'rotate database credentials quarterly', summary: 'vault rotation cron', status: 'done', context_deps: [], deps: [] };
const newTask      = { id: 's/9', label: 'refund pipeline reconciliation job', summary: 'reconcile stripe refund ledger', context_deps: [], deps: [] };

const g = { tasks: [doneProvider, openTask, noteNode, unrelated, newTask] };

// --- new task overlapping done/note nodes auto-gets weighted context edges (weight == score) ---
{
  const overlay = ov.EMPTY();
  const matches = scoreMatches(g, newTask);
  const added = autowireNewTask(overlay, g, newTask);
  ok('autowire added at least one edge for overlapping task', added >= 1);

  const ctx = overlay.edges.filter((e) => e.kind === 'context' && e.to === newTask.id);
  ok('all auto edges are context edges', ctx.length === overlay.edges.length && overlay.edges.length === added);

  // every auto edge points FROM a context-eligible provider (done or note), never the open task
  const froms = new Set(ctx.map((e) => e.from));
  ok('done provider auto-wired', froms.has('s/1'));
  ok('note node auto-wired', froms.has('note:abc'));
  ok('open task NOT auto-wired (blocking-eligible)', !froms.has('s/2'));
  ok('unrelated task NOT auto-wired (below threshold / no overlap)', !froms.has('s/3'));

  // weight stored on each edge equals that match's relevance score
  const scoreOf = (key) => matches.find((m) => m.key === key).score;
  ok('done-edge weight == relevance score', ctx.find((e) => e.from === 's/1').weight === scoreOf('s/1'));
  ok('note-edge weight == relevance score', ctx.find((e) => e.from === 'note:abc').weight === scoreOf('note:abc'));

  // every stored weight clears the threshold
  ok('every auto edge weight >= threshold', ctx.every((e) => e.weight >= DEFAULT_AUTOWIRE_THRESHOLD));

  // never a blocking edge
  ok('no blocking edges auto-created', !overlay.edges.some((e) => e.kind !== 'context'));

  // --- idempotent: re-seeing the same task adds no new edges ---
  const before = overlay.edges.length;
  const added2 = autowireNewTask(overlay, g, newTask);
  ok('re-wiring adds zero edges', added2 === 0);
  ok('edge count unchanged after re-wire', overlay.edges.length === before);
}

// --- a genuinely novel task (no token overlap with anything) gets NO edges ---
{
  const overlay = ov.EMPTY();
  const novel = { id: 's/10', label: 'configure airline mileage redemption portal', summary: 'frequent flyer kiosk theme', context_deps: [], deps: [] };
  const g2 = { tasks: [doneProvider, noteNode, unrelated, novel] };
  const added = autowireNewTask(overlay, g2, novel);
  ok('novel task auto-wires nothing', added === 0 && overlay.edges.length === 0);
}

// --- conservative default threshold is 0.25 ---
ok('default autowire threshold is 0.25', DEFAULT_AUTOWIRE_THRESHOLD === 0.25);

// --- threshold knob: a high threshold suppresses weaker matches ---
{
  const overlay = ov.EMPTY();
  const added = autowireNewTask(overlay, g, newTask, 0.99); // nothing realistically scores this high
  ok('threshold=0.99 suppresses all auto edges', added === 0 && overlay.edges.length === 0);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
