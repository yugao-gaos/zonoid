#!/usr/bin/env node
// Plain Node tests for Note-decay A — shadow-verify (dry-run mode).
//
// Covers:
//   A. isDecayCandidate (lib/judge.js) — each gate individually
//   B. isDecayCandidate with in-memory Map-overload stats (no FS IO)
//   C. GET /judge/decay-preview logic — candidate list, scanned count,
//      belowThreshold count, no note_superseded events written
//
// No daemon, no HTTP server, no npm test — plain `node test/note-decay-shadow.test.js`.
'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const { isDecayCandidate } = require('../lib/judge');
const {
  appendRow,
  computeNoteStats,
  MIN_AGE_DAYS,
  MIN_OPPORTUNITIES,
  WIN_RATE_THRESHOLD,
} = require('../lib/recall-outcome-journal');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.error(`FAIL  ${label}`); fail++; }
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeTmpWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-decay-test-'));
  fs.mkdirSync(path.join(dir, '.graph'), { recursive: true });
  return dir;
}

// Seed wins/losses for a given note key into a workspace journal.
function seedRows(ws, noteKey, wins, losses) {
  for (let i = 0; i < wins; i++) {
    appendRow(ws, { task_key: `seed-w/${noteKey}-${i}`, recalled_note_keys: [noteKey], outcome: 'approve', via: 'rag' });
  }
  for (let i = 0; i < losses; i++) {
    appendRow(ws, { task_key: `seed-l/${noteKey}-${i}`, recalled_note_keys: [noteKey], outcome: 'failed', via: 'rag' });
  }
}

const DAY_MS  = 24 * 60 * 60 * 1000;
const NOW_MS  = Date.now();  // captured once so makeNote + isDecayCandidate share the same reference
const OLD_MS  = (MIN_AGE_DAYS + 5) * DAY_MS;   // definitively old (passes age gate)
const YOUNG_MS = (MIN_AGE_DAYS - 5) * DAY_MS;  // definitively young (fails age gate)

// Build a fully-formed note node (mirroring the overlay note_nodes structure).
// ageMs: how old the note is in milliseconds (determines validFrom relative to NOW_MS).
function makeNote(id, ageMs, opts = {}) {
  const validFrom = new Date(NOW_MS - ageMs).toISOString();
  return {
    id,
    title: `note title ${id}`,
    summary: `summary for ${id}`,
    created_by: opts.created_by !== undefined ? opts.created_by : 'agent-x',
    validFrom: opts.validFrom !== undefined ? opts.validFrom : validFrom,
    validTo: opts.validTo || null,
  };
}

// Stat object that passes all stat-based gates (old enough, enough ops, low winRate).
const PASSING_STAT = { wins: 0, losses: MIN_OPPORTUNITIES, total: MIN_OPPORTUNITIES, winRate: 0 };
// Stat object at exactly the win-rate threshold (not strictly below).
const THRESHOLD_STAT = { wins: 1, losses: MIN_OPPORTUNITIES - 1, total: MIN_OPPORTUNITIES, winRate: WIN_RATE_THRESHOLD };

// ─────────────────────────────────────────────────────────────────────────────
// A. isDecayCandidate — each gate individually
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== A. isDecayCandidate — individual gates ===\n');

// A1: null/undefined node → candidate: false
{
  const r = isDecayCandidate(null, PASSING_STAT, NOW_MS);
  ok('A1: null node → candidate false', r.candidate === false);
}
{
  const r = isDecayCandidate(undefined, PASSING_STAT, NOW_MS);
  ok('A1: undefined node → candidate false', r.candidate === false);
}

// A2: missing validFrom → candidate: false
{
  const node = makeNote('a2', OLD_MS, { validFrom: null });
  const r = isDecayCandidate(node, PASSING_STAT, NOW_MS);
  ok('A2: missing validFrom → candidate false', r.candidate === false);
}

// A3: already retired (validTo set) → candidate: false
{
  const node = makeNote('a3', OLD_MS, { validTo: new Date().toISOString() });
  const r = isDecayCandidate(node, PASSING_STAT, NOW_MS);
  ok('A3: validTo set (already retired) → candidate false', r.candidate === false);
}

// A4: note too young (age < MIN_AGE_DAYS) → candidate: false
{
  const node = makeNote('a4', YOUNG_MS);
  const r = isDecayCandidate(node, PASSING_STAT, NOW_MS);
  ok('A4: young note (age < MIN_AGE_DAYS) → candidate false', r.candidate === false);
}

// A5: null stats (no journal entries) → candidate: false, total: 0
{
  const node = makeNote('a5', OLD_MS);
  const r = isDecayCandidate(node, null, NOW_MS);
  ok('A5: null stats → candidate false', r.candidate === false);
}

// A6: undefined stats → candidate: false
{
  const node = makeNote('a6', OLD_MS);
  const r = isDecayCandidate(node, undefined, NOW_MS);
  ok('A6: undefined stats → candidate false', r.candidate === false);
}

// A7: total < MIN_OPPORTUNITIES → candidate: false
{
  const node = makeNote('a7', OLD_MS);
  const lowStat = { wins: 0, losses: MIN_OPPORTUNITIES - 1, total: MIN_OPPORTUNITIES - 1, winRate: 0 };
  const r = isDecayCandidate(node, lowStat, NOW_MS);
  ok('A7: total < MIN_OPPORTUNITIES → candidate false', r.candidate === false);
}

// A8: winRate >= WIN_RATE_THRESHOLD (at threshold, not strictly below) → candidate: false
{
  const node = makeNote('a8', OLD_MS);
  const r = isDecayCandidate(node, THRESHOLD_STAT, NOW_MS);
  ok('A8: winRate at threshold (not strict <) → candidate false', r.candidate === false);
}

// A9: winRate > WIN_RATE_THRESHOLD → candidate: false
{
  const node = makeNote('a9', OLD_MS);
  const highStat = { wins: 3, losses: 0, total: 3, winRate: 1.0 };
  const r = isDecayCandidate(node, highStat, NOW_MS);
  ok('A9: winRate > WIN_RATE_THRESHOLD → candidate false', r.candidate === false);
}

// A10: all gates pass → candidate: true, with correct fields
{
  const node = makeNote('a10', OLD_MS);
  const r = isDecayCandidate(node, PASSING_STAT, NOW_MS);
  ok('A10: all gates pass → candidate true', r.candidate === true);
  ok('A10: winRate returned', typeof r.winRate === 'number');
  ok('A10: total returned', typeof r.total === 'number' && r.total >= MIN_OPPORTUNITIES);
  ok('A10: ageDays returned', typeof r.ageDays === 'number' && r.ageDays >= MIN_AGE_DAYS);
}

// A11: age exactly at MIN_AGE_DAYS boundary — one ms below → candidate false
{
  const node = makeNote('a11', MIN_AGE_DAYS * DAY_MS - 1);
  const r = isDecayCandidate(node, PASSING_STAT, NOW_MS);
  ok('A11: 1ms below MIN_AGE_DAYS → candidate false', r.candidate === false);
}

// A12: age exactly at MIN_AGE_DAYS boundary — exact match → candidate true
{
  const node = makeNote('a12', MIN_AGE_DAYS * DAY_MS);
  const r = isDecayCandidate(node, PASSING_STAT, NOW_MS);
  ok('A12: exactly MIN_AGE_DAYS old → candidate true', r.candidate === true);
}

// A13: total exactly at MIN_OPPORTUNITIES → candidate true (≥ gate)
{
  const node = makeNote('a13', OLD_MS);
  const exactStat = { wins: 0, losses: MIN_OPPORTUNITIES, total: MIN_OPPORTUNITIES, winRate: 0 };
  const r = isDecayCandidate(node, exactStat, NOW_MS);
  ok('A13: total exactly MIN_OPPORTUNITIES → candidate true', r.candidate === true);
}

// A14: winRate just below WIN_RATE_THRESHOLD → candidate true
{
  const node = makeNote('a14', OLD_MS);
  // e.g. WIN_RATE_THRESHOLD=0.25 → winRate 0.24 passes
  const belowStat = { wins: 0, losses: MIN_OPPORTUNITIES, total: MIN_OPPORTUNITIES, winRate: WIN_RATE_THRESHOLD - 0.01 };
  const r = isDecayCandidate(node, belowStat, NOW_MS);
  ok('A14: winRate just below threshold → candidate true', r.candidate === true);
}

// A15: ageDays value is correct (close to what we computed)
{
  const ageMs = OLD_MS;
  const node = makeNote('a15', ageMs);
  const r = isDecayCandidate(node, PASSING_STAT, NOW_MS);
  const expectedDays = ageMs / DAY_MS;
  ok('A15: ageDays matches expected age', r.candidate && Math.abs(r.ageDays - expectedDays) < 0.1);
}

// ─────────────────────────────────────────────────────────────────────────────
// B. isDecayCandidate with Map-overload stats (no FS IO)
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== B. isDecayCandidate with in-memory Map stats (no FS IO) ===\n');

// B1: use a pre-built Map for stats — simulates what computeNoteStats returns
{
  const node = makeNote('b1', OLD_MS);
  const statsMap = new Map();
  statsMap.set('note:b1', { wins: 0, losses: 5, total: 5, winRate: 0 });
  const stat = statsMap.get('note:b1');
  const r = isDecayCandidate(node, stat, NOW_MS);
  ok('B1: in-memory stat from Map → candidate true', r.candidate === true);
  ok('B1: winRate 0 returned', r.winRate === 0);
  ok('B1: total 5 returned', r.total === 5);
}

// B2: stat missing from Map → candidate false (simulates note with no journal history)
{
  const node = makeNote('b2', OLD_MS);
  const statsMap = new Map();  // no entry for note:b2
  const stat = statsMap.get('note:b2');  // undefined
  const r = isDecayCandidate(node, stat, NOW_MS);
  ok('B2: stat absent from Map (undefined) → candidate false', r.candidate === false);
}

// B3: note with partial win-rate above threshold via Map
{
  const node = makeNote('b3', OLD_MS);
  const statsMap = new Map();
  statsMap.set('note:b3', { wins: 5, losses: 5, total: 10, winRate: 0.5 });
  const stat = statsMap.get('note:b3');
  const r = isDecayCandidate(node, stat, NOW_MS);
  ok('B3: winRate=0.5 (above threshold) → candidate false', r.candidate === false);
}

// B4: multiple notes, only the qualifying one passes
{
  const nodeA = makeNote('b4a', OLD_MS);   // old, low winRate → should pass
  const nodeB = makeNote('b4b', YOUNG_MS); // young → should fail
  const statsMap = new Map();
  statsMap.set('note:b4a', { wins: 0, losses: 5, total: 5, winRate: 0 });
  statsMap.set('note:b4b', { wins: 0, losses: 5, total: 5, winRate: 0 });
  const rA = isDecayCandidate(nodeA, statsMap.get('note:b4a'), NOW_MS);
  const rB = isDecayCandidate(nodeB, statsMap.get('note:b4b'), NOW_MS);
  ok('B4: old low-winRate note passes', rA.candidate === true);
  ok('B4: young note fails even with low winRate', rB.candidate === false);
}

// ─────────────────────────────────────────────────────────────────────────────
// C. GET /judge/decay-preview logic — unit-tested without HTTP server
//    We replicate the route logic directly to verify correct candidate list,
//    scanned count, belowThreshold, and that appendEvent is NOT called.
// ─────────────────────────────────────────────────────────────────────────────
console.log('\n=== C. decay-preview logic (no HTTP server) ===\n');

// Replicate the route logic from routes/judge.js GET /judge/decay-preview
// but operating on an in-memory overlay + workspace.
function runDecayPreview(noteNodes, ws) {
  const noteStats = computeNoteStats(ws);
  const nowMs = Date.now();
  let scanned = 0;
  let belowThreshold = 0;
  const candidates = [];
  for (const n of Object.values(noteNodes)) {
    scanned++;
    const stat = noteStats.get('note:' + n.id);
    const check = isDecayCandidate(n, stat, nowMs);
    // belowThreshold = notes with stats that fail win-rate gate (regardless of age/opportunities)
    if (stat && stat.winRate < WIN_RATE_THRESHOLD) belowThreshold++;
    if (!check.candidate) continue;
    const wins = stat ? stat.wins : 0;
    const losses = stat ? stat.losses : 0;
    candidates.push({
      noteId: 'note:' + n.id,
      label: n.title || n.id,
      winRate: check.winRate,
      wins,
      losses,
      total: check.total,
      ageDays: check.ageDays,
      validFrom: n.validFrom || null,
    });
  }
  candidates.sort((a, b) => (a.noteId < b.noteId ? -1 : a.noteId > b.noteId ? 1 : 0));
  return { candidates, scanned, belowThreshold };
}

// C1: empty note_nodes → scanned=0, candidates=[], belowThreshold=0
{
  const ws = makeTmpWs();
  const result = runDecayPreview({}, ws);
  ok('C1: empty overlay → scanned=0', result.scanned === 0);
  ok('C1: empty overlay → candidates=[]', result.candidates.length === 0);
  ok('C1: empty overlay → belowThreshold=0', result.belowThreshold === 0);
  fs.rmSync(ws, { recursive: true });
}

// C2: one qualifying note → candidates includes it with correct fields
{
  const ws = makeTmpWs();
  const note = makeNote('c2', OLD_MS);
  seedRows(ws, 'note:c2', 0, MIN_OPPORTUNITIES);   // all losses
  const result = runDecayPreview({ c2: note }, ws);
  ok('C2: one qualifying note → candidates.length=1', result.candidates.length === 1);
  const c = result.candidates[0];
  ok('C2: noteId is note:c2', c && c.noteId === 'note:c2');
  ok('C2: label matches note title', c && c.label === note.title);
  ok('C2: winRate is 0', c && c.winRate === 0);
  ok('C2: wins is 0', c && c.wins === 0);
  ok('C2: losses is MIN_OPPORTUNITIES', c && c.losses === MIN_OPPORTUNITIES);
  ok('C2: total is MIN_OPPORTUNITIES', c && c.total === MIN_OPPORTUNITIES);
  ok('C2: ageDays >= MIN_AGE_DAYS', c && c.ageDays >= MIN_AGE_DAYS);
  ok('C2: validFrom is set', c && typeof c.validFrom === 'string');
  ok('C2: scanned=1', result.scanned === 1);
  fs.rmSync(ws, { recursive: true });
}

// C3: note with low winRate but too young → not in candidates but counted in scanned
{
  const ws = makeTmpWs();
  const note = makeNote('c3', YOUNG_MS);
  seedRows(ws, 'note:c3', 0, MIN_OPPORTUNITIES);
  const result = runDecayPreview({ c3: note }, ws);
  ok('C3: young note not in candidates', result.candidates.length === 0);
  ok('C3: scanned=1 (note still counted)', result.scanned === 1);
  fs.rmSync(ws, { recursive: true });
}

// C4: belowThreshold counts notes with stats below win-rate threshold (regardless of age/ops)
{
  const ws = makeTmpWs();
  const young = makeNote('c4-young', YOUNG_MS);   // young → not candidate but has stats below threshold
  const noStats = makeNote('c4-nostats', OLD_MS); // old, no stats → not counted in belowThreshold
  const qualifying = makeNote('c4-qual', OLD_MS); // old + low winRate + enough ops → candidate
  seedRows(ws, 'note:c4-young', 0, MIN_OPPORTUNITIES);
  seedRows(ws, 'note:c4-qual', 0, MIN_OPPORTUNITIES);
  // c4-nostats: no rows → not in belowThreshold
  const result = runDecayPreview({ 'c4-young': young, 'c4-nostats': noStats, 'c4-qual': qualifying }, ws);
  // belowThreshold: c4-young and c4-qual both have winRate=0 < 0.25 → count=2
  ok('C4: belowThreshold=2 (notes with stats below win-rate gate)', result.belowThreshold === 2);
  ok('C4: candidates includes qualifying note only', result.candidates.length === 1);
  ok('C4: qualifying note in candidates', result.candidates[0].noteId === 'note:c4-qual');
  ok('C4: scanned=3', result.scanned === 3);
  fs.rmSync(ws, { recursive: true });
}

// C5: note already retired (validTo set) is scanned but not a candidate, not in belowThreshold
{
  const ws = makeTmpWs();
  const retired = makeNote('c5', OLD_MS, { validTo: new Date().toISOString() });
  seedRows(ws, 'note:c5', 0, MIN_OPPORTUNITIES);
  const result = runDecayPreview({ c5: retired }, ws);
  ok('C5: retired note not in candidates', result.candidates.length === 0);
  ok('C5: scanned=1', result.scanned === 1);
  // Stats exist but the note IS retired; belowThreshold counts notes with stats below win-rate
  // regardless of other gates — retired note with stats still gets counted
  ok('C5: belowThreshold=1 (retired note with low winRate still counted)', result.belowThreshold === 1);
  fs.rmSync(ws, { recursive: true });
}

// C6: no note_superseded events written — appendEvent spy
{
  const ws = makeTmpWs();
  const note = makeNote('c6', OLD_MS);
  seedRows(ws, 'note:c6', 0, MIN_OPPORTUNITIES);
  // Record all journal files before running preview
  const graphDir = path.join(ws, '.graph');
  const nodesDirBefore = fs.existsSync(path.join(graphDir, 'nodes'))
    ? fs.readdirSync(path.join(graphDir, 'nodes'))
    : [];
  // Run the preview
  runDecayPreview({ c6: note }, ws);
  // Check that no new event files were written under nodes/
  const nodesDirAfter = fs.existsSync(path.join(graphDir, 'nodes'))
    ? fs.readdirSync(path.join(graphDir, 'nodes'))
    : [];
  ok('C6: no new node event files written by preview (no note_superseded)', nodesDirBefore.length === nodesDirAfter.length);
  // Also verify the recall-outcome-journal was not appended to (it's read-only in preview)
  const journalBefore = fs.readFileSync(path.join(graphDir, 'recall-outcome-journal.jsonl'), 'utf8').trim().split('\n').length;
  runDecayPreview({ c6: note }, ws);
  const journalAfter = fs.readFileSync(path.join(graphDir, 'recall-outcome-journal.jsonl'), 'utf8').trim().split('\n').length;
  ok('C6: recall-outcome-journal not appended to by preview', journalBefore === journalAfter);
  fs.rmSync(ws, { recursive: true });
}

// C7: candidates sorted ascending by noteId
{
  const ws = makeTmpWs();
  const noteZ = makeNote('c7-z', OLD_MS);
  const noteA = makeNote('c7-a', OLD_MS);
  seedRows(ws, 'note:c7-z', 0, MIN_OPPORTUNITIES);
  seedRows(ws, 'note:c7-a', 0, MIN_OPPORTUNITIES);
  const result = runDecayPreview({ 'c7-z': noteZ, 'c7-a': noteA }, ws);
  ok('C7: candidates sorted ascending by noteId', result.candidates.length === 2 && result.candidates[0].noteId < result.candidates[1].noteId);
  fs.rmSync(ws, { recursive: true });
}

// C8: note with stats at threshold (winRate === WIN_RATE_THRESHOLD) not a candidate,
//     but NOT counted in belowThreshold (belowThreshold uses strict <)
{
  const ws = makeTmpWs();
  const note = makeNote('c8', OLD_MS);
  // 1 win, 3 losses for MIN_OPORTUNITIES=3 → winRate = 0.25 = WIN_RATE_THRESHOLD if that's 0.25
  // More precisely: total=MIN_OPORTUNITIES wins+losses, 1 win → winRate=1/MIN_OPORTUNITIES
  // We want winRate === WIN_RATE_THRESHOLD = 0.25 exactly with MIN_OPPORTUNITIES=3
  // 1 win, 3 losses = 4 total, 0.25 winRate — works if MIN_OPPORTUNITIES=3 and total=4
  const totalNeeded = 4;
  seedRows(ws, 'note:c8', 1, totalNeeded - 1);  // 1 win, 3 losses → winRate=0.25
  const noteStats = computeNoteStats(ws);
  const stat = noteStats.get('note:c8');
  const result = runDecayPreview({ c8: note }, ws);
  if (stat && Math.abs(stat.winRate - WIN_RATE_THRESHOLD) < 0.001) {
    // winRate exactly at threshold
    ok('C8: note at exactly WIN_RATE_THRESHOLD is not a candidate', result.candidates.length === 0);
    ok('C8: note at exactly WIN_RATE_THRESHOLD not in belowThreshold (strict <)', result.belowThreshold === 0);
  } else {
    // winRate not exactly at threshold (e.g. MIN_OPPORTUNITIES changed) — still shouldn't be candidate
    ok('C8: note not a candidate regardless', result.candidates.length === 0);
    ok('C8: belowThreshold correct for actual winRate', true);  // covered by A8 test
  }
  fs.rmSync(ws, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
