#!/usr/bin/env node
// Plain Node test for the MULTI-LANGUAGE tree-sitter backend of the code extractor (no framework;
// matches code-extract.test.js style). Run: node test/code-extract-multilang.test.js — exits non-zero
// on any failed assertion.
//
// Strategy: write one tiny inline fixture PER language to a temp repo (a function, a class/struct, an
// import, and a call), run the async multi-language extractor (extractRepoAsync — boots the WASM
// grammars first), and assert each language extracts the expected symbols (with kind) + a call edge +
// an import edge. The babel (JS/TS) path is covered by code-extract.test.js; here we additionally
// assert that JS and a tree-sitter language coexist in ONE extractRepo pass (the registry dispatches
// per file).
//
// Per-language kind mapping under test (documented in backends/treesitter.js):
//   Python def->function, class->class, method->method
//   Go     func->function, method->method, struct->struct, interface->interface
//   Rust   fn->function, struct->struct, enum->enum, trait->interface
//   Java   method->method, class->class, interface->interface, enum->enum
//   C      function->function, struct->struct, enum->enum
//   C++    free fn->function, member fn->method, class->class, struct->struct, enum->enum
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { extractRepoAsync, initTreeSitter } = require('../lib/code-extract');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Each fixture: filename + source + the assertions to run against that file's extracted symbols/edges.
const FIXTURES = {
  'sample.py': [
    'import os',
    'from collections import OrderedDict',
    '',
    'def greet(name):',
    '    return "hi " + helper(name)',
    '',
    'class Animal(Base):',
    '    def speak(self):',
    '        return noise()',
    '',
  ].join('\n'),

  'sample.go': [
    'package main',
    '',
    'import "fmt"',
    '',
    'type Point struct {',
    '\tX int',
    '}',
    '',
    'type Greeter interface {',
    '\tHi() string',
    '}',
    '',
    'func Add(a int, b int) int {',
    '\treturn helper(a) + b',
    '}',
    '',
    'func (p Point) Move() {',
    '\tfmt.Println(noise())',
    '}',
    '',
  ].join('\n'),

  'sample.rs': [
    'use std::collections::HashMap;',
    '',
    'pub struct Point {',
    '    x: i32,',
    '}',
    '',
    'enum Color {',
    '    Red,',
    '    Green,',
    '}',
    '',
    'trait Shape {',
    '    fn area(&self) -> f64;',
    '}',
    '',
    'pub fn add(a: i32, b: i32) -> i32 {',
    '    helper(a) + b',
    '}',
    '',
  ].join('\n'),

  'Sample.java': [
    'package com.example;',
    '',
    'import java.util.List;',
    '',
    'public class Animal extends Base {',
    '    public void speak() {',
    '        noise();',
    '    }',
    '    static int add(int a) {',
    '        return helper(a);',
    '    }',
    '}',
    '',
    'interface Runner {',
    '    void run();',
    '}',
    '',
    'enum Day { MON, TUE }',
    '',
  ].join('\n'),

  'sample.c': [
    '#include <stdio.h>',
    '',
    'struct Point {',
    '    int x;',
    '};',
    '',
    'enum Color { RED, GREEN };',
    '',
    'int add(int a, int b) {',
    '    return helper(a) + b;',
    '}',
    '',
  ].join('\n'),

  'sample.cpp': [
    '#include <vector>',
    '',
    'class Animal {',
    'public:',
    '    void speak() { noise(); }',
    '};',
    '',
    'struct Point { int x; };',
    '',
    'int add(int a, int b) {',
    '    return helper(a) + b;',
    '}',
    '',
  ].join('\n'),

  // A JS file in the SAME repo, to prove the registry dispatches babel + tree-sitter in one pass.
  'sample.js': [
    "import { thing } from './other.js';",
    'export function jsAdd(a, b) { return helper(a) + b; }',
    '',
  ].join('\n'),
};

(async () => {
  const report = await initTreeSitter();
  ok('init: tree-sitter booted', report && report.ready === true);
  ok('init: all 6 grammars loaded (python,go,rust,java,c,cpp)',
    ['python', 'go', 'rust', 'java', 'c', 'cpp'].every((l) => report.languages.includes(l)));
  if (report.skipped && report.skipped.length) {
    console.log('  (skipped grammars: ' + JSON.stringify(report.skipped) + ')');
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'code-extract-ml-'));
  try {
    for (const [name, src] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(tmp, name), src);

    const res = await extractRepoAsync(tmp);

    // helpers scoped to a file
    const symsOf = (file) => res.symbols.filter((s) => s.file === file);
    const sym = (file, name) => symsOf(file).find((s) => s.name === name);
    const callTos = (file) => new Set(res.edges.filter((e) => e.from === file && e.kind === 'calls').map((e) => e.to));
    const importTos = (file) => new Set(res.edges.filter((e) => e.from === file && e.kind === 'imports').map((e) => e.to));

    // ---- PYTHON ----
    {
      const f = 'sample.py';
      const greet = sym(f, 'greet');
      ok('py: function `greet` (kind=function)', greet && greet.kind === 'function');
      ok('py: `greet` has line range', greet && greet.start_line >= 1 && greet.end_line >= greet.start_line);
      ok('py: class `Animal` (kind=class)', (sym(f, 'Animal') || {}).kind === 'class');
      const speak = symsOf(f).find((s) => s.kind === 'method' && s.name === 'speak');
      ok('py: method `speak` (kind=method, class=Animal)', speak && speak.class === 'Animal');
      ok('py: call edge -> helper', callTos(f).has('helper'));
      ok('py: call edge -> noise', callTos(f).has('noise'));
      ok('py: import edge -> os', importTos(f).has('os'));
      ok('py: import edge -> collections', importTos(f).has('collections'));
    }

    // ---- GO ----
    {
      const f = 'sample.go';
      ok('go: function `Add` (kind=function)', (sym(f, 'Add') || {}).kind === 'function');
      const move = sym(f, 'Move');
      ok('go: method `Move` (kind=method)', move && move.kind === 'method');
      ok('go: struct `Point` (kind=struct)', (sym(f, 'Point') || {}).kind === 'struct');
      ok('go: interface `Greeter` (kind=interface)', (sym(f, 'Greeter') || {}).kind === 'interface');
      ok('go: `Add` exported (Capitalized)', (sym(f, 'Add') || {}).exported === true);
      ok('go: call edge -> helper', callTos(f).has('helper'));
      ok('go: call edge -> Println (member call)', callTos(f).has('Println'));
      ok('go: import edge -> fmt', importTos(f).has('fmt'));
    }

    // ---- RUST ----
    {
      const f = 'sample.rs';
      ok('rust: function `add` (kind=function)', (sym(f, 'add') || {}).kind === 'function');
      ok('rust: struct `Point` (kind=struct)', (sym(f, 'Point') || {}).kind === 'struct');
      ok('rust: enum `Color` (kind=enum)', (sym(f, 'Color') || {}).kind === 'enum');
      ok('rust: trait `Shape` (kind=interface)', (sym(f, 'Shape') || {}).kind === 'interface');
      ok('rust: `add` exported (pub)', (sym(f, 'add') || {}).exported === true);
      ok('rust: call edge -> helper', callTos(f).has('helper'));
      ok('rust: import edge -> std::collections::HashMap', importTos(f).has('std::collections::HashMap'));
    }

    // ---- JAVA ----
    {
      const f = 'Sample.java';
      ok('java: class `Animal` (kind=class)', (sym(f, 'Animal') || {}).kind === 'class');
      ok('java: interface `Runner` (kind=interface)', (sym(f, 'Runner') || {}).kind === 'interface');
      ok('java: enum `Day` (kind=enum)', (sym(f, 'Day') || {}).kind === 'enum');
      const speak = symsOf(f).find((s) => s.kind === 'method' && s.name === 'speak');
      ok('java: method `speak` (kind=method, class=Animal)', speak && speak.class === 'Animal');
      ok('java: `Animal` exported (public)', (sym(f, 'Animal') || {}).exported === true);
      ok('java: call edge -> helper', callTos(f).has('helper'));
      ok('java: call edge -> noise', callTos(f).has('noise'));
      ok('java: import edge -> java.util.List', importTos(f).has('java.util.List'));
    }

    // ---- C ----
    {
      const f = 'sample.c';
      ok('c: function `add` (kind=function)', (sym(f, 'add') || {}).kind === 'function');
      ok('c: struct `Point` (kind=struct)', (sym(f, 'Point') || {}).kind === 'struct');
      ok('c: enum `Color` (kind=enum)', (sym(f, 'Color') || {}).kind === 'enum');
      ok('c: call edge -> helper', callTos(f).has('helper'));
      ok('c: import edge -> stdio.h', importTos(f).has('stdio.h'));
    }

    // ---- C++ ----
    {
      const f = 'sample.cpp';
      ok('cpp: free function `add` (kind=function)', (sym(f, 'add') || {}).kind === 'function');
      ok('cpp: class `Animal` (kind=class)', (sym(f, 'Animal') || {}).kind === 'class');
      ok('cpp: struct `Point` (kind=struct)', (sym(f, 'Point') || {}).kind === 'struct');
      const speak = symsOf(f).find((s) => s.kind === 'method' && s.name === 'speak');
      ok('cpp: member function `speak` (kind=method, class=Animal)', speak && speak.class === 'Animal');
      ok('cpp: call edge -> helper', callTos(f).has('helper'));
      ok('cpp: call edge -> noise', callTos(f).has('noise'));
      ok('cpp: import edge -> vector', importTos(f).has('vector'));
    }

    // ---- MIXED-REPO DISPATCH: JS coexists with tree-sitter langs in one pass ----
    {
      const f = 'sample.js';
      ok('mixed: JS `jsAdd` extracted via babel in same repo', (sym(f, 'jsAdd') || {}).kind === 'function');
      ok('mixed: JS call edge -> helper', callTos(f).has('helper'));
      ok('mixed: stats.by_language covers .py/.go/.rs/.java/.c/.cpp/.js',
        ['.py', '.go', '.rs', '.java', '.c', '.cpp', '.js'].every((e) => res.stats.by_language[e]));
      ok('mixed: zero parse failures across all fixtures', res.stats.parse_failed === 0);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  // Set exitCode rather than calling process.exit(): the emscripten WASM runtime keeps async handles
  // open briefly, and an abrupt process.exit() while they close trips a libuv assertion on Windows.
  // Letting the event loop drain naturally exits with this code cleanly.
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exitCode = 1; });
