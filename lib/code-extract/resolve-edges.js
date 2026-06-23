'use strict';
// code-extract/resolve-edges.js — Phase 2 (edge persistence): turn the PURE extractor's RAW edge list
// into resolved code_node ↔ code_node graph edges. This is the deterministic, NO-LLM structural wiring
// half of the code-index layer (code↔code edges are ground truth — they are derived from the AST, not
// judged). It consumes an extractRepo()/extractFile() result ({ symbols, edges }) and emits edges whose
// endpoints are code_node KEYS (code:<file>#<name>) wherever a definition exists in the repo.
//
// ── EDGE MODEL (documented; deterministic) ─────────────────────────────────────────────────────────
// The extractor reports raw edges file-granularly:
//   calls   — { from:<file>, to:<callee NAME>, kind:'calls' }            (callee name is unresolved)
//   imports — { from:<file>, to:<resolved repo file | raw spec>, kind:'imports', external? }
// A code_node is keyed PER-SYMBOL (code:<file>#<name>), never per-file, so resolution maps each raw
// edge onto symbol nodes:
//
//   CALL edge  →  one resolved edge per code_node DEFINING the callee name, anywhere in the repo:
//                 { from_file:<callsite file>, to:'code:<deffile>#<callee>', kind:'calls', name:<callee>,
//                   ambiguous:<true if >1 def of that name> }
//                 • `from` stays the FILE (call sites are only file-granular at the extractor layer —
//                   we never fabricate a specific caller symbol the AST walk didn't attribute). The
//                   call edge therefore answers "which symbols can this FILE reach by name".
//                 • MULTIPLE same-name defs → link to ALL of them (ambiguous:true), so retrieval can
//                   surface every candidate; a later phase may narrow by scope/imports.
//                 • NO local def (callee is a builtin / import / method on a value) → DROPPED, counted
//                   in stats.calls_external. (We deliberately do not create dangling name-only edges.)
//
//   IMPORT edge (LOCAL, to a repo file) → fan to the imported file's EXPORTED symbols:
//                 { from_file:<importer>, to:'code:<importedfile>#<exportname>', kind:'imports' } for
//                 each exported symbol of the imported file. This models "importer depends on importee's
//                 public surface". If the imported file has NO exported symbol (e.g. side-effect import,
//                 or a file we extracted no exports from), fall back to a single FILE-LEVEL edge
//                 { from_file, to_file:<importedfile>, kind:'imports' } so the dependency is not lost.
//   IMPORT edge (EXTERNAL, external:true) → DROPPED (package/builtin — no code_node to point at),
//                 counted in stats.imports_external.
//
// All endpoints that resolve to a symbol use the code_node key code:<file>#<name>, IDENTICAL to the key
// upsertCodeNode mints, so a code edge's endpoints line up with real code_nodes in the overlay.
//
// DETERMINISTIC: symbols/edges arrive in stable source order; we preserve it and de-dup by signature,
// then sort the final list by (from_file, kind, to) so the same repo always yields byte-identical edges.

// Mint the canonical code_node key for a (file, name) pair — must match overlay.codeNodeKey exactly.
function codeNodeKey(file, name) {
  return `code:${String(file || '').trim()}#${String(name || '').trim()}`;
}

// Build lookup indexes from the symbol list:
//   byName:        callee NAME            -> [ {file, name} ... ]   (every def of that name, any file)
//   exportsByFile: file                   -> [ exportname ... ]     (exported symbols of that file)
// Methods are included in byName (a `foo()` call can resolve to a class method named foo). Exported
// methods are NOT independently exported (the extractor sets method.exported=false; class export is
// separate), so exportsByFile holds only top-level exported symbols — the file's public surface.
function buildSymbolIndex(symbols) {
  const byName = new Map();
  const exportsByFile = new Map();
  for (const s of (Array.isArray(symbols) ? symbols : [])) {
    if (!s || !s.name) continue;
    const file = String(s.file || '').trim();
    const name = String(s.name).trim();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ file, name });
    if (s.exported && file) {
      if (!exportsByFile.has(file)) exportsByFile.set(file, []);
      // de-dup names within a file (e.g. overloads) while preserving first-seen order
      const arr = exportsByFile.get(file);
      if (!arr.includes(name)) arr.push(name);
    }
  }
  return { byName, exportsByFile };
}

// Resolve raw extractor edges to code_node↔code_node edges. Pure: no IO, no overlay/daemon writes.
//   input: { symbols:[...], edges:[...] }  (an extractRepo / extractFile result — only these two fields
//           are read; everything else on the result is ignored).
// Returns { codeEdges:[ {from_file, to, kind, name?, to_file?, ambiguous?} ], stats }.
//   stats: { calls_resolved, calls_external, calls_ambiguous, imports_resolved_symbol,
//            imports_resolved_file, imports_external, total } — counts for a caller/CLI to report.
function resolveCodeEdges({ symbols, edges } = {}) {
  const { byName, exportsByFile } = buildSymbolIndex(symbols);
  const out = [];
  const seen = new Set(); // signature de-dup: from_file\0to\0kind (to is the key or file-level marker)
  const stats = {
    calls_resolved: 0, calls_external: 0, calls_ambiguous: 0,
    imports_resolved_symbol: 0, imports_resolved_file: 0, imports_external: 0,
    total: 0,
  };

  const push = (edge) => {
    const to = edge.to || (edge.to_file ? `file:${edge.to_file}` : '');
    const sig = `${edge.from_file}\u0000${to}\u0000${edge.kind}`;
    if (seen.has(sig)) return false;
    seen.add(sig);
    out.push(edge);
    return true;
  };

  for (const e of (Array.isArray(edges) ? edges : [])) {
    if (!e || !e.kind) continue;
    const fromFile = String(e.from || '').trim();
    if (!fromFile) continue;

    if (e.kind === 'calls') {
      const callee = String(e.to || '').trim();
      const defs = callee ? byName.get(callee) : null;
      if (!defs || !defs.length) { stats.calls_external++; continue; }
      const ambiguous = defs.length > 1;
      for (const d of defs) {
        // A self-edge (file calls a symbol it defines, e.g. recursion or sibling top-level call) is
        // still a real code→code relation; keep it (callsite file may equal def file).
        if (push({ from_file: fromFile, to: codeNodeKey(d.file, d.name), kind: 'calls', name: callee, ambiguous })) {
          stats.calls_resolved++;
          if (ambiguous) stats.calls_ambiguous++;
        }
      }
    } else if (e.kind === 'imports') {
      if (e.external) { stats.imports_external++; continue; }
      const toFile = String(e.to || '').trim();
      if (!toFile) { stats.imports_external++; continue; }
      const exps = exportsByFile.get(toFile);
      if (exps && exps.length) {
        for (const name of exps) {
          if (push({ from_file: fromFile, to: codeNodeKey(toFile, name), kind: 'imports', name, to_file: toFile })) {
            stats.imports_resolved_symbol++;
          }
        }
      } else {
        // No exported symbol on the imported file — keep a file-level dependency edge so the import is
        // not silently dropped (side-effect import, or a file with no extracted exports).
        if (push({ from_file: fromFile, to_file: toFile, kind: 'imports' })) {
          stats.imports_resolved_file++;
        }
      }
    }
    // any other kind is ignored (the extractor only emits 'calls' | 'imports')
  }

  // Deterministic order: (from_file, kind, to-key). Stable regardless of input edge order.
  out.sort((a, b) => {
    if (a.from_file !== b.from_file) return a.from_file < b.from_file ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    const at = a.to || `file:${a.to_file}`;
    const bt = b.to || `file:${b.to_file}`;
    if (at !== bt) return at < bt ? -1 : 1;
    return 0;
  });
  stats.total = out.length;
  return { codeEdges: out, stats };
}

module.exports = { resolveCodeEdges, buildSymbolIndex, codeNodeKey };
