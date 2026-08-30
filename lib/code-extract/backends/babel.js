'use strict';
// code-extract/backends/babel.js — the JS/TS/JSX backend, behind the pluggable extractFile() seam.
//
// This is the Phase-1 @babel/parser extractor (richest JS/TS fidelity, zero native deps) repackaged
// to the language-agnostic backend contract the registry dispatches on:
//
//   extractFile(relPath, source, ext) -> { symbols, edges }
//     symbols: [{ name, kind, file, start_line, end_line, signature, exported, class? }]
//     edges:   [{ from, to, kind:'calls'|'imports', caller?, external? }]
//
// The actual AST descent still lives in ../parse.js + ../symbols.js (unchanged — so the existing
// test/code-extract.test.js keeps passing verbatim). This module is a thin adapter: it parses, runs
// extractFromAst, stamps the file path onto every symbol, and lowers the raw imports/calls arrays to
// edges. IMPORT RESOLUTION IS DEFERRED TO index.js: import edges here carry the RAW specifier in
// `to`; index.js rewrites local specifiers to repo-relative module paths (it owns the repo file set)
// and marks the rest external. That keeps per-file backends repo-agnostic while resolution stays in
// one place, identical for every language.

const { parseSource } = require('../parse');
const { extractFromAst, calleeName } = require('../symbols');

function methodName(node) {
  const key = node && node.key;
  if (!key) return '<computed>';
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'PrivateName' && key.id) return '#' + key.id.name;
  if (key.type === 'StringLiteral') return key.value;
  return '<computed>';
}

// Map the exact AST nodes that extractFromAst indexes to their symbol names. Nested declarations are
// intentionally absent (the symbol layer does not index them), so their calls inherit the nearest
// indexed outer caller instead of producing a dangling code_node key.
function indexedCallerNodes(ast) {
  const callers = new Map();
  const body = ast && ast.program && Array.isArray(ast.program.body) ? ast.program.body : [];
  for (const top of body) {
    const decl = (top.type === 'ExportNamedDeclaration' || top.type === 'ExportDefaultDeclaration')
      ? top.declaration
      : top;
    if (!decl) continue;
    if (decl.type === 'FunctionDeclaration') {
      callers.set(decl, decl.id ? decl.id.name : '(default)');
    } else if (decl.type === 'VariableDeclaration') {
      for (const item of decl.declarations || []) {
        if (!item.init || (item.init.type !== 'ArrowFunctionExpression' && item.init.type !== 'FunctionExpression')) continue;
        callers.set(item.init, item.id && item.id.type === 'Identifier' ? item.id.name : '(anon)');
      }
    } else if (decl.type === 'FunctionExpression' || decl.type === 'ArrowFunctionExpression') {
      callers.set(decl, '(default)');
    }
    if (decl.type === 'ClassDeclaration' || decl.type === 'ClassExpression') {
      for (const member of (decl.body && decl.body.body) || []) {
        if (member.type === 'ClassMethod' || member.type === 'ClassPrivateMethod') {
          callers.set(member, methodName(member));
        }
      }
    }
  }
  return callers;
}

// Collect one raw edge per (indexed caller, callee). Top-level calls omit `caller`, preserving the
// legacy file-level fallback. This separate walk retains source locations without changing the public
// collectCallNames() helper or extractFromAst().calls compatibility surface.
function collectCallEdges(ast, relPath) {
  const edges = [];
  const seen = new Set();
  const callerNodes = indexedCallerNodes(ast);
  const visit = (node, caller = null) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) visit(child, caller); return; }
    const enclosing = callerNodes.get(node) || caller;
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression' || node.type === 'NewExpression') {
      const callee = calleeName(node.callee);
      if (callee && callee !== 'require') {
        const sig = `${enclosing || ''}\u0000${callee}`;
        if (!seen.has(sig)) {
          seen.add(sig);
          edges.push({ from: relPath, to: callee, kind: 'calls', ...(enclosing ? { caller: enclosing } : {}) });
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' ||
          key === 'trailingComments' || key === 'innerComments' || key === 'range') continue;
      const value = node[key];
      if (value && typeof value === 'object') visit(value, enclosing);
    }
  };
  visit(ast && ast.program);
  return edges;
}

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
  // Call edges retain the enclosing indexed caller when one exists; the resolver canonicalizes it.
  edges.push(...collectCallEdges(ast, relPath));

  return { symbols, edges };
}

module.exports = { extractFile, indexedCallerNodes, collectCallEdges };
