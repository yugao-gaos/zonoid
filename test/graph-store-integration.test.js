#!/usr/bin/env node
// Integration smoke test for the graph-store dual-write path via overlay.save().
// Tests that overlay mutations reach .graph/nodes/{id}.jsonl without starting the HTTP daemon.
// Run: node test/graph-store-integration.test.js
'use strict';
const fs   = require('fs');
const os   = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

// Set CLAUDE_PLUGIN_DATA BEFORE requiring overlay (BASE is computed at require time).
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gs-integration-')));
process.env.CLAUDE_PLUGIN_DATA = TMP;

const overlayStore = require('../lib/overlay');
const graphStore   = require('../lib/graph-store');

// Create a stable fake workspace dir inside TMP.
const WS = path.join(TMP, 'fake-workspace');
fs.mkdirSync(WS, { recursive: true });

// Helper: count non-empty lines in a JSONL file.
function lineCount(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch { return 0; }
}

// Helper: parse all events from a JSONL file.
function parseEvents(file) {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch { return []; }
}

try {
  // ── Step 1: init the store (simulates daemon workspace load) ─────────────
  graphStore.forWorkspace(WS);

  // ── Step 2: load empty overlay ───────────────────────────────────────────
  const ov = overlayStore.load(WS);

  // ── Step 3: mutate via helpers ───────────────────────────────────────────
  const FROM_ID = 'task/from-1';
  const TO_ID   = 'task/to-2';

  // edge
  overlayStore.addEdge(ov, FROM_ID, TO_ID, null, 'blocking');

  // status
  overlayStore.setStatus(ov, FROM_ID, 'in_progress');

  // summary
  overlayStore.setSummary(ov, FROM_ID, 'Finished the thing');

  // note_node
  const noteId = overlayStore.addNoteNode(ov, { title: 'Decision note', summary: 'We chose X', category: 'preference', tags: ['search', 'replay'], created_by: 'tester' });

  // snapshot (for TO_ID)
  overlayStore.setSnapshot(ov, TO_ID, { subject: 'target task', description: 'desc', status: 'done', blockedBy: [], owner: null, metadata: {} });

  // ── Step 4: save — triggers emitDiff ─────────────────────────────────────
  overlayStore.save(WS, ov);

  // ── Assertions ────────────────────────────────────────────────────────────

  // Test 1: .graph/nodes/{fromId}.jsonl exists
  const nodesDir  = path.join(WS, '.graph', 'nodes');
  const fromFile  = path.join(nodesDir, `${FROM_ID}.jsonl`);
  ok('1. edge save: .graph/nodes/{fromId}.jsonl exists', fs.existsSync(fromFile));

  // Test 2: JSONL file contains edge_added event with correct from/to/kind
  const fromEvents = parseEvents(fromFile);
  const edgeEv = fromEvents.find((e) => e.evt === 'edge_added');
  ok('2. edge_added event present', !!edgeEv);
  ok('2. edge_added.from correct',  edgeEv && edgeEv.from === FROM_ID);
  ok('2. edge_added.to correct',    edgeEv && edgeEv.to   === TO_ID);
  ok('2. edge_added.kind correct',  edgeEv && edgeEv.kind === 'blocking');

  // Test 3: status change → status_changed event in node file
  const statusEv = fromEvents.find((e) => e.evt === 'status_changed');
  ok('3. status_changed event present', !!statusEv);
  ok('3. status_changed.status correct', statusEv && statusEv.status === 'in_progress');

  // Test 4: summary → summary_set event in node file
  const summaryEv = fromEvents.find((e) => e.evt === 'summary_set');
  ok('4. summary_set event present', !!summaryEv);
  ok('4. summary_set.summary correct', summaryEv && summaryEv.summary === 'Finished the thing');

  // Test 5: new note_node → note_created event in its own node file (key = 'note:' + noteId)
  const noteFile   = path.join(nodesDir, `note%3A${noteId}.jsonl`);
  ok('5. note_node file exists', fs.existsSync(noteFile));
  const noteEvents = parseEvents(noteFile);
  const noteEv     = noteEvents.find((e) => e.evt === 'note_created');
  ok('5. note_created event present', !!noteEv);
  ok('5. note_created.title correct', noteEv && noteEv.title === 'Decision note');
  ok('5. note_created.category correct', noteEv && noteEv.category === 'preference');
  ok('5. note_created.tags correct', noteEv && JSON.stringify(noteEv.tags) === JSON.stringify(['search', 'replay']));

  // Test 6: snapshot → snapshot_stored event in the TO node file
  const toFile    = path.join(nodesDir, `${TO_ID}.jsonl`);
  ok('6. snapshot: node file for TO_ID exists', fs.existsSync(toFile));
  const toEvents  = parseEvents(toFile);
  const snapEv    = toEvents.find((e) => e.evt === 'snapshot_stored');
  ok('6. snapshot_stored event present', !!snapEv);
  ok('6. snapshot_stored.subject correct', snapEv && snapEv.subject === 'target task');

  // Test 7: loadGraph returns the edge in graph.edges
  const store  = graphStore.forWorkspace(WS);
  const graph  = graphStore.loadGraph(store);
  const edgeInGraph = graph.edges.find((e) => e.from === FROM_ID && e.to === TO_ID);
  ok('7. loadGraph returns the edge in graph.edges', !!edgeInGraph);
  ok('7. edge kind is blocking', edgeInGraph && edgeInGraph.kind === 'blocking');

  // Test 8: loadGraph returns the edge in graph.backEdges[toId]
  const backs = graph.backEdges[TO_ID];
  ok('8. loadGraph populates backEdges[toId]', Array.isArray(backs) && backs.length > 0);
  const backEdge = backs && backs.find((b) => b.from === FROM_ID);
  ok('8. backEdge.from is correct', !!backEdge);

  // Test 9: second save with NO changes emits no new events (line count unchanged)
  const beforeCount = lineCount(fromFile);
  overlayStore.save(WS, ov);          // overlay unchanged — emitDiff should produce nothing
  const afterCount  = lineCount(fromFile);
  ok('9. second save with no changes: no new events emitted', afterCount === beforeCount);

  // Test 10: second save with a new status change adds exactly one new line to that node's file
  overlayStore.setStatus(ov, FROM_ID, 'done');
  overlayStore.save(WS, ov);
  const afterCount2 = lineCount(fromFile);
  ok('10. second save with status change: exactly one new event', afterCount2 === beforeCount + 1);

  // Test 11: code-node snapshots keep identity so unchanged saves avoid serializing/emitting the
  // large payload, while replacement and removal still persist through graph replay.
  const inserted = overlayStore.upsertCodeNode(ov, {
    key: 'code:src/example.js#run', name: 'run', kind: 'function', file: 'src/example.js',
    summary: 'first version', vec: Array(256).fill(0.25),
  });
  overlayStore.save(WS, ov);
  const codeFile = path.join(nodesDir, graphStore.idToFile(inserted.key));
  const initialCodeLines = lineCount(codeFile);
  const originalNode = ov.code_nodes[inserted.key];
  ok('11. code-node save stores object identity in previous snapshot',
    graphStore.getPrevState(WS).code_nodes[inserted.key] === originalNode);

  const originalStringify = JSON.stringify;
  let codePayloadSerializations = 0;
  try {
    JSON.stringify = (value, ...args) => {
      if (value && value.kind === 'code_node' && value.symbol_kind === 'function') {
        codePayloadSerializations++;
      }
      return originalStringify(value, ...args);
    };
    overlayStore.save(WS, ov);
  } finally {
    JSON.stringify = originalStringify;
  }
  ok('11. unchanged code-node save emits no event', lineCount(codeFile) === initialCodeLines);
  ok('11. unchanged code-node save skips payload serialization', codePayloadSerializations === 0);

  overlayStore.upsertCodeNode(ov, {
    key: inserted.key, name: 'run', kind: 'function', file: 'src/example.js',
    summary: 'second version', vec: Array(256).fill(0.5),
  });
  ok('11. code-node upsert replaces the node object', ov.code_nodes[inserted.key] !== originalNode);
  overlayStore.save(WS, ov);
  ok('11. changed code-node emits one replacement', lineCount(codeFile) === initialCodeLines + 1);
  ok('11. changed code-node replays updated payload',
    graphStore.loadGraph(store).nodes[inserted.key].summary === 'second version');

  overlayStore.removeCodeNodesForFile(ov, 'src/example.js');
  overlayStore.save(WS, ov);
  ok('11. removed code-node emits one tombstone', lineCount(codeFile) === initialCodeLines + 2);
  ok('11. removed code-node stays absent after replay', !graphStore.loadGraph(store).nodes[inserted.key]);

  // Test 12: removing one edge from a high-cardinality overlay stays linear. The indexed-read
  // counter makes the complexity regression deterministic; the generous wall-clock bound catches
  // accidental expensive work outside that membership scan without being a microbenchmark.
  const HIGH_FROM = 'task/high-cardinality';
  const HIGH_EDGE_COUNT = 8000;
  const highEdges = Array.from({ length: HIGH_EDGE_COUNT }, (_, i) => ({
    from: HIGH_FROM, to: `task/high-target-${i}`, kind: 'context', weight: 0.5,
  }));
  ov.edges.push(...highEdges);
  overlayStore.save(WS, ov);
  const highFile = path.join(nodesDir, graphStore.idToFile(HIGH_FROM));
  ok('12. high-cardinality baseline emits each edge once',
    parseEvents(highFile).filter((event) => event.evt === 'edge_added').length === HIGH_EDGE_COUNT);

  const removedTarget = highEdges[Math.floor(HIGH_EDGE_COUNT / 2)].to;
  overlayStore.removeEdge(ov, HIGH_FROM, removedTarget, null, 'context');
  const currentEdges = ov.edges;
  let indexedReads = 0;
  ov.edges = new Proxy(currentEdges, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/.test(property)) indexedReads++;
      return Reflect.get(target, property, receiver);
    },
  });
  const started = process.hrtime.bigint();
  overlayStore.save(WS, ov);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  ok('12. high-cardinality removal uses linear edge reads', indexedReads < HIGH_EDGE_COUNT * 10);
  ok('12. high-cardinality removal completes within generous runtime bound', elapsedMs < 5000);

  overlayStore.save(WS, ov); // unchanged save must not duplicate add/remove events
  const highEvents = parseEvents(highFile);
  ok('12. unchanged resave does not duplicate edge additions',
    highEvents.filter((event) => event.evt === 'edge_added').length === HIGH_EDGE_COUNT);
  ok('12. removed edge emits exactly one tombstone',
    highEvents.filter((event) => event.evt === 'edge_removed' && event.to === removedTarget).length === 1);
  const reloadedHighEdges = graphStore.loadGraph(store).edges.filter((edge) => edge.from === HIGH_FROM);
  ok('12. reload preserves every remaining high-cardinality edge',
    reloadedHighEdges.length === HIGH_EDGE_COUNT - 1);
  ok('12. reload keeps the removed edge absent',
    !reloadedHighEdges.some((edge) => edge.to === removedTarget));

} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
