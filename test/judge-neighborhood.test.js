#!/usr/bin/env node
// Plain Node test for the PURE neighborhood-expansion + supersede-chain logic in lib/judge.js
// (no framework; matches test/judge-queue.test.js style). Run: node test/judge-neighborhood.test.js
//
// Properties under test (the dumb substrate's structural-context assembly):
//   - expandNeighborhood is a relevance-decayed best-first walk over POSITIVE-weight context edges:
//       relevance(node @ depth d) = product(edge weights) × decay^d.
//   - A node that is only relevant ~2 hops up via a STRONG judged chain is INCLUDED (endpoint-only
//     judgment would miss it); a diffuse/weak chain stops ~1 hop (relevance floor).
//   - weight-0 (unpromoted autowire) edges are NOT traversed.
//   - the node/char budget caps the payload on a dense node (it doesn't blow up).
//   - supersedeChain returns N's replaced notes (bitemporal), oldest→newest, N excluded.
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// resolver: tasks t1.. and notes note:n.. — title=key, summary short.
const nodeOf = (key) => ({ title: key, summary: 'sum-' + key });

// --- strong 2-hop chain is reached; weak chain stops at 1 hop ------------------------------------
{
  const o = ov.EMPTY();
  // anchor 'A' → N ; N is the candidate endpoint we expand FROM.
  // STRONG chain from N: N -w0.9-> S1 -w0.9-> S2  (relevance at S2 = 0.9*0.6 * 0.9*0.6 = 0.2916 > 0.15 floor)
  // WEAK chain  from N: N -w0.3-> W1 -w0.3-> W2  (rel W1 = 0.18 > floor; rel W2 = 0.18*0.3*0.6=0.0324 < floor → stop)
  o.edges = [
    { from: 'N', to: 'S1', kind: 'context', weight: 0.9, judged: true },
    { from: 'S1', to: 'S2', kind: 'context', weight: 0.9, judged: true },
    { from: 'N', to: 'W1', kind: 'context', weight: 0.3, judged: true },
    { from: 'W1', to: 'W2', kind: 'context', weight: 0.3, judged: true },
  ];
  const r = judge.expandNeighborhood(o, 'N', nodeOf);
  const keys = r.nodes.map((n) => n.key);
  ok('strong 2-hop node S2 IS included (deep via strong judged chain)', keys.includes('S2'));
  ok('strong 1-hop S1 included', keys.includes('S1'));
  ok('weak 1-hop W1 included', keys.includes('W1'));
  ok('weak 2-hop W2 EXCLUDED (relevance below floor — diffuse stops ~1 hop)', !keys.includes('W2'));
  ok('start node N is NOT in its own neighborhood', !keys.includes('N'));
  // ordering: by descending relevance — S1 (0.54) before S2 (0.29) before W1 (0.18)
  const relOf = (k) => r.nodes.find((n) => n.key === k).relevance;
  ok('relevance decays with depth (S1 > S2)', relOf('S1') > relOf('S2'));
  ok('strong S2 outranks weak W1 (0.29 > 0.18)', relOf('S2') > relOf('W1'));
  ok('nodes sorted descending by relevance', r.nodes.every((n, i, a) => i === 0 || a[i - 1].relevance >= n.relevance));
}

// --- weight-0 (unpromoted) edges are not traversed -----------------------------------------------
{
  const o = ov.EMPTY();
  o.edges = [
    { from: 'N', to: 'P', kind: 'context', weight: 0, judged: false },   // unpromoted autowire — skip
    { from: 'N', to: 'Q', kind: 'context', weight: 0.8, judged: true },  // promoted — traverse
    { from: 'N', to: 'B', kind: 'blocking' },                            // non-context — skip
  ];
  const keys = judge.expandNeighborhood(o, 'N', nodeOf).nodes.map((n) => n.key);
  ok('weight-0 edge NOT traversed (P absent)', !keys.includes('P'));
  ok('blocking edge NOT traversed (B absent)', !keys.includes('B'));
  ok('promoted edge traversed (Q present)', keys.includes('Q'));
}

// --- both directions: a neighbor connected INTO N is structural context too ----------------------
{
  const o = ov.EMPTY();
  o.edges = [{ from: 'IN', to: 'N', kind: 'context', weight: 0.8, judged: true }];
  const r = judge.expandNeighborhood(o, 'N', nodeOf);
  ok('incoming-edge neighbor IN is reached (both directions walked)', r.nodes.map((n) => n.key).includes('IN'));
}

// --- dense node: node + char budget caps the payload (does not blow up) ---------------------------
{
  const o = ov.EMPTY();
  o.edges = [];
  for (let i = 0; i < 200; i++) o.edges.push({ from: 'N', to: 'D' + i, kind: 'context', weight: 0.9, judged: true });
  const r = judge.expandNeighborhood(o, 'N', nodeOf, { maxNodes: 12 });
  ok('dense node capped at maxNodes (<=12)', r.nodes.length <= 12);
  ok('dense node flagged truncated', r.truncated === true);
  // char budget independently caps
  const bigNode = (key) => ({ title: key, summary: 'x'.repeat(1000) });
  const r2 = judge.expandNeighborhood(o, 'N', bigNode, { maxNodes: 100, maxChars: 2500 });
  ok('char budget caps payload (<= ~3 big nodes)', r2.nodes.length <= 4 && r2.truncated === true);
}

// --- config override via overlay.config.judge.neighborhood ----------------------------------------
{
  const o = ov.EMPTY();
  o.config = { judge: { neighborhood: { threshold: 0.5, decay: 0.6, maxNodes: 12, maxChars: 4000 } } };
  o.edges = [
    { from: 'N', to: 'S1', kind: 'context', weight: 0.9, judged: true }, // rel 0.54 > 0.5 → in
    { from: 'S1', to: 'S2', kind: 'context', weight: 0.9, judged: true }, // rel 0.29 < 0.5 → out
  ];
  const keys = judge.expandNeighborhood(o, 'N', nodeOf).nodes.map((n) => n.key);
  ok('high config threshold prunes deeper node S2', keys.includes('S1') && !keys.includes('S2'));
}

// --- supersede chain (bitemporal) -----------------------------------------------------------------
{
  const o = ov.EMPTY();
  // chain: n1 (retired) ← n2 (retired) ← n3 (current, = N). N excluded; oldest→newest.
  o.note_nodes = {
    n1: { id: 'n1', title: 't1', summary: 's1', validFrom: '2026-01-01', validTo: '2026-02-01', supersededBy: 'n2', supersedes: null },
    n2: { id: 'n2', title: 't2', summary: 's2', validFrom: '2026-02-01', validTo: '2026-03-01', supersededBy: 'n3', supersedes: 'n1' },
    n3: { id: 'n3', title: 't3', summary: 's3', validFrom: '2026-03-01', validTo: null, supersededBy: null, supersedes: 'n2' },
  };
  const chain = judge.supersedeChain(o, 'note:n3');
  ok('supersedeChain returns the 2 notes N replaced', chain.length === 2);
  ok('chain is oldest→newest (n1 before n2)', chain[0].key === 'note:n1' && chain[1].key === 'note:n2');
  ok('chain excludes N itself (n3 absent)', !chain.some((c) => c.key === 'note:n3'));
  ok('chain entries carry bitemporal fields', chain[0].validTo === '2026-02-01' && chain[0].current === false);
  // a task or chainless note returns []
  ok('supersedeChain empty for a task key', judge.supersedeChain(o, 'some/task').length === 0);
  o.note_nodes.solo = { id: 'solo', title: 't', summary: 's', validFrom: 'x', validTo: null, supersededBy: null, supersedes: null };
  ok('supersedeChain empty for a chainless note', judge.supersedeChain(o, 'note:solo').length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
