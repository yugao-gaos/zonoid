#!/usr/bin/env node
// Unit tests for the AST code-edge RESOLVER (lib/code-extract/resolve-edges.js): turning the raw
// extractor edge list ({from:file, to:callee-name|file}) into code_node↔code_node edges.
//
// Pure function, no babel / no daemon / no MiniLM — driven entirely by synthetic { symbols, edges }
// inputs in the exact shape extractRepo()/extractFile() emit. Covers:
//   • call edge -> resolves callee NAME to the defining code_node key (code:<file>#<name>)
//   • ambiguity -> a name defined in N files links to ALL N (ambiguous:true)
//   • external call -> callee with no local def is DROPPED (counted)
//   • local import -> fans to the imported file's EXPORTED symbols
//   • import to a file with no exports -> file-level fallback edge (to_file)
//   • external import (external:true) -> DROPPED (counted)
//   • determinism -> shuffled input yields byte-identical output
// Run: node test/code-edge-resolve.test.js
'use strict';
const { resolveCodeEdges, buildSymbolIndex, codeNodeKey } = require('../lib/code-extract/resolve-edges');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// A small synthetic repo: main.js imports helper.js + an external pkg, and calls helperFn, add, dup.
// helper.js defines helperFn (exported). util.js defines add (exported) + dup. other.js defines dup too.
// sideeffect.js is imported but exports nothing.
const symbols = [
  { name: 'helperFn', kind: 'function', file: 'helper.js', exported: true,  signature: 'helperFn(x)' },
  { name: 'add',      kind: 'function', file: 'util.js',   exported: true,  signature: 'add(a,b)' },
  { name: 'dup',      kind: 'function', file: 'util.js',   exported: false, signature: 'dup()' },
  { name: 'dup',      kind: 'function', file: 'other.js',  exported: true,  signature: 'dup()' },
  { name: 'main',     kind: 'function', file: 'main.js',   exported: true,  signature: 'main()' },
  // sideeffect.js intentionally has NO exported symbol (only an internal):
  { name: '_priv',    kind: 'function', file: 'sideeffect.js', exported: false, signature: '_priv()' },
];
const edges = [
  // calls from main.js
  { from: 'main.js', to: 'helperFn', kind: 'calls' },
  { from: 'main.js', to: 'add',      kind: 'calls' },
  { from: 'main.js', to: 'dup',      kind: 'calls' },   // ambiguous: util.js + other.js
  { from: 'main.js', to: 'console',  kind: 'calls' },   // external: no local def -> dropped
  // imports from main.js
  { from: 'main.js', to: 'helper.js',     kind: 'imports' },              // local -> fan to helperFn
  { from: 'main.js', to: 'sideeffect.js', kind: 'imports' },              // local, no exports -> file edge
  { from: 'main.js', to: 'lodash',        kind: 'imports', external: true }, // external -> dropped
];

// ── buildSymbolIndex ──────────────────────────────────────────────────────────────────────────────
{
  const { byName, exportsByFile } = buildSymbolIndex(symbols);
  ok('index: byName has both dup defs', (byName.get('dup') || []).length === 2);
  ok('index: byName helperFn -> helper.js', (byName.get('helperFn') || [])[0].file === 'helper.js');
  ok('index: exportsByFile util.js lists only exported add (not dup)',
    JSON.stringify(exportsByFile.get('util.js')) === JSON.stringify(['add']));
  ok('index: exportsByFile has no entry for sideeffect.js (no exports)', !exportsByFile.has('sideeffect.js'));
}

// ── resolveCodeEdges ────────────────────────────────────────────────────────────────────────────
const { codeEdges, stats } = resolveCodeEdges({ symbols, edges });
const has = (pred) => codeEdges.some(pred);

// CALLS
ok('call helperFn -> code:helper.js#helperFn',
  has((e) => e.kind === 'calls' && e.from_file === 'main.js' && e.to === codeNodeKey('helper.js', 'helperFn')));
ok('call add -> code:util.js#add',
  has((e) => e.kind === 'calls' && e.to === codeNodeKey('util.js', 'add')));
ok('ambiguous call dup -> BOTH util.js and other.js defs',
  has((e) => e.kind === 'calls' && e.to === codeNodeKey('util.js', 'dup') && e.ambiguous === true) &&
  has((e) => e.kind === 'calls' && e.to === codeNodeKey('other.js', 'dup') && e.ambiguous === true));
ok('external call (console) is DROPPED (no edge)',
  !has((e) => e.kind === 'calls' && e.name === 'console'));
ok('stats.calls_external counts the dropped console call', stats.calls_external === 1);
ok('stats.calls_ambiguous counts both dup links', stats.calls_ambiguous === 2);

// IMPORTS
ok('local import main.js -> fans to helper.js exported helperFn',
  has((e) => e.kind === 'imports' && e.from_file === 'main.js' && e.to === codeNodeKey('helper.js', 'helperFn')));
ok('import to sideeffect.js (no exports) -> FILE-LEVEL fallback edge (to_file)',
  has((e) => e.kind === 'imports' && e.from_file === 'main.js' && e.to_file === 'sideeffect.js' && !e.to));
ok('external import (lodash) is DROPPED', !has((e) => e.kind === 'imports' && (e.to_file === 'lodash' || e.to === 'lodash')));
ok('stats.imports_external counts the dropped lodash import', stats.imports_external === 1);
ok('stats.imports_resolved_file counts the sideeffect.js file edge', stats.imports_resolved_file === 1);
ok('stats.total === codeEdges.length', stats.total === codeEdges.length);

// All resolved symbol endpoints are valid code:<file>#<name> keys.
ok('every symbol-targeted edge has a code:<file>#<name> `to`',
  codeEdges.filter((e) => e.to).every((e) => /^code:[^#]*#.+$/.test(e.to)));

// ── DETERMINISM: shuffled input -> identical output ───────────────────────────────────────────────
{
  const shuffled = [...edges].reverse();
  const symsShuffled = [...symbols].reverse();
  const a = JSON.stringify(resolveCodeEdges({ symbols, edges }).codeEdges);
  const b = JSON.stringify(resolveCodeEdges({ symbols: symsShuffled, edges: shuffled }).codeEdges);
  ok('resolver is deterministic (shuffled input -> identical sorted output)', a === b);
}

// ── EDGE CASES: empty / missing inputs never throw ────────────────────────────────────────────────
{
  ok('empty input -> no edges, no throw', resolveCodeEdges({}).codeEdges.length === 0);
  ok('edges with no symbols -> all calls external, no throw',
    resolveCodeEdges({ symbols: [], edges: [{ from: 'a.js', to: 'x', kind: 'calls' }] }).stats.calls_external === 1);
  ok('a self-call (file calls a symbol it defines) is kept',
    resolveCodeEdges({
      symbols: [{ name: 'rec', kind: 'function', file: 'r.js', exported: true }],
      edges: [{ from: 'r.js', to: 'rec', kind: 'calls' }],
    }).codeEdges.some((e) => e.to === codeNodeKey('r.js', 'rec')));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
