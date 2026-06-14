#!/usr/bin/env node
// Offline test for POST /judge/rejudge-edges — the bulk markForRejudge endpoint added in task #30.
// Tests the overlay mutation + buildQueue surfacing logic without binding a port.
// Run: node test/judge-rejudge-edges.test.js
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log('PASS  ' + label); pass++; } else { console.log('FAIL  ' + label); fail++; } };

// Mirrors the endpoint's per-sig application logic (no HTTP; pure overlay mutation).
function applyRejudgeEdges(overlay, sigs) {
  const edgeMap = new Map();
  for (const e of overlay.edges) {
    if (e.kind !== 'context') continue;
    edgeMap.set(e.from + '>>' + e.to, e);
  }
  let marked = 0, skipped = 0;
  for (const sig of sigs) {
    if (typeof sig !== 'string') { skipped++; continue; }
    const e = edgeMap.get(sig);
    if (!e || e.judged !== true || typeof e.weight !== 'number' || e.weight <= 0 || e.origin === 'asserted') {
      skipped++;
      continue;
    }
    if (!overlay.edgeRejudge) overlay.edgeRejudge = {};
    if (!overlay.edgeRejudge[sig]) { overlay.edgeRejudge[sig] = true; marked++; }
    else marked++;
  }
  return { marked, skipped };
}

// --- basic: marks a LEGACY KEPT edge for rejudge ------------------------------------------------
{
  const o = ov.EMPTY();
  o.edges = [
    { from: 'note:a', to: 's/1', kind: 'context', judged: true, weight: 0.7 },   // legacy kept -> markable
    { from: 'note:b', to: 's/2', kind: 'context', judged: false, weight: 0 },     // unjudged -> NOT legacy kept
    { from: 'note:c', to: 's/3', kind: 'context', judged: true, weight: 0.6, origin: 'asserted' }, // asserted -> skip
    { from: 'note:d', to: 's/4', kind: 'context', judged: true, weight: 0 },      // weight=0 -> not kept
  ];
  const r = applyRejudgeEdges(o, ['note:a>>s/1']);
  ok('marks 1 legacy-kept edge', r.marked === 1 && r.skipped === 0);
  ok('edgeRejudge flag set for the sig', o.edgeRejudge && o.edgeRejudge['note:a>>s/1'] === true);
}

// --- skip: unjudged edges are NOT legacy kept ---------------------------------------------------
{
  const o = ov.EMPTY();
  o.edges = [{ from: 'note:b', to: 's/2', kind: 'context', judged: false, weight: 0 }];
  const r = applyRejudgeEdges(o, ['note:b>>s/2']);
  ok('skips unjudged edge (not legacy kept)', r.marked === 0 && r.skipped === 1);
}

// --- skip: asserted edges are exempt ------------------------------------------------------------
{
  const o = ov.EMPTY();
  o.edges = [{ from: 'note:c', to: 's/3', kind: 'context', judged: true, weight: 0.6, origin: 'asserted' }];
  const r = applyRejudgeEdges(o, ['note:c>>s/3']);
  ok('skips asserted edge', r.marked === 0 && r.skipped === 1);
}

// --- skip: unknown sig skips silently -----------------------------------------------------------
{
  const o = ov.EMPTY();
  o.edges = [];
  const r = applyRejudgeEdges(o, ['nonexistent>>edge']);
  ok('skips unknown sig silently', r.marked === 0 && r.skipped === 1);
}

// --- idempotent: re-marking already-marked edge counts as marked but does not double-mark --------
{
  const o = ov.EMPTY();
  o.edges = [{ from: 'note:x', to: 's/5', kind: 'context', judged: true, weight: 0.5 }];
  applyRejudgeEdges(o, ['note:x>>s/5']);
  const r2 = applyRejudgeEdges(o, ['note:x>>s/5']);  // second call
  ok('idempotent: second mark still returns marked=1', r2.marked === 1 && r2.skipped === 0);
  ok('edgeRejudge not duplicated (still true, not array)', o.edgeRejudge['note:x>>s/5'] === true);
}

// --- buildQueue surfaces rejudge edge with needs_rejudge:true -----------------------------------
{
  const o = ov.EMPTY();
  o.edges = [
    { from: 'note:a', to: 's/1', kind: 'context', judged: true, weight: 0.7 },   // legacy kept
  ];
  applyRejudgeEdges(o, ['note:a>>s/1']);
  const q = judge.buildQueue(o);
  const edgeItems = q.filter(function(it) { return it.kind === 'edge'; });
  ok('buildQueue surfaces rejudge edge', edgeItems.length === 1 && edgeItems[0].id === 'note:a>>s/1');
  ok('rejudge edge has needs_rejudge:true', edgeItems[0].needs_rejudge === true);
}

// --- multiple sigs, mixed legibility -----------------------------------------------------------
{
  const o = ov.EMPTY();
  o.edges = [
    { from: 'note:p', to: 's/10', kind: 'context', judged: true, weight: 0.8 },
    { from: 'note:q', to: 's/11', kind: 'context', judged: true, weight: 0.9 },
    { from: 'note:r', to: 's/12', kind: 'context', judged: false, weight: 0 },   // not legacy kept
  ];
  const r = applyRejudgeEdges(o, ['note:p>>s/10', 'note:q>>s/11', 'note:r>>s/12', 'bad>>sig']);
  ok('bulk: marks 2, skips 2 (unjudged + unknown)', r.marked === 2 && r.skipped === 2);
  ok('bulk: both legacy-kept edges in edgeRejudge', o.edgeRejudge['note:p>>s/10'] && o.edgeRejudge['note:q>>s/11']);
  ok('bulk: unjudged edge NOT in edgeRejudge', !o.edgeRejudge['note:r>>s/12']);
}

// --- non-string sigs are skipped ---------------------------------------------------------------
{
  const o = ov.EMPTY();
  o.edges = [];
  const r = applyRejudgeEdges(o, [null, 123, undefined, 'x>>y']);
  ok('non-string sigs are skipped', r.skipped === 4);
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : fail + ' FAILED') + ' (' + pass + '/' + (pass + fail) + ')');
process.exit(fail > 0 ? 1 : 0);
