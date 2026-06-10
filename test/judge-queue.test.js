#!/usr/bin/env node
// Plain Node test for the PURE edge-judge queue/cursor/budget/epoch logic in lib/judge.js (no
// framework; matches test/orphan-sweep.test.js style). Run: node test/judge-queue.test.js — exits
// non-zero on any failed assertion.
//
// Properties under test (the dumb substrate's contract):
//   - tagBlindEdges tags ONLY note-provider context edges, idempotently, never blocking/supersede.
//   - buildQueue lists unverified edges + orphan/under-connected un-judged-this-epoch notes, stably.
//   - nextSlice advances the cursor by min(budget,total), WRAPS, caps at total, idles on empty queue.
//   - judgedAtEpoch gates re-pull: a note judged at the current epoch drops out of the queue until
//     epoch grows; bumping epoch makes it eligible again.
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --- tagBlindEdges: tags note-provider context edges only, idempotent ---------------------------
{
  const o = ov.EMPTY();
  o.edges = [
    { from: 'note:a', to: 'note:b', kind: 'context' },              // blind note->note  → tag
    { from: 'note:a', to: 's/1', kind: 'context' },                 // blind note->task  → tag
    { from: 's/1', to: 's/2', kind: 'context' },                    // task->task ctx    → NOT tagged (out of scope)
    { from: 's/1', to: 's/2' },                                     // blocking          → NOT tagged
    { from: 'note:x', to: 'note:y', kind: 'supersede' },            // supersede         → NOT tagged
    { from: 'note:c', to: 's/3', kind: 'context', judged: true },   // already judged    → left alone
  ];
  const tagged = judge.tagBlindEdges(o);
  ok('tagBlindEdges tags exactly the 2 blind note-provider context edges', tagged === 2);
  ok('note->note edge tagged judged:false,by:autowire', o.edges[0].judged === false && o.edges[0].by === 'autowire');
  ok('note->task edge tagged', o.edges[1].judged === false);
  ok('task->task context edge NOT tagged', !('judged' in o.edges[2]));
  ok('blocking edge NOT tagged', !('judged' in o.edges[3]));
  ok('supersede edge NOT tagged', !('judged' in o.edges[4]));
  ok('already-judged edge left at judged:true', o.edges[5].judged === true);
  // idempotent: a second run tags nothing new
  ok('tagBlindEdges is idempotent (0 on re-run)', judge.tagBlindEdges(o) === 0);
}

// --- buildQueue: unverified edges first (sorted), then orphan un-judged notes (sorted) ----------
{
  const o = ov.EMPTY();
  o.epoch = 1;
  o.note_nodes = {
    n1: { id: 'n1', title: 'A', summary: '', validTo: null },      // orphan (no outgoing ctx) → in queue
    n2: { id: 'n2', title: 'B', summary: '', validTo: null },      // has outgoing ctx edge   → NOT orphan
    n3: { id: 'n3', title: 'C', summary: '', validTo: '2020-01-01' }, // superseded            → skip
    n4: { id: 'n4', title: 'D', summary: '', validTo: null },      // orphan but judged@epoch → skip
  };
  o.judgedAtEpoch = { 'note:n4': 1 };
  o.edges = [
    { from: 'note:n2', to: 's/9', kind: 'context' },               // makes n2 connected (not in queue)
    { from: 'note:zz', to: 'note:yy', kind: 'context', judged: false }, // unverified edge → in queue
  ];
  const q = judge.buildQueue(o);
  const ids = q.map((i) => `${i.kind}:${i.id}`);
  ok('queue puts the unverified edge first', q[0].kind === 'edge' && q[0].id === 'note:zz>>note:yy');
  ok('queue includes orphan n1', ids.includes('orphan:note:n1'));
  ok('queue excludes connected n2', !ids.includes('orphan:note:n2'));
  ok('queue excludes superseded n3', !ids.includes('orphan:note:n3'));
  ok('queue excludes already-judged-this-epoch n4', !ids.includes('orphan:note:n4'));
  ok('queue length is 2 (1 edge + 1 orphan)', q.length === 2);
}

// --- nextSlice: advances by min(budget,total), wraps, caps, idles -------------------------------
{
  const queue = [{ kind: 'orphan', id: 'a' }, { kind: 'orphan', id: 'b' }, { kind: 'orphan', id: 'c' }, { kind: 'orphan', id: 'd' }, { kind: 'orphan', id: 'e' }];
  const s1 = judge.nextSlice(queue, 0, 2);
  ok('slice1 takes 2 from cursor 0', s1.items.map((i) => i.id).join('') === 'ab' && s1.cursorAfter === 2);
  const s2 = judge.nextSlice(queue, s1.cursorAfter, 2);
  ok('slice2 resumes at cursor 2 (no re-pull)', s2.items.map((i) => i.id).join('') === 'cd' && s2.cursorAfter === 4);
  const s3 = judge.nextSlice(queue, s2.cursorAfter, 2);
  ok('slice3 wraps past end: e then a', s3.items.map((i) => i.id).join('') === 'ea' && s3.cursorAfter === 1);
  // budget caps at total — never re-emit within one call
  const sCap = judge.nextSlice(queue, 0, 99);
  ok('budget caps at total (5 items, no dupes)', sCap.items.length === 5 && new Set(sCap.items.map((i) => i.id)).size === 5);
  // stale cursor past a shrunken queue wraps to 0
  const sStale = judge.nextSlice(queue, 50, 2);
  ok('stale cursor (>=total) wraps to 0', sStale.items.map((i) => i.id).join('') === 'ab');
  // empty queue idles
  const sIdle = judge.nextSlice([], 3, 5);
  ok('empty queue idles, cursor reset to 0', sIdle.idle === true && sIdle.items.length === 0 && sIdle.cursorAfter === 0);
}

// --- judgedAtEpoch gates re-pull; bumping epoch re-opens the note --------------------------------
{
  const o = ov.EMPTY();
  o.epoch = 2;
  o.note_nodes = { n1: { id: 'n1', title: 'X', summary: '', validTo: null } };
  o.judgedAtEpoch = {};
  ok('orphan eligible before judging', judge.buildQueue(o).some((i) => i.id === 'note:n1'));
  // judge it at current epoch (a 'no edge' verdict)
  judge.stampJudged(o.judgedAtEpoch, 'note:n1', o.epoch);
  ok('judged-at-epoch note drops out of queue', !judge.buildQueue(o).some((i) => i.id === 'note:n1'));
  // a new node arrives → epoch grows → eligible again
  ov.bumpEpoch(o);
  ok('after epoch bump the note is re-pullable', judge.buildQueue(o).some((i) => i.id === 'note:n1'));
}

// --- dupClusters: tight cluster groups, outlier stays separate (synthetic vecs) -----------------
{
  // Build 384-dim unit vectors. A tight cluster of 3 near-identical vecs + 1 outlier far away.
  const dim = 384;
  const base = new Array(dim).fill(0); base[0] = 1;                       // points along axis 0
  const jitter = (eps) => { const v = base.slice(); v[1] = eps; let n = Math.hypot(...v.slice(0, 2)); v[0] /= n; v[1] /= n; return v; };
  const outlier = new Array(dim).fill(0); outlier[200] = 1;                // orthogonal → cosine ~0
  const o = ov.EMPTY(); o.epoch = 1;
  o.note_nodes = {
    a: { id: 'a', title: 'dup A', summary: '', validTo: null, vec: jitter(0.01) },
    b: { id: 'b', title: 'dup B', summary: '', validTo: null, vec: jitter(0.02) },
    c: { id: 'c', title: 'dup C', summary: '', validTo: null, vec: jitter(0.03) },
    z: { id: 'z', title: 'outlier', summary: '', validTo: null, vec: outlier },
    s: { id: 's', title: 'superseded dup', summary: '', validTo: '2020-01-01', vec: jitter(0.01) }, // not current → excluded
    n: { id: 'n', title: 'no vec', summary: '', validTo: null, vec: null },                          // no vec → excluded
  };
  const cl = judge.dupClusters(o, 0.85);
  ok('dupClusters finds exactly ONE cluster', cl.length === 1);
  ok('cluster has the 3 tight dups (a,b,c)', cl[0].join(',') === 'note:a,note:b,note:c');
  ok('outlier z is NOT clustered', !cl.flat().includes('note:z'));
  ok('superseded note s excluded (not current)', !cl.flat().includes('note:s'));
  ok('vec-less note n excluded', !cl.flat().includes('note:n'));
  // signature is stable / order-independent
  ok('clusterSignature is sorted+stable', judge.clusterSignature(['note:c', 'note:a', 'note:b']) === 'note:a|note:b|note:c');
  // watermark gating
  ok('cluster pending before judging', judge.clusterPending(o, cl[0]));
  judge.stampCluster(o.judgedClusters = {}, cl[0], o.epoch);
  ok('cluster not pending after stamping at current epoch', !judge.clusterPending(o, cl[0]));
  ov.bumpEpoch(o);
  ok('cluster pending again after epoch bump', judge.clusterPending(o, cl[0]));
}

// --- buildQueue / judgeQueueDepth include unjudged dup-clusters as a third bucket ----------------
{
  const dim = 384;
  const v = (k) => { const a = new Array(dim).fill(0); a[0] = 1; a[1] = k * 0.01; let n = Math.hypot(a[0], a[1]); a[0] /= n; a[1] /= n; return a; };
  const o = ov.EMPTY(); o.epoch = 1;
  o.note_nodes = {
    d1: { id: 'd1', title: 'D1', summary: '', validTo: null, vec: v(1) },
    d2: { id: 'd2', title: 'D2', summary: '', validTo: null, vec: v(2) },
  };
  // d1,d2 are a dup cluster AND orphans (no outgoing ctx). They appear as orphans AND a dup-cluster item.
  const q = judge.buildQueue(o);
  const clusterItem = q.find((i) => i.kind === 'dup-cluster');
  ok('buildQueue includes a dup-cluster item', !!clusterItem);
  ok('dup-cluster item carries both keys', clusterItem && clusterItem.keys.join(',') === 'note:d1,note:d2');
  ok('judgeQueueDepth counts the dup-cluster', judge.judgeQueueDepth(o) >= 1);
  // stamping the cluster removes it from the queue
  judge.stampCluster(o.judgedClusters, clusterItem.keys, o.epoch);
  ok('judged dup-cluster drops from buildQueue', !judge.buildQueue(o).some((i) => i.kind === 'dup-cluster'));
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
