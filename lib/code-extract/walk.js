'use strict';
// code-extract/walk.js — file discovery + relative-module resolution for the code extractor.
//
// Mirrors scripts/onboard-mine-structure.js's scaffolding (SKIP_DIRS, CODE_EXT, recursive walk,
// resolveModule) so the AST extractor walks repos the same way the structure miner does. Kept as a
// separate module so both the structure miner and the symbol extractor can share one definition of
// "what counts as a code file" and "how a local specifier resolves to a repo-relative path".

const fs = require('fs');
const path = require('path');

// Same noise dirs the structure miner skips. node_modules/.git/.graph/worktrees/dist are the
// load-bearing ones for this workspace (the handoff calls those out explicitly).
const SKIP_DIRS = new Set([
  'node_modules', 'worktrees', '.git', '.graph', 'dist', 'build', 'coverage',
  'vendor', '.next', 'out', 'tmp', '__pycache__',
]);

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);

// Recursively list code files under the repo, repo-relative (forward-slash), skipping SKIP_DIRS and
// dotfiles/dotdirs (except .claude-plugin, matching the structure miner). Deterministic: sorted.
function walkCodeFiles(repoAbs, opts = {}) {
  const skip = opts.skipDirs instanceof Set ? opts.skipDirs : SKIP_DIRS;
  const exts = opts.exts instanceof Set ? opts.exts : CODE_EXT;
  const out = [];
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.claude-plugin') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(full);
      } else if (e.isFile() && exts.has(path.extname(e.name))) {
        out.push(path.relative(repoAbs, full).split(path.sep).join('/'));
      }
    }
  })(repoAbs);
  return out.sort();
}

// Resolve a local specifier ('./x', '../y/z') from `fromRel` to a repo-relative module path that
// exists on disk. Tries the bare path, then each code extension, then index.<ext>. Returns null for
// bare/package specifiers (no leading dot) or unresolvable paths — same contract as the miner.
function resolveModule(repoAbs, fromRel, spec, opts = {}) {
  if (typeof spec !== 'string' || !spec.startsWith('.')) return null;
  const exts = opts.exts instanceof Set ? opts.exts : CODE_EXT;
  const fromDir = path.dirname(path.join(repoAbs, fromRel));
  const base = path.resolve(fromDir, spec);
  const cands = [base];
  for (const ext of exts) cands.push(base + ext);
  for (const ext of exts) cands.push(path.join(base, 'index' + ext));
  for (const c of cands) {
    try { if (fs.statSync(c).isFile()) return path.relative(repoAbs, c).split(path.sep).join('/'); }
    catch { /* keep trying */ }
  }
  return null;
}

module.exports = { SKIP_DIRS, CODE_EXT, walkCodeFiles, resolveModule };
