'use strict';
// code-extract/index.js — extractRepo(repoPath, opts): pure JS/TS AST extraction.
//
// Ties walk + parse + symbols into the Phase-1 deliverable. PURE extraction: no daemon/overlay/KB
// writes, no graph mutation — it only reads files and returns a structured object (the CLI persists
// it to disk). Output shape:
//   {
//     repo,
//     files:   [{ path, role }],
//     symbols: [{ name, kind, file, start_line, end_line, signature, exported }],
//     edges:   [{ from, to, kind:'calls'|'imports' }],
//     stats:   { files, parsed, parse_failed, symbols, edges }
//   }
//
// edges:
//   imports — from=file, to=resolved repo-relative module (local specifiers that exist on disk) OR
//             the raw specifier (package/unresolved). `external:true` marks the non-local ones.
//   calls   — from=file, to=callee identifier name (raw; symbol-level resolution is a later phase).

const fs = require('fs');
const path = require('path');
const { walkCodeFiles, resolveModule } = require('./walk');
const { parseSource } = require('./parse');
const { extractFromAst } = require('./symbols');

// Infer a 1-line role for a file from its leading block comment, else its export shape. Lifted from
// scripts/onboard-mine-structure.js inferRole so file roles read identically across both miners.
function inferRole(src) {
  if (typeof src !== 'string') return '(unreadable)';
  const lines = src.split('\n');
  const comment = [];
  for (let line of lines) {
    const t = line.trim();
    if (t.startsWith('#!')) continue;
    if (t === "'use strict';" || t === '"use strict";') continue;
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
      const names = exp[1].split(',').map((s) => s.trim().split(':')[0].trim()).filter(Boolean).slice(0, 6);
      return 'Exports: ' + names.join(', ');
    }
    if (exp[2]) return 'Exports: ' + exp[2];
  }
  return '(no description)';
}

// Extract a whole repo. `opts.skipDirs` / `opts.exts` override the defaults (Sets). Deterministic:
// files are walked in sorted order, symbols/edges follow file+source order.
function extractRepo(repoPath, opts = {}) {
  const repoAbs = path.resolve(repoPath);
  if (!fs.existsSync(repoAbs)) throw new Error(`repo not found: ${repoAbs}`);

  const relFiles = walkCodeFiles(repoAbs, opts);
  const fileSet = new Set(relFiles);

  const files = [];
  const symbols = [];
  const edges = [];
  let parsed = 0;
  let parseFailed = 0;

  for (const rel of relFiles) {
    let src;
    try { src = fs.readFileSync(path.join(repoAbs, rel), 'utf8'); }
    catch { files.push({ path: rel, role: '(unreadable)' }); continue; }

    files.push({ path: rel, role: inferRole(src) });

    const ast = parseSource(src, path.extname(rel));
    if (!ast) { parseFailed++; continue; }
    parsed++;

    let extracted;
    try { extracted = extractFromAst(ast, src); }
    catch { parseFailed++; continue; }

    for (const s of extracted.symbols) {
      symbols.push({
        name: s.name,
        kind: s.kind,
        file: rel,
        start_line: s.start_line,
        end_line: s.end_line,
        signature: s.signature,
        exported: !!s.exported,
        ...(s.class ? { class: s.class } : {}),
      });
    }

    // import edges
    for (const spec of extracted.imports) {
      const resolved = resolveModule(repoAbs, rel, spec, opts);
      if (resolved && fileSet.has(resolved)) {
        edges.push({ from: rel, to: resolved, kind: 'imports' });
      } else {
        edges.push({ from: rel, to: spec, kind: 'imports', external: true });
      }
    }

    // call edges (file -> callee name)
    for (const callee of extracted.calls) {
      edges.push({ from: rel, to: callee, kind: 'calls' });
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
    },
  };
}

module.exports = { extractRepo, inferRole };
