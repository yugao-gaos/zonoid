#!/usr/bin/env node
'use strict';
// onboard-mine-structure.js — generalized static module-dependency miner for ANY repo.
//
// Generalizes scripts/ingest-structure.js (which hardcoded this orchestrator via
// path.resolve(__dirname,'..') and a fixed SCAN_DIRS list). Here the target repo and
// output dir are arguments; scan dirs are DISCOVERED (recursively walk, skipping the
// usual noise dirs) so it works on an arbitrary CommonJS/ESM JS/TS project.
//
//   node scripts/onboard-mine-structure.js --repo <abs> [--out <abs>]
//
// Emits <out>/structure.json = { repo, nodes:[{id, role}], edges:[{from,to,kind}] }.
// Does NOT touch the orchestrator graph and does NOT commit. (--out defaults to
// <repo>/.zonoid/onboard/<basename(repo)>/.)

const fs = require('fs');
const path = require('path');
const { defaultOnboardOutDir } = require('../lib/onboard-paths');

const SKIP_DIRS = new Set([
  'node_modules', 'worktrees', '.git', 'dist', 'build', 'coverage',
  'vendor', '.next', 'out', 'tmp', '__pycache__',
]);
// Test/bench files are real modules but rarely the "backbone"; we still index them but
// they tend to be leaf nodes. We DO skip obvious fixture/sandbox trees by name below.
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

// Local require()/import specifiers: require('./x'), import ... from "../y".
const SPEC_RE = /(?:require\(\s*|from\s+|import\s*\(\s*)['"](\.\.?\/[^'"]+)['"]/g;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

// Recursively list code files under the repo, repo-relative, skipping SKIP_DIRS.
function walk(repo, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.claude-plugin') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(repo, full, out);
    } else if (e.isFile() && CODE_EXT.has(path.extname(e.name))) {
      out.push(path.relative(repo, full).split(path.sep).join('/'));
    }
  }
  return out;
}

// Resolve a relative specifier to a repo-relative module path that exists on disk.
function resolveModule(repo, fromRel, spec) {
  const fromDir = path.dirname(path.join(repo, fromRel));
  const base = path.resolve(fromDir, spec);
  const cands = [base];
  for (const ext of CODE_EXT) cands.push(base + ext);
  for (const ext of CODE_EXT) cands.push(path.join(base, 'index' + ext));
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return path.relative(repo, c).split(path.sep).join('/'); }
    catch { /* keep trying */ }
  }
  return null;
}

// Infer a 1-line role from the leading block comment, else the export shape.
function inferRole(repo, rel) {
  let src;
  try { src = fs.readFileSync(path.join(repo, rel), 'utf8'); } catch { return '(unreadable)'; }
  const lines = src.split('\n');
  const comment = [];
  for (let line of lines) {
    const t = line.trim();
    if (t.startsWith('#!')) continue;
    if (t === "'use strict';" || t === '"use strict";') continue;
    // Support both // and /* */ and JSDoc-ish * lines.
    if (t.startsWith('//')) { comment.push(t.replace(/^\/\/\s?/, '').trim()); continue; }
    if (t.startsWith('/*') || t.startsWith('*')) {
      const c = t.replace(/^\/\*+/, '').replace(/\*+\/$/, '').replace(/^\*\s?/, '').trim();
      if (c) comment.push(c);
      if (t.endsWith('*/') && comment.length) break;
      continue;
    }
    if (t === '') { if (comment.length) break; else continue; }
    break;
  }
  if (comment.length) {
    const joined = comment.join(' ').replace(/\s+/g, ' ').trim();
    const sentence = joined.split(/(?<=\.)\s/)[0];
    return sentence.length > 160 ? sentence.slice(0, 157) + '...' : sentence;
  }
  const exp = src.match(/(?:module\.exports\s*=\s*\{([^}]*)\}|export\s+(?:default|const|function|class)\s+(\w+))/);
  if (exp) {
    if (exp[1]) {
      const names = exp[1].split(',').map(s => s.trim().split(':')[0].trim()).filter(Boolean).slice(0, 6);
      return 'Exports: ' + names.join(', ');
    }
    if (exp[2]) return 'Exports: ' + exp[2];
  }
  return '(no description)';
}

function main() {
  const repo = arg('repo');
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: onboard-mine-structure.js --repo <abs path to target repo> [--out <dir>]');
    process.exit(2);
  }
  const repoAbs = path.resolve(repo);
  const outDir = path.resolve(arg('out', defaultOnboardOutDir(repoAbs)));
  const OUT = path.join(outDir, 'structure.json');

  const files = walk(repoAbs, repoAbs, []).sort();
  const fileSet = new Set(files);
  const nodes = files.map(id => ({ id, role: inferRole(repoAbs, id) }));

  const edges = [];
  const seen = new Set();
  for (const from of files) {
    let src;
    try { src = fs.readFileSync(path.join(repoAbs, from), 'utf8'); } catch { continue; }
    let m;
    SPEC_RE.lastIndex = 0;
    while ((m = SPEC_RE.exec(src)) !== null) {
      const to = resolveModule(repoAbs, from, m[1]);
      if (!to || !fileSet.has(to)) continue;
      const key = from + '->' + to;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ from, to, kind: 'depends-on' });
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ repo: repoAbs, nodes, edges }, null, 2) + '\n');
  console.log(`wrote ${OUT}`);
  console.log(`repo=${repoAbs} nodes=${nodes.length} edges=${edges.length}`);
  for (const e of edges.slice(0, 8)) console.log(`  ${e.from} -> ${e.to}`);
}

main();
