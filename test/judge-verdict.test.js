#!/usr/bin/env node
// Plain Node test for edge-judge VERDICT application — the create/keep/prune/surface effects the
// /judge/verdict route applies, modeled over the same pure overlay + judge primitives the route uses
// (so it tests the real logic without binding a port). Run: node test/judge-verdict.test.js.
//
// Properties:
//   - createEdge writes a context edge tagged judged:true,by:'judge' (a REASONED assertion, not cosine).
//   - keepEdge flips an unverified edge to judged:true.
//   - pruneEdge removes the edge; it is actually GONE.
//   - surfaceCluster auto-resolves as DISTINCT — no guidance, no note timeline mutation.
//   - every verdict stamps the source note's judgedAtEpoch (a 'no edge' verdict included).
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Faithful re-implementation of the route's per-verdict application (mirrors daemon /judge/verdict).
function applyVerdict(overlay, v) {
  const epoch = overlay.epoch || 0;
  if (!overlay.judgedAtEpoch) overlay.judgedAtEpoch = {};
  if (v.createEdge && v.createEdge.from && v.createEdge.to) {
    ov.addEdge(overlay, v.createEdge.from, v.createEdge.to, null, 'context', v.createEdge.weight);
    const e = overlay.edges.find((x) => x.from === v.createEdge.from && x.to === v.createEdge.to && x.kind === 'context');
    if (e) { e.judged = true; e.by = 'judge'; }
  }
  if (v.keepEdge && v.keepEdge.from && v.keepEdge.to) {
    const kept = overlay.edges.find((x) => x.from === v.keepEdge.from && x.to === v.keepEdge.to && x.kind === 'context');
    judge.keepEdge(overlay, v.keepEdge.from, v.keepEdge.to);
    if (v.keepEdge.kind === 'blocking' && kept) { kept.kind = 'blocking'; delete kept.weight; }
  }
  if (v.pruneEdge && v.pruneEdge.from && v.pruneEdge.to) ov.removeEdge(overlay, v.pruneEdge.from, v.pruneEdge.to, null, v.pruneEdge.kind);
  if (v.supersedeTask && v.supersedeTask.old && v.supersedeTask.new && v.supersedeTask.old !== v.supersedeTask.new) {
    ov.setStatus(overlay, v.supersedeTask.old, 'canceled', `superseded by ${v.supersedeTask.new}`);
    ov.addEdge(overlay, v.supersedeTask.old, v.supersedeTask.new, null, 'supersede');
  }
  if (!overlay.judgedClusters) overlay.judgedClusters = {};
  if (v.consolidate && v.consolidate.keep && Array.isArray(v.consolidate.supersede)) {
    const keep = String(v.consolidate.keep).replace(/^note:/, '');
    const supersededNow = [];
    for (const oldKey of v.consolidate.supersede) {
      const oldId = String(oldKey).replace(/^note:/, '');
      const r = ov.supersedeNote(overlay, oldId, keep);
      if (r && r.ok) supersededNow.push('note:' + oldId);
    }
    const keepKey = 'note:' + keep;
    for (const e of overlay.edges) {
      if (e.kind !== 'context') continue;
      if (supersededNow.includes(e.from)) e.from = keepKey;
      if (supersededNow.includes(e.to)) e.to = keepKey;
    }
    const seen = new Set();
    overlay.edges = overlay.edges.filter((e) => {
      if (e.from === e.to) return false;
      const sig = `${e.from}>>${e.to}>>${e.fromWorkspace || ''}>>${e.kind || 'blocking'}`;
      if (seen.has(sig)) return false; seen.add(sig); return true;
    });
    judge.stampCluster(overlay.judgedClusters, [keepKey, ...supersededNow], epoch);
  }
  if (v.surfaceCluster && Array.isArray(v.surfaceCluster.keys) && v.surfaceCluster.keys.length) {
    const keys = v.surfaceCluster.keys.map((k) => String(k).startsWith('note:') ? k : 'note:' + k);
    const settled = judge.clusterConsolidationState(overlay, keys);
    if (settled) {
      judge.stampCluster(overlay.judgedClusters, keys, epoch);
      return;
    }
    ov.markClusterDistinct(overlay, keys);
    for (const k of keys) ov.clearPendingDup(overlay, k);
    judge.stampCluster(overlay.judgedClusters, keys, epoch);
  }
  const noteKey = v.markJudged || (v.item && v.item.kind === 'orphan' ? v.item.id : null);
  if (noteKey) judge.stampJudged(overlay.judgedAtEpoch, noteKey, epoch);
}

// --- createEdge: reasoned context edge, tagged judged:true,by:judge -----------------------------
{
  const o = ov.EMPTY(); o.epoch = 3;
  applyVerdict(o, { createEdge: { from: 'note:a', to: 's/1', weight: 0.7 }, markJudged: 'note:a' });
  const e = o.edges.find((x) => x.from === 'note:a' && x.to === 's/1');
  ok('createEdge writes a context edge', !!e && e.kind === 'context');
  ok('created edge tagged judged:true,by:judge (reasoned, not cosine)', e.judged === true && e.by === 'judge');
  ok('created edge carries the agent weight', e.weight === 0.7);
  ok('createEdge stamps the source note judgedAtEpoch=epoch', o.judgedAtEpoch['note:a'] === 3);
}

// --- keepEdge: flip an unverified edge to judged:true -------------------------------------------
{
  const o = ov.EMPTY();
  o.edges = [{ from: 'note:a', to: 'note:b', kind: 'context', judged: false, by: 'autowire' }];
  applyVerdict(o, { keepEdge: { from: 'note:a', to: 'note:b' } });
  ok('keepEdge flips judged:false → true', o.edges[0].judged === true && o.edges[0].by === 'judge');
  ok('keepEdge does not remove the edge', o.edges.length === 1);
}

// --- pruneEdge: edge is actually gone -----------------------------------------------------------
{
  const o = ov.EMPTY();
  o.edges = [
    { from: 'note:a', to: 'note:b', kind: 'context', judged: false },
    { from: 'note:a', to: 's/1', kind: 'context', judged: false },
  ];
  applyVerdict(o, { pruneEdge: { from: 'note:a', to: 'note:b' } });
  ok('pruneEdge removes exactly the targeted edge', o.edges.length === 1 && o.edges[0].to === 's/1');
  ok('pruned edge is actually gone', !o.edges.some((e) => e.from === 'note:a' && e.to === 'note:b'));
}

// --- consolidate: supersede non-canonical into keeper + re-point context edges -------------------
{
  const o = ov.EMPTY(); o.epoch = 4;
  const keep = ov.addNoteNode(o, { title: 'keeper (newest)', summary: 'canonical fact' });
  const old1 = ov.addNoteNode(o, { title: 'dup 1', summary: 'same fact' });
  const old2 = ov.addNoteNode(o, { title: 'dup 2', summary: 'same fact' });
  // Edges: a consumer task depends on old1 (context); old2 provides context to a task; keep already
  // has an edge to the same task as old2 (will dedup); old1 has an edge to keep (becomes self-loop).
  o.edges = [
    { from: 'note:' + old1, to: 's/consumer', kind: 'context', weight: 0.6 },   // re-point from -> keep
    { from: 'note:' + old2, to: 's/task', kind: 'context', weight: 0.5 },        // re-point from -> keep
    { from: 'note:' + keep, to: 's/task', kind: 'context', weight: 0.5 },        // dup after re-point → dedup
    { from: 'note:' + old1, to: 'note:' + keep, kind: 'context' },               // becomes self-loop → drop
    { from: 's/x', to: 's/y' },                                                  // unrelated blocking, untouched
  ];
  applyVerdict(o, { consolidate: { keep: 'note:' + keep, supersede: ['note:' + old1, 'note:' + old2], why: 'same fact' } });
  ok('consolidate stamps validTo on each superseded note', o.note_nodes[old1].validTo != null && o.note_nodes[old2].validTo != null);
  ok('consolidate leaves the keeper current', o.note_nodes[keep].validTo === null);
  ok('consolidate chains superseded -> keeper', o.note_nodes[old1].supersededBy === keep && o.note_nodes[old2].supersededBy === keep);
  ok('re-pointed edge old1->consumer now keep->consumer', o.edges.some((e) => e.from === 'note:' + keep && e.to === 's/consumer'));
  ok('self-loop (old1->keep) dropped', !o.edges.some((e) => e.from === 'note:' + keep && e.to === 'note:' + keep));
  ok('duplicate keep->s/task collapsed to one edge', o.edges.filter((e) => e.from === 'note:' + keep && e.to === 's/task').length === 1);
  ok('no context edge points to a superseded (hidden) note', !o.edges.some((e) => e.kind === 'context' && (e.from === 'note:' + old1 || e.to === 'note:' + old1 || e.from === 'note:' + old2 || e.to === 'note:' + old2)));
  ok('unrelated blocking edge untouched', o.edges.some((e) => e.from === 's/x' && e.to === 's/y'));
  ok('cluster stamped judged at epoch', o.judgedClusters[judge.clusterSignature(['note:' + keep, 'note:' + old1, 'note:' + old2])] === 4);
  // REVERSIBILITY: the superseded notes still exist (recoverable as-of), not deleted.
  ok('superseded notes are NOT deleted (recoverable)', !!o.note_nodes[old1] && !!o.note_nodes[old2]);
}

// --- consolidate is idempotent (re-applying does not double-supersede or error) ------------------
{
  const o = ov.EMPTY(); o.epoch = 1;
  const keep = ov.addNoteNode(o, { title: 'k', summary: '' });
  const old1 = ov.addNoteNode(o, { title: 'd', summary: '' });
  const apply = () => applyVerdict(o, { consolidate: { keep: 'note:' + keep, supersede: ['note:' + old1] } });
  apply(); apply();
  ok('consolidate idempotent: keeper still current', o.note_nodes[keep].validTo === null);
  ok('consolidate idempotent: old still superseded by keep', o.note_nodes[old1].supersededBy === keep);
}

// --- surfaceCluster: auto-resolves as DISTINCT (no guidance) -------------------------------------
{
  const o = ov.EMPTY(); o.epoch = 2;
  const a = ov.addNoteNode(o, { title: 'amb a', summary: '' });
  const b = ov.addNoteNode(o, { title: 'amb b', summary: '' });
  const c = ov.addNoteNode(o, { title: 'amb c', summary: '' });
  ov.markPendingDup(o, 'note:' + b, 'note:' + a, 0.74);
  applyVerdict(o, { surfaceCluster: { keys: ['note:' + a, 'note:' + b, 'note:' + c], why: 'unsure same fact' } });
  ok('surfaceCluster raises no guidance item', ov.pendingGuidance(o).length === 0);
  ok('surfaceCluster marks the cluster DISTINCT', ov.isClusterDistinct(o, ['note:' + a, 'note:' + b, 'note:' + c]) === true);
  ok('surfaceCluster clears pendingDup for member notes', ov.isPendingDup(o, 'note:' + b) === false);
  ok('surfaceCluster does NOT mutate any note timeline', o.note_nodes[a].validTo === null && o.note_nodes[b].validTo === null && o.note_nodes[c].validTo === null);
  ok('surfaceCluster marks the cluster judged', o.judgedClusters[judge.clusterSignature(['note:' + a, 'note:' + b, 'note:' + c])] === 2);
}

// --- a 'no edge' verdict (markJudged only) still stamps the watermark ----------------------------
{
  const o = ov.EMPTY(); o.epoch = 5;
  applyVerdict(o, { markJudged: 'note:x' });            // no create/keep/prune — pure "no edge"
  ok("'no edge' verdict stamps judgedAtEpoch so it isn't re-pulled", o.judgedAtEpoch['note:x'] === 5);
  ok("'no edge' verdict writes no edge", o.edges.length === 0);
}

// --- idempotency: re-applying createEdge doesn't duplicate ---------------------------------------
{
  const o = ov.EMPTY(); o.epoch = 1;
  applyVerdict(o, { createEdge: { from: 'note:a', to: 's/1' } });
  applyVerdict(o, { createEdge: { from: 'note:a', to: 's/1' } });
  ok('createEdge is idempotent (no duplicate edge)', o.edges.filter((e) => e.from === 'note:a' && e.to === 's/1').length === 1);
}

// --- task→task KIND: keepEdge kind:'blocking' reclassifies the kept context edge ------------------
{
  const o = ov.EMPTY();
  o.edges = [{ from: 't/anchor', to: 't/N', kind: 'context', judged: false, score: 0.4 }];
  applyVerdict(o, { keepEdge: { from: 't/anchor', to: 't/N', kind: 'blocking' } });
  const e = o.edges[0];
  ok('task→task keep+blocking reclassifies edge to blocking', e.kind === 'blocking');
  ok('reclassified blocking edge drops its weight', !('weight' in e));
  ok('keep still flips judged:true', e.judged === true && e.by === 'judge');
}

// --- task→task DUPLICATE: supersedeTask retires N (cancel + supersede edge) ------------------------
{
  const o = ov.EMPTY();
  applyVerdict(o, { supersedeTask: { old: 't/N', new: 't/anchor', reason: 'anchor re-plans N' } });
  ok('supersedeTask cancels the retired task N', o.status['t/N'] === 'canceled');
  ok('supersedeTask writes a supersede edge old→new', o.edges.some((e) => e.from === 't/N' && e.to === 't/anchor' && e.kind === 'supersede'));
  // self-supersede is a no-op
  const o2 = ov.EMPTY();
  applyVerdict(o2, { supersedeTask: { old: 't/x', new: 't/x' } });
  ok('supersedeTask self-link is a no-op', o2.edges.length === 0 && !o2.status['t/x']);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
