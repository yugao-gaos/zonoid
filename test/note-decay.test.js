#!/usr/bin/env node
// Plain Node tests for the note-decay feature:
//   A. computeNoteStats (lib/recall-outcome-journal.js) — win/loss counting
//   B. buildQueue decay slow lane (lib/judge.js) — age-gated, opportunity-gated, winRate-gated
//   C. Already-retired notes (validTo set) skipped by the decay lane
//   D. Notes with zero opportunities (or below MIN_OPPORTUNITIES) skipped
//
// No daemon, no HTTP, no npm test — plain `node test/note-decay.test.js`.
'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const {
  appendRow,
  readRows,
  latestByTask,
  computeNoteStats,
  MIN_AGE_DAYS,
  MIN_OPPORTUNITIES,
  WIN_RATE_THRESHOLD,
} = require('../lib/recall-outcome-journal');

const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.error(`FAIL  ${label}`); fail++; }
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

// Build a minimal overlay that includes overlay.workspace so the decay lane can
// call computeNoteStats(ws) internally.
function makeOverlay(noteNodes, ws) {
  return {
    epoch: 1,
    edges: [],
    note_nodes: noteNodes || {},
    judgedAtEpoch: {},
    judgedClusters: {},
    workspace: ws || null,
  };
}

// Create a temp workspace dir with a .graph subdir so appendRow can write.
function makeTmpWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-decay-test-'));
  fs.mkdirSync(path.join(dir, '.graph'), { recursive: true });
  return dir;
}

// Fully-formed note node (created_by + validFrom set, not retired).
function makeNote(id, ageMs, opts = {}) {
  const validFrom = new Date(Date.now() - ageMs).toISOString();
  return {
    id,
    title: `note title ${id}`,
    summary: `summary for ${id}`,
    created_by: opts.created_by || 'agent-x',
    validFrom,
    validTo: opts.validTo || null,
  };
}

const DAY_MS  = 24 * 60 * 60 * 1000;
const OLD_MS  = (MIN_AGE_DAYS + 5) * DAY_MS;   // definitively old
const YOUNG_MS = (MIN_AGE_DAYS - 5) * DAY_MS;  // definitively young (below gate)

// ──────────────────────────────────────────────────────────────────────────────
// A. computeNoteStats
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== A. computeNoteStats ===\n');

// A1: basic win/loss counting — one win, one loss
{
  const ws = makeTmpWs();
  appendRow(ws, { task_key: 'task/1', recalled_note_keys: ['note:n1'], outcome: 'approve',  via: 'rag' });
  appendRow(ws, { task_key: 'task/2', recalled_note_keys: ['note:n1'], outcome: 'failed',   via: 'rag' });
  const stats = computeNoteStats(ws);
  const s = stats.get('note:n1');
  ok('A1: note:n1 wins=1', s && s.wins === 1);
  ok('A1: note:n1 losses=1', s && s.losses === 1);
  ok('A1: note:n1 total=2', s && s.total === 2);
  ok('A1: note:n1 winRate=0.5', s && s.winRate === 0.5);
  fs.rmSync(ws, { recursive: true });
}

// A2: 'tested' counts as win, 'kickback' counts as loss
{
  const ws = makeTmpWs();
  appendRow(ws, { task_key: 'task/3', recalled_note_keys: ['note:n2'], outcome: 'tested',   via: 'rag' });
  appendRow(ws, { task_key: 'task/4', recalled_note_keys: ['note:n2'], outcome: 'kickback', via: 'rag' });
  const stats = computeNoteStats(ws);
  const s = stats.get('note:n2');
  ok('A2: tested → win', s && s.wins === 1);
  ok('A2: kickback → loss', s && s.losses === 1);
  fs.rmSync(ws, { recursive: true });
}

// A3: latest-row-wins — pending then resolved; the resolved row should win
{
  const ws = makeTmpWs();
  appendRow(ws, { task_key: 'task/5', recalled_note_keys: ['note:n3'], outcome: 'pending', via: 'rag' });
  appendRow(ws, { task_key: 'task/5', recalled_note_keys: ['note:n3'], outcome: 'approve', via: 'rag' });
  const stats = computeNoteStats(ws);
  const s = stats.get('note:n3');
  ok('A3: latest row wins (resolved overrides pending)', s && s.wins === 1 && s.losses === 0);
  fs.rmSync(ws, { recursive: true });
}

// A4: pending rows excluded — a task with only a pending row contributes no signal
{
  const ws = makeTmpWs();
  appendRow(ws, { task_key: 'task/6', recalled_note_keys: ['note:n4'], outcome: 'pending', via: 'rag' });
  const stats = computeNoteStats(ws);
  ok('A4: pending-only task excluded from stats', !stats.has('note:n4'));
  fs.rmSync(ws, { recursive: true });
}

// A5: multiple notes in one row all get credited
{
  const ws = makeTmpWs();
  appendRow(ws, { task_key: 'task/7', recalled_note_keys: ['note:n5', 'note:n6'], outcome: 'approve', via: 'rag' });
  const stats = computeNoteStats(ws);
  ok('A5: note:n5 credited', stats.get('note:n5') && stats.get('note:n5').wins === 1);
  ok('A5: note:n6 credited', stats.get('note:n6') && stats.get('note:n6').wins === 1);
  fs.rmSync(ws, { recursive: true });
}

// A6: a note with all losses → winRate === 0
{
  const ws = makeTmpWs();
  for (let i = 0; i < 4; i++) {
    appendRow(ws, { task_key: `task/8-${i}`, recalled_note_keys: ['note:n7'], outcome: 'failed', via: 'rag' });
  }
  const stats = computeNoteStats(ws);
  const s = stats.get('note:n7');
  ok('A6: all-loss note winRate===0', s && s.winRate === 0 && s.total === 4);
  fs.rmSync(ws, { recursive: true });
}

// A7: a note recalled only with wins → winRate===1
{
  const ws = makeTmpWs();
  for (let i = 0; i < 3; i++) {
    appendRow(ws, { task_key: `task/9-${i}`, recalled_note_keys: ['note:n8'], outcome: 'tested', via: 'rag' });
  }
  const stats = computeNoteStats(ws);
  const s = stats.get('note:n8');
  ok('A7: all-win note winRate===1', s && s.winRate === 1 && s.total === 3);
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// B. buildQueue decay lane — gate conditions
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== B. buildQueue decay lane ===\n');

// Helper: seed the workspace with enough resolved rows to meet/fail the gates.
function seedRows(ws, noteKey, wins, losses) {
  for (let i = 0; i < wins; i++) {
    appendRow(ws, { task_key: `seed-w/${noteKey}-${i}`, recalled_note_keys: [noteKey], outcome: 'approve', via: 'rag' });
  }
  for (let i = 0; i < losses; i++) {
    appendRow(ws, { task_key: `seed-l/${noteKey}-${i}`, recalled_note_keys: [noteKey], outcome: 'failed', via: 'rag' });
  }
}

// B1: note passes ALL gates → appears in decay lane
{
  const ws = makeTmpWs();
  const note = makeNote('decay-ok', OLD_MS);
  // 0 wins, 4 losses → winRate 0 < 0.25, total 4 >= MIN_OPPORTUNITIES
  seedRows(ws, 'note:decay-ok', 0, 4);

  const o = makeOverlay({ 'decay-ok': note }, ws);
  const q = judge.buildQueue(o);
  const decayItems = q.filter((i) => i.kind === 'decay');
  ok('B1: decay item emitted for qualifying note', decayItems.length === 1);
  const it = decayItems[0];
  ok('B1: decay item noteId is note:decay-ok', it && it.noteId === 'note:decay-ok');
  ok('B1: decay item action is retire', it && it.action === 'retire');
  ok('B1: decay item reason is decay', it && it.reason === 'decay');
  ok('B1: decay item carries winRate', it && typeof it.winRate === 'number');
  ok('B1: decay item carries total', it && typeof it.total === 'number' && it.total >= MIN_OPPORTUNITIES);
  fs.rmSync(ws, { recursive: true });
}

// B2: note is too young → NOT in decay lane
{
  const ws = makeTmpWs();
  const note = makeNote('young-note', YOUNG_MS);
  seedRows(ws, 'note:young-note', 0, 4);

  const o = makeOverlay({ 'young-note': note }, ws);
  const q = judge.buildQueue(o);
  const decayItems = q.filter((i) => i.kind === 'decay');
  ok('B2: young note excluded from decay lane', decayItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// B3: note has high win rate → NOT in decay lane (winRate >= WIN_RATE_THRESHOLD)
{
  const ws = makeTmpWs();
  const note = makeNote('good-note', OLD_MS);
  // 3 wins, 0 losses → winRate 1.0 ≥ 0.25
  seedRows(ws, 'note:good-note', 3, 0);

  const o = makeOverlay({ 'good-note': note }, ws);
  const q = judge.buildQueue(o);
  const decayItems = q.filter((i) => i.kind === 'decay');
  ok('B3: high-win-rate note excluded from decay lane', decayItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// B4: win rate exactly at threshold (0.25) → NOT in decay lane (gate is strict <)
{
  const ws = makeTmpWs();
  const note = makeNote('threshold-note', OLD_MS);
  // 1 win, 3 losses → winRate = 0.25, not < 0.25
  seedRows(ws, 'note:threshold-note', 1, 3);

  const o = makeOverlay({ 'threshold-note': note }, ws);
  const q = judge.buildQueue(o);
  const decayItems = q.filter((i) => i.kind === 'decay');
  ok('B4: note at exactly threshold excluded (strict <)', decayItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// B5: note has too few opportunities (< MIN_OPPORTUNITIES) → NOT in decay lane
{
  const ws = makeTmpWs();
  const note = makeNote('low-opp', OLD_MS);
  // 0 wins, 2 losses → total=2 < MIN_OPPORTUNITIES (3)
  seedRows(ws, 'note:low-opp', 0, 2);

  const o = makeOverlay({ 'low-opp': note }, ws);
  const q = judge.buildQueue(o);
  const decayItems = q.filter((i) => i.kind === 'decay');
  ok('B5: note below MIN_OPPORTUNITIES excluded', decayItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// B6: note with no journal rows → NOT in decay lane (zero opportunities)
{
  const ws = makeTmpWs();
  const note = makeNote('no-rows', OLD_MS);

  const o = makeOverlay({ 'no-rows': note }, ws);
  const q = judge.buildQueue(o);
  const decayItems = q.filter((i) => i.kind === 'decay');
  ok('B6: note with zero rows excluded from decay lane', decayItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// B7: phantom note (missing created_by or validFrom) → NOT in decay lane
{
  const ws = makeTmpWs();
  // Phantom: no created_by
  const phantom1 = { id: 'phantom1', title: 'x', summary: '', created_by: null, validFrom: new Date(Date.now() - OLD_MS).toISOString(), validTo: null };
  // Phantom: no validFrom
  const phantom2 = { id: 'phantom2', title: 'y', summary: '', created_by: 'agent', validFrom: null, validTo: null };
  seedRows(ws, 'note:phantom1', 0, 5);
  seedRows(ws, 'note:phantom2', 0, 5);

  const o = makeOverlay({ phantom1, phantom2 }, ws);
  const q = judge.buildQueue(o);
  const decayItems = q.filter((i) => i.kind === 'decay');
  ok('B7: phantom notes (missing created_by/validFrom) excluded', decayItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// B8: decay items appear AFTER edge/orphan items in the queue (slow lane ordering)
{
  const ws = makeTmpWs();
  const note = makeNote('decay-order', OLD_MS);
  seedRows(ws, 'note:decay-order', 0, 4);

  // Also add an orphan note to get a mix
  const orphan = { id: 'orphan-z', title: 'orphan', summary: '', created_by: null, validFrom: null, validTo: null };

  const o = makeOverlay({ 'decay-order': note, 'orphan-z': orphan }, ws);
  // Add an unverified edge to test ordering
  o.edges.push({ from: 'note:decay-order', to: 'task/x', kind: 'context', judged: false, by: 'autowire' });

  const q = judge.buildQueue(o);
  const firstDecayIdx = q.findIndex((i) => i.kind === 'decay');
  const lastNonDecayIdx = q.reduce((acc, item, idx) => item.kind !== 'decay' ? idx : acc, -1);
  ok('B8: all decay items come after non-decay items', firstDecayIdx === -1 || firstDecayIdx > lastNonDecayIdx);
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// C. Already-retired notes skipped
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== C. Already-retired notes skipped ===\n');

{
  const ws = makeTmpWs();
  // Note already has validTo set → already soft-retired
  const retired = makeNote('retired-note', OLD_MS, { validTo: new Date().toISOString() });
  seedRows(ws, 'note:retired-note', 0, 5);

  const o = makeOverlay({ 'retired-note': retired }, ws);
  const q = judge.buildQueue(o);
  const decayItems = q.filter((i) => i.kind === 'decay');
  ok('C1: already-retired note (validTo set) skipped', decayItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// D. Zero opportunities (or below threshold) — comprehensive
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== D. Zero / sub-threshold opportunities ===\n');

// D1: workspace with no journal at all
{
  const ws = makeTmpWs();
  const note = makeNote('zero-opp', OLD_MS);
  const o = makeOverlay({ 'zero-opp': note }, ws);
  const q = judge.buildQueue(o);
  ok('D1: note with zero rows in journal → no decay item', q.filter((i) => i.kind === 'decay').length === 0);
  fs.rmSync(ws, { recursive: true });
}

// D2: only pending rows → no resolved signal → no decay item
{
  const ws = makeTmpWs();
  for (let i = 0; i < 5; i++) {
    appendRow(ws, { task_key: `pend/${i}`, recalled_note_keys: ['note:pend-note'], outcome: 'pending', via: 'rag' });
  }
  const note = makeNote('pend-note', OLD_MS);
  const o = makeOverlay({ 'pend-note': note }, ws);
  const q = judge.buildQueue(o);
  ok('D2: only pending rows → no decay item', q.filter((i) => i.kind === 'decay').length === 0);
  fs.rmSync(ws, { recursive: true });
}

// D3: exactly MIN_OPPORTUNITIES - 1 resolved rows → still excluded
{
  const ws = makeTmpWs();
  const count = MIN_OPPORTUNITIES - 1;
  seedRows(ws, 'note:edge-count', 0, count);
  const note = makeNote('edge-count', OLD_MS);
  const o = makeOverlay({ 'edge-count': note }, ws);
  const q = judge.buildQueue(o);
  ok(`D3: exactly ${count} rows (< MIN_OPPORTUNITIES ${MIN_OPPORTUNITIES}) → excluded`, q.filter((i) => i.kind === 'decay').length === 0);
  fs.rmSync(ws, { recursive: true });
}

// D4: exactly MIN_OPPORTUNITIES resolved rows with all losses → included
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:exact-min', 0, MIN_OPPORTUNITIES);
  const note = makeNote('exact-min', OLD_MS);
  const o = makeOverlay({ 'exact-min': note }, ws);
  const q = judge.buildQueue(o);
  ok(`D4: exactly MIN_OPPORTUNITIES=${MIN_OPPORTUNITIES} rows, all losses → included in decay lane`, q.filter((i) => i.kind === 'decay').length === 1);
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
