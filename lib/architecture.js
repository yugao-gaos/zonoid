'use strict';

const VERSION = 1;
const DEFAULT_MAX_FILES = 120;
const DEFAULT_MAX_HIERARCHY_FILES = 5000;
const DEFAULT_MAX_RELATIONS = 240;
const DEFAULT_MAX_MODULE_RELATIONS = 120;
const DEFAULT_MAX_SYMBOLS_PER_FILE = 12;
const DEFAULT_MAX_SYMBOL_NODES = 240;
const DEFAULT_MAX_SYMBOL_RELATIONS = 480;
const MAX_DIRECT_FILES_PER_GROUP = 12;
const MIN_PREFIX_GROUP_FILES = 3;

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

function filenamePrefix(name) {
  const stem = String(name || '').replace(/\.[^.]+$/, '');
  const separated = /^([a-z][a-z0-9]{1,})[-_.]/i.exec(stem);
  if (separated) return separated[1].toLowerCase();
  const numbered = /^([a-z][a-z_-]*[a-z])\d/i.exec(stem);
  if (numbered) return numbered[1].toLowerCase();
  const camel = /^([a-z][a-z0-9]{1,}?)(?=[A-Z])/.exec(stem);
  return camel ? camel[1].toLowerCase() : '';
}

function balancedBuckets(items, maxSize) {
  if (!items.length) return [];
  const bucketCount = Math.ceil(items.length / maxSize);
  const baseSize = Math.floor(items.length / bucketCount);
  const largerBuckets = items.length % bucketCount;
  const buckets = [];
  let offset = 0;
  for (let index = 0; index < bucketCount; index++) {
    const size = baseSize + (index < largerBuckets ? 1 : 0);
    buckets.push(items.slice(offset, offset + size));
    offset += size;
  }
  return buckets;
}

function syntheticGroup(parent, files, kind, key, bucketIndex, bucketCount) {
  const first = files[0].name;
  const last = files[files.length - 1].name;
  const suffix = bucketCount > 1 ? `:${bucketIndex + 1}` : '';
  const id = `group:@display/${encodeURIComponent(parent.id)}/${kind}/${encodeURIComponent(key)}${suffix}`;
  const name = kind === 'prefix'
    ? `${key}*${bucketCount > 1 ? ` · ${first} – ${last}` : ''}`
    : `${first} – ${last}`;
  const group = {
    id,
    name,
    path: `${parent.path || parent.name}/${name}`,
    parent_id: parent.id,
    child_ids: files.map((file) => file.id).sort((a, b) => a.localeCompare(b)),
    file_ids: files.map((file) => file.id).sort((a, b) => a.localeCompare(b)),
    depth: (parent.depth || 0) + 1,
    module: parent.module || parent.name,
    direct_file_count: files.length,
    file_count: files.length,
    default_file_count: files.filter((file) => !file.is_noisy).length,
    hidden_file_count: files.filter((file) => file.is_noisy).length,
    symbol_count: files.reduce((sum, file) => sum + file.symbol_count, 0),
    synthetic: true,
    synthetic_kind: kind,
  };
  if (kind === 'prefix') group.prefix = key;
  else {
    group.range_start = first;
    group.range_end = last;
  }
  return group;
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
  const maxFiles = positiveInt(opts.maxFiles, DEFAULT_MAX_FILES);
  const limits = {
    files: maxFiles,
    hierarchy_files: Math.max(maxFiles, positiveInt(opts.maxHierarchyFiles, DEFAULT_MAX_HIERARCHY_FILES)),
    relations: positiveInt(opts.maxRelations, DEFAULT_MAX_RELATIONS),
    module_relations: positiveInt(opts.maxModuleRelations, DEFAULT_MAX_MODULE_RELATIONS),
    symbols_per_file: positiveInt(opts.maxSymbolsPerFile, DEFAULT_MAX_SYMBOLS_PER_FILE),
    symbol_nodes: positiveInt(opts.maxSymbolNodes, DEFAULT_MAX_SYMBOL_NODES),
    symbol_relations: positiveInt(opts.maxSymbolRelations, DEFAULT_MAX_SYMBOL_RELATIONS),
  };
  const files = new Map();
  const symbolsById = new Map();
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
    const symbol = {
      id: String(raw.key || raw.id || key),
      name: boundedText(raw.name || raw.signature || key, 240),
      kind: String(raw.kind || raw.symbol_kind || 'symbol'),
      start_line: raw.start_line != null && Number.isFinite(Number(raw.start_line)) ? Number(raw.start_line) : null,
      end_line: raw.end_line != null && Number.isFinite(Number(raw.end_line)) ? Number(raw.end_line) : null,
      signature: raw.signature ? boundedText(raw.signature, 320) : null,
      summary: raw.summary ? boundedText(raw.summary, 480) : null,
      exported: !!raw.exported,
    };
    file.symbols.push(symbol);
    if (!symbolsById.has(symbol.id)) {
      symbolsById.set(symbol.id, {
        ...symbol,
        file: file.path,
        file_id: file.id,
        module: file.module,
        noise: file.noise,
        is_noisy: file.is_noisy,
      });
    }
    if (raw.exported) file.exported_count++;
  }

  const relations = new Map();
  const moduleRelations = new Map();
  const symbolCallEdges = [];
  const sourceLessSymbolCallEdges = [];
  let indexedRelations = 0;
  for (const raw of codeEdges) {
    if (!raw) continue;
    if (raw.kind === 'calls') {
      const toSymbolId = String(raw.to || '').trim();
      const toSymbol = symbolsById.get(toSymbolId);
      const explicitFromId = String(raw.from || '').trim();
      const explicitFrom = symbolsById.get(explicitFromId);
      const rawFromPath = cleanFile(raw.from_file);
      const rawToPath = cleanFile(raw.to_file);
      const fromPath = explicitFrom ? explicitFrom.file : rawFromPath;
      const mismatchedFromPath = explicitFrom && rawFromPath && rawFromPath !== explicitFrom.file;
      const mismatchedToPath = toSymbol && rawToPath && rawToPath !== toSymbol.file;
      if (explicitFrom && toSymbol && fromPath && !mismatchedFromPath && !mismatchedToPath) {
        symbolCallEdges.push({
          from_symbol: explicitFrom.id,
          from_file: fromPath,
          to_symbol: toSymbol.id,
          to_file: toSymbol.file,
          ambiguous: !!raw.ambiguous,
        });
      } else if (!explicitFromId && toSymbol && rawFromPath && !mismatchedToPath) {
        sourceLessSymbolCallEdges.push({
          from_file: rawFromPath,
          to_symbol: toSymbol.id,
          to_file: toSymbol.file,
          ambiguous: !!raw.ambiguous,
        });
      }
    }
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
  const hierarchySourceFiles = rankedFiles.slice(0, limits.hierarchy_files);
  const visibleFiles = rankedFiles.slice(0, limits.files);
  const visibleIds = new Set(visibleFiles.map((file) => file.id));
  let visibleSymbols = 0;
  for (const file of visibleFiles) {
    file.has_rich_detail = true;
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
  for (const file of hierarchySourceFiles) {
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

  for (const file of hierarchySourceFiles) {
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

  const actualGroupsById = new Map([...groups.values()].map((group) => [group.id, group]));
  const actualAncestorsByFile = new Map();
  const directFilesByParent = new Map();
  for (const file of hierarchySourceFiles) {
    const ancestors = directoryGroupPaths(file.path)
      .filter((path) => groups.has(path))
      .reverse()
      .map((path) => `group:${path}`);
    ancestors.push(`module:${file.module}`);
    actualAncestorsByFile.set(file.id, ancestors);
    const parentId = ancestors[0];
    if (!directFilesByParent.has(parentId)) directFilesByParent.set(parentId, []);
    directFilesByParent.get(parentId).push(file);
  }

  const syntheticGroups = new Map();
  const syntheticParentByFile = new Map();
  const registerSyntheticGroup = (parent, bucket, kind, key, index, count) => {
    const group = syntheticGroup(parent, bucket, kind, key, index, count);
    syntheticGroups.set(group.id, group);
    for (const file of bucket) syntheticParentByFile.set(file.id, group.id);
  };
  for (const [parentId, directFiles] of [...directFilesByParent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))) {
    if (directFiles.length <= MAX_DIRECT_FILES_PER_GROUP) continue;
    const parent = actualGroupsById.get(parentId)
      || modules.get(parentId.slice('module:'.length));
    const sortedFiles = [...directFiles]
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    const filesByPrefix = new Map();
    for (const file of sortedFiles) {
      const prefix = filenamePrefix(file.name);
      if (!prefix) continue;
      if (!filesByPrefix.has(prefix)) filesByPrefix.set(prefix, []);
      filesByPrefix.get(prefix).push(file);
    }
    const assigned = new Set();
    for (const [prefix, prefixFiles] of [...filesByPrefix.entries()]
      .filter(([, prefixFiles]) => prefixFiles.length >= MIN_PREFIX_GROUP_FILES)
      .sort(([a], [b]) => a.localeCompare(b))) {
      const buckets = balancedBuckets(prefixFiles, MAX_DIRECT_FILES_PER_GROUP);
      buckets.forEach((bucket, index) => {
        registerSyntheticGroup(parent, bucket, 'prefix', prefix, index, buckets.length);
        for (const file of bucket) assigned.add(file.id);
      });
    }
    const remaining = sortedFiles.filter((file) => !assigned.has(file.id));
    const buckets = balancedBuckets(remaining, MAX_DIRECT_FILES_PER_GROUP);
    buckets.forEach((bucket, index) => {
      const key = `${bucket[0].name}..${bucket[bucket.length - 1].name}`;
      registerSyntheticGroup(parent, bucket, 'range', key, index, buckets.length);
    });
    const actualParent = actualGroupsById.get(parentId);
    if (actualParent) actualParent.direct_file_count = 0;
  }

  for (const group of groups.values()) {
    const parentGroup = group.parent_id.startsWith('group:')
      ? groups.get(group.parent_id.slice('group:'.length))
      : null;
    if (parentGroup) parentGroup.child_ids.push(group.id);
    else modules.get(group.module).child_ids.push(group.id);
  }
  for (const group of syntheticGroups.values()) {
    const parentGroup = actualGroupsById.get(group.parent_id);
    if (parentGroup) parentGroup.child_ids.push(group.id);
    else modules.get(group.module).child_ids.push(group.id);
  }

  const allGroupsById = new Map([...actualGroupsById, ...syntheticGroups]);
  const hierarchyAncestors = new Map();
  for (const file of hierarchySourceFiles) {
    const ancestors = [...actualAncestorsByFile.get(file.id)];
    const syntheticParentId = syntheticParentByFile.get(file.id);
    if (syntheticParentId) ancestors.unshift(syntheticParentId);
    file.parent_id = ancestors[0];
    file.ancestor_ids = ancestors;
    hierarchyAncestors.set(file.id, ancestors);
    if (syntheticParentId) continue;
    const parent = allGroupsById.get(file.parent_id);
    if (parent) {
      parent.file_ids.push(file.id);
      parent.child_ids.push(file.id);
    } else {
      modules.get(file.module).child_ids.push(file.id);
    }
  }

  const allGroups = [...allGroupsById.values()];
  for (const group of allGroups) {
    group.child_ids.sort((a, b) => a.localeCompare(b));
    group.file_ids.sort((a, b) => a.localeCompare(b));
  }
  for (const module of modules.values()) module.child_ids.sort((a, b) => a.localeCompare(b));

  const richFileIds = new Set(visibleFiles.map((file) => file.id));
  const hierarchyFiles = hierarchySourceFiles.map((file) => ({
    id: file.id,
    path: file.path,
    name: file.name,
    module: file.module,
    parent_id: file.parent_id,
    ancestor_ids: file.ancestor_ids,
    noise: file.noise,
    is_noisy: file.is_noisy,
    symbol_count: file.symbol_count,
    exported_count: file.exported_count,
    incoming_count: file.incoming_count,
    outgoing_count: file.outgoing_count,
    internal_count: file.internal_count,
    has_rich_detail: richFileIds.has(file.id),
  })).sort((a, b) => a.module.localeCompare(b.module) || a.path.localeCompare(b.path));
  const hierarchyFilesById = new Map(hierarchySourceFiles.map((file) => [file.id, file]));
  const cleanHierarchyRelations = [...relations.values()].filter((relation) => {
    const from = hierarchyFilesById.get(relation.from);
    const to = hierarchyFilesById.get(relation.to);
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

  const symbolRelationsByKey = new Map();
  for (const edge of symbolCallEdges) {
    const fromSymbol = symbolsById.get(edge.from_symbol);
    const toSymbol = symbolsById.get(edge.to_symbol);
    const fromFile = files.get(edge.from_file);
    const toFile = toSymbol && files.get(toSymbol.file);
    if (!fromSymbol || !fromFile || !toFile || !toSymbol) continue;
    const fromId = fromSymbol.id;
    const scope = fromFile.path === toFile.path
      ? 'same-file'
      : fromFile.module === toFile.module ? 'same-module' : 'cross-module';
    const key = `${fromId}\u0000${toSymbol.id}\u0000calls`;
    const relation = symbolRelationsByKey.get(key) || {
      id: `symbol-relation:${fromId}:calls:${toSymbol.id}`,
      from: fromId,
      to: toSymbol.id,
      from_kind: 'symbol',
      to_kind: 'symbol',
      source_precision: 'symbol',
      kind: 'calls',
      scope,
      same_file: scope === 'same-file',
      same_module: scope !== 'cross-module',
      cross_file: scope !== 'same-file',
      cross_module: scope === 'cross-module',
      from_file: fromFile.path,
      from_file_id: fromFile.id,
      from_module: fromFile.module,
      to_file: toFile.path,
      to_file_id: toFile.id,
      to_module: toFile.module,
      is_noisy: fromFile.is_noisy || toFile.is_noisy,
      count: 0,
      ambiguous_count: 0,
    };
    relation.count++;
    if (edge.ambiguous) relation.ambiguous_count++;
    symbolRelationsByKey.set(key, relation);
  }

  const sourceLessSymbolRelationsByKey = new Map();
  for (const edge of sourceLessSymbolCallEdges) {
    const toSymbol = symbolsById.get(edge.to_symbol);
    const fromFile = files.get(edge.from_file);
    const toFile = toSymbol && files.get(toSymbol.file);
    if (!fromFile || !toFile || !toSymbol) continue;
    const key = `${fromFile.id}\u0000${toSymbol.id}\u0000calls`;
    const relation = sourceLessSymbolRelationsByKey.get(key) || {
      from_file_id: fromFile.id,
      to: toSymbol.id,
      count: 0,
      ambiguous_count: 0,
    };
    relation.count++;
    if (edge.ambiguous) relation.ambiguous_count++;
    sourceLessSymbolRelationsByKey.set(key, relation);
  }

  const symbolDegree = new Map();
  const addSymbolDegree = (id, field, count) => {
    const degree = symbolDegree.get(id) || { incoming_count: 0, outgoing_count: 0 };
    degree[field] += count;
    symbolDegree.set(id, degree);
  };
  for (const relation of symbolRelationsByKey.values()) {
    addSymbolDegree(relation.to, 'incoming_count', relation.count);
    addSymbolDegree(relation.from, 'outgoing_count', relation.count);
  }
  for (const relation of sourceLessSymbolRelationsByKey.values()) {
    addSymbolDegree(relation.to, 'incoming_count', relation.count);
  }

  const rankedSymbolRecords = [...symbolsById.values()]
    .filter((symbol) => hierarchyAncestors.has(symbol.file_id))
    .sort((a, b) => {
      const ad = symbolDegree.get(a.id) || { incoming_count: 0, outgoing_count: 0 };
      const bd = symbolDegree.get(b.id) || { incoming_count: 0, outgoing_count: 0 };
      return (bd.incoming_count + bd.outgoing_count) - (ad.incoming_count + ad.outgoing_count)
        || Number(b.exported) - Number(a.exported)
        || a.file.localeCompare(b.file)
        || (a.start_line == null) - (b.start_line == null)
        || (a.start_line || 0) - (b.start_line || 0)
        || a.name.localeCompare(b.name)
        || a.id.localeCompare(b.id);
    });
  const selectedSymbolRecords = rankedSymbolRecords.slice(0, limits.symbol_nodes);
  const selectedSymbolIds = new Set(selectedSymbolRecords.map((symbol) => symbol.id));
  const symbolNodes = selectedSymbolRecords.map((symbol) => {
    const degree = symbolDegree.get(symbol.id) || { incoming_count: 0, outgoing_count: 0 };
    return {
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
      file_id: symbol.file_id,
      module: symbol.module,
      parent_id: symbol.file_id,
      ancestor_ids: [symbol.file_id, ...hierarchyAncestors.get(symbol.file_id)],
      start_line: symbol.start_line,
      end_line: symbol.end_line,
      signature: symbol.signature,
      summary: symbol.summary,
      exported: symbol.exported,
      noise: symbol.noise,
      is_noisy: symbol.is_noisy,
      incoming_count: degree.incoming_count,
      outgoing_count: degree.outgoing_count,
    };
  }).sort((a, b) => a.module.localeCompare(b.module) || a.file.localeCompare(b.file)
    || (a.start_line == null) - (b.start_line == null)
    || (a.start_line || 0) - (b.start_line || 0)
    || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const symbolNodesById = new Map(symbolNodes.map((symbol) => [symbol.id, symbol]));
  const symbolRelationCandidates = [...symbolRelationsByKey.values()].filter((relation) =>
    selectedSymbolIds.has(relation.to)
      && selectedSymbolIds.has(relation.from)
      && hierarchyAncestors.has(relation.from_file_id)
      && hierarchyAncestors.has(relation.to_file_id));
  const symbolRelations = symbolRelationCandidates
    .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)
      || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind))
    .slice(0, limits.symbol_relations)
    .map((relation) => ({
      ...relation,
      from_ancestors: symbolNodesById.get(relation.from).ancestor_ids,
      to_ancestors: symbolNodesById.get(relation.to).ancestor_ids,
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
      visible_groups: allGroups.length,
      visible_hierarchy_files: hierarchyFiles.length,
      visible_hierarchy_relations: hierarchyRelations.length,
      indexed_symbol_nodes: symbolsById.size,
      visible_symbol_nodes: symbolNodes.length,
      indexed_symbol_relations: symbolCallEdges.length,
      indexed_symbol_relation_groups: symbolRelationsByKey.size,
      visible_symbol_relations: symbolRelations.length,
      source_less_symbol_relations: sourceLessSymbolCallEdges.length,
      source_less_symbol_relation_groups: sourceLessSymbolRelationsByKey.size,
    },
    omitted: {
      files: Math.max(0, files.size - visibleFiles.length),
      hierarchy_files: Math.max(0, files.size - hierarchyFiles.length),
      symbols: Math.max(0, allSymbolCount - visibleSymbols),
      relations: Math.max(0, relations.size - visibleRelations.length),
      module_relations: Math.max(0, moduleRelations.size - visibleModuleRelations.length),
      hierarchy_relations: Math.max(0, cleanHierarchyRelations.length - hierarchyRelations.length),
      symbol_nodes: Math.max(0, symbolsById.size - symbolNodes.length),
      symbol_relations: Math.max(0, symbolRelationsByKey.size - symbolRelations.length),
      source_less_symbol_relations: sourceLessSymbolRelationsByKey.size,
    },
    modules: [...modules.values()].sort((a, b) => a.name.localeCompare(b.name)),
    groups: allGroups.sort((a, b) => a.path.localeCompare(b.path)),
    hierarchy_files: hierarchyFiles,
    module_relations: visibleModuleRelations,
    hierarchy_relations: hierarchyRelations,
    symbol_nodes: symbolNodes,
    symbol_relations: symbolRelations,
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
  DEFAULT_MAX_HIERARCHY_FILES,
  DEFAULT_MAX_RELATIONS,
  DEFAULT_MAX_MODULE_RELATIONS,
  DEFAULT_MAX_SYMBOLS_PER_FILE,
  DEFAULT_MAX_SYMBOL_NODES,
  DEFAULT_MAX_SYMBOL_RELATIONS,
  classifyFileNoise,
  buildArchitectureProjection,
};
