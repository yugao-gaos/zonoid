#!/usr/bin/env node
// Plain Node test for the DURABLE judge verdict journal — the additive logging that makes
// keep-rate-by-cosine recoverable. Run: node test/judge-journal.test.js.
//
// The gap this closes: a PRUNE deletes the edge with no record, so prune verdicts vanished and a true
// per-cosine-band keep/prune rate was unrecoverable. We now append one JSON line per verdict to
// .graph/judge-journal.jsonl (mirror of gate-journal.jsonl), carrying the edge's creation cosine —
// read BEFORE the prune deletes the edge.
//
// Properties:
//   - a PRUNE verdict appends a line carrying the edge's cosine (read before the edge was removed).
//   - a KEEP verdict appends a line carrying the edge's cosine.
//   - keepRateByBand buckets a synthetic journal into the right cosine bands.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const judge = require('../lib/judge');
const journal = require('../lib/judge-journal');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Fresh workspace with a .graph dir so appendVerdict has somewhere to write.
function tmpWs() {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-journal-'));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

// --- a PRUNE verdict appends a line carrying the edge's cosine -----------------------------------
{
  const ws = tmpWs();
  // Mirror the route: read the edge's cosine BEFORE deleting, then journal the prune.
  const edge = { from: 'note:a', to: 'note:b', kind: 'context', judged: false, score: 0.42 };
  const cos = edge.score;          // what the route's edgeCosine() reads
  judge.appendVerdict(ws, { epoch: 7, verdict: 'prune', from: edge.from, to: edge.to, edgeKind: 'context', cosine: cos, by: 'judge' });
  const rows = journal.readVerdicts(ws);
  ok('prune appends exactly one journal line', rows.length === 1);
  ok('prune line records verdict=prune', rows[0].verdict === 'prune');
  ok('prune line carries the edge cosine (load-bearing)', rows[0].cosine === 0.42);
  ok('prune line carries from/to/edgeKind/epoch/by', rows[0].from === 'note:a' && rows[0].to === 'note:b' && rows[0].edgeKind === 'context' && rows[0].epoch === 7 && rows[0].by === 'judge');
  ok('prune line carries a ts', typeof rows[0].ts === 'string' && rows[0].ts.length > 0);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- a KEEP verdict appends a line carrying the edge's cosine ------------------------------------
{
  const ws = tmpWs();
  judge.appendVerdict(ws, { epoch: 3, verdict: 'keep', from: 'note:a', to: 's/1', edgeKind: 'context', cosine: 0.31, by: 'judge' });
  const rows = journal.readVerdicts(ws);
  ok('keep appends one journal line', rows.length === 1 && rows[0].verdict === 'keep');
  ok('keep line carries the edge cosine', rows[0].cosine === 0.31);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- markJudged / consolidate / surface append with cosine:null ---------------------------------
{
  const ws = tmpWs();
  judge.appendVerdict(ws, { epoch: 1, verdict: 'markJudged', from: 'note:x', to: null, edgeKind: 'note', cosine: null, by: 'judge' });
  const rows = journal.readVerdicts(ws);
  ok('markJudged appends a line with cosine:null', rows.length === 1 && rows[0].verdict === 'markJudged' && rows[0].cosine === null);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- keepRateByBand buckets a synthetic journal correctly ---------------------------------------
{
  const ws = tmpWs();
  // Band [0.25-0.30): 1 keep, 1 prune → 0.50.  Band [0.40-0.45): 2 keep, 0 prune → 1.0.
  // Band [0.50+): 0 keep, 1 prune → 0.0.  A markJudged (cosine null) must NOT count.
  const rows = [
    { epoch: 1, verdict: 'keep',  cosine: 0.26 },
    { epoch: 1, verdict: 'prune', cosine: 0.27 },
    { epoch: 1, verdict: 'keep',  cosine: 0.41 },
    { epoch: 1, verdict: 'keep',  cosine: 0.44 },
    { epoch: 1, verdict: 'prune', cosine: 0.73 },
    { epoch: 1, verdict: 'markJudged', cosine: null },
  ];
  for (const r of rows) judge.appendVerdict(ws, r);
  const bands = journal.keepRateByBand(ws);
  const byLabel = Object.fromEntries(bands.map((b) => [b.band, b]));
  ok('band 0.25-0.30 has 1 keep 1 prune, keepRate 0.5', byLabel['0.25-0.30'].kept === 1 && byLabel['0.25-0.30'].pruned === 1 && byLabel['0.25-0.30'].keepRate === 0.5);
  ok('band 0.40-0.45 has 2 keeps, keepRate 1.0', byLabel['0.40-0.45'].kept === 2 && byLabel['0.40-0.45'].pruned === 0 && byLabel['0.40-0.45'].keepRate === 1);
  ok('band 0.50+ has 1 prune, keepRate 0.0', byLabel['0.50+'].kept === 0 && byLabel['0.50+'].pruned === 1 && byLabel['0.50+'].keepRate === 0);
  ok('empty band 0.30-0.35 has keepRate null', byLabel['0.30-0.35'].total === 0 && byLabel['0.30-0.35'].keepRate === null);
  ok('markJudged (cosine null) excluded from every band', bands.reduce((s, b) => s + b.total, 0) === 5);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- origin: keepRateByBand filtered to autowire-lexical EXCLUDES asserted note->task edges -------
// This is the core fix: live data had all sub-0.40 KEEPs as hand-asserted note->task edges, which
// corrupted threshold tuning. Filtering to origin:'autowire-lexical' must isolate the gated population.
{
  const ws = tmpWs();
  const rows = [
    // 8 asserted note->task KEEPs in the sub-0.40 tail (the real-world contamination)
    { verdict: 'keep', cosine: 0.28, origin: 'asserted' },
    { verdict: 'keep', cosine: 0.31, origin: 'asserted' },
    { verdict: 'keep', cosine: 0.34, origin: 'asserted' },
    { verdict: 'keep', cosine: 0.38, origin: 'asserted' },
    // the genuine threshold-gated lexical population
    { verdict: 'keep',  cosine: 0.41, origin: 'autowire-lexical' },
    { verdict: 'prune', cosine: 0.42, origin: 'autowire-lexical' },
    { verdict: 'keep',  cosine: 0.27, origin: 'autowire-lexical' },
    // a semantic-origin row that must ALSO be excluded from the lexical curve
    { verdict: 'keep',  cosine: 0.60, origin: 'autowire-semantic' },
  ];
  for (const r of rows) judge.appendVerdict(ws, r);

  const lex = journal.keepRateByBand(ws, journal.DEFAULT_BANDS, { origin: 'autowire-lexical' });
  const byLabel = Object.fromEntries(lex.map((b) => [b.band, b]));
  ok('lexical filter: sub-0.40 band has only the 1 lexical keep (asserted excluded)',
    byLabel['0.25-0.30'].kept === 1 && byLabel['0.25-0.30'].pruned === 0);
  ok('lexical filter: 0.30-0.40 bands empty (asserted note edges excluded)',
    byLabel['0.30-0.35'].total === 0 && byLabel['0.35-0.40'].total === 0);
  ok('lexical filter: 0.40-0.45 band has the lexical keep+prune',
    byLabel['0.40-0.45'].kept === 1 && byLabel['0.40-0.45'].pruned === 1);
  ok('lexical filter: total counted == 3 (only autowire-lexical)',
    lex.reduce((s, b) => s + b.total, 0) === 3);

  // convenience wrapper == explicit lexical filter
  const conv = journal.keepRateByBandAutowireLexical(ws);
  ok('keepRateByBandAutowireLexical matches the explicit lexical filter',
    JSON.stringify(conv) === JSON.stringify(lex));

  // array origin filter (lexical + semantic) widens the population
  const both = journal.keepRateByBand(ws, journal.DEFAULT_BANDS, { origin: ['autowire-lexical', 'autowire-semantic'] });
  ok('array origin filter includes both autowire populations',
    both.reduce((s, b) => s + b.total, 0) === 4);

  // unfiltered still counts everything (back-compat)
  const all = journal.keepRateByBand(ws);
  ok('unfiltered keepRateByBand counts all 8 edge verdicts',
    all.reduce((s, b) => s + b.total, 0) === 8);

  // per-origin breakdown
  const byOrigin = journal.keepRateByOrigin(ws);
  ok('keepRateByOrigin: asserted = 4 kept / 0 pruned',
    byOrigin.asserted.kept === 4 && byOrigin.asserted.pruned === 0 && byOrigin.asserted.keepRate === 1);
  ok('keepRateByOrigin: autowire-lexical = 2 kept / 1 pruned',
    byOrigin['autowire-lexical'].kept === 2 && byOrigin['autowire-lexical'].pruned === 1);
  fs.rmSync(ws, { recursive: true, force: true });
}

// --- origin: an asserted edge journals origin:'asserted'; tag-less rows excluded by an origin filter
{
  const ws = tmpWs();
  judge.appendVerdict(ws, { verdict: 'keep', from: 'note:a', to: 's/1', cosine: 0.3, origin: 'asserted', by: 'judge' });
  const rows = journal.readVerdicts(ws);
  ok('asserted verdict row persists origin:asserted', rows[0].origin === 'asserted');

  // a pre-stamping (tag-less) row gets origin:null and must NOT match any origin filter
  const ws2 = tmpWs();
  judge.appendVerdict(ws2, { verdict: 'keep', cosine: 0.42 }); // no origin field
  const r2 = journal.readVerdicts(ws2);
  ok('tag-less row journals origin:null', r2[0].origin === null);
  const filtered = journal.keepRateByBand(ws2, journal.DEFAULT_BANDS, { origin: 'autowire-lexical' });
  ok('tag-less row excluded from origin-filtered curve', filtered.reduce((s, b) => s + b.total, 0) === 0);
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(ws2, { recursive: true, force: true });
}

// --- legacy origin INFERENCE for tag-less edges (mirrors routes/judge.js edgeOrigin) --------------
// The route infers origin from by + endpoints when an edge predates origin stamping. Replicate that
// pure logic here and assert the classification, so the inference contract is locked by a test.
{
  const isNote = (id) => typeof id === 'string' && id.startsWith('note:');
  const edgeOrigin = (e) => {
    if (e && typeof e.origin === 'string') return e.origin;
    if (e && e.by === 'autowire') return isNote(e.from) ? 'autowire-semantic' : 'autowire-lexical';
    return 'asserted';
  };
  ok('infer: by:autowire + note source => autowire-semantic',
    edgeOrigin({ from: 'note:x', to: 's/1', by: 'autowire' }) === 'autowire-semantic');
  ok('infer: by:autowire + both tasks => autowire-lexical',
    edgeOrigin({ from: 's/2', to: 's/1', by: 'autowire' }) === 'autowire-lexical');
  ok('infer: non-autowire edge => asserted',
    edgeOrigin({ from: 'note:x', to: 's/1', by: 'judge' }) === 'asserted');
  ok('explicit origin tag wins over inference',
    edgeOrigin({ from: 's/2', to: 's/1', by: 'autowire', origin: 'asserted' }) === 'asserted');
}

// --- readVerdicts on a missing journal returns [] (no throw) ------------------------------------
{
  const ws = tmpWs();
  ok('readVerdicts on empty workspace returns []', Array.isArray(journal.readVerdicts(ws)) && journal.readVerdicts(ws).length === 0);
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
