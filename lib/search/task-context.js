'use strict';

const retrievalWeights = require('./retrieval-weights');

const DEFAULT_CONTEXT_WEIGHT = 0.5;
const DIRECT_CONTEXT_LIMIT = 50;
const NOTE_DEP_LIMIT = 50;
const SURROUNDING_LIMIT = 50;

function clampWeight(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_CONTEXT_WEIGHT;
  return Math.max(0, Math.min(1, value));
}

function contextWeight(node, key) {
  const weights = node && node.context_weights;
  if (!weights || typeof weights !== 'object' || weights[key] == null) return DEFAULT_CONTEXT_WEIGHT;
  return clampWeight(weights[key]);
}

function retrievalWeight(options, from, to, relation) {
  return retrievalWeights.weightFromMap(options && options.retrievalWeightMap, from, to, relation);
}

function isGhostKey(key) {
  return typeof key === 'string' && key.startsWith('ghost:');
}

function nodeKind(node) {
  return (node && node.kind) || 'task';
}

function summarizeNode(node, key) {
  return {
    key,
    title: node ? node.label : key,
    label: node ? node.label : key,
    status: node ? node.status : '?',
    kind: nodeKind(node),
    summary: String((node && node.summary) || '').slice(0, 200),
  };
}

function makeEntry({ node, key, via, tier, path, weight, source, edge, order, structuralRank }) {
  const entry = {
    ...summarizeNode(node, key),
    via,
    tier,
    path,
    pinned: tier === 'dag' || tier === 'dag-note',
    structuralRank,
    order,
  };
  if (weight != null) entry.weight = clampWeight(weight);
  if (source) entry.source = source;
  if (edge) entry.edge = edge;
  return entry;
}

function buildAdjacency(nodes, options = {}) {
  const adjacency = new Map();
  const ensure = (key) => {
    if (!adjacency.has(key)) adjacency.set(key, []);
    return adjacency.get(key);
  };

  for (const node of nodes) {
    if (!node || !node.id) continue;
    ensure(node.id);
    (node.deps || []).forEach((dep, index) => {
      if (!dep || isGhostKey(dep)) return;
      ensure(dep);
      const retrievalWeightValue = retrievalWeight(options, node.id, dep, 'blocking');
      const edge = { kind: 'blocking', from: node.id, to: dep, index, retrievalWeight: retrievalWeightValue };
      adjacency.get(node.id).push({ key: dep, source: node.id, edge });
      adjacency.get(dep).push({ key: node.id, source: dep, edge: { ...edge, reverse: true } });
    });
    (node.context_deps || []).forEach((dep, index) => {
      if (!dep || isGhostKey(dep)) return;
      const weight = contextWeight(node, dep);
      if (weight === 0) return;
      ensure(dep);
      const retrievalWeightValue = retrievalWeight(options, node.id, dep, 'context');
      const edge = { kind: 'context', from: node.id, to: dep, index, weight, retrievalWeight: retrievalWeightValue };
      adjacency.get(node.id).push({ key: dep, source: node.id, edge });
      adjacency.get(dep).push({ key: node.id, source: dep, edge: { ...edge, reverse: true } });
    });
  }

  return adjacency;
}

function directDeps(node, field, weightFor) {
  return (node[field] || [])
    .map((key, index) => ({ key, index, weight: weightFor ? weightFor(key) : null }))
    .filter((dep) => dep.key && !isGhostKey(dep.key))
    .filter((dep) => dep.weight == null || dep.weight > 0);
}

function ghostDependencies(graph, node) {
  const refs = new Set([...(node.deps || []), ...(node.context_deps || [])].filter(isGhostKey));
  return (graph.ghosts || [])
    .filter((ghost) => refs.has(`ghost:${ghost.workspace}|${ghost.key}`))
    .map((ghost) => ({ workspace: ghost.workspace, key: ghost.key, label: ghost.label, status: ghost.status }));
}

function addEntry(entries, seen, entry) {
  if (!entry || seen.has(entry.key)) return false;
  seen.add(entry.key);
  entries.push(entry);
  return true;
}

function buildTaskContextPack(graph, taskKey, options = {}) {
  const nodes = Array.isArray(graph && graph.tasks) ? graph.tasks : [];
  const byId = new Map(nodes.filter((node) => node && node.id).map((node) => [node.id, node]));
  const task = byId.get(taskKey);
  if (!task) {
    return {
      ok: false,
      error: 'unknown task',
      task: null,
      results: [],
      pinned: { blocking: [], context: [], notes: [], surrounding: [] },
      dependencySummaries: [],
      ghostDependencies: [],
    };
  }

  const directContextLimit = Math.max(0, options.directContextLimit ?? DIRECT_CONTEXT_LIMIT);
  const noteDepLimit = Math.max(0, options.noteDepLimit ?? NOTE_DEP_LIMIT);
  const surroundingLimit = Math.max(0, options.surroundingLimit ?? SURROUNDING_LIMIT);
  const retrievalWeightMap = options.retrievalWeightMap instanceof Map
    ? options.retrievalWeightMap
    : retrievalWeights.latestWeightMap(options.workspace);
  const weightOptions = { ...options, retrievalWeightMap };
  const entries = [];
  const seen = new Set([task.id]);
  let rank = 0;

  const blocking = directDeps(task, 'deps').map((dep) => {
    const node = byId.get(dep.key);
    return makeEntry({
      node,
      key: dep.key,
      via: 'blocking',
      tier: 'dag',
      path: [`blocking_dep of task/${task.id}`],
      order: dep.index,
      structuralRank: rank++,
    });
  });
  for (const entry of blocking) addEntry(entries, seen, entry);

  const context = directDeps(task, 'context_deps', (key) => contextWeight(task, key))
    .map((dep) => ({
      ...dep,
      retrievalWeight: retrievalWeight(weightOptions, task.id, dep.key, 'context'),
    }))
    .sort((a, b) => (b.weight - a.weight) || (b.retrievalWeight - a.retrievalWeight) || (a.index - b.index))
    .slice(0, directContextLimit)
    .map((dep) => makeEntry({
      node: byId.get(dep.key),
      key: dep.key,
      via: 'context',
      tier: 'dag',
      path: [`context_dep of task/${task.id}`],
      weight: dep.weight,
      order: dep.index,
      structuralRank: rank++,
    }));
  for (const entry of context) addEntry(entries, seen, entry);

  const noteSeeds = [...blocking, ...context].filter((entry) => entry.kind === 'note');
  const notes = [];
  const noteSeen = new Set();
  for (const seed of noteSeeds) {
    const noteNode = byId.get(seed.key);
    const noteDeps = directDeps(noteNode || {}, 'context_deps', (key) => contextWeight(noteNode || {}, key))
      .sort((a, b) => (b.weight - a.weight) || (a.index - b.index));
    for (const dep of noteDeps) {
      if (notes.length >= noteDepLimit) break;
      const entry = makeEntry({
        node: byId.get(dep.key),
        key: dep.key,
        via: 'note',
        tier: 'dag-note',
        path: [`context_dep of ${seed.key}`],
        weight: dep.weight,
        source: seed.key,
        order: dep.index,
        structuralRank: rank++,
      });
      if (!seen.has(entry.key) && !noteSeen.has(entry.key)) {
        noteSeen.add(entry.key);
        notes.push(entry);
      }
    }
    if (notes.length >= noteDepLimit) break;
  }
  for (const entry of notes) addEntry(entries, seen, entry);

  const adjacency = buildAdjacency(nodes, weightOptions);
  const structuralSeeds = [...blocking, ...context, ...notes];
  const surroundingSeeds = [{ key: task.id }, ...structuralSeeds];
  const seedOrder = new Map([[task.id, -1], ...structuralSeeds.map((entry, index) => [entry.key, index])]);
  const surroundingCandidates = [];
  for (const seed of surroundingSeeds) {
    for (const neighbor of adjacency.get(seed.key) || []) {
      if (!neighbor.key || seen.has(neighbor.key) || neighbor.key === task.id) continue;
      const edgeWeight = neighbor.edge.kind === 'context' ? neighbor.edge.weight : null;
      if (edgeWeight === 0) continue;
      surroundingCandidates.push({
        key: neighbor.key,
        seed: seed.key,
        edge: neighbor.edge,
        sourceOrder: seedOrder.get(seed.key) ?? 0,
      });
    }
  }
  surroundingCandidates.sort((a, b) => {
    if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
    const edgeA = a.edge.kind === 'blocking' ? 0 : 1;
    const edgeB = b.edge.kind === 'blocking' ? 0 : 1;
    if (edgeA !== edgeB) return edgeA - edgeB;
    const weightA = a.edge.kind === 'context' ? a.edge.weight : 1;
    const weightB = b.edge.kind === 'context' ? b.edge.weight : 1;
    const learnedA = a.edge.retrievalWeight || 1;
    const learnedB = b.edge.retrievalWeight || 1;
    return (weightB - weightA) || (learnedB - learnedA) || (a.edge.index - b.edge.index) || a.key.localeCompare(b.key);
  });

  const surrounding = [];
  for (const candidate of surroundingCandidates) {
    if (surrounding.length >= surroundingLimit) break;
    if (seen.has(candidate.key)) continue;
    const entry = makeEntry({
      node: byId.get(candidate.key),
      key: candidate.key,
      via: 'surrounding',
      tier: 'surrounding',
      path: [`${candidate.edge.kind}:${candidate.seed}`],
      weight: candidate.edge.kind === 'context' ? candidate.edge.weight : null,
      source: candidate.seed,
      edge: candidate.edge.kind,
      order: candidate.edge.index,
      structuralRank: rank++,
    });
    if (addEntry(entries, seen, entry)) surrounding.push(entry);
  }

  const dependencySummaries = [...blocking, ...context].map((entry) => {
    const summary = {
      key: entry.key,
      label: entry.label,
      status: entry.status,
      summary: entry.summary,
      via: entry.via,
    };
    if (entry.via === 'context') summary.weight = entry.weight;
    return summary;
  });

  return {
    ok: true,
    mode: 'task-context',
    task: summarizeNode(task, task.id),
    results: entries,
    pinned: { blocking, context, notes, surrounding },
    dependencySummaries,
    ghostDependencies: ghostDependencies(graph || {}, task),
  };
}

module.exports = {
  DEFAULT_CONTEXT_WEIGHT,
  buildTaskContextPack,
  searchTaskContext: buildTaskContextPack,
};
