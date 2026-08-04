'use strict';
// code-extract/backends/babel.js — the JS/TS/JSX backend, behind the pluggable extractFile() seam.
//
// This is the Phase-1 @babel/parser extractor (richest JS/TS fidelity, zero native deps) repackaged
// to the language-agnostic backend contract the registry dispatches on:
//
//   extractFile(relPath, source, ext) -> { symbols, edges }
//     symbols: [{ name, kind, file, start_line, end_line, signature, exported, class? }]
//     edges:   [{ from, to, kind:'calls'|'imports', external? }]   // `from` is always the file path
//
// The actual AST descent still lives in ../parse.js + ../symbols.js (unchanged — so the existing
// test/code-extract.test.js keeps passing verbatim). This module is a thin adapter: it parses, runs
// extractFromAst, stamps the file path onto every symbol, and lowers the raw imports/calls arrays to
// edges. IMPORT RESOLUTION IS DEFERRED TO index.js: import edges here carry the RAW specifier in
// `to`; index.js rewrites local specifiers to repo-relative module paths (it owns the repo file set)
// and marks the rest external. That keeps per-file backends repo-agnostic while resolution stays in
// one place, identical for every language.

const { parseSource } = require('../parse');
const { extractFromAst } = require('../symbols');

// kinds emitted: function | class | method | arrow  (JS/TS has no struct/interface/enum at this layer)
function extractFile(relPath, source, ext) {
  const ast = parseSource(source, ext);
  if (!ast) return null; // hard parse failure — caller counts it as parse_failed

  let extracted;
  try {
    extracted = extractFromAst(ast, source);
  } catch {
    return null;
  }

  const symbols = extracted.symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    file: relPath,
    start_line: s.start_line,
    end_line: s.end_line,
    signature: s.signature,
    exported: !!s.exported,
    ...(s.class ? { class: s.class } : {}),
  }));

  const edges = [];
  // import edges — raw specifier in `to`; index.js resolves/marks-external against the repo file set.
  for (const spec of extracted.imports) {
    edges.push({ from: relPath, to: spec, kind: 'imports', resolve: true });
  }
  // call edges — file -> callee name (raw; symbol-level resolution is a later phase).
  for (const callee of extracted.calls) {
    edges.push({ from: relPath, to: callee, kind: 'calls' });
  }

  return { symbols, edges };
}

module.exports = { extractFile };
