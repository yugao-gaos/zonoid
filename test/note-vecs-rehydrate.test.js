#!/usr/bin/env node
// Regression: note field-level vectors stored in graph-store must survive overlay reload
// and remain visible on the buildGraph note projection.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-note-vecs-')));
process.env.CLAUDE_PLUGIN_DATA = TMP;

const overlayStore = require('../lib/overlay');
const graphStore = require('../lib/graph-store');
const daemon = require('../daemon');

const WS = fs.realpathSync(fs.mkdtempSync(path.join(TMP, 'ws-')));
const noteId = 'note-rehydrate1';
const noteKey = 'note:' + noteId;
const pooledVec = [0.25, 0.5, 0.75];
const fieldVecs = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

try {
  const store = graphStore.forWorkspace(WS);
  graphStore.appendEvent(store, noteKey, {
    evt: 'note_created',
    actor: 'test',
    id: noteId,
    workspace: WS,
    title: 'Vector rehydrate note',
    summary: 'Field vectors should survive reload.',
    created_by: 'test',
    valid_from: '2026-06-21T00:00:00.000Z',
    vec: pooledVec,
    vecs: fieldVecs,
  });

  const reloaded = overlayStore.load(WS);
  const loadedNote = reloaded.note_nodes[noteId];
  ok('overlay.load rehydrates note.vec', !!loadedNote && same(loadedNote.vec, pooledVec));
  ok('overlay.load rehydrates note.vecs', !!loadedNote && same(loadedNote.vecs, fieldVecs));

  daemon.__clearOverlayCacheForTest();
  daemon.__setWorkspaceForTest(WS);
  const graph = daemon.buildGraph(WS);
  const projected = graph.tasks.find((t) => t.id === noteKey);
  ok('buildGraph projects pooled note.vec unchanged', !!projected && same(projected.vec, pooledVec));
  ok('buildGraph projects field-level note.vecs', !!projected && same(projected.vecs, fieldVecs));
} finally {
  try {
    const pid = parseInt(fs.readFileSync(path.join(TMP, 'embed.pid'), 'utf8'), 10);
    if (pid) process.kill(pid, 'SIGTERM');
  } catch { /* sidecar may not have spawned */ }
  fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
