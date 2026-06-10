#!/usr/bin/env node
// Plain Node test for edge-judge VERDICT application — the create/keep/prune/surface effects the
// /judge/verdict route applies, modeled over the same pure overlay + judge primitives the route uses
// (so it tests the real logic without binding a port). Run: node test/judge-verdict.test.js.
//
// Properties:
//   - createEdge writes a context edge tagged judged:true,by:'judge' (a REASONED assertion, not cosine).
//   - keepEdge flips an unverified edge to judged:true.
//   - pruneEdge removes the edge; it is actually GONE.
//   - surfaceSupersede raises GUIDANCE only — NEVER stamps validTo / mutates the note timeline.
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
  if (v.keepEdge && v.keepEdge.from && v.keepEdge.to) judge.keepEdge(overlay, v.keepEdge.from, v.keepEdge.to);
  if (v.pruneEdge && v.pruneEdge.from && v.pruneEdge.to) ov.removeEdge(overlay, v.pruneEdge.from, v.pruneEdge.to, null, v.pruneEdge.kind);
  if (v.surfaceSupersede && v.surfaceSupersede.old && v.surfaceSupersede.new) {
    ov.addGuidance(overlay, { question: `supersede ${v.surfaceSupersede.old}->${v.surfaceSupersede.new}?`, context: v.surfaceSupersede.why || '', trigger: 'ambiguous_intent' });
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

// --- surfaceSupersede: GUIDANCE only — NO validTo / timeline mutation ----------------------------
{
  const o = ov.EMPTY();
  const oldId = ov.addNoteNode(o, { title: 'old fact', summary: 'v1' });
  const newId = ov.addNoteNode(o, { title: 'new fact', summary: 'v2' });
  applyVerdict(o, { surfaceSupersede: { old: 'note:' + oldId, new: 'note:' + newId, why: 'corrected' } });
  ok('surfaceSupersede raises one guidance item', ov.pendingGuidance(o).length === 1);
  ok('surfaceSupersede does NOT stamp validTo on the old note', o.note_nodes[oldId].validTo === null);
  ok('surfaceSupersede does NOT chain supersededBy', o.note_nodes[oldId].supersededBy === null && o.note_nodes[newId].supersedes === null);
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

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
