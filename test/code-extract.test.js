#!/usr/bin/env node
// Plain Node test for the JS/TS AST code extractor (no framework; matches extract-decisions.test.js
// style). Run: node test/code-extract.test.js — exits non-zero on any failed assertion.
//
// Two halves:
//   (1) FIXTURE — a tiny inline repo written to a temp dir, exercising every symbol kind
//       (function / arrow / class+method), plus an import edge and a call edge. Asserts the exact
//       extraction shape on known-good input.
//   (2) SELF — runs extractRepo on the extractor's OWN lib/ and asserts three real anchor symbols
//       (createWorktree, compileSearchContext, gateTask) extract with the right file + a non-empty
//       signature. This guards against AST-walk regressions on real, messy source.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractRepo } = require('../lib/code-extract');
const { collectCallNames } = require('../lib/code-extract/symbols');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --------------------------------------------------------------------------
// (1) Inline fixture: function + arrow + class/method + import + call.
// --------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-extract-fixture-'));
try {
  // a helper module the main file imports from (so a LOCAL import edge resolves).
  fs.writeFileSync(path.join(tmp, 'helper.js'),
    'export function helperFn(x) { return x + 1; }\n');

  // main module: ESM import, a function decl, an arrow const, a class with a method, and a call.
  fs.writeFileSync(path.join(tmp, 'main.js'), [
    "import { helperFn } from './helper.js';",
    "import assert from 'node:assert';",
    '',
    'export function add(a, b) {',
    '  return helperFn(a) + b;',  // call: helperFn
    '}',
    '',
    'export const double = (n) => add(n, n);',  // arrow const + call: add
    '',
    'export class Calculator {',
    '  constructor(seed = 0) { this.seed = seed; }',
    '  compute(x) { return double(x); }',  // method + call: double
    '}',
    '',
    'function _internal() { return 42; }',  // non-exported function
    '',
  ].join('\n'));

  const res = extractRepo(tmp);

  // files
  ok('fixture: walks both files', res.files.length === 2 &&
    res.files.some((f) => f.path === 'main.js') && res.files.some((f) => f.path === 'helper.js'));
  ok('fixture: parsed both, no parse failures', res.stats.parsed === 2 && res.stats.parse_failed === 0);

  const byName = (n) => res.symbols.filter((s) => s.file === 'main.js' && s.name === n)[0];

  // function decl
  const add = byName('add');
  ok('fixture: function `add` extracted', add && add.kind === 'function');
  ok('fixture: `add` signature has params', add && /add\(a, b\)/.test(add.signature));
  ok('fixture: `add` exported flag true', add && add.exported === true);
  ok('fixture: `add` has a line range', add && add.start_line >= 1 && add.end_line >= add.start_line);

  // arrow const
  const dbl = byName('double');
  ok('fixture: arrow `double` extracted as kind=arrow', dbl && dbl.kind === 'arrow');
  ok('fixture: `double` signature shows arrow', dbl && /=>/.test(dbl.signature));
  ok('fixture: `double` exported flag true', dbl && dbl.exported === true);

  // class + method
  const cls = byName('Calculator');
  ok('fixture: class `Calculator` extracted', cls && cls.kind === 'class');
  ok('fixture: `Calculator` exported flag true', cls && cls.exported === true);
  const compute = res.symbols.find((s) => s.file === 'main.js' && s.kind === 'method' && s.name === 'compute');
  ok('fixture: method `compute` extracted with class qualifier', compute && compute.class === 'Calculator');
  ok('fixture: `compute` signature qualified by class', compute && /Calculator\.compute\(x\)/.test(compute.signature));
  const ctor = res.symbols.find((s) => s.file === 'main.js' && s.kind === 'method' && s.name === 'constructor');
  ok('fixture: constructor method extracted', !!ctor);

  // non-exported function gets exported:false
  const internal = byName('_internal');
  ok('fixture: non-exported `_internal` has exported=false', internal && internal.exported === false);

  // import edges: one LOCAL (./helper.js -> helper.js) + one EXTERNAL (node:assert)
  const localImport = res.edges.find((e) => e.kind === 'imports' && e.from === 'main.js' && e.to === 'helper.js' && !e.external);
  ok('fixture: local import edge main.js -> helper.js', !!localImport);
  const extImport = res.edges.find((e) => e.kind === 'imports' && e.from === 'main.js' && e.to === 'node:assert' && e.external);
  ok('fixture: external import edge for node:assert', !!extImport);

  // call edges: helperFn, add, double all invoked from main.js
  const callTos = new Set(res.edges.filter((e) => e.kind === 'calls' && e.from === 'main.js').map((e) => e.to));
  ok('fixture: call edge -> helperFn', callTos.has('helperFn'));
  ok('fixture: call edge -> add', callTos.has('add'));
  ok('fixture: call edge -> double', callTos.has('double'));

  // --- TS/TSX coverage: typescript plugin + jsx parse and extract ---
  fs.writeFileSync(path.join(tmp, 'typed.ts'), [
    'export const greet = (name: string): string => `hi ${name}`;',
    'export class Box<T> {',
    '  private val: T;',
    '  constructor(v: T) { this.val = v; }',
    '  get(): T { return this.val; }',
    '}',
    '',
  ].join('\n'));
  const res2 = extractRepo(tmp);
  const greet = res2.symbols.find((s) => s.file === 'typed.ts' && s.name === 'greet');
  ok('fixture: TS arrow `greet` extracted with typed params', greet && greet.kind === 'arrow' && /name: string/.test(greet.signature));
  const boxGet = res2.symbols.find((s) => s.file === 'typed.ts' && s.kind === 'method' && s.name === 'get');
  ok('fixture: TS class method `Box.get` extracted', boxGet && boxGet.class === 'Box');

  // --- direct unit: collectCallNames picks member-call property name (a.b.c() -> c) ---
  const { parseSource } = require('../lib/code-extract/parse');
  const callAst = parseSource('foo(); obj.bar(); a.b.baz(); new Thing();', '.js');
  const names = [];
  collectCallNames(callAst.program, names);
  ok('unit: collectCallNames gets identifier + member + new callees',
    names.includes('foo') && names.includes('bar') && names.includes('baz') && names.includes('Thing'));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// (2) Self-extraction: known anchor symbols in the extractor's own lib/.
// --------------------------------------------------------------------------
const LIB = path.join(__dirname, '..', 'lib');
const self = extractRepo(LIB);

const anchors = [
  { name: 'createWorktree', file: 'git.js' },
  { name: 'compileSearchContext', file: 'search/context-compiler.js' },
  { name: 'gateTask', file: 'context-gate.js' },
];
for (const a of anchors) {
  const sym = self.symbols.filter((s) => s.name === a.name).find((s) => s.file === a.file);
  ok(`self: \`${a.name}\` extracted from ${a.file}`, !!sym);
  ok(`self: \`${a.name}\` has non-empty signature`, sym && typeof sym.signature === 'string' && sym.signature.trim().length > 0);
  ok(`self: \`${a.name}\` signature names the symbol`, sym && sym.signature.includes(a.name));
}
ok('self: extracted a substantial symbol count (>200)', self.stats.symbols > 200);
ok('self: zero parse failures on own lib/', self.stats.parse_failed === 0);
ok('self: produced both import and call edges',
  self.edges.some((e) => e.kind === 'imports') && self.edges.some((e) => e.kind === 'calls'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
