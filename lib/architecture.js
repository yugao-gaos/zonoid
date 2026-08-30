'use strict';

const VERSION = 1;
const DEFAULT_MAX_FILES = 120;
const DEFAULT_MAX_RELATIONS = 240;
const DEFAULT_MAX_SYMBOLS_PER_FILE = 12;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function cleanFile(value) {
  return String(value || '').trim().replace(/^\.\//, '');
}

function boundedText(value, max) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function moduleName(file) {
  const parts = cleanFile(file).split('/').filter(Boolean);
  return parts.length > 1 ? parts[0] : '(root)';
}

function fileFromCodeKey(key) {
  const match = /^code:(.+)#([^#]+)$/.exec(String(key || ''));
  return match ? cleanFile(match[1]) : '';
}

function buildArchitectureProjection(input = {}, opts = {}) {
  const codeNodes = input.codeNodes || input.code_nodes || {};
  const codeEdges = Array.isArray(input.codeEdges || input.code_edges)
    ? (input.codeEdges || input.code_edges)
    : [];
  const limits = {
    files: positiveInt(opts.maxFiles, DEFAULT_MAX_FILES),
    relations: positiveInt(opts.maxRelations, DEFAULT_MAX_RELATIONS),
    symbols_per_file: positiveInt(opts.maxSymbolsPerFile, DEFAULT_MAX_SYMBOLS_PER_FILE),
  };
  const files = new Map();
  const ensureFile = (raw) => {
    const path = cleanFile(raw);
    if (!path) return null;
    if (!files.has(path)) files.set(path, {
      id: `file:${path}`,
      path,
      name: path.split('/').pop(),
      module: moduleName(path),
      symbols: [],
      exported_count: 0,
      incoming_count: 0,
      outgoing_count: 0,
      internal_count: 0,
    });
    return files.get(path);
  };

  for (const [key, raw] of Object.entries(codeNodes)) {
    if (!raw) continue;
    const file = ensureFile(raw.file || fileFromCodeKey(raw.key || raw.id || key));
    if (!file) continue;
    file.symbols.push({
      id: String(raw.key || raw.id || key),
      name: boundedText(raw.name || raw.signature || key, 240),
      kind: String(raw.kind || raw.symbol_kind || 'symbol'),
      start_line: raw.start_line != null && Number.isFinite(Number(raw.start_line)) ? Number(raw.start_line) : null,
      end_line: raw.end_line != null && Number.isFinite(Number(raw.end_line)) ? Number(raw.end_line) : null,
      signature: raw.signature ? boundedText(raw.signature, 320) : null,
      summary: raw.summary ? boundedText(raw.summary, 480) : null,
      exported: !!raw.exported,
    });
    if (raw.exported) file.exported_count++;
  }

  const relations = new Map();
  let indexedRelations = 0;
  for (const raw of codeEdges) {
    if (!raw) continue;
    const fromPath = cleanFile(raw.from_file);
    const toPath = cleanFile(raw.to_file || (raw.to && codeNodes[raw.to] && codeNodes[raw.to].file) || fileFromCodeKey(raw.to));
    const kind = raw.kind === 'calls' ? 'calls' : raw.kind === 'imports' ? 'imports' : '';
    if (!fromPath || !toPath || !kind) continue;
    const from = ensureFile(fromPath);
    const to = ensureFile(toPath);
    if (!from || !to) continue;
    indexedRelations++;
    if (fromPath === toPath) {
      from.internal_count++;
      continue;
    }
    from.outgoing_count++;
    to.incoming_count++;
    const key = `${fromPath}\u0000${toPath}\u0000${kind}`;
    const relation = relations.get(key) || {
      id: `relation:${fromPath}:${kind}:${toPath}`,
      from: from.id,
      to: to.id,
      kind,
      count: 0,
      ambiguous_count: 0,
    };
    relation.count++;
    if (raw.ambiguous) relation.ambiguous_count++;
    relations.set(key, relation);
  }

  for (const file of files.values()) {
    file.symbols.sort((a, b) => (a.start_line == null) - (b.start_line == null)
      || (a.start_line || 0) - (b.start_line || 0)
      || a.name.localeCompare(b.name));
    file.symbol_count = file.symbols.length;
  }

  const rankedFiles = [...files.values()].sort((a, b) =>
    (b.incoming_count + b.outgoing_count) - (a.incoming_count + a.outgoing_count)
    || b.symbol_count - a.symbol_count
    || a.path.localeCompare(b.path));
  const visibleFiles = rankedFiles.slice(0, limits.files);
  const visibleIds = new Set(visibleFiles.map((file) => file.id));
  let visibleSymbols = 0;
  for (const file of visibleFiles) {
    const allSymbols = file.symbols;
    file.symbols = allSymbols.slice(0, limits.symbols_per_file);
    file.omitted_symbols = Math.max(0, allSymbols.length - file.symbols.length);
    visibleSymbols += file.symbols.length;
  }
  visibleFiles.sort((a, b) => a.module.localeCompare(b.module) || a.path.localeCompare(b.path));

  const visibleRelations = [...relations.values()]
    .filter((relation) => visibleIds.has(relation.from) && visibleIds.has(relation.to))
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)
      || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind))
    .slice(0, limits.relations)
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
      || a.kind.localeCompare(b.kind));

  const modules = new Map();
  for (const file of visibleFiles) {
    const module = modules.get(file.module) || {
      id: `module:${file.module}`,
      name: file.module,
      file_ids: [],
      symbol_count: 0,
    };
    module.file_ids.push(file.id);
    module.symbol_count += file.symbol_count;
    modules.set(file.module, module);
  }

  const allSymbolCount = [...files.values()].reduce((sum, file) => sum + file.symbol_count, 0);
  const projection = {
    version: VERSION,
    status: files.size ? 'ready' : 'empty',
    limits,
    summary: {
      indexed_files: files.size,
      visible_files: visibleFiles.length,
      indexed_symbols: allSymbolCount,
      visible_symbols: visibleSymbols,
      indexed_relations: indexedRelations,
      indexed_relation_groups: relations.size,
      visible_relations: visibleRelations.length,
      visible_modules: modules.size,
    },
    omitted: {
      files: Math.max(0, files.size - visibleFiles.length),
      symbols: Math.max(0, allSymbolCount - visibleSymbols),
      relations: Math.max(0, relations.size - visibleRelations.length),
    },
    modules: [...modules.values()].sort((a, b) => a.name.localeCompare(b.name)),
    files: visibleFiles,
    relations: visibleRelations,
  };
  if (!files.size) {
    projection.message = 'Architecture data is not indexed yet. Run project onboarding to map source files and relationships.';
  }
  return projection;
}

module.exports = {
  VERSION,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_RELATIONS,
  DEFAULT_MAX_SYMBOLS_PER_FILE,
  buildArchitectureProjection,
};
