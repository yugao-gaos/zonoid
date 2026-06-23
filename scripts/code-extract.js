#!/usr/bin/env node
'use strict';
// code-extract.js — Phase 1 first-party JS/TS AST code extractor (CLI).
//
// Walks a target repo, parses every .js/.mjs/.cjs/.ts/.tsx/.jsx file via @babel/parser, and extracts
// SYMBOLS (function/class/method/arrow declarations) + EDGES (calls + imports). PURE extraction: it
// does NOT touch the orchestrator graph / overlay / KB and does NOT commit — it only emits a
// structured JSON map to an out dir, mirroring scripts/onboard-mine-structure.js's structure.json
// convention (here the file is code-structure.json).
//
//   node scripts/code-extract.js --repo <abs> [--out <dir>]
//
// Emits <out>/code-structure.json = { repo, files, symbols, edges, stats }.
// --out defaults to <repo>/.zonoid/onboard/<basename(repo)>/ (same dir family as the structure miner).

const fs = require('fs');
const path = require('path');
const { extractRepo } = require('../lib/code-extract');
const { defaultOnboardOutDir } = require('../lib/onboard-paths');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function main() {
  const repo = arg('repo');
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: code-extract.js --repo <abs path to target repo> [--out <dir>]');
    process.exit(2);
  }
  const repoAbs = path.resolve(repo);
  const outDir = path.resolve(arg('out', defaultOnboardOutDir(repoAbs)));
  const OUT = path.join(outDir, 'code-structure.json');

  const result = extractRepo(repoAbs);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n');

  console.log(`wrote ${OUT}`);
  console.log(`repo=${repoAbs} files=${result.stats.files} parsed=${result.stats.parsed} ` +
    `parse_failed=${result.stats.parse_failed} symbols=${result.stats.symbols} edges=${result.stats.edges}`);
  for (const s of result.symbols.slice(0, 8)) {
    console.log(`  ${s.kind.padEnd(8)} ${s.file}:${s.start_line}  ${s.signature}`);
  }
}

main();
