#!/usr/bin/env node
// Tests for edge judging-metadata persistence (by/judged/score/origin) across a graph-store reload
// and checkpoint round-trip. Regression for the judging→ready gate silently no-opping after a daemon
// restart: edges were reconstructed as only {from,to,kind,weight}, dropping judged:false so the gate
// found no unjudged edges and let every task go ready immediately.
// Plain Node, no framework. Run: node test/graph-store-edge-meta.test.js
'use strict';
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const gs    = require('../lib/graph-store');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gs-edgemeta-')));
}
const findEdge = (g, from, to) => (g.edges || []).find((e) => e.from === from && e.to === to);

// ── reload preserves by/judged/score/origin on an unjudged autowire candidate edge ─────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  // unjudged autowire candidate: weight 0 (retrieval-invisible), judged:false, by:'autowire'
  gs.appendEvent(store, 'note:n1', {
    evt: 'edge_added', actor: 'a', from: 'note:n1', to: 'task/1',
    kind: 'context', weight: 0, by: 'autowire', judged: false, origin: 'autowire-semantic',
  });
  // promoted (judged-kept) edge: weight>0, judged:true, carries recall score
  gs.appendEvent(store, 'note:n2', {
    evt: 'edge_added', actor: 'a', from: 'note:n2', to: 'task/1',
    kind: 'context', weight: 0.8, by: 'autowire', judged: true, score: 0.8, origin: 'autowire-semantic',
  });

  const g = gs.loadGraph(store);
  const unjudged = findEdge(g, 'note:n1', 'task/1');
  const promoted = findEdge(g, 'note:n2', 'task/1');

  ok('reloaded unjudged edge keeps by:autowire',          unjudged && unjudged.by === 'autowire');
  ok('reloaded unjudged edge keeps judged:false',         unjudged && unjudged.judged === false);
  ok('reloaded unjudged edge keeps origin',               unjudged && unjudged.origin === 'autowire-semantic');
  ok('reloaded unjudged edge keeps weight:0',             unjudged && unjudged.weight === 0);
  ok('reloaded promoted edge keeps judged:true',          promoted && promoted.judged === true);
  ok('reloaded promoted edge keeps score',                promoted && promoted.score === 0.8);

  // backEdges (incoming view) must carry the metadata too
  const back = (g.backEdges['task/1'] || []).find((b) => b.from === 'note:n1');
  ok('backEdges entry keeps judged:false',                back && back.judged === false);
  ok('backEdges entry keeps by:autowire',                 back && back.by === 'autowire');

  fs.rmSync(dir, { recursive: true });
}

// ── causal task-result edge metadata survives graph-store replay ────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  gs.appendEvent(store, 'task/a', {
    evt: 'edge_added', actor: 'a', from: 'task/a', to: 'task/b',
    kind: 'context', origin: 'task-result-causal', relation: 'fixed',
    confidence: 0.75, evidence: 'regression test passed',
  });

  const g = gs.loadGraph(store);
  const causal = findEdge(g, 'task/a', 'task/b');
  ok('reloaded causal edge keeps relation',           causal && causal.relation === 'fixed');
  ok('reloaded causal edge keeps origin',             causal && causal.origin === 'task-result-causal');
  ok('reloaded causal edge keeps confidence',         causal && causal.confidence === 0.75);
  ok('reloaded causal edge keeps evidence',           causal && causal.evidence === 'regression test passed');

  fs.rmSync(dir, { recursive: true });
}

// ── checkpoint/compaction round-trip carries the metadata ──────────────────────────────────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  // terminal node so it compacts; the edge lives in its file and would be lost without checkpointing
  gs.appendEvent(store, 'note:nc', { evt: 'node_created', actor: 'a', label: 'note', kind: 'note' });
  gs.appendEvent(store, 'note:nc', { evt: 'status_changed', actor: 'a', status: 'done' });
  gs.appendEvent(store, 'note:nc', {
    evt: 'edge_added', actor: 'a', from: 'note:nc', to: 'task/2',
    kind: 'context', weight: 0, by: 'autowire', judged: false, origin: 'autowire-semantic',
  });

  gs.compact(store);
  // checkpoint.json is now the only surviving record of the edge (file removed if compacted)
  const g = gs.loadGraph(store);
  const e = findEdge(g, 'note:nc', 'task/2');
  ok('checkpoint round-trip keeps judged:false',          e && e.judged === false);
  ok('checkpoint round-trip keeps by:autowire',           e && e.by === 'autowire');
  ok('checkpoint round-trip keeps origin',                e && e.origin === 'autowire-semantic');

  fs.rmSync(dir, { recursive: true });
}

// ── back-compat: legacy edge_added without `judged` but weight>0 reloads as judged:true ─────────
// (Old events predate this fix. A promoted edge has weight>0; it must NOT be treated as a fresh
// weight-0 unjudged edge — otherwise tagBlindEdges flips every old promoted edge to judged:false.)
{
  const dir   = tmpDir();
  const store = gs.open(dir);

  // legacy promoted edge: no judged/by/origin, but weight>0
  gs.appendEvent(store, 'note:nL', {
    evt: 'edge_added', actor: 'a', from: 'note:nL', to: 'task/3', kind: 'context', weight: 0.7,
  });
  // legacy weight-0 edge: stays absent-judged (NOT promoted) — tagBlindEdges will adopt it later
  gs.appendEvent(store, 'note:nZ', {
    evt: 'edge_added', actor: 'a', from: 'note:nZ', to: 'task/3', kind: 'context', weight: 0,
  });

  const g = gs.loadGraph(store);
  const legacyPromoted = findEdge(g, 'note:nL', 'task/3');
  const legacyZero     = findEdge(g, 'note:nZ', 'task/3');
  ok('legacy promoted (weight>0) defaults judged:true',   legacyPromoted && legacyPromoted.judged === true);
  ok('legacy weight-0 leaves judged absent',              legacyZero && !('judged' in legacyZero));

  // tagBlindEdges must NOT re-stamp the promoted edge (judged already present → skipped),
  // but DOES adopt the weight-0 edge as unjudged.
  const ov = { edges: g.edges };
  const tagged = judge.tagBlindEdges(ov);
  ok('tagBlindEdges adopts only the weight-0 legacy edge', tagged === 1);
  ok('legacy promoted edge stays judged:true after migration', findEdge(g, 'note:nL', 'task/3').judged === true);

  fs.rmSync(dir, { recursive: true });
}

// ── judge.judgingState() returns the SAME verdict pre- and post-reload (load-bearing) ──────────
{
  const dir   = tmpDir();
  const store = gs.open(dir);
  const now   = Date.now();
  const HOUR  = 3600 * 1000;

  gs.appendEvent(store, 'note:nj', {
    evt: 'edge_added', actor: 'a', from: 'note:nj', to: 'task/4',
    kind: 'context', weight: 0, by: 'autowire', judged: false, origin: 'autowire-semantic',
  });

  // PRE-reload overlay (as the daemon holds it in memory right after seeding the candidate edge)
  const preOverlay = {
    edges: [{ from: 'note:nj', to: 'task/4', kind: 'context', weight: 0, by: 'autowire', judged: false, origin: 'autowire-semantic' }],
    judgingSince: { 'task/4': now },
  };
  const preState = judge.judgingState(preOverlay, 'task/4', now, HOUR);
  ok('pre-reload: task is judging (held)',                preState.judging === true && preState.timedOut === false);

  // POST-reload overlay (edges rehydrated from disk, judgingSince re-anchored identically)
  const g = gs.loadGraph(store);
  const postOverlay = { edges: g.edges, judgingSince: { 'task/4': now } };
  const postState = judge.judgingState(postOverlay, 'task/4', now, HOUR);
  ok('post-reload: task is STILL judging (held)',         postState.judging === true && postState.timedOut === false);
  ok('judgingState verdict identical pre/post reload',
     preState.judging === postState.judging && preState.timedOut === postState.timedOut);

  fs.rmSync(dir, { recursive: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
