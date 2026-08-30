'use strict';

const VERSION = 1;
const DEFAULT_MAX_FILES = 120;
const DEFAULT_MAX_RELATIONS = 240;
const DEFAULT_MAX_MODULE_RELATIONS = 120;
const DEFAULT_MAX_SYMBOLS_PER_FILE = 12;

const NOISE_RULES = [
  ['worktree', /(^|\/)(?:\.?(?:git-)?worktrees?|\.codex\/worktrees?)(\/|$)/i],
  ['generated', /(^|\/)(?:node_modules|vendor|dist|build|coverage|\.next|\.cache|generated|gen|out)(\/|$)|(?:^|\/)[^/]+(?:\.generated\.|\.min\.)[^/]+$/i],
  ['archive', /(^|\/)[^/]*(?:archive|archived)[^/]*(\/|$)/i],
  ['fixture', /(^|\/)(?:__fixtures__|fixtures?|mocks?)(\/|$)/i],
  ['bench', /(^|\/)(?:bench|benches|benchmark|benchmarks)(\/|$)|(?:^|\/)[^/]+\.bench\.[^/]+$/i],
  ['test', /(^|\/)(?:__tests__|test|tests)(\/|$)|(?:^|\/)(?:test_[^/]+|[^/]+(?:\.test|\.spec|_test))\.[^/]+$/i],
];

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

function directoryGroupPaths(file) {
  const parts = cleanFile(file).split('/').filter(Boolean);
  if (parts.length < 3) return [];
  const paths = [];
  for (let end = 2; end < parts.length; end++) paths.push(parts.slice(0, end).join('/'));
  return paths;
}

function classifyFileNoise(file) {
  const path = cleanFile(file);
  for (const [category, pattern] of NOISE_RULES) {
    if (pattern.test(path)) return category;
  }
  return null;
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
  const codeIndexStatus = input.codeIndexStatus || input.code_index_status || null;
  const limits = {
    files: positiveInt(opts.maxFiles, DEFAULT_MAX_FILES),
    relations: positiveInt(opts.maxRelations, DEFAULT_MAX_RELATIONS),
    module_relations: positiveInt(opts.maxModuleRelations, DEFAULT_MAX_MODULE_RELATIONS),
    symbols_per_file: positiveInt(opts.maxSymbolsPerFile, DEFAULT_MAX_SYMBOLS_PER_FILE),
  };
  const files = new Map();
  const ensureFile = (raw) => {
    const path = cleanFile(raw);
    if (!path) return null;
    if (!files.has(path)) {
      const noise = classifyFileNoise(path);
      files.set(path, {
        id: `file:${path}`,
        path,
        name: path.split('/').pop(),
        module: moduleName(path),
        noise,
        is_noisy: noise != null,
        symbols: [],
        exported_count: 0,
        incoming_count: 0,
        outgoing_count: 0,
        internal_count: 0,
      });
    }
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
  const moduleRelations = new Map();
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

    if (!from.is_noisy && !to.is_noisy && from.module !== to.module) {
      const moduleKey = `${from.module}\u0000${to.module}\u0000${kind}`;
      const moduleRelation = moduleRelations.get(moduleKey) || {
        id: `module-relation:${from.module}:${kind}:${to.module}`,
        from: `module:${from.module}`,
        to: `module:${to.module}`,
        kind,
        count: 0,
        ambiguous_count: 0,
      };
      moduleRelation.count++;
      if (raw.ambiguous) moduleRelation.ambiguous_count++;
      moduleRelations.set(moduleKey, moduleRelation);
    }
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
  for (const file of files.values()) {
    const module = modules.get(file.module) || {
      id: `module:${file.module}`,
      name: file.module,
      parent_id: null,
      child_ids: [],
      file_ids: [],
      file_count: 0,
      default_file_count: 0,
      hidden_file_count: 0,
      symbol_count: 0,
      incoming_count: 0,
      outgoing_count: 0,
    };
    module.file_count++;
    if (file.is_noisy) module.hidden_file_count++;
    else module.default_file_count++;
    module.symbol_count += file.symbol_count;
    modules.set(file.module, module);
  }

  for (const file of visibleFiles) modules.get(file.module).file_ids.push(file.id);

  for (const relation of moduleRelations.values()) {
    const from = modules.get(relation.from.slice('module:'.length));
    const to = modules.get(relation.to.slice('module:'.length));
    if (from) from.outgoing_count += relation.count;
    if (to) to.incoming_count += relation.count;
  }

  const visibleModuleRelations = [...moduleRelations.values()]
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)
      || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind))
    .slice(0, limits.module_relations)
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
      || a.kind.localeCompare(b.kind));

  const emittedGroupPaths = new Set();
  for (const file of visibleFiles) {
    for (const path of directoryGroupPaths(file.path)) emittedGroupPaths.add(path);
  }
  const groups = new Map();
  for (const path of [...emittedGroupPaths].sort((a, b) => a.localeCompare(b))) {
    const parts = path.split('/');
    const parentPath = parts.slice(0, -1).join('/');
    const parentId = emittedGroupPaths.has(parentPath)
      ? `group:${parentPath}`
      : `module:${parts[0]}`;
    groups.set(path, {
      id: `group:${path}`,
      name: parts[parts.length - 1],
      path,
      parent_id: parentId,
      child_ids: [],
      file_ids: [],
      depth: parts.length - 1,
      module: parts[0],
      direct_file_count: 0,
      file_count: 0,
      default_file_count: 0,
      hidden_file_count: 0,
      symbol_count: 0,
    });
  }

  for (const file of files.values()) {
    const paths = directoryGroupPaths(file.path);
    for (const path of paths) {
      const group = groups.get(path);
      if (!group) continue;
      group.file_count++;
      if (file.is_noisy) group.hidden_file_count++;
      else group.default_file_count++;
      group.symbol_count += file.symbol_count;
      if (path === paths[paths.length - 1]) group.direct_file_count++;
    }
  }

  const hierarchyAncestors = new Map();
  for (const file of visibleFiles) {
    const ancestors = directoryGroupPaths(file.path)
      .filter((path) => groups.has(path))
      .reverse()
      .map((path) => `group:${path}`);
    ancestors.push(`module:${file.module}`);
    file.parent_id = ancestors[0];
    file.ancestor_ids = ancestors;
    hierarchyAncestors.set(file.id, ancestors);
    const parent = file.parent_id.startsWith('group:')
      ? groups.get(file.parent_id.slice('group:'.length))
      : null;
    if (parent) {
      parent.file_ids.push(file.id);
      parent.child_ids.push(file.id);
    } else {
      modules.get(file.module).child_ids.push(file.id);
    }
  }

  for (const group of groups.values()) {
    const parentGroup = group.parent_id.startsWith('group:')
      ? groups.get(group.parent_id.slice('group:'.length))
      : null;
    if (parentGroup) parentGroup.child_ids.push(group.id);
    else modules.get(group.module).child_ids.push(group.id);
    group.child_ids.sort((a, b) => a.localeCompare(b));
    group.file_ids.sort((a, b) => a.localeCompare(b));
  }
  for (const module of modules.values()) module.child_ids.sort((a, b) => a.localeCompare(b));

  const visibleFilesById = new Map(visibleFiles.map((file) => [file.id, file]));
  const cleanHierarchyRelations = [...relations.values()].filter((relation) => {
    const from = visibleFilesById.get(relation.from);
    const to = visibleFilesById.get(relation.to);
    return from && to && !from.is_noisy && !to.is_noisy;
  });
  const hierarchyRelations = cleanHierarchyRelations
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)
      || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind))
    .slice(0, limits.relations)
    .map((relation) => ({
      ...relation,
      id: `hierarchy-${relation.id}`,
      from_ancestors: hierarchyAncestors.get(relation.from),
      to_ancestors: hierarchyAncestors.get(relation.to),
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
      || a.kind.localeCompare(b.kind));

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
      indexed_module_relations: moduleRelations.size,
      visible_module_relations: visibleModuleRelations.length,
      visible_modules: modules.size,
      visible_groups: groups.size,
      visible_hierarchy_relations: hierarchyRelations.length,
    },
    omitted: {
      files: Math.max(0, files.size - visibleFiles.length),
      symbols: Math.max(0, allSymbolCount - visibleSymbols),
      relations: Math.max(0, relations.size - visibleRelations.length),
      module_relations: Math.max(0, moduleRelations.size - visibleModuleRelations.length),
      hierarchy_relations: Math.max(0, cleanHierarchyRelations.length - hierarchyRelations.length),
    },
    modules: [...modules.values()].sort((a, b) => a.name.localeCompare(b.name)),
    groups: [...groups.values()].sort((a, b) => a.path.localeCompare(b.path)),
    module_relations: visibleModuleRelations,
    hierarchy_relations: hierarchyRelations,
    files: visibleFiles,
    relations: visibleRelations,
    code_index: codeIndexStatus,
  };
  if (!files.size) {
    if (codeIndexStatus && codeIndexStatus.state === 'running') {
      projection.status = 'indexing';
      projection.message = 'Indexing source files and relationships…';
    } else if (codeIndexStatus && codeIndexStatus.state === 'failed') {
      projection.status = 'error';
      projection.message = codeIndexStatus.error || 'Architecture indexing failed and will retry automatically.';
    } else if (codeIndexStatus && codeIndexStatus.state === 'succeeded') {
      projection.status = 'ready';
      projection.message = 'Indexing completed, but no supported source symbols were found.';
    } else {
      projection.message = 'Architecture data is not indexed yet. Project onboarding will map source files and relationships automatically.';
    }
  }
  return projection;
}

module.exports = {
  VERSION,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_RELATIONS,
  DEFAULT_MAX_MODULE_RELATIONS,
  DEFAULT_MAX_SYMBOLS_PER_FILE,
  classifyFileNoise,
  buildArchitectureProjection,
};
