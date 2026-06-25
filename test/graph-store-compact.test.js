#!/usr/bin/env node
// Tests for graphStore.compact() — the checkpoint contract.
// Asserts the merged graph view (checkpointed + live nodes, edges) is IDENTICAL before and
// after compaction, and that appends after compaction fold on top of the checkpointed state.
// Plain Node, no framework. Run: node test/graph-store-compact.test.js
'use strict';
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const assert = require('assert');
const gs     = require('../lib/graph-store');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};
const eq = (label, a, b) => {
  try { assert.deepStrictEqual(a, b); console.log(`PASS  ${label}`); pass++; }
  catch (e) { console.log(`FAIL  ${label}: ${e.message.split('\n')[0]}`); fail++; }
};

function tmpDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-gs-compact-')));
}

// Merged node view — what consumers (overlay.load) actually read.
function mergedNodes(graph) {
  return JSON.parse(JSON.stringify({ ...graph.checkpointed, ...graph.nodes }));
}
function sortedEdges(graph) {
  return JSON.parse(JSON.stringify(
    [...graph.edges].sort((a, b) => `${a.from}\0${a.to}\0${a.kind}`.localeCompare(`${b.from}\0${b.to}\0${b.kind}`))
  ));
}
function jsonlFiles(store) {
  return fs.readdirSync(store.nodesDir, { recursive: true }).filter((f) => f.endsWith('.jsonl'));
}

const dir   = tmpDir();
const store = gs.open(dir);

try {
  // ── Build a store: several node files, events, and edges ──────────────────

  // done/1 — terminal (done), rich state, with outgoing + incoming edges in ITS file
  gs.appendEvent(store, 'done/1', { evt: 'node_created',    actor: 'a', label: 'finished task', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'done/1', { evt: 'status_changed',  actor: 'a', status: 'in_progress' });
  gs.appendEvent(store, 'done/1', { evt: 'summary_set',     actor: 'a', summary: 'built the thing' });
  gs.appendEvent(store, 'done/1', { evt: 'knowledge_added', actor: 'a', item: { type: 'file', value: 'foo.js' } });
  gs.appendEvent(store, 'done/1', { evt: 'status_changed',  actor: 'b', status: 'done', note: 'merged' });
  // edge FROM the terminal node, stored in its own file (lost on compaction unless checkpointed)
  gs.appendEvent(store, 'done/1', { evt: 'edge_added', actor: 'a', from: 'done/1', to: 'live/2', kind: 'blocking' });
  // edge from a NON-terminal node but stored in the terminal node's file (record-decision pattern)
  gs.appendEvent(store, 'done/1', { evt: 'edge_added', actor: 'a', from: 'note:k', to: 'done/1', kind: 'context', weight: 0.9 });

  // tested/1 — terminal (tested)
  gs.appendEvent(store, 'tested/1', { evt: 'node_created',   actor: 'a', label: 'tested task', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'tested/1', { evt: 'status_changed', actor: 'a', status: 'tested' });

  // live/2 — in_progress (must NOT be compacted)
  gs.appendEvent(store, 'live/2', { evt: 'node_created',   actor: 'a', label: 'live task', kind: 'task', workspace: '/w' });
  gs.appendEvent(store, 'live/2', { evt: 'status_changed', actor: 'a', status: 'in_progress' });

  // note:k — note node, status null (must NOT be compacted)
  gs.appendEvent(store, 'note:k', { evt: 'note_created', actor: 'a', title: 'a note', summary: 'remember X', workspace: '/w', created_by: 'tester' });

  // ── Snapshot before ────────────────────────────────────────────────────────
  const before       = gs.loadGraph(store);
  const nodesBefore  = mergedNodes(before);
  const edgesBefore  = sortedEdges(before);
  ok('setup: 4 node files before compaction', jsonlFiles(store).length === 4);
  ok('setup: 2 edges loaded before compaction', before.edges.length === 2);

  // ── Compact ────────────────────────────────────────────────────────────────
  const r = gs.compact(store);
  ok('compact returns compacted count 2 (done/1 + tested/1)', r.compacted === 2);
  ok('compact writes checkpoint.json', fs.existsSync(store.checkpointFile));
  ok('compact removes terminal node files (2 remain)', jsonlFiles(store).length === 2);

  const cp = JSON.parse(fs.readFileSync(store.checkpointFile, 'utf8'));
  ok('checkpoint stores both terminal nodes', !!cp.nodes['done/1'] && !!cp.nodes['tested/1']);
  ok('checkpoint stores edges', Array.isArray(cp.edges) && cp.edges.length === 2);
  ok('checkpoint has compacted_at', typeof cp.compacted_at === 'string');

  // ── Identity: loadGraph before vs after ───────────────────────────────────
  const after = gs.loadGraph(store);
  eq('merged nodes identical before vs after compaction', mergedNodes(after), nodesBefore);
  eq('edges identical before vs after compaction', sortedEdges(after), edgesBefore);

  // ── appendEvent AFTER compaction still works ──────────────────────────────
  // (a) append to a COMPACTED node — folds on top of checkpointed state
  gs.appendEvent(store, 'done/1', { evt: 'knowledge_added', actor: 'c', item: { type: 'note', value: 'post-compact tip' } });
  // (b) append to a brand-new node
  gs.appendEvent(store, 'new/9', { evt: 'node_created', actor: 'c', label: 'born after compaction', kind: 'task', workspace: '/w' });
  // (c) a new edge
  gs.appendEvent(store, 'live/2', { evt: 'edge_added', actor: 'c', from: 'live/2', to: 'new/9', kind: 'blocking' });

  const reloaded = gs.loadGraph(store);
  const m        = mergedNodes(reloaded);
  ok('post-compact append: compacted node keeps checkpointed label',   m['done/1'].label === 'finished task');
  ok('post-compact append: compacted node keeps checkpointed summary', m['done/1'].summary === 'built the thing');
  ok('post-compact append: new knowledge folds onto checkpointed state',
    m['done/1'].knowledge.length === 2 && m['done/1'].knowledge[1].value === 'post-compact tip');
  ok('post-compact append: new node loads', m['new/9'] && m['new/9'].label === 'born after compaction');
  ok('post-compact append: new edge loads', reloaded.edges.some((e) => e.from === 'live/2' && e.to === 'new/9'));
  ok('post-compact append: pre-compaction edges still present',
    reloaded.edges.some((e) => e.from === 'done/1' && e.to === 'live/2') &&
    reloaded.edges.some((e) => e.from === 'note:k' && e.to === 'done/1' && e.weight === 0.9));

  // ── Second compaction folds the post-compact appends and stays lossless ───
  const snapshot2 = { nodes: mergedNodes(reloaded), edges: sortedEdges(reloaded) };
  const r2 = gs.compact(store);
  ok('second compact folds the re-appended terminal node', r2.compacted === 1);
  const final = gs.loadGraph(store);
  eq('merged nodes identical across second compaction', mergedNodes(final), snapshot2.nodes);
  eq('edges identical across second compaction', sortedEdges(final), snapshot2.edges);
  ok('second-pass checkpoint kept the post-compact knowledge',
    mergedNodes(final)['done/1'].knowledge.length === 2);

  // ── Idempotency ────────────────────────────────────────────────────────────
  ok('compact with nothing terminal left is a no-op', gs.compact(store).compacted === 0);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
