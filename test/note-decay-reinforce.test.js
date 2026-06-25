#!/usr/bin/env node
// Plain Node tests for the note-decay reinforce lane (pass 5):
//   A. computeNoteBoost — zero below threshold, linear ramp, max cap, insufficient opportunities
//   B. buildQueue reinforce lane — gate conditions (note flag, validTo, boost > 0)
//   C. note_reinforced event in graph-store — reinforceBoost accumulation, reinforceWinRate
//
// No daemon, no HTTP, no npm test — plain `node test/note-decay-reinforce.test.js`.
'use strict';

const os   = require('os');
const fs   = require('fs');
const path = require('path');

const {
  appendRow,
  computeNoteBoost,
  REINFORCE_WIN_RATE_THRESHOLD,
  REINFORCE_MAX_BOOST,
  MIN_OPPORTUNITIES,
  computeNoteStats,
} = require('../lib/recall-outcome-journal');

const judge = require('../lib/judge');
const graphStore = require('../lib/graph-store');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.error(`FAIL  ${label}`); fail++; }
};

const approxEq = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeTmpWs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-reinforce-test-'));
  fs.mkdirSync(path.join(dir, '.graph'), { recursive: true });
  return dir;
}

function seedRows(ws, noteKey, wins, losses) {
  for (let i = 0; i < wins; i++) {
    appendRow(ws, { task_key: `seed-w/${noteKey}-${i}`, recalled_note_keys: [noteKey], outcome: 'approve', via: 'rag' });
  }
  for (let i = 0; i < losses; i++) {
    appendRow(ws, { task_key: `seed-l/${noteKey}-${i}`, recalled_note_keys: [noteKey], outcome: 'failed', via: 'rag' });
  }
}

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

function makeNote(id, opts = {}) {
  return {
    id,
    title: `note title ${id}`,
    summary: `summary for ${id}`,
    created_by: opts.created_by || 'agent-x',
    validFrom: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    validTo: opts.validTo || null,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// A. computeNoteBoost
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== A. computeNoteBoost ===\n');

ok('A0: REINFORCE_WIN_RATE_THRESHOLD exported', typeof REINFORCE_WIN_RATE_THRESHOLD === 'number' && REINFORCE_WIN_RATE_THRESHOLD === 0.75);
ok('A0: REINFORCE_MAX_BOOST exported', typeof REINFORCE_MAX_BOOST === 'number' && REINFORCE_MAX_BOOST === 0.2);

// A1: zero observations — boost must be 0
{
  const ws = makeTmpWs();
  // No rows for this note
  const statsMap = computeNoteStats(ws);
  const boost = computeNoteBoost('note:zero-obs', statsMap);
  ok('A1: zero observations => boost 0', boost === 0);
  fs.rmSync(ws, { recursive: true });
}

// A2: below MIN_OPPORTUNITIES — boost must be 0 even if winRate is very high
{
  const ws = makeTmpWs();
  const count = MIN_OPPORTUNITIES - 1;
  seedRows(ws, 'note:sub-min', count, 0);   // all wins, but too few
  const statsMap = computeNoteStats(ws);
  const boost = computeNoteBoost('note:sub-min', statsMap);
  ok(`A2: ${count} obs (< MIN_OPPORTUNITIES ${MIN_OPPORTUNITIES}) => boost 0`, boost === 0);
  fs.rmSync(ws, { recursive: true });
}

// A3: win rate below REINFORCE_WIN_RATE_THRESHOLD — boost must be 0
{
  const ws = makeTmpWs();
  // 1 win, 3 losses → winRate = 0.25 < 0.75
  seedRows(ws, 'note:low-win', 1, 3);
  const statsMap = computeNoteStats(ws);
  const boost = computeNoteBoost('note:low-win', statsMap);
  ok('A3: winRate < threshold => boost 0', boost === 0);
  fs.rmSync(ws, { recursive: true });
}

// A4: win rate exactly at threshold (0.75) — linear ramp starts at 0; boost must be 0
{
  const ws = makeTmpWs();
  // 3 wins, 1 loss → winRate = 0.75 = REINFORCE_WIN_RATE_THRESHOLD
  seedRows(ws, 'note:exact-threshold', 3, 1);
  const statsMap = computeNoteStats(ws);
  const boost = computeNoteBoost('note:exact-threshold', statsMap);
  ok('A4: winRate == threshold (0.75) => boost 0 (ramp starts above threshold)', boost === 0);
  fs.rmSync(ws, { recursive: true });
}

// A5: win rate > threshold — linear ramp
{
  const ws = makeTmpWs();
  // 4 wins, 0 losses → winRate = 1.0
  // boost = REINFORCE_MAX_BOOST * (1.0 - 0.75) / (1 - 0.75) = REINFORCE_MAX_BOOST * 1.0 = 0.2
  seedRows(ws, 'note:max-boost', 4, 0);
  const statsMap = computeNoteStats(ws);
  const boost = computeNoteBoost('note:max-boost', statsMap);
  const expected = REINFORCE_MAX_BOOST * (1.0 - REINFORCE_WIN_RATE_THRESHOLD) / (1 - REINFORCE_WIN_RATE_THRESHOLD);
  ok('A5: winRate=1.0 => boost at max cap', approxEq(boost, expected));
  ok('A5: boost equals REINFORCE_MAX_BOOST at winRate=1.0', approxEq(boost, REINFORCE_MAX_BOOST));
  fs.rmSync(ws, { recursive: true });
}

// A6: partial ramp — winRate midway between threshold and 1.0
{
  const ws = makeTmpWs();
  // 7 wins, 1 loss → winRate = 0.875 (midpoint between 0.75 and 1.0)
  // boost = REINFORCE_MAX_BOOST * (0.875 - 0.75) / (1 - 0.75) = 0.2 * 0.125 / 0.25 = 0.2 * 0.5 = 0.1
  seedRows(ws, 'note:mid-boost', 7, 1);
  const statsMap = computeNoteStats(ws);
  const winRate = statsMap.get('note:mid-boost').winRate;
  const boost = computeNoteBoost('note:mid-boost', statsMap);
  const expected = REINFORCE_MAX_BOOST * (winRate - REINFORCE_WIN_RATE_THRESHOLD) / (1 - REINFORCE_WIN_RATE_THRESHOLD);
  ok('A6: partial ramp boost matches formula', approxEq(boost, expected));
  ok('A6: partial ramp boost is between 0 and REINFORCE_MAX_BOOST', boost > 0 && boost < REINFORCE_MAX_BOOST);
  fs.rmSync(ws, { recursive: true });
}

// A7: accepts a workspace path as second arg (not just a Map)
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:ws-arg', 4, 0);
  const boost = computeNoteBoost('note:ws-arg', ws);   // pass ws path directly
  ok('A7: workspace path as second arg works', boost > 0);
  fs.rmSync(ws, { recursive: true });
}

// A8: accepts a Map (statsOrMap branch via instanceof Map)
{
  const ws = makeTmpWs();
  seedRows(ws, 'note:map-arg', 4, 0);
  const statsMap = computeNoteStats(ws);
  const boost = computeNoteBoost('note:map-arg', statsMap);
  ok('A8: Map as second arg works', boost > 0);
  fs.rmSync(ws, { recursive: true });
}

// A9: note not in map at all — boost 0 (no stats record)
{
  const ws = makeTmpWs();
  const statsMap = computeNoteStats(ws);   // empty
  const boost = computeNoteBoost('note:phantom', statsMap);
  ok('A9: note absent from stats map => boost 0', boost === 0);
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// B. buildQueue reinforce lane — gate conditions
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== B. buildQueue reinforce lane ===\n');

// B1: qualifying note (current, high win rate, enough observations) → emits reinforce item
{
  const ws = makeTmpWs();
  const note = makeNote('reinforce-ok');
  seedRows(ws, 'note:reinforce-ok', 4, 0);    // winRate=1.0, 4>=MIN_OPPORTUNITIES

  const o = makeOverlay({ 'reinforce-ok': note }, ws);
  const q = judge.buildQueue(o);
  const rItems = q.filter((i) => i.kind === 'reinforce');
  ok('B1: reinforce item emitted for qualifying note', rItems.length === 1);
  const it = rItems[0];
  ok('B1: noteId is note:reinforce-ok', it && it.noteId === 'note:reinforce-ok');
  ok('B1: action is boost', it && it.action === 'boost');
  ok('B1: boost > 0', it && typeof it.boost === 'number' && it.boost > 0);
  ok('B1: winRate present', it && typeof it.winRate === 'number');
  ok('B1: total present', it && typeof it.total === 'number' && it.total >= MIN_OPPORTUNITIES);
  fs.rmSync(ws, { recursive: true });
}

// B2: retired note (validTo set) → NOT in reinforce lane
{
  const ws = makeTmpWs();
  const note = makeNote('retired-reinforce', { validTo: new Date().toISOString() });
  seedRows(ws, 'note:retired-reinforce', 4, 0);

  const o = makeOverlay({ 'retired-reinforce': note }, ws);
  const q = judge.buildQueue(o);
  const rItems = q.filter((i) => i.kind === 'reinforce');
  ok('B2: retired note excluded from reinforce lane', rItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// B3: note with low win rate → NOT in reinforce lane (boost === 0)
{
  const ws = makeTmpWs();
  const note = makeNote('low-win-reinforce');
  seedRows(ws, 'note:low-win-reinforce', 0, 4);   // winRate=0

  const o = makeOverlay({ 'low-win-reinforce': note }, ws);
  const q = judge.buildQueue(o);
  const rItems = q.filter((i) => i.kind === 'reinforce');
  ok('B3: low-win-rate note excluded from reinforce lane', rItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// B4: note with too few observations → NOT in reinforce lane
{
  const ws = makeTmpWs();
  const note = makeNote('few-obs-reinforce');
  const count = MIN_OPPORTUNITIES - 1;
  seedRows(ws, 'note:few-obs-reinforce', count, 0);

  const o = makeOverlay({ 'few-obs-reinforce': note }, ws);
  const q = judge.buildQueue(o);
  const rItems = q.filter((i) => i.kind === 'reinforce');
  ok('B4: insufficient-observations note excluded from reinforce lane', rItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// B5: reinforce items appear AFTER decay items (slow lane ordering: clusters, edges, orphans, decay, reinforce)
{
  const ws = makeTmpWs();
  // A high-win note for reinforce
  const goodNote = makeNote('good-win-order');
  seedRows(ws, 'note:good-win-order', 4, 0);
  // A low-win note for decay (we need age+opp gates for decay too)
  const badNote = {
    id: 'bad-loss-order',
    title: 'bad note',
    summary: 'bad summary',
    created_by: 'agent-x',
    validFrom: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    validTo: null,
  };
  seedRows(ws, 'note:bad-loss-order', 0, 4);

  const o = makeOverlay({ 'good-win-order': goodNote, 'bad-loss-order': badNote }, ws);
  const q = judge.buildQueue(o);
  const firstReinforceIdx = q.findIndex((i) => i.kind === 'reinforce');
  const lastDecayIdx = q.reduce((acc, item, idx) => item.kind === 'decay' ? idx : acc, -1);
  if (firstReinforceIdx !== -1 && lastDecayIdx !== -1) {
    ok('B5: all reinforce items appear after decay items', firstReinforceIdx > lastDecayIdx);
  } else {
    ok('B5: ordering check skipped (missing decay or reinforce item)', firstReinforceIdx !== -1);
  }
  fs.rmSync(ws, { recursive: true });
}

// B6: note with no journal rows → NOT in reinforce lane (no stats)
{
  const ws = makeTmpWs();
  const note = makeNote('no-rows-reinforce');
  const o = makeOverlay({ 'no-rows-reinforce': note }, ws);
  const q = judge.buildQueue(o);
  const rItems = q.filter((i) => i.kind === 'reinforce');
  ok('B6: note with zero rows excluded from reinforce lane', rItems.length === 0);
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// C. note_reinforced event in graph-store
// ──────────────────────────────────────────────────────────────────────────────
console.log('\n=== C. note_reinforced event in graph-store ===\n');

// C1: note_reinforced sets reinforceBoost on the node
{
  const ws = makeTmpWs();
  const store = graphStore.forWorkspace(ws);
  const noteId = 'note:rein-test-1';
  // Seed a note_created event first so the node exists
  graphStore.appendEvent(store, noteId, { evt: 'note_created', actor: 'test', title: 'reinforce test 1', summary: 'test summary' });
  graphStore.appendEvent(store, noteId, { evt: 'note_reinforced', actor: 'judge:reinforce', boost: 0.1, winRate: 0.9, total: 5 });

  const g = graphStore.loadGraph(store);
  const node = g.nodes[noteId];
  ok('C1: node exists after note_reinforced', !!node);
  ok('C1: reinforceBoost set correctly', node && approxEq(node.reinforceBoost || 0, 0.1));
  ok('C1: reinforceWinRate set correctly', node && approxEq(node.reinforceWinRate || 0, 0.9));
  fs.rmSync(ws, { recursive: true });
}

// C2: note_reinforced accumulates boost across multiple events
{
  const ws = makeTmpWs();
  const store = graphStore.forWorkspace(ws);
  const noteId = 'note:rein-test-2';
  graphStore.appendEvent(store, noteId, { evt: 'note_created', actor: 'test', title: 'reinforce test 2', summary: 'test summary' });
  graphStore.appendEvent(store, noteId, { evt: 'note_reinforced', actor: 'judge:reinforce', boost: 0.1, winRate: 0.85, total: 4 });
  graphStore.appendEvent(store, noteId, { evt: 'note_reinforced', actor: 'judge:reinforce', boost: 0.15, winRate: 0.9, total: 5 });

  const g = graphStore.loadGraph(store);
  const node = g.nodes[noteId];
  ok('C2: reinforceBoost accumulates across events', node && approxEq(node.reinforceBoost || 0, 0.25));
  ok('C2: reinforceWinRate is last event value', node && approxEq(node.reinforceWinRate || 0, 0.9));
  fs.rmSync(ws, { recursive: true });
}

// C3: note_reinforced without boost field — no reinforceBoost set (type guard)
{
  const ws = makeTmpWs();
  const store = graphStore.forWorkspace(ws);
  const noteId = 'note:rein-test-3';
  graphStore.appendEvent(store, noteId, { evt: 'note_created', actor: 'test', title: 'reinforce test 3', summary: 'test summary' });
  graphStore.appendEvent(store, noteId, { evt: 'note_reinforced', actor: 'judge:reinforce', winRate: 0.9, total: 5 });  // no boost field

  const g = graphStore.loadGraph(store);
  const node = g.nodes[noteId];
  ok('C3: no boost field => reinforceBoost stays 0', node && (node.reinforceBoost || 0) === 0);
  ok('C3: reinforceWinRate still set', node && approxEq(node.reinforceWinRate || 0, 0.9));
  fs.rmSync(ws, { recursive: true });
}

// C4: note_reinforced with boost=0 — reinforceBoost stays unchanged (0+0=0)
{
  const ws = makeTmpWs();
  const store = graphStore.forWorkspace(ws);
  const noteId = 'note:rein-test-4';
  graphStore.appendEvent(store, noteId, { evt: 'note_created', actor: 'test', title: 'reinforce test 4', summary: 'test summary' });
  graphStore.appendEvent(store, noteId, { evt: 'note_reinforced', actor: 'judge:reinforce', boost: 0, winRate: 0.76, total: 4 });

  const g = graphStore.loadGraph(store);
  const node = g.nodes[noteId];
  ok('C4: boost=0 => reinforceBoost is 0', node && (node.reinforceBoost || 0) === 0);
  fs.rmSync(ws, { recursive: true });
}

// C5: note_reinforced doesn't set reinforceWinRate when winRate is undefined
{
  const ws = makeTmpWs();
  const store = graphStore.forWorkspace(ws);
  const noteId = 'note:rein-test-5';
  graphStore.appendEvent(store, noteId, { evt: 'note_created', actor: 'test', title: 'reinforce test 5', summary: 'test summary' });
  graphStore.appendEvent(store, noteId, { evt: 'note_reinforced', actor: 'judge:reinforce', boost: 0.1 });  // no winRate

  const g = graphStore.loadGraph(store);
  const node = g.nodes[noteId];
  ok('C5: no winRate field => reinforceWinRate not set', node && node.reinforceWinRate === undefined);
  ok('C5: boost still applied when winRate absent', node && approxEq(node.reinforceBoost || 0, 0.1));
  fs.rmSync(ws, { recursive: true });
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
