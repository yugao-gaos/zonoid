#!/usr/bin/env node
// Regression tests for the shared/local overlay split.
// Verifies that save() writes only LOCAL fields to disk, and load() rehydrates
// shared fields (edges, status, summaries, knowledge, note_nodes, snapshots)
// from graph-store — not from the overlay JSON file.
// Run: node test/overlay-split.test.js
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

// Set CLAUDE_PLUGIN_DATA BEFORE requiring overlay or graph-store (BASE is computed at require time).
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-split-')));
process.env.CLAUDE_PLUGIN_DATA = TMP;

const overlayStore = require('../lib/overlay');
const graphStore   = require('../lib/graph-store');

// Helper: count non-empty lines in a JSONL file.
function lineCount(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch { return 0; }
}

// Helper: all JSONL files under a workspace's .graph/nodes directory.
function nodeFiles(ws) {
  const dir = path.join(ws, '.graph', 'nodes');
  try {
    return fs.readdirSync(dir, { recursive: true })
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f));
  } catch { return []; }
}

// Helper: total line count across all node JSONL files in a workspace.
function totalNodeLines(ws) {
  return nodeFiles(ws).reduce((sum, f) => sum + lineCount(f), 0);
}

try {

  // ── Test 1 & 2: save() strips shared fields / keeps local fields on disk ──

  const WS1 = path.join(TMP, 'ws1');
  fs.mkdirSync(WS1, { recursive: true });
  graphStore.forWorkspace(WS1);

  const ov1 = overlayStore.load(WS1);

  // Add shared fields
  overlayStore.addEdge(ov1, 'task/a', 'task/b', null, 'blocking');
  overlayStore.setStatus(ov1, 'task/a', 'in_progress');
  overlayStore.setSummary(ov1, 'task/a', 'some summary');

  // Add local fields (ephemeral runtime — kept on disk)
  ov1.config.test_key = 'val-1';
  // Add moved-to-graph-store fields
  ov1.assignee['task/a'] = 'agent-1';
  ov1.timestamps['task/a'] = { firstSeen: '2026-01-01T00:00:00.000Z' };

  overlayStore.save(WS1, ov1);

  // Read raw JSON from disk — find the file for WS1 via config discriminator
  const overlayDir = path.join(TMP, 'overlay');
  const files = fs.readdirSync(overlayDir).filter((f) => f.endsWith('.json'));
  const diskFile = files.map((f) => path.join(overlayDir, f)).find((f) => {
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      return d.config && d.config.test_key === 'val-1';
    } catch { return false; }
  });

  ok('1. disk file exists for WS1', !!diskFile);

  if (diskFile) {
    const diskData = JSON.parse(fs.readFileSync(diskFile, 'utf8'));

    // Test 1: shared fields must NOT be on disk
    ok('1. save() strips edges from disk',      !Object.prototype.hasOwnProperty.call(diskData, 'edges'));
    ok('1. save() strips status from disk',     !Object.prototype.hasOwnProperty.call(diskData, 'status'));
    ok('1. save() strips summaries from disk',  !Object.prototype.hasOwnProperty.call(diskData, 'summaries'));
    ok('1. save() strips knowledge from disk',  !Object.prototype.hasOwnProperty.call(diskData, 'knowledge'));
    ok('1. save() strips note_nodes from disk', !Object.prototype.hasOwnProperty.call(diskData, 'note_nodes'));
    ok('1. save() strips snapshots from disk',  !Object.prototype.hasOwnProperty.call(diskData, 'snapshots'));

    // Test 1 (continued): moved-to-graph-store fields must NOT be on disk
    ok('1. save() strips assignee from disk',     !Object.prototype.hasOwnProperty.call(diskData, 'assignee'));
    ok('1. save() strips timestamps from disk',   !Object.prototype.hasOwnProperty.call(diskData, 'timestamps'));
    ok('1. save() strips metrics from disk',      !Object.prototype.hasOwnProperty.call(diskData, 'metrics'));
    ok('1. save() strips measurements from disk', !Object.prototype.hasOwnProperty.call(diskData, 'measurements'));
    ok('1. save() strips benchmarks from disk',   !Object.prototype.hasOwnProperty.call(diskData, 'benchmarks'));
    ok('1. save() strips repos from disk',        !Object.prototype.hasOwnProperty.call(diskData, 'repos'));

    // Test 2: local fields MUST be on disk
    ok('2. save() keeps config on disk', Object.prototype.hasOwnProperty.call(diskData, 'config'));
    ok('2. config value correct on disk', diskData.config && diskData.config.test_key === 'val-1');
  }

  // ── Test 3: load() rehydrates edges from graph-store ─────────────────────

  const WS3 = path.join(TMP, 'ws3');
  fs.mkdirSync(WS3, { recursive: true });
  graphStore.forWorkspace(WS3);

  const ov3 = overlayStore.load(WS3);
  overlayStore.addEdge(ov3, 'task/src', 'task/dst', null, 'context');
  overlayStore.save(WS3, ov3);

  // Fresh load — reads disk (no edges in local JSON) + graph-store (has the edge)
  const ov3b = overlayStore.load(WS3);
  ok('3. load() rehydrates edges array', Array.isArray(ov3b.edges));
  ok('3. load() rehydrates edge count === 1', ov3b.edges.length === 1);
  ok('3. load() rehydrated edge.from correct', ov3b.edges[0] && ov3b.edges[0].from === 'task/src');
  ok('3. load() rehydrated edge.to correct',   ov3b.edges[0] && ov3b.edges[0].to   === 'task/dst');
  ok('3. load() rehydrated edge.kind correct', ov3b.edges[0] && ov3b.edges[0].kind === 'context');

  // ── Test 4: load() rehydrates status from graph-store ────────────────────

  const WS4 = path.join(TMP, 'ws4');
  fs.mkdirSync(WS4, { recursive: true });
  graphStore.forWorkspace(WS4);

  const ov4 = overlayStore.load(WS4);
  overlayStore.setStatus(ov4, 'task/x', 'done');
  overlayStore.save(WS4, ov4);

  const ov4b = overlayStore.load(WS4);
  ok('4. load() rehydrates status map', typeof ov4b.status === 'object');
  ok('4. load() rehydrated status[task/x] === done', ov4b.status['task/x'] === 'done');

  // ── Test 5: load() rehydrates summaries from graph-store ─────────────────

  const WS5 = path.join(TMP, 'ws5');
  fs.mkdirSync(WS5, { recursive: true });
  graphStore.forWorkspace(WS5);

  const ov5 = overlayStore.load(WS5);
  overlayStore.setSummary(ov5, 'task/y', 'the summary text');
  overlayStore.save(WS5, ov5);

  const ov5b = overlayStore.load(WS5);
  ok('5. load() rehydrates summaries map', typeof ov5b.summaries === 'object');
  ok('5. load() rehydrated summaries[task/y] correct', ov5b.summaries['task/y'] === 'the summary text');

  // ── Test 6: load() rehydrates note_nodes from graph-store ────────────────

  const WS6 = path.join(TMP, 'ws6');
  fs.mkdirSync(WS6, { recursive: true });
  graphStore.forWorkspace(WS6);

  const ov6 = overlayStore.load(WS6);
  const noteId = overlayStore.addNoteNode(ov6, { title: 'Key decision', summary: 'We chose A', created_by: 'tester' });
  overlayStore.save(WS6, ov6);

  const ov6b = overlayStore.load(WS6);
  ok('6. load() rehydrates note_nodes map', typeof ov6b.note_nodes === 'object');
  ok('6. load() rehydrated note exists', !!ov6b.note_nodes[noteId]);
  ok('6. load() rehydrated note.title correct', ov6b.note_nodes[noteId] && ov6b.note_nodes[noteId].title === 'Key decision');

  // ── Test 7: load() on fresh workspace (no graph yet) returns EMPTY ────────

  // Use a path that does NOT exist — no graph, no overlay file
  const WS7 = path.join(TMP, 'ws7-nonexistent-' + Date.now());

  let ov7, threw7 = false;
  try { ov7 = overlayStore.load(WS7); }
  catch (e) { threw7 = true; console.log(`  (threw: ${e.message})`); }

  ok('7. load() on fresh path does not throw', !threw7);
  ok('7. load() returns edges: []',  ov7 && Array.isArray(ov7.edges) && ov7.edges.length === 0);
  ok('7. load() returns status: {}', ov7 && typeof ov7.status === 'object' && Object.keys(ov7.status).length === 0);

  // ── Test 8: round-trip save → load → save produces no new JSONL events ───

  const WS8 = path.join(TMP, 'ws8');
  fs.mkdirSync(WS8, { recursive: true });
  graphStore.forWorkspace(WS8);

  // First: build an overlay with several shared fields and save it
  const ov8 = overlayStore.load(WS8);
  overlayStore.addEdge(ov8, 'task/p', 'task/q', null, 'blocking');
  overlayStore.setStatus(ov8, 'task/p', 'in_progress');
  overlayStore.setSummary(ov8, 'task/p', 'round-trip summary');
  overlayStore.addNoteNode(ov8, { title: 'RT note', summary: 'round-trip', created_by: 'test' });
  overlayStore.save(WS8, ov8);

  const afterFirst = totalNodeLines(WS8);
  ok('8. after first save, node files exist', afterFirst > 0);

  // Round-trip: load into a NEW in-memory object, then save again
  const ov8b = overlayStore.load(WS8);
  overlayStore.save(WS8, ov8b);

  const afterRoundTrip = totalNodeLines(WS8);
  ok('8. round-trip save produces no new JSONL events', afterRoundTrip === afterFirst);

} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
