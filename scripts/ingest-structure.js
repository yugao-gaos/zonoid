#!/usr/bin/env node
// ingest-structure - extract the orchestrator's STATIC module-dependency graph.
//
// Scans first-party *.js (repo root + lib/ + scripts/ + hooks/, skipping node_modules,
// worktrees/, test/, bench/), finds local `require('./...')` / `require('../...')` calls
// (regex, good enough for this CommonJS repo), and resolves each to a repo-relative module
// path. Emits bench/ingest/structure.json = { nodes:[{id, role}], edges:[{from,to,kind}] }.
//
// This is the STRUCTURAL backbone other modalities (semantic / cross-modal edges) attach to.
// It does NOT touch the orchestrator graph and does NOT commit.
'use strict';
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const SCAN_DIRS = ['', 'lib', 'scripts', 'hooks']; // '' = repo root (non-recursive each)
const SKIP_DIRS = new Set(['node_modules', 'worktrees', 'test', 'bench']);
const OUT = path.join(REPO, 'bench', 'ingest', 'structure.json');

// All local require specifiers in a source string: require('./x'), require("../y/z").
const REQUIRE_RE = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

// List *.js directly inside a repo-relative dir (non-recursive), honoring SKIP_DIRS.
function listJs(relDir) {
  const abs = path.join(REPO, relDir);
  let entries;
  try { entries = fs.readdirSync(abs, { withFileTypes: true }); }
  catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith('.js')) {
      out.push(path.posix.join(relDir, e.name).replace(/^\//, ''));
    }
  }
  return out;
}

// Resolve a require specifier (relative to the requiring file's dir) to a repo-relative
// module path that exists on disk. Tries `x`, `x.js`, `x/index.js`. Returns null if unresolved.
function resolveModule(fromRel, spec) {
  const fromDir = path.dirname(path.join(REPO, fromRel));
  const base = path.resolve(fromDir, spec);
  const candidates = [base, base + '.js', path.join(base, 'index.js')];
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) {
        return path.relative(REPO, c).split(path.sep).join('/');
      }
    } catch { /* keep trying */ }
  }
  return null;
}

// Infer a 1-line role from a module's top block comment, else its module.exports shape.
function inferRole(rel) {
  const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const lines = src.split('\n');
  // Collect the leading `//` comment block (skip a shebang and 'use strict').
  const comment = [];
  for (let line of lines) {
    const t = line.trim();
    if (t.startsWith('#!')) continue;
    if (t === "'use strict';" || t === '"use strict";') continue;
    if (t.startsWith('//')) { comment.push(t.replace(/^\/\/\s?/, '').trim()); continue; }
    if (t === '') { if (comment.length) break; else continue; }
    break; // first non-comment, non-blank code line ends the header
  }
  if (comment.length) {
    // First sentence of the header comment, trimmed to a single line.
    const joined = comment.join(' ').replace(/\s+/g, ' ').trim();
    const sentence = joined.split(/(?<=\.)\s/)[0];
    return sentence.length > 160 ? sentence.slice(0, 157) + '...' : sentence;
  }
  const exp = src.match(/module\.exports\s*=\s*\{([^}]*)\}/);
  if (exp) {
    const names = exp[1].split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
    return 'Exports: ' + names.join(', ');
  }
  return '(no description)';
}

function main() {
  const files = [];
  for (const d of SCAN_DIRS) {
    if (SKIP_DIRS.has(d)) continue;
    for (const f of listJs(d)) files.push(f);
  }
  files.sort();
  const fileSet = new Set(files);

  const nodes = files.map(id => ({ id, role: inferRole(id) }));

  const edges = [];
  const seen = new Set();
  for (const from of files) {
    const src = fs.readFileSync(path.join(REPO, from), 'utf8');
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(src)) !== null) {
      const to = resolveModule(from, m[1]);
      if (!to) continue;            // unresolved (e.g. points outside scan set or missing file)
      if (!fileSet.has(to)) continue; // only edges between scanned first-party modules
      const key = from + '->' + to;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, kind: 'depends-on' });
    }
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ nodes, edges }, null, 2) + '\n');
  console.log(`wrote ${OUT}`);
  console.log(`nodes=${nodes.length} edges=${edges.length}`);
  for (const e of edges.slice(0, 8)) console.log(`  ${e.from} -> ${e.to}`);
}

main();
