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

// --- buildQueue ordering: dup-clusters BEFORE edges BEFORE orphans ----------------------------
// Rationale: a dup-cluster degrades every future retrieval (measured: clones depressed a winner
// note from 0.787→0.480); an unverified autowire edge was created at a deliberately loose 0.25
// threshold and mis-wiring is cheap. So priority is: dup-cluster > edge > orphan.
{
  const dim = 384;
  const v = (k) => { const a = new Array(dim).fill(0); a[0] = 1; a[1] = k * 0.01; let n = Math.hypot(a[0], a[1]); a[0] /= n; a[1] /= n; return a; };
  const o = ov.EMPTY(); o.epoch = 1;
  // Two notes that form a dup cluster (similar vectors)
  o.note_nodes = {
    c1: { id: 'c1', title: 'Clone 1', summary: '', validTo: null, vec: v(1) },
    c2: { id: 'c2', title: 'Clone 2', summary: '', validTo: null, vec: v(2) },
    // A third orphan note with no vec (so it's an orphan but not a cluster member)
    n1: { id: 'n1', title: 'Orphan', summary: '', validTo: null, vec: null },
  };
  // One unverified edge
  o.edges = [
    { from: 'note:zz', to: 'note:yy', kind: 'context', judged: false },
  ];
  const q = judge.buildQueue(o);
  const kinds = q.map((i) => i.kind);
  // Find positions
  const dupPos   = kinds.indexOf('dup-cluster');
  const edgePos  = kinds.indexOf('edge');
  const orphanPos = kinds.indexOf('orphan');
  ok('dup-cluster item appears in queue', dupPos !== -1);
  ok('edge item appears in queue', edgePos !== -1);
  ok('orphan item appears in queue', orphanPos !== -1);
  ok('dup-cluster comes before edge', dupPos < edgePos);
  ok('dup-cluster comes before orphan', dupPos < orphanPos);
  ok('edge comes before orphan', edgePos < orphanPos);
  // judgeQueueDepth membership must agree with buildQueue membership (ordering doesn't change count)
  ok('judgeQueueDepth matches buildQueue length', judge.judgeQueueDepth(o) === q.length);
}

// --- nextSlice priority-vs-cursor: the live drain regression -----------------------------------
// Exact live failure: 9 dup-cluster items + ~490 edge items, cursor at 166, budget 20.
// Old behaviour: slice walked queue[166..186] → 20 edges, 0 dup-clusters (clusters are at [0..8]).
// New behaviour: every slice serves all priority items first, then fills remaining budget from
//   the tail (edges+orphans) starting at the cursor.  cursorAfter advances over the TAIL only.
{
  const dim = 384;
  const makeVec = (k) => {
    const a = new Array(dim).fill(0); a[0] = 1; a[1] = k * 0.005;
    const n = Math.hypot(a[0], a[1]); a[0] /= n; a[1] /= n; return a;
  };
  const o = ov.EMPTY(); o.epoch = 1;

  // Build 9 dup-cluster pairs (each pair forms one cluster; cluster items = 9).
  // We need 9 separate clusters, not one big one → use orthogonal axes for each pair.
  // Each cluster note gets an outgoing context edge so it is NOT an orphan (notes in a dup-cluster
  // typically already have edges; this keeps the tail pure-edge to match the live scenario).
  o.note_nodes = {};
  o.edges = [];
  for (let c = 0; c < 9; c++) {
    const va = new Array(dim).fill(0); va[c] = 1; va[c + 1] = 0.005; const na = Math.hypot(va[c], va[c + 1]); va[c] /= na; va[c + 1] /= na;
    const vb = new Array(dim).fill(0); vb[c] = 1; vb[c + 1] = 0.006; const nb = Math.hypot(vb[c], vb[c + 1]); vb[c] /= nb; vb[c + 1] /= nb;
    o.note_nodes[`dc${c}a`] = { id: `dc${c}a`, title: `C${c}A`, summary: '', validTo: null, vec: va };
    o.note_nodes[`dc${c}b`] = { id: `dc${c}b`, title: `C${c}B`, summary: '', validTo: null, vec: vb };
    // Give each a judged outgoing context edge → connected, not orphan.
    o.edges.push({ from: `note:dc${c}a`, to: `task:connected`, kind: 'context', judged: true });
    o.edges.push({ from: `note:dc${c}b`, to: `task:connected`, kind: 'context', judged: true });
  }

  // Build 490 unverified edge items (no overlapping note keys so they don't form clusters)
  for (let i = 0; i < 490; i++) {
    o.edges.push({ from: `note:src${i}`, to: `note:dst${i}`, kind: 'context', judged: false });
  }

  const queue = judge.buildQueue(o);
  const clusterCount = queue.filter((i) => i.kind === 'dup-cluster').length;
  const tailCount    = queue.filter((i) => i.kind !== 'dup-cluster').length;
  ok('live-regression: 9 dup-cluster items in queue', clusterCount === 9);
  ok('live-regression: 490 edge items in tail (cluster notes are connected, not orphans)', tailCount === 490);

  // Set cursor to 166 (past the reordered front in the old flat queue).
  const cursor = 166;
  const slice = judge.nextSlice(queue, cursor, 20);

  ok('live-regression: received 20 items total', slice.items.length === 20);
  ok('live-regression: all 9 dup-clusters present', slice.items.filter((i) => i.kind === 'dup-cluster').length === 9);
  ok('live-regression: 11 tail items (budget 20 - 9 priority)', slice.items.filter((i) => i.kind !== 'dup-cluster').length === 11);
  ok('live-regression: cursorBefore is 166', slice.cursorBefore === 166);
  ok('live-regression: cursorAfter is 177 (166+11), NOT 186', slice.cursorAfter === 177);
  ok('live-regression: idle:false', slice.idle === false);
  ok('live-regression: total is full queue length', slice.total === queue.length);
}

// --- nextSlice priority exhausted → subsequent slice is pure tail -----------------------------
{
  const dim = 384;
  const va = new Array(dim).fill(0); va[0] = 1; va[1] = 0.005; const na = Math.hypot(va[0], va[1]); va[0] /= na; va[1] /= na;
  const vb = new Array(dim).fill(0); vb[0] = 1; vb[1] = 0.006; const nb = Math.hypot(vb[0], vb[1]); vb[0] /= nb; vb[1] /= nb;
  const o = ov.EMPTY(); o.epoch = 1;
  o.note_nodes = {
    p1: { id: 'p1', title: 'P1', summary: '', validTo: null, vec: va },
    p2: { id: 'p2', title: 'P2', summary: '', validTo: null, vec: vb },
  };
  // Give cluster notes outgoing context edges → they are connected, not orphans.
  // Tail is purely the 10 unverified edges.
  o.edges = [
    { from: 'note:p1', to: 'task:t1', kind: 'context', judged: true },
    { from: 'note:p2', to: 'task:t1', kind: 'context', judged: true },
  ];
  for (let i = 0; i < 10; i++) {
    o.edges.push({ from: `note:e${i}a`, to: `note:e${i}b`, kind: 'context', judged: false });
  }
  const queue = judge.buildQueue(o);
  const clusterCount = queue.filter((i) => i.kind === 'dup-cluster').length;
  ok('priority-exhausted: 1 cluster in queue', clusterCount === 1);

  // Stamp the cluster as judged → it disappears from priority.
  const clusterItem = queue.find((i) => i.kind === 'dup-cluster');
  judge.stampCluster(o.judgedClusters, clusterItem.keys, o.epoch);

  const queue2 = judge.buildQueue(o);
  ok('priority-exhausted: cluster gone after stamp', queue2.filter((i) => i.kind === 'dup-cluster').length === 0);

  // A slice now is pure tail — cursor advances normally.
  const slice2 = judge.nextSlice(queue2, 0, 5);
  ok('priority-exhausted: pure-tail slice has 5 edge items', slice2.items.length === 5 && slice2.items.every((i) => i.kind === 'edge'));
  ok('priority-exhausted: cursorAfter is 5', slice2.cursorAfter === 5);
}

// --- nextSlice: un-judged cluster reappears next slice without consuming the edge cursor ------
{
  // A cluster that was served in a slice but NOT given a verdict (skipped) should reappear on the
  // very next slice without any cursor change for the tail items.
  const dim = 384;
  const va = new Array(dim).fill(0); va[0] = 1; va[1] = 0.005; const na = Math.hypot(va[0], va[1]); va[0] /= na; va[1] /= na;
  const vb = new Array(dim).fill(0); vb[0] = 1; vb[1] = 0.006; const nb = Math.hypot(vb[0], vb[1]); vb[0] /= nb; vb[1] /= nb;
  const o = ov.EMPTY(); o.epoch = 1;
  o.note_nodes = {
    r1: { id: 'r1', title: 'R1', summary: '', validTo: null, vec: va },
    r2: { id: 'r2', title: 'R2', summary: '', validTo: null, vec: vb },
  };
  // Give cluster notes outgoing judged edges → connected, not orphans.
  // Tail is purely the 2 unverified edges (length 2).
  o.edges = [
    { from: 'note:r1', to: 'task:t1', kind: 'context', judged: true },
    { from: 'note:r2', to: 'task:t1', kind: 'context', judged: true },
    { from: 'note:ea', to: 'note:eb', kind: 'context', judged: false },
    { from: 'note:ec', to: 'note:ed', kind: 'context', judged: false },
  ];
  const queue = judge.buildQueue(o);
  ok('reappear: 1 cluster + 2 tail edges', queue.filter((i) => i.kind === 'dup-cluster').length === 1 && queue.filter((i) => i.kind !== 'dup-cluster').length === 2);
  // Slice 1: serve cluster + 1 tail item (budget 2 total: 1 priority + 1 tail).
  const s1 = judge.nextSlice(queue, 0, 2);
  ok('reappear: slice1 has 1 cluster + 1 tail', s1.items.filter((i) => i.kind === 'dup-cluster').length === 1 && s1.items.filter((i) => i.kind !== 'dup-cluster').length === 1);
  ok('reappear: cursorAfter after slice1 is 1 (only tail moved)', s1.cursorAfter === 1);

  // Do NOT stamp the cluster (simulate skipped verdict).
  // Slice 2 with the new cursorAfter: cluster reappears, tail resumes at 1.
  const s2 = judge.nextSlice(queue, s1.cursorAfter, 2);
  ok('reappear: cluster reappears in slice2 (not stamped)', s2.items.filter((i) => i.kind === 'dup-cluster').length === 1);
  ok('reappear: tail in slice2 starts at edge[1] (cursor=1)', s2.items.filter((i) => i.kind !== 'dup-cluster').length === 1 && s2.items.find((i) => i.kind !== 'dup-cluster').id === 'note:ec>>note:ed');
  // Tail length is 2; cursor was 1; take 1 → cursorAfter = (1+1) % 2 = 0 (wraps).
  ok('reappear: cursorAfter after slice2 wraps to 0 (tail length 2)', s2.cursorAfter === 0);

  // Stamp the cluster now: it disappears from slice3.
  const ci = queue.find((i) => i.kind === 'dup-cluster');
  judge.stampCluster(o.judgedClusters, ci.keys, o.epoch);
  const queue3 = judge.buildQueue(o);
  const s3 = judge.nextSlice(queue3, s2.cursorAfter, 2);
  ok('reappear: after stamp, cluster absent from slice3', s3.items.filter((i) => i.kind === 'dup-cluster').length === 0);
}

// --- nextSlice: epoch wrap unaffected by priority split ----------------------------------------
{
  const o = ov.EMPTY(); o.epoch = 1;
  o.edges = [];
  for (let i = 0; i < 5; i++) {
    o.edges.push({ from: `note:w${i}a`, to: `note:w${i}b`, kind: 'context', judged: false });
  }
  // No clusters — pure tail queue of 5 edge items.
  const queue = judge.buildQueue(o);
  ok('epoch-wrap: pure-tail queue of 5', queue.length === 5);

  // Walk to the end and verify wrap.
  const s1 = judge.nextSlice(queue, 3, 3); // takes [3,4] then wraps to [0] → 3 items total
  ok('epoch-wrap: takes 3 items wrapping', s1.items.length === 3);
  ok('epoch-wrap: cursorAfter wraps to 1', s1.cursorAfter === 1); // (3+3)%5 = 1

  // Bump epoch — tail membership changes (all edges still unverified, epoch doesn't affect edges).
  ov.bumpEpoch(o);
  const queue2 = judge.buildQueue(o);
  ok('epoch-wrap: queue unchanged after epoch bump (edges are epoch-independent)', queue2.length === 5);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
