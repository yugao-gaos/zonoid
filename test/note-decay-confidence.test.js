#!/usr/bin/env node
// Plain Node tests for the note-decay confidence scoring feature (DEG-RAG):
//   A. computeConfidence — scalar score formula
//   B. noteConfidenceMap — convenience map over computeNoteStats
//   C. Filter simulation — confidence floor excludes low-confidence notes,
//      keeps notes with no history, keeps notes at/above floor
//   D. Env var override — CONFIDENCE_FLOOR respected at module init
//
// No daemon, no HTTP, no npm test — plain `node test/note-decay-confidence.test.js`.
'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const {
  appendRow,
  computeConfidence,
  noteConfidenceMap,
  CONFIDENCE_PRIOR,
  CONFIDENCE_FLOOR,
} = require('../lib/recall-outcome-journal');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.error(`FAIL  ${label}`); fail++; }
};

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeTmpWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-conf-test-'));
  fs.mkdirSync(path.join(dir, '.graph'), { recursive: true });
  return dir;
}

// Seed wins/losses for a single note key.
function seedRows(ws, noteKey, wins, losses) {
  for (let i = 0; i < wins; i++) {
    appendRow(ws, { task_key: `seed-w/${noteKey}-${i}`, recalled_note_keys: [noteKey], outcome: 'approve', via: 'rag' });
  }
  for (let i = 0; i < losses; i++) {
    appendRow(ws, { task_key: `seed-l/${noteKey}-${i}`, recalled_note_keys: [noteKey], outcome: 'failed', via: 'rag' });
  }
}

// Approximate equality for floating-point comparisons.
const approxEq = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ──────────────────────────────────────────────────────────────────────────────
// A. computeConfidence
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== A. computeConfidence ===\n');

ok('A0: CONFIDENCE_PRIOR exported and equals 4', CONFIDENCE_PRIOR === 4);

// A1: zero wins (all losses) — winRate=0 regardless of total -> score=0*(n/(n+prior))=0
{
  const stats = { wins: 0, losses: 4, total: 4, winRate: 0 };
  ok('A1: all losses => confidence 0', computeConfidence(stats) === 0);
}

// A2: all wins, high total -> score approaches winRate (winRate=1)
// With wins=100, total=100: 1.0 * (100 / (100 + 4)) approx 0.9615
{
  const total = 100;
  const stats = { wins: total, losses: 0, total, winRate: 1.0 };
  const conf = computeConfidence(stats);
  const expected = 1.0 * (total / (total + CONFIDENCE_PRIOR));
  ok('A2: all-wins high total => near winRate', approxEq(conf, expected));
  ok('A2: score < 1.0 (shrinkage still applies)', conf < 1.0);
  ok('A2: score > 0.9 (high total, small shrinkage)', conf > 0.9);
}

// A3: low total -> score shrunk toward 0
// wins=1, losses=0, total=1, winRate=1: 1.0 * (1/(1+4)) = 0.2
{
  const stats = { wins: 1, losses: 0, total: 1, winRate: 1.0 };
  const conf = computeConfidence(stats);
  const expected = 1.0 * (1 / (1 + CONFIDENCE_PRIOR));
  ok('A3: low total (1) => shrunk toward 0', approxEq(conf, expected));
  ok('A3: low total score == 0.2', approxEq(conf, 0.2));
}

// A4: exact formula check — wins=2, losses=2, total=4, winRate=0.5
// confidence = 0.5 * (4 / (4 + 4)) = 0.5 * 0.5 = 0.25
{
  const stats = { wins: 2, losses: 2, total: 4, winRate: 0.5 };
  const conf = computeConfidence(stats);
  const expected = 0.5 * (4 / (4 + CONFIDENCE_PRIOR));
  ok('A4: exact formula check (wins=2,losses=2)', approxEq(conf, expected));
  ok('A4: exact value == 0.25', approxEq(conf, 0.25));
}

// A5: zero total -> 0 (no-obs guard)
{
  const stats = { wins: 0, losses: 0, total: 0, winRate: 0 };
  ok('A5: total=0 => confidence 0', computeConfidence(stats) === 0);
}

// A6: null/undefined stats -> 0 (defensive)
{
  ok('A6: null stats => confidence 0', computeConfidence(null) === 0);
  ok('A6: undefined stats => confidence 0', computeConfidence(undefined) === 0);
}

// A7: winRate=1, total=4 (exactly CONFIDENCE_PRIOR) -> 0.5
// confidence = 1.0 * (4 / (4 + 4)) = 0.5
{
  const stats = { wins: 4, losses: 0, total: 4, winRate: 1.0 };
  const conf = computeConfidence(stats);
  ok('A7: total == CONFIDENCE_PRIOR, winRate=1 => 0.5', approxEq(conf, 0.5));
}

// ──────────────────────────────────────────────────────────────────────────────
// B. noteConfidenceMap
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== B. noteConfidenceMap ===\n');

// B1: empty journal -> empty map
{
  const ws = makeTmpWs();
  const m = noteConfidenceMap(ws);
  ok('B1: empty journal => empty confidence map', m.size === 0);
  fs.rmSync(ws, { recursive: true });
}

// B2: note with all wins -> confidence > 0
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:conf-win', 5, 0);
  const m = noteConfidenceMap(ws);
  ok('B2: all-wins note in map', m.has('note:conf-win'));
  ok('B2: all-wins note confidence > 0', (m.get('note:conf-win') || 0) > 0);
  fs.rmSync(ws, { recursive: true });
}

// B3: note with all losses -> confidence 0
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:conf-loss', 0, 5);
  const m = noteConfidenceMap(ws);
  ok('B3: all-losses note in map', m.has('note:conf-loss'));
  ok('B3: all-losses note confidence === 0', m.get('note:conf-loss') === 0);
  fs.rmSync(ws, { recursive: true });
}

// B4: maps stats correctly — exact formula
// wins=2, losses=2, total=4, winRate=0.5 -> 0.5*(4/8)=0.25
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:conf-exact', 2, 2);
  const m = noteConfidenceMap(ws);
  ok('B4: exact formula value', approxEq(m.get('note:conf-exact'), 0.25));
  fs.rmSync(ws, { recursive: true });
}

// B5: multiple notes mapped correctly
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:conf-a', 10, 0);  // high confidence
  seedRows(ws, 'note:conf-b', 0, 10);  // zero confidence
  const m = noteConfidenceMap(ws);
  const confA = m.has('note:conf-a') ? m.get('note:conf-a') : 0;
  const confB = m.has('note:conf-b') ? m.get('note:conf-b') : 0;
  ok('B5: high-confidence note > low-confidence note', confA > confB);
  ok('B5: zero-confidence note is 0', m.get('note:conf-b') === 0);
  fs.rmSync(ws, { recursive: true });
}

// B6: pending-only rows -> note not in map (no resolved signal)
{
  const ws = makeTmpWs();
  appendRow(ws, { task_key: 'pend/1', recalled_note_keys: ['note:conf-pend'], outcome: 'pending', via: 'rag' });
  const m = noteConfidenceMap(ws);
  ok('B6: pending-only rows => note absent from confidence map', !m.has('note:conf-pend'));
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// C. Filter simulation — confidence floor injection gate
// ──────────────────────────────────────────────────────────────────────────────
// We simulate the routes/graph.js filter loop directly here, since we cannot
// spawn the daemon. The filter is: for each note-kind item in ragResults,
// if confMap.has(r.key) and confMap.get(r.key) < floor -> exclude.
// Notes absent from confMap -> treat as confidence 1.0 -> always pass.
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== C. Filter simulation ===\n');

const FLOOR = typeof CONFIDENCE_FLOOR === 'number' ? CONFIDENCE_FLOOR : 0.3;

// Build a simulated confMap and apply the filter inline.
function applyFilter(candidates, confMap) {
  const floor = FLOOR;
  const out = [];
  for (const r of candidates) {
    if ((r.kind || 'task') !== 'note') { out.push(r); continue; }
    const conf = confMap.has(r.key) ? confMap.get(r.key) : 1.0;
    if (conf >= floor) out.push(r);
  }
  return out;
}

// C1: note below floor is excluded
{
  const confMap = new Map([['note:bad', 0.1]]);   // below any reasonable floor
  const candidates = [{ key: 'note:bad', kind: 'note', score: 0.9 }];
  const out = applyFilter(candidates, confMap);
  ok('C1: note below floor excluded', out.length === 0);
}

// C2: note with no history (absent from map) -> confidence 1.0 -> kept
{
  const confMap = new Map();  // no entries
  const candidates = [{ key: 'note:new', kind: 'note', score: 0.9 }];
  const out = applyFilter(candidates, confMap);
  ok('C2: note absent from map kept (treated as confidence 1.0)', out.length === 1);
}

// C3: note exactly at floor -> kept (floor is strict <, not <=)
{
  const confMap = new Map([['note:at-floor', FLOOR]]);
  const candidates = [{ key: 'note:at-floor', kind: 'note', score: 0.7 }];
  const out = applyFilter(candidates, confMap);
  ok('C3: note at exactly CONFIDENCE_FLOOR is kept (strict < floor)', out.length === 1);
}

// C4: note above floor -> kept
{
  const confMap = new Map([['note:above-floor', FLOOR + 0.1]]);
  const candidates = [{ key: 'note:above-floor', kind: 'note', score: 0.8 }];
  const out = applyFilter(candidates, confMap);
  ok('C4: note above floor kept', out.length === 1);
}

// C5: non-note-kind items pass through regardless of confidence
{
  const confMap = new Map([['task/1#k0', 0.0], ['task/2', 0.0]]);
  const candidates = [
    { key: 'task/1#k0', kind: 'knowledge', score: 0.5 },
    { key: 'task/2',    kind: 'task',      score: 0.5 },
  ];
  const out = applyFilter(candidates, confMap);
  ok('C5: knowledge item passes through filter', out.some((r) => r.key === 'task/1#k0'));
  ok('C5: task item passes through filter', out.some((r) => r.key === 'task/2'));
}

// C6: mixed batch — only low-confidence notes excluded
{
  const confMap = new Map([
    ['note:below', 0.05],
    ['note:above', 0.9],
  ]);
  const candidates = [
    { key: 'note:below',   kind: 'note',      score: 0.8 },
    { key: 'note:above',   kind: 'note',      score: 0.7 },
    { key: 'note:no-hist', kind: 'note',      score: 0.6 },  // not in map -> pass
    { key: 'task/1#k0',    kind: 'knowledge', score: 0.5 },
  ];
  const out = applyFilter(candidates, confMap);
  ok('C6: below-floor note excluded', !out.some((r) => r.key === 'note:below'));
  ok('C6: above-floor note kept', out.some((r) => r.key === 'note:above'));
  ok('C6: no-history note kept', out.some((r) => r.key === 'note:no-hist'));
  ok('C6: knowledge item kept', out.some((r) => r.key === 'task/1#k0'));
}

// C7: live integration — seed journal and build real confidence map, then filter
{
  const ws = makeTmpWs();
  // note:high — 10 wins -> near-winRate confidence
  seedRows(ws, 'note:high', 10, 0);
  // note:low — 0 wins, 10 losses -> confidence 0
  seedRows(ws, 'note:low', 0, 10);
  // note:mid — 2 wins, 2 losses, total=4 -> confidence 0.25 (below default floor 0.3: excluded)
  seedRows(ws, 'note:mid', 2, 2);
  // note:fresh — not in journal -> treated as 1.0 -> kept

  const confMap = noteConfidenceMap(ws);
  const candidates = [
    { key: 'note:high',  kind: 'note', score: 0.9 },
    { key: 'note:low',   kind: 'note', score: 0.8 },
    { key: 'note:mid',   kind: 'note', score: 0.7 },
    { key: 'note:fresh', kind: 'note', score: 0.6 },
  ];
  const out = applyFilter(candidates, confMap);

  ok('C7: high-confidence note kept', out.some((r) => r.key === 'note:high'));
  ok('C7: zero-confidence note excluded', !out.some((r) => r.key === 'note:low'));
  ok('C7: fresh (no-history) note kept', out.some((r) => r.key === 'note:fresh'));
  // note:mid: confidence = 0.5*(4/8)=0.25; default floor=0.3; 0.25 < 0.3 -> excluded
  if (FLOOR === 0.3) {
    ok('C7: mid-confidence (0.25) below default floor 0.3 => excluded', !out.some((r) => r.key === 'note:mid'));
  } else {
    ok('C7: env-override active, skip mid assertion', true);
  }
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// D. Env var override
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== D. Env var override ===\n');

// D1: CONFIDENCE_FLOOR exported value matches default (0.3) unless env var is set at this run.
{
  const envVal = parseFloat(process.env.CONFIDENCE_FLOOR);
  const expected = Number.isFinite(envVal) ? envVal : 0.3;
  ok('D1: CONFIDENCE_FLOOR exported value matches env-or-default', approxEq(CONFIDENCE_FLOOR, expected));
}

// D2: CONFIDENCE_FLOOR is a number in [0,1]
{
  ok('D2: CONFIDENCE_FLOOR is a finite number', Number.isFinite(CONFIDENCE_FLOOR));
  ok('D2: CONFIDENCE_FLOOR >= 0', CONFIDENCE_FLOOR >= 0);
  ok('D2: CONFIDENCE_FLOOR <= 1', CONFIDENCE_FLOOR <= 1);
}

// D3: CONFIDENCE_PRIOR is exported and equals 4
{
  ok('D3: CONFIDENCE_PRIOR exported as 4', CONFIDENCE_PRIOR === 4);
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
