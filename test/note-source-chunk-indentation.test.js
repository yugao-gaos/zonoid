#!/usr/bin/env node
'use strict';

// Regression: chunkText must preserve intra-chunk whitespace so an indented source program stored
// as a long note round-trips through the source-chunk cluster byte-for-byte and still compiles.
// (note:note-mr5bebfkw0t / SPEC IS INCOMPLETE — chunkText used to trim chunk-leading indentation at
// write time, so reassembled Python de-dented and failed to compile.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const { buildSourceClusterForNote } = require('../lib/note-source-cluster');
const { reassembleNoteBody } = require('../lib/note-full-body');

// An indented Python program long/code-like enough to trip shouldClusterNote (>1000 chars, source
// signal) and to span multiple chunks. Deep, meaningful indentation on interior lines.
const PY_PROGRAM = `import sys
from dataclasses import dataclass


@dataclass
class Grid:
    cells: list

    def at(self, r, c):
        if r < 0 or c < 0:
            return None
        try:
            return self.cells[r][c]
        except IndexError:
            return None

    def neighbours(self, r, c):
        out = []
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if dr == 0 and dc == 0:
                    continue
                v = self.at(r + dr, c + dc)
                if v is not None:
                    out.append(v)
        return out


def flood(grid, start):
    seen = set()
    stack = [start]
    while stack:
        node = stack.pop()
        if node in seen:
            continue
        seen.add(node)
        for nb in grid.neighbours(*node):
            if nb not in seen:
                stack.append(nb)
    return seen


def summarise(grid):
    totals = {}
    for r, row in enumerate(grid.cells):
        for c, value in enumerate(row):
            if value not in totals:
                totals[value] = 0
            totals[value] += len(grid.neighbours(r, c))
    ordered = sorted(totals.items(), key=lambda kv: (-kv[1], kv[0]))
    lines = []
    for value, weight in ordered:
        if weight > 0:
            lines.append("{}:{}".format(value, weight))
        else:
            lines.append("{}:0".format(value))
    return "\\n".join(lines)


def main():
    rows = []
    for line in sys.stdin:
        row = [int(x) for x in line.split()]
        rows.append(row)
    grid = Grid(rows)
    if rows:
        result = flood(grid, (0, 0))
        print(len(result))
        report = summarise(grid)
        if report:
            for entry in report.split("\\n"):
                print(entry)
    else:
        print(0)


if __name__ == "__main__":
    main()
`;

// Reassembly reproduces the CLEANED evidence (CRLF-normalized + whole-doc trimmed), never the raw
// pre-clean bytes — same contract note-full-body.js documents. The program above has no leading
// blank lines and one trailing newline, so cleaning only strips that trailing newline.
function cleaned(s) {
  return String(s).replace(/\r\n/g, '\n').trim();
}

// Minimal projected-graph shim mirroring buildGraph(ws) shape that reassembleNoteBody consumes:
// a note task + one task per knowledge node, plus the overlay edge list.
function projectCluster(noteKey, title, summary, cluster) {
  const tasks = [{ id: noteKey, label: title, kind: 'note', summary }];
  for (const n of cluster.nodes) {
    const key = `knowledge:${n.type}:${n.id}`;
    tasks.push({ id: key, label: n.label, kind: n.type, summary: n.summary, chunk_ref: n.chunk_ref });
  }
  return { graph: { tasks }, edges: cluster.edges };
}

test('indented python program round-trips through the source-chunk cluster byte-for-byte', () => {
  const noteKey = 'note:test-indented-python';
  const title = 'Indented Python program evidence';

  const cluster = buildSourceClusterForNote(noteKey, {
    title,
    summary: PY_PROGRAM,
    source_path: 'out/program.py',
  });
  assert.ok(cluster, 'a long source-like note produces a cluster');
  assert.ok(cluster.chunkCount > 1, 'the program spans more than one chunk');

  const { graph, edges } = projectCluster(noteKey, title, cluster.noteSummary, cluster);
  const res = reassembleNoteBody(graph, edges, noteKey);
  assert.equal(res.ok, true, res.error || 'reassembly ok');

  // Byte-exact: reassembled full body equals the cleaned program.
  assert.equal(res.full_body, cleaned(PY_PROGRAM), 'full body is byte-identical to the cleaned program');

  // Interior indentation survived (the exact failure mode: chunk-leading dedent).
  assert.ok(res.full_body.includes('\n            return self.cells[r][c]'), '12-space indent preserved');
  assert.ok(res.full_body.includes('\n                if dr == 0 and dc == 0:'), '16-space indent preserved');

  // And it still compiles under python3.
  const py = spawnSync('python3', ['-c', 'import ast,sys; ast.parse(sys.stdin.read())'], {
    input: res.full_body,
    encoding: 'utf8',
  });
  assert.equal(py.status, 0, `reassembled program compiles (python3 says: ${py.stderr})`);
});

test('non-source short note is unchanged (no cluster)', () => {
  const cluster = buildSourceClusterForNote('note:short', {
    title: 'short',
    summary: 'A compact note should stay exactly as written.',
  });
  assert.equal(cluster, null, 'short prose note produces no cluster');
});

test('prose long note still chunks on blank-line boundaries and round-trips', () => {
  const noteKey = 'note:prose-long';
  const prose = Array.from({ length: 40 }, (_, i) =>
    `Paragraph ${i + 1}: the retrieval hardening evidence must remain exactly recoverable so that a stored fact can round-trip through the cluster without loss.`
  ).join('\n\n');
  const cluster = buildSourceClusterForNote(noteKey, { title: 'prose', summary: prose });
  assert.ok(cluster && cluster.chunkCount > 1, 'long prose produces multiple chunks');
  const { graph, edges } = projectCluster(noteKey, 'prose', cluster.noteSummary, cluster);
  const res = reassembleNoteBody(graph, edges, noteKey);
  assert.equal(res.full_body, cleaned(prose), 'prose round-trips byte-for-byte');
});
