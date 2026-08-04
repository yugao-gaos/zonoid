#!/usr/bin/env node
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildSourceClusterForNote } = require('../lib/note-source-cluster');
const { reassembleNoteBody, normalizeNoteKey, chunkIndex } = require('../lib/note-full-body');

// Project a cluster's nodes + edges into the { tasks } graph shape reassembleNoteBody consumes,
// mirroring daemon.js buildGraph projection: note nodes get kind:'note', knowledge nodes keep their
// type as kind. Cluster node keys are knowledge:<type>:<id>; the note node is added separately.
function projectCluster(noteKey, noteSummary, cluster) {
  const tasks = [{ id: noteKey, label: 'test note', kind: 'note', summary: noteSummary }];
  for (const n of cluster.nodes) {
    tasks.push({
      id: `knowledge:${n.type}:${n.id}`,
      label: n.label,
      kind: n.type,
      summary: n.summary,
      chunk_ref: n.chunk_ref || null,
    });
  }
  return { graph: { tasks }, edges: cluster.edges.map((e) => ({ ...e, kind: 'context' })) };
}

// The evidence text as it is stored after cleanText + chunkText normalization. reassembleNoteBody
// can only reproduce THIS (chunks join with a blank line) — the pre-clean bytes (CRLF, blank-line
// whitespace) are not preserved in chunk summaries. So the byte-exact target is the cleaned form.
function cleanedChunkedForm(cluster) {
  return cluster.nodes
    .filter((n) => n.type === 'source_chunk')
    .map((n) => n.summary)
    .join('\n\n');
}

test('clustered note reassembly is byte-exact against the stored chunks', () => {
  const noteKey = 'note:prog-roundtrip';
  // A long, code-like program payload that forces clustering (multi-chunk).
  const program = Array.from({ length: 10 }, (_, i) => `## Step ${i + 1}

function stage${i + 1}(input) {
  const result = transform(input, ${i + 1});
  return result.filter((x) => x.valid && x.index === ${i + 1});
}`).join('\n\n');

  const cluster = buildSourceClusterForNote(noteKey, {
    title: 'Stored program',
    summary: program,
    source_path: 'programs/pipeline.js',
  });
  assert.ok(cluster, 'long code-like note clusters');
  assert.ok(cluster.chunkCount > 1, 'program spans multiple chunks');

  const { graph, edges } = projectCluster(noteKey, cluster.noteSummary, cluster);
  const out = reassembleNoteBody(graph, edges, noteKey);

  assert.equal(out.ok, true);
  assert.equal(out.key, noteKey);
  assert.equal(out.chunk_count, cluster.chunkCount);
  // Byte-exact against the cleaned+chunked stored form.
  const expected = cleanedChunkedForm(cluster);
  assert.equal(out.full_body, expected, 'reassembled body equals the concatenated stored chunks');
  assert.equal(out.byte_length, Buffer.byteLength(expected, 'utf8'), 'byte_length matches full_body');
  // The compacted note summary is returned separately and is NOT the full body.
  assert.equal(out.summary, cluster.noteSummary);
  assert.notEqual(out.full_body, out.summary, 'full body recovers more than the compacted summary');
});

test('reassembly recovers chunks in order even when edges are shuffled', () => {
  const noteKey = 'note:ordering';
  const program = Array.from({ length: 12 }, (_, i) =>
    `paragraph ${i + 1}: ` + 'x'.repeat(300)).join('\n\n');
  const cluster = buildSourceClusterForNote(noteKey, { title: 'ordered', summary: program });
  assert.ok(cluster && cluster.chunkCount > 1);

  const { graph, edges } = projectCluster(noteKey, cluster.noteSummary, cluster);
  // Reverse the edge list to prove ordering comes from chunk index, not edge order.
  const out = reassembleNoteBody(graph, edges.slice().reverse(), noteKey);
  assert.equal(out.full_body, cleanedChunkedForm(cluster));
});

test('unclustered short note passes its stored summary through as full_body', () => {
  const noteKey = 'note:short';
  const summary = 'A compact note stays exactly as written.';
  // A short note does NOT cluster.
  assert.equal(buildSourceClusterForNote(noteKey, { title: 'short', summary }), null);

  const graph = { tasks: [{ id: noteKey, label: 'short', kind: 'note', summary }] };
  const out = reassembleNoteBody(graph, [], noteKey);
  assert.equal(out.ok, true);
  assert.equal(out.chunk_count, 0);
  assert.equal(out.full_body, summary);
  assert.equal(out.summary, summary);
  assert.equal(out.byte_length, Buffer.byteLength(summary, 'utf8'));
});

test('missing / unknown note key returns ok:false', () => {
  const graph = { tasks: [{ id: 'note:exists', kind: 'note', summary: 'hi' }] };
  const missing = reassembleNoteBody(graph, [], 'note:does-not-exist');
  assert.equal(missing.ok, false);
  assert.match(missing.error, /unknown note/);

  const empty = reassembleNoteBody(graph, [], '');
  assert.equal(empty.ok, false);
  assert.match(empty.error, /key required/);

  // A non-note node (e.g. a task or knowledge node) is not a note.
  const g2 = { tasks: [{ id: 'knowledge:source_chunk:x', kind: 'source_chunk', summary: 'c' }] };
  const notNote = reassembleNoteBody(g2, [], 'knowledge:source_chunk:x');
  assert.equal(notNote.ok, false);
});

test('normalizeNoteKey adds the note: prefix; reassembly accepts bare keys', () => {
  assert.equal(normalizeNoteKey('abc'), 'note:abc');
  assert.equal(normalizeNoteKey('note:abc'), 'note:abc');
  assert.equal(normalizeNoteKey('  '), null);

  const graph = { tasks: [{ id: 'note:bare', kind: 'note', summary: 'body' }] };
  const out = reassembleNoteBody(graph, [], 'bare'); // no note: prefix
  assert.equal(out.ok, true);
  assert.equal(out.key, 'note:bare');
});

test('chunkIndex parses order from chunk_ref and from the node id', () => {
  assert.equal(chunkIndex({ chunk_ref: 'chunk-7' }), 7);
  assert.equal(chunkIndex({ id: 'knowledge:source_chunk:doc#note-evidence:chunk-3' }), 3);
  assert.equal(chunkIndex({ id: 'no-index' }), Number.POSITIVE_INFINITY);
});
