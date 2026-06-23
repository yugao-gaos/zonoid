'use strict';
// code-extract/index.js — extractRepo(repoPath, opts): pure, pluggable, multi-language AST extraction.
//
// extractRepo walks a repo and routes EACH file through the backend registry (backends/registry.js)
// by extension: JS/TS/JSX -> @babel/parser backend; Python/Go/Rust/Java/C/C++ -> web-tree-sitter
// (WASM) backend. Every backend returns the SAME language-agnostic shape, so the output below is
// uniform regardless of source language and the Phase-2 code_node layer consumes any backend's output
// without special-casing. PURE extraction: no daemon/overlay/KB writes, no graph mutation — it only
// reads files and returns a structured object (the CLI persists it). Output shape:
//   {
//     repo,
//     files:   [{ path, role }],
//     symbols: [{ name, kind, file, start_line, end_line, signature, exported, class? }],
//     edges:   [{ from, to, kind:'calls'|'imports', external? }],
//     stats:   { files, parsed, parse_failed, symbols, edges, by_language }
//   }
//   kind: function | class | method | arrow (JS/TS) + struct | interface | enum (tree-sitter langs).
//
// edges:
//   imports — from=file, to=resolved repo-relative module (LOCAL JS/TS specifiers that exist on disk)
//             OR the raw specifier (package/unresolved/tree-sitter langs). `external:true` marks the
//             non-local ones.
//   calls   — from=file, to=callee identifier name (raw; symbol-level resolution is a later phase).
//
// ── SYNC vs ASYNC ────────────────────────────────────────────────────────────────────────────────
// extractRepo is synchronous and works out-of-the-box for JS/TS (babel needs no async init). The
// tree-sitter backend must boot its WASM runtime first (async). So:
//   • For JS/TS-only repos: call extractRepo(repo) directly (unchanged Phase-1 behavior).
//   • For multi-language repos: `await extractRepoAsync(repo)` (it runs initTreeSitter() then
//     extractRepo), OR call `await initTreeSitter()` yourself once and then extractRepo synchronously.
// If a tree-sitter file is reached before init, that file is counted as parse_failed (never silently
// dropped as if it had no symbols) and noted in stats.by_language.

const fs = require('fs');
const path = require('path');
const { walkCodeFiles, resolveModule } = require('./walk');
const registry = require('./backends/registry');
const { initTreeSitter } = require('./backends/treesitter');

// Infer a 1-line role for a file from its leading block comment, else its export shape. Lifted from
// scripts/onboard-mine-structure.js inferRole so file roles read identically across both miners.
// Handles both `//`/`/* */` (C-family) and `#` (Python/shell) leading comments.
function inferRole(src) {
  if (typeof src !== 'string') return '(unreadable)';
  const lines = src.split('\n');
  const comment = [];
  for (let line of lines) {
    const t = line.trim();
    if (t.startsWith('#!')) continue;
    if (t === "'use strict';" || t === '"use strict";') continue;
    if (t.startsWith('//')) { comment.push(t.replace(/^\/\/\s?/, '').trim()); continue; }
    if (t.startsWith('#')) { comment.push(t.replace(/^#+\s?/, '').trim()); continue; }
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
      const names = exp[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean).slice(0, 6);
      return 'Exports: ' + names.join(', ');
    }
    if (exp[2]) return 'Exports: ' + exp[2];
  }
  return '(no description)';
}

// The default extension set is now the UNION of every backend's extensions (JS/TS + tree-sitter
// languages), so the walker actually visits .py/.go/.rs/.java/.c/.h/.cpp/... A caller can still
// override via opts.exts to restrict the languages walked.
const DEFAULT_EXTS = new Set(registry.allExtensions());

// Extract a whole repo. `opts.skipDirs` / `opts.exts` override the defaults (Sets). Deterministic:
// files are walked in sorted order, symbols/edges follow file+source order. Synchronous — for
// tree-sitter languages, await initTreeSitter() (or use extractRepoAsync) first.
function extractRepo(repoPath, opts = {}) {
  const repoAbs = path.resolve(repoPath);
  if (!fs.existsSync(repoAbs)) throw new Error(`repo not found: ${repoAbs}`);

  const exts = opts.exts instanceof Set ? opts.exts : DEFAULT_EXTS;
  const relFiles = walkCodeFiles(repoAbs, { ...opts, exts });
  const fileSet = new Set(relFiles);

  const files = [];
  const symbols = [];
  const edges = [];
  let parsed = 0;
  let parseFailed = 0;
  const byLanguage = {}; // ext -> { files, parsed, parse_failed, symbols }

  const bump = (ext, field, n = 1) => {
    const k = ext || '(none)';
    (byLanguage[k] || (byLanguage[k] = { files: 0, parsed: 0, parse_failed: 0, symbols: 0 }))[field] += n;
  };

  for (const rel of relFiles) {
    const ext = path.extname(rel).toLowerCase();
    bump(ext, 'files');

    let src;
    try { src = fs.readFileSync(path.join(repoAbs, rel), 'utf8'); }
    catch { files.push({ path: rel, role: '(unreadable)' }); continue; }

    files.push({ path: rel, role: inferRole(src) });

    const backend = registry.backendForExt(ext);
    if (!backend) { parseFailed++; bump(ext, 'parse_failed'); continue; }

    let result;
    try {
      result = backend.extractFile(rel, src, ext);
    } catch {
      // e.g. tree-sitter backend reached before initTreeSitter() — count as a parse failure, do NOT
      // pretend the file was empty.
      result = null;
    }
    if (!result) { parseFailed++; bump(ext, 'parse_failed'); continue; }
    parsed++; bump(ext, 'parsed');

    for (const s of result.symbols) {
      symbols.push(s);
      bump(ext, 'symbols');
    }

    // Backends emit edges with a raw `to`. Import edges flagged { resolve:true } (JS/TS) get their
    // local specifiers rewritten to repo-relative module paths here, where the repo file set lives;
    // everything else (already-external imports, calls) passes through unchanged.
    for (const e of result.edges) {
      if (e.kind === 'imports' && e.resolve) {
        const resolved = resolveModule(repoAbs, rel, e.to, { ...opts, exts });
        if (resolved && fileSet.has(resolved)) {
          edges.push({ from: e.from, to: resolved, kind: 'imports' });
        } else {
          edges.push({ from: e.from, to: e.to, kind: 'imports', external: true });
        }
      } else {
        const { resolve, ...clean } = e; // drop the internal `resolve` flag if present
        edges.push(clean);
      }
    }
  }

  return {
    repo: repoAbs,
    files,
    symbols,
    edges,
    stats: {
      files: files.length,
      parsed,
      parse_failed: parseFailed,
      symbols: symbols.length,
      edges: edges.length,
      by_language: byLanguage,
    },
  };
}

// Async convenience: boot the tree-sitter WASM backend, then extract. Use this for repos that may
// contain non-JS/TS code. Returns { ...extractRepo result, treesitter: <init report> }.
async function extractRepoAsync(repoPath, opts = {}) {
  const init = await initTreeSitter();
  const out = extractRepo(repoPath, opts);
  out.stats.treesitter = init;
  return out;
}

module.exports = { extractRepo, extractRepoAsync, initTreeSitter, inferRole };
