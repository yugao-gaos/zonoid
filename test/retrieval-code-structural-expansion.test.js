#!/usr/bin/env node
'use strict';
// Unit test for the CODE-STRUCTURAL expansion tier (task #2): expandCodeStructure walks the
// deterministic code_edges layer from the code_node cosine seeds to surface their callees, callers, and
// imports as ADDITIVE structural neighbors. Pure function — driven directly with a synthetic overlay
// (code_nodes + code_edges) and a seed ragResults array, mirroring retrieval-cluster-expansion.test.js.
//
// Run: node test/retrieval-code-structural-expansion.test.js

const { expandCodeStructure } = require('../lib/search/memory-search');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const K = (file, name) => `code:${file}#${name}`;

// ── Core fixture ───────────────────────────────────────────────────────────────────────────────────
// seed lives in handler.js. It CALLS validate (util.js) and IMPORTS db.js (exporting query). It is
// CALLED BY route.js (which also defines a sibling symbol `mw`). renderer.js defines an UNRELATED
// symbol that touches none of the edges.
function makeOverlay() {
  return {
    code_nodes: {
      [K('handler.js', 'handle')]:  { key: K('handler.js', 'handle'),  name: 'handle',  file: 'handler.js',  kind: 'function', signature: 'handle(req)', exported: true,  start_line: 10, end_line: 30 },
      [K('util.js', 'validate')]:   { key: K('util.js', 'validate'),   name: 'validate', file: 'util.js',     kind: 'function', signature: 'validate(x)', exported: true,  start_line: 1,  end_line: 8 },
      [K('db.js', 'query')]:        { key: K('db.js', 'query'),        name: 'query',    file: 'db.js',       kind: 'function', signature: 'query(sql)', exported: true,  start_line: 1,  end_line: 12 },
      [K('route.js', 'route')]:     { key: K('route.js', 'route'),     name: 'route',    file: 'route.js',    kind: 'function', signature: 'route()',    exported: true,  start_line: 1,  end_line: 20 },
      [K('route.js', 'mw')]:        { key: K('route.js', 'mw'),        name: 'mw',       file: 'route.js',    kind: 'function', signature: 'mw()',       exported: false, start_line: 22, end_line: 28 },
      [K('renderer.js', 'render')]: { key: K('renderer.js', 'render'), name: 'render',   file: 'renderer.js', kind: 'function', signature: 'render()',   exported: true,  start_line: 1,  end_line: 5 },
    },
    code_edges: [
      // CALLEE: handler.js calls validate (util.js)
      { from_file: 'handler.js', to: K('util.js', 'validate'), kind: 'calls', name: 'validate' },
      // IMPORT-OUT: handler.js imports db.js -> its exported symbol query
      { from_file: 'handler.js', to: K('db.js', 'query'), kind: 'imports', name: 'query', to_file: 'db.js' },
      // CALLER: route.js calls handle (the seed)
      { from_file: 'route.js', to: K('handler.js', 'handle'), kind: 'calls', name: 'handle' },
      // a file-level import fallback FROM the seed (no symbol target) -> must be ignored (no `to`)
      { from_file: 'handler.js', to_file: 'sideeffect.js', kind: 'imports' },
      // an unrelated edge that touches neither the seed's file nor the seed key
      { from_file: 'renderer.js', to: K('util.js', 'validate'), kind: 'calls', name: 'validate' },
    ],
  };
}

const seedRow = () => ({
  key: K('handler.js', 'handle'),
  title: 'handle',
  summary: 'handle(req)',
  score: 0.61,
  cosine: 0.61,
  kind: 'code_node',
  tier: 'code',
  via: 'semantic',
  path: [],
});

// ── 1. callees / callers / imports surface; unrelated does not ───────────────────────────────────────
{
  const overlay = makeOverlay();
  const ragResults = [seedRow()];
  const added = expandCodeStructure({ overlay, ragResults, excludedKeys: new Set() });
  const keys = ragResults.map((r) => r.key);

  ok('cosine seed remains present and first (additive, not reordered)',
    keys[0] === K('handler.js', 'handle') && ragResults[0].via === 'semantic' && ragResults[0].score === 0.61);
  ok('callee surfaces (handler -> validate)', keys.includes(K('util.js', 'validate')));
  ok('import-out surfaces (handler imports db.query)', keys.includes(K('db.js', 'query')));
  ok('caller surfaces (route.route calls handle)', keys.includes(K('route.js', 'route')));
  ok('caller sibling symbol in same calling file surfaces (route.mw)', keys.includes(K('route.js', 'mw')));
  ok('unrelated symbol does NOT surface (renderer.render)', !keys.includes(K('renderer.js', 'render')));

  const expanded = ragResults.filter((r) => r.code_expanded);
  ok('every added row is a structural code row (tier code / via code-structural)',
    expanded.length === added.length
    && expanded.every((r) => r.tier === 'code' && r.via === 'code-structural' && r.code_expanded_from === K('handler.js', 'handle')));
  ok('structural rows carry a tiny floor score below the cosine seed',
    expanded.every((r) => r.score > 0 && r.score < 0.61));

  // relation tagging
  const byKey = Object.fromEntries(ragResults.map((r) => [r.key, r]));
  ok('callee tagged relation=callee', byKey[K('util.js', 'validate')].code_relation === 'callee');
  ok('import-out tagged relation=imports_out kind=imports',
    byKey[K('db.js', 'query')].code_relation === 'imports_out' && byKey[K('db.js', 'query')].code_edge_kind === 'imports');
  ok('caller tagged relation=caller', byKey[K('route.js', 'route')].code_relation === 'caller');
  ok('file-level (to_file) import edge from seed produced no row',
    !keys.some((k) => k && k.startsWith('code:sideeffect.js')));
}

// ── 2. ADDITIVE: a neighbor already present as a cosine hit is annotated, NOT duplicated/rescored ─────
{
  const overlay = makeOverlay();
  const validateHit = {
    key: K('util.js', 'validate'),
    title: 'validate',
    summary: 'validate(x)',
    score: 0.55, // genuine cosine score
    cosine: 0.55,
    kind: 'code_node',
    tier: 'code',
    via: 'semantic',
    path: [],
  };
  const ragResults = [seedRow(), validateHit];
  expandCodeStructure({ overlay, ragResults, excludedKeys: new Set() });

  const validateRows = ragResults.filter((r) => r.key === K('util.js', 'validate'));
  ok('callee already in results is NOT duplicated', validateRows.length === 1);
  ok('existing cosine score preserved (still 0.55, not the floor)', validateRows[0].score === 0.55);
  ok('existing cosine via preserved (still semantic)', validateRows[0].via === 'semantic');
  ok('existing hit annotated as structural neighbor', validateRows[0].code_expanded === true && validateRows[0].code_relation === 'callee');
}

// ── 3. BOUNDED: a hot symbol imported by many files cannot explode the result set ────────────────────
{
  // hot.js#util is imported by 40 files, each defining 5 symbols. Without caps that is 200 caller rows.
  const code_nodes = {
    [K('hot.js', 'util')]: { key: K('hot.js', 'util'), name: 'util', file: 'hot.js', kind: 'function', signature: 'util()', exported: true },
  };
  const code_edges = [];
  for (let f = 0; f < 40; f++) {
    const file = `caller${f}.js`;
    code_edges.push({ from_file: file, to: K('hot.js', 'util'), kind: 'imports', name: 'util', to_file: 'hot.js' });
    for (let s = 0; s < 5; s++) {
      code_nodes[K(file, `sym${s}`)] = { key: K(file, `sym${s}`), name: `sym${s}`, file, kind: 'function', signature: `sym${s}()`, exported: true };
    }
  }
  const overlay = { code_nodes, code_edges };
  const ragResults = [{
    key: K('hot.js', 'util'), title: 'util', summary: 'util()', score: 0.7, cosine: 0.7,
    kind: 'code_node', tier: 'code', via: 'semantic', path: [],
  }];
  const added = expandCodeStructure({ overlay, ragResults, excludedKeys: new Set() });

  ok('total fan-out is capped (<= totalLimit 24)', added.length <= 24);
  ok('per-seed cap holds (<= perSeedLimit 8 from a single seed)', added.length <= 8);
  // per-calling-file cap: no single caller file contributes more than callerSymbolsPerFile (3) symbols
  const perFileCounts = {};
  for (const r of ragResults.filter((x) => x.code_expanded)) {
    const file = (overlay.code_nodes[r.key] || {}).file;
    perFileCounts[file] = (perFileCounts[file] || 0) + 1;
  }
  ok('per-calling-file symbol cap holds (<= 3 each)', Object.values(perFileCounts).every((n) => n <= 3));
}

// ── 4. excluded keys are never surfaced ──────────────────────────────────────────────────────────────
{
  const overlay = makeOverlay();
  const ragResults = [seedRow()];
  const excluded = new Set([K('util.js', 'validate')]); // exclude the callee
  expandCodeStructure({ overlay, ragResults, excludedKeys: excluded });
  const keys = ragResults.map((r) => r.key);
  ok('excluded callee is not surfaced', !keys.includes(K('util.js', 'validate')));
  ok('non-excluded neighbors still surface', keys.includes(K('db.js', 'query')) && keys.includes(K('route.js', 'route')));
}

// ── 5. dangling edge target (no backing code_node) is dropped ────────────────────────────────────────
{
  const overlay = makeOverlay();
  // Point an outgoing edge at a symbol that has NO code_node entry.
  overlay.code_edges.push({ from_file: 'handler.js', to: K('ghost.js', 'gone'), kind: 'calls', name: 'gone' });
  const ragResults = [seedRow()];
  expandCodeStructure({ overlay, ragResults, excludedKeys: new Set() });
  ok('edge target with no backing code_node is not surfaced',
    !ragResults.some((r) => r.key === K('ghost.js', 'gone')));
}

// ── 6. no-op guards: empty edges / empty results return [] without throwing ──────────────────────────
{
  ok('no code_edges -> no expansion', expandCodeStructure({ overlay: { code_nodes: makeOverlay().code_nodes, code_edges: [] }, ragResults: [seedRow()], excludedKeys: new Set() }).length === 0);
  ok('no rag results -> no expansion', expandCodeStructure({ overlay: makeOverlay(), ragResults: [], excludedKeys: new Set() }).length === 0);
  ok('no seeds (only note rows) -> no expansion',
    expandCodeStructure({ overlay: makeOverlay(), ragResults: [{ key: 'note:x', kind: 'note', tier: 'rag', via: 'rrf-bm25', score: 0.4 }], excludedKeys: new Set() }).length === 0);
  ok('structural seed is NOT itself re-expanded (via code-structural skipped)',
    expandCodeStructure({ overlay: makeOverlay(), ragResults: [{ ...seedRow(), via: 'code-structural', code_expanded: true }], excludedKeys: new Set() }).length === 0);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
