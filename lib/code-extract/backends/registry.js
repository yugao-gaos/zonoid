'use strict';
// code-extract/backends/registry.js — the pluggable backend registry.
//
// ONE dispatch point: given a file extension, return the backend that extracts it. A backend is any
// module exposing  extractFile(relPath, source, ext) -> { symbols, edges } | null  (null = parse
// failure / unsupported). This is the seam the whole multi-language design turns on — adding a
// language means registering an extension here (+ a grammar + a query in the tree-sitter backend);
// extractRepo / the daemon / the code-index layer never change.
//
//   .js/.mjs/.cjs/.ts/.tsx/.jsx           -> babel backend (@babel/parser, richest JS/TS fidelity)
//   .py/.go/.rs/.java/.c/.h/.cpp/.cc/...   -> tree-sitter backend (web-tree-sitter WASM grammars)

const babel = require('./babel');
const treesitter = require('./treesitter');

// JS/TS family handled by babel (kept identical to the Phase-1 CODE_EXT for those langs).
const BABEL_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'];

// ext (lowercase, with dot) -> backend module
const REGISTRY = new Map();
for (const e of BABEL_EXTS) REGISTRY.set(e, babel);
for (const e of treesitter.supportedExtensions()) REGISTRY.set(e, treesitter);

// Return the backend for an extension, or null if no backend is registered.
function backendForExt(ext) {
  return REGISTRY.get(String(ext || '').toLowerCase()) || null;
}

// All extensions any backend can handle — the union the walker uses so it actually visits the new
// languages (the Phase-1 walker only knew the JS/TS set).
function allExtensions() {
  return [...REGISTRY.keys()];
}

// Convenience: is this a tree-sitter (async-init) extension? extractRepo uses this only for a nicer
// error message when a tree-sitter file is encountered before initTreeSitter() has run.
function isTreeSitterExt(ext) {
  return backendForExt(ext) === treesitter;
}

module.exports = {
  backendForExt,
  allExtensions,
  isTreeSitterExt,
  REGISTRY,
  babel,
  treesitter,
};
