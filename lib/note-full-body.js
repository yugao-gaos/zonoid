'use strict';

// Read-only reassembly of a note's full body from its source-chunk cluster.
//
// Long / code-like note summaries are compacted at write time (lib/note-source-cluster.js): the
// note keeps a ~1000-char compacted summary + marker, and the FULL raw evidence is preserved as a
// source_doc -> source_section -> source_chunk knowledge cluster. /search only ever returns the
// compacted note summary, so a stored program cannot round-trip through search alone. This helper
// walks the cluster and reassembles the chunk bodies in order so the full text is recoverable.
//
// Cluster shape (see lib/note-source-cluster.js buildSourceClusterForNote):
//   node keys:  knowledge:source_doc:<docId>
//               knowledge:source_section:<docId>#note-evidence
//               knowledge:source_chunk:<docId>#note-evidence:chunk-<i>   (1-based, in order)
//   edges:      doc -> section, section -> chunk_i, chunk_i -> note   (chunk is PROVIDER of note)
//
// Reassembly walks chunk -> note edges (the authoritative link back to the note), orders the chunks
// by their trailing chunk-<i> index, and joins their summaries with a blank line — the same
// paragraph boundary chunkText() split on. This reproduces the cleaned+chunked evidence text
// byte-for-byte (chunkText already normalized CRLF and trimmed paragraphs at write time; the
// original pre-clean bytes are not preserved and cannot be reconstructed from chunks).
//
// This module performs NO writes and NO graph mutations. It only reads a projected graph snapshot.

const SOURCE_CHUNK_PREFIX = 'knowledge:source_chunk:';

function normalizeNoteKey(key) {
  const raw = String(key || '').trim();
  if (!raw) return null;
  return raw.startsWith('note:') ? raw : `note:${raw}`;
}

// Trailing ":chunk-<N>" index — the deterministic 1-based order chunkText produced. Falls back to
// +Infinity so an unexpectedly-formatted key sorts last (stable) rather than corrupting the order.
function chunkIndex(node) {
  const ref = node && node.chunk_ref;
  let m = ref && /chunk-(\d+)/.exec(String(ref));
  if (!m) m = /:chunk-(\d+)$/.exec(String((node && node.id) || ''));
  return m ? parseInt(m[1], 10) : Number.POSITIVE_INFINITY;
}

// graph: the projected graph from buildGraph(ws) — { tasks: [...] , ... }. Each task/node carries
//   { id, kind, summary, chunk_ref, ... }.
// edges: the overlay edge list — [{ from, to, ... }]. chunk -> note edges are the traversal link.
function reassembleNoteBody(graph, edges, key) {
  const noteKey = normalizeNoteKey(key);
  if (!noteKey) return { ok: false, error: 'key required' };

  const tasks = (graph && graph.tasks) || [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const note = byId.get(noteKey);
  if (!note || note.kind !== 'note') {
    return { ok: false, error: `unknown note: ${noteKey}` };
  }

  const storedSummary = String(note.summary || '');

  // Collect source_chunk nodes that link to this note (chunk -> note edges).
  const chunkNodes = [];
  const seen = new Set();
  for (const e of edges || []) {
    if (!e || e.to !== noteKey) continue;
    const from = e.from;
    if (typeof from !== 'string' || !from.startsWith(SOURCE_CHUNK_PREFIX)) continue;
    if (seen.has(from)) continue;
    const node = byId.get(from);
    if (!node) continue;
    seen.add(from);
    chunkNodes.push(node);
  }

  if (chunkNodes.length === 0) {
    // Short / unclustered note: its stored summary IS the full body.
    return {
      ok: true,
      key: noteKey,
      title: note.label || noteKey,
      summary: storedSummary,
      full_body: storedSummary,
      chunk_count: 0,
      byte_length: Buffer.byteLength(storedSummary, 'utf8'),
    };
  }

  chunkNodes.sort((a, b) => chunkIndex(a) - chunkIndex(b));
  const fullBody = chunkNodes.map((n) => String(n.summary || '')).join('\n\n');

  return {
    ok: true,
    key: noteKey,
    title: note.label || noteKey,
    summary: storedSummary,
    full_body: fullBody,
    chunk_count: chunkNodes.length,
    byte_length: Buffer.byteLength(fullBody, 'utf8'),
  };
}

module.exports = { reassembleNoteBody, normalizeNoteKey, chunkIndex };
