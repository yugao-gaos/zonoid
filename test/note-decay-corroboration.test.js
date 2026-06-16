#!/usr/bin/env node
// Plain Node tests for note-decay sub-feature C — corroboration threshold.
//
// A new note must appear in >= CORROBORATION_MIN resolved task journals before it
// is inject-eligible via RAG. This prevents untested notes from polluting context.
//
// Sections:
//   1. isCorroborated — unit tests (below/at/above threshold, absent note)
//   2. Map-overload   — stat map passed directly (no FS IO)
//   3. Filter integration — note items with total < CORROBORATION_MIN excluded from ragResults
//
// No daemon, no HTTP, no npm test. Run: node test/note-decay-corroboration.test.js
'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const {
  appendRow,
  computeNoteStats,
  isCorroborated,
  CORROBORATION_MIN,
} = require('../lib/recall-outcome-journal');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.error(`FAIL  ${label}`); fail++; }
};

// Create a temp workspace with a .graph subdir.
function makeTmpWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-corr-test-'));
  fs.mkdirSync(path.join(dir, '.graph'), { recursive: true });
  return dir;
}

// Seed resolved rows for a given noteKey.
function seedRows(ws, noteKey, count) {
  for (let i = 0; i < count; i++) {
    appendRow(ws, { task_key: `task/corr-${noteKey}-${i}`, recalled_note_keys: [noteKey], outcome: 'approve', via: 'rag' });
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. isCorroborated unit tests (filesystem overload — takes ws string)
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== 1. isCorroborated (filesystem) ===\n');

ok(`CORROBORATION_MIN is a positive integer >= 1`, Number.isInteger(CORROBORATION_MIN) && CORROBORATION_MIN >= 1);

// 1a: note not in journal at all
{
  const ws = makeTmpWs();
  ok('1a: note absent from journal -> false', isCorroborated('note:absent', ws) === false);
  fs.rmSync(ws, { recursive: true });
}

// 1b: note below threshold
{
  const ws = makeTmpWs();
  const count = CORROBORATION_MIN - 1;
  seedRows(ws, 'note:below', count);
  ok(`1b: note with ${count} rows (below threshold ${CORROBORATION_MIN}) -> false`,
    isCorroborated('note:below', ws) === false);
  fs.rmSync(ws, { recursive: true });
}

// 1c: note at exactly threshold
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:exact', CORROBORATION_MIN);
  ok(`1c: note with exactly ${CORROBORATION_MIN} rows (at threshold) -> true`,
    isCorroborated('note:exact', ws) === true);
  fs.rmSync(ws, { recursive: true });
}

// 1d: note above threshold
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:above', CORROBORATION_MIN + 3);
  ok(`1d: note with ${CORROBORATION_MIN + 3} rows (above threshold) -> true`,
    isCorroborated('note:above', ws) === true);
  fs.rmSync(ws, { recursive: true });
}

// 1e: pending rows only — not corroborated (pending rows do not count)
{
  const ws = makeTmpWs();
  for (let i = 0; i < CORROBORATION_MIN + 2; i++) {
    appendRow(ws, { task_key: `task/pend-${i}`, recalled_note_keys: ['note:pend'], outcome: 'pending', via: 'rag' });
  }
  ok('1e: pending-only rows -> not corroborated', isCorroborated('note:pend', ws) === false);
  fs.rmSync(ws, { recursive: true });
}

// 1f: mix of loss and win outcomes both count toward total
{
  const ws = makeTmpWs();
  appendRow(ws, { task_key: 'task/mix-w', recalled_note_keys: ['note:mix'], outcome: 'approve', via: 'rag' });
  appendRow(ws, { task_key: 'task/mix-l', recalled_note_keys: ['note:mix'], outcome: 'failed',  via: 'rag' });
  const expected = CORROBORATION_MIN <= 2;
  ok(`1f: 1 win + 1 loss (total=2) -> ${expected ? 'true' : 'false'} (CORROBORATION_MIN=${CORROBORATION_MIN})`,
    isCorroborated('note:mix', ws) === expected);
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. Map overload — pre-computed stats map, no filesystem IO
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== 2. Map overload (statsMap direct) ===\n');

// Build a Map manually instead of reading from disk.
function buildStatsMap(entries) {
  const m = new Map();
  for (const [key, total] of entries) {
    m.set(key, { wins: total, losses: 0, total, winRate: 1 });
  }
  return m;
}

// 2a: below threshold via Map
{
  const statsMap = buildStatsMap([['note:map-low', CORROBORATION_MIN - 1]]);
  ok('2a: Map overload — below threshold -> false',
    isCorroborated('note:map-low', statsMap) === false);
}

// 2b: at threshold via Map
{
  const statsMap = buildStatsMap([['note:map-exact', CORROBORATION_MIN]]);
  ok('2b: Map overload — at threshold -> true',
    isCorroborated('note:map-exact', statsMap) === true);
}

// 2c: absent key in Map
{
  const statsMap = buildStatsMap([]);
  ok('2c: Map overload — absent key -> false',
    isCorroborated('note:not-in-map', statsMap) === false);
}

// 2d: Map overload does NOT touch filesystem
{
  const statsMap = buildStatsMap([['note:map-bypass', CORROBORATION_MIN]]);
  let threw = false;
  let result;
  try {
    // Deliberately pass a Map (not a path string) — FS must not be touched.
    result = isCorroborated('note:map-bypass', statsMap);
  } catch (_e) {
    threw = true;
  }
  ok('2d: Map overload — result is true', result === true);
  ok('2d: Map overload — no FS throw', !threw);
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Filter integration — simulate the ragResults corroboration filter
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== 3. Filter integration (ragResults corroboration filter) ===\n');

// Mirror the filter logic from routes/graph.js for isolated testing.
function applyCorroborationFilter(ragResults, ws) {
  const corrStats = computeNoteStats(ws);
  for (let ci = ragResults.length - 1; ci >= 0; ci--) {
    const r = ragResults[ci];
    if ((r.kind || 'task') !== 'note') continue;
    if (!isCorroborated(r.key, corrStats)) {
      ragResults.splice(ci, 1);
    }
  }
  return ragResults;
}

// 3a: uncorroborated note is removed; corroborated note is kept
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:corr-good', CORROBORATION_MIN);

  const ragResults = [
    { key: 'note:corr-good', kind: 'note', score: 0.9, tier: 'rag' },
    { key: 'note:corr-new',  kind: 'note', score: 0.8, tier: 'rag' },
  ];

  applyCorroborationFilter(ragResults, ws);

  ok('3a: corroborated note retained', ragResults.some((r) => r.key === 'note:corr-good'));
  ok('3a: uncorroborated note removed', !ragResults.some((r) => r.key === 'note:corr-new'));
  fs.rmSync(ws, { recursive: true });
}

// 3b: non-note items (tasks, knowledge) are NOT filtered
{
  const ws = makeTmpWs();

  const ragResults = [
    { key: 'task/foo',      kind: 'task',      score: 0.7, tier: 'rag' },
    { key: 'task/foo#k0',   kind: 'knowledge', score: 0.6, tier: 'rag' },
  ];

  applyCorroborationFilter(ragResults, ws);

  ok('3b: task item not filtered', ragResults.some((r) => r.key === 'task/foo'));
  ok('3b: knowledge item not filtered', ragResults.some((r) => r.key === 'task/foo#k0'));
  fs.rmSync(ws, { recursive: true });
}

// 3c: all notes uncorroborated — empty after filter; non-notes survive
{
  const ws = makeTmpWs();

  const ragResults = [
    { key: 'note:new1',   kind: 'note',      score: 0.9, tier: 'rag' },
    { key: 'note:new2',   kind: 'note',      score: 0.8, tier: 'rag' },
    { key: 'task/bar',    kind: 'task',      score: 0.5, tier: 'rag' },
    { key: 'task/baz#k0', kind: 'knowledge', score: 0.4, tier: 'rag' },
  ];

  applyCorroborationFilter(ragResults, ws);

  ok('3c: uncorroborated notes both removed', !ragResults.some((r) => r.kind === 'note'));
  ok('3c: task survives', ragResults.some((r) => r.key === 'task/bar'));
  ok('3c: knowledge survives', ragResults.some((r) => r.key === 'task/baz#k0'));
  fs.rmSync(ws, { recursive: true });
}

// 3d: note reaching exactly CORROBORATION_MIN rows is kept
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:edge-corr', CORROBORATION_MIN);

  const ragResults = [
    { key: 'note:edge-corr', kind: 'note', score: 0.75, tier: 'rag' },
  ];

  applyCorroborationFilter(ragResults, ws);

  ok(`3d: note with exactly ${CORROBORATION_MIN} rows is kept`, ragResults.length === 1);
  fs.rmSync(ws, { recursive: true });
}

// 3e: note with CORROBORATION_MIN - 1 rows is removed
{
  const ws = makeTmpWs();
  if (CORROBORATION_MIN > 1) {
    seedRows(ws, 'note:one-short', CORROBORATION_MIN - 1);
    const ragResults = [
      { key: 'note:one-short', kind: 'note', score: 0.7, tier: 'rag' },
    ];
    applyCorroborationFilter(ragResults, ws);
    ok(`3e: note with ${CORROBORATION_MIN - 1} rows (one short) is removed`, ragResults.length === 0);
  } else {
    ok('3e: CORROBORATION_MIN is 1 — any resolved row is enough (boundary not applicable)', true);
  }
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
