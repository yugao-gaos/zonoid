'use strict';

// Pure spreading-activation substrate for search callers. It treats seed scores as initial
// activation, follows caller-supplied adjacency, and keeps raw unjudged/weight-0 candidate edges
// retrieval-invisible until the judge promotes them.
const DEFAULTS = {
  maxDepth: 2,
  decay: 0.65,
  budget: Infinity,
  defaultEdgeWeight: 1,
  defaultRelationWeight: 1,
  defaultConfidence: 1,
  minActivation: 0,
  includeSeeds: true,
};

function activateGraph(input = {}) {
  const opts = normalizeOptions(input);
  const seeds = normalizeSeeds(input.seeds || input.seedActivations || []);
  if (!seeds.length || opts.budget === 0) return [];

  const edgesFor = adjacencyReader(input.adjacency || input.edges || {});
  const records = new Map();
  const queue = [];

  for (const seed of seeds) {
    const item = {
      key: seed.key,
      activation: seed.activation,
      depth: 0,
      path: [seed.key],
      provenance: [{
        type: 'seed',
        key: seed.key,
        activation: seed.activation,
        rawActivation: seed.rawActivation,
        confidence: seed.confidence,
        source: seed.source,
      }],
      isSeed: true,
    };
    addContribution(records, item);
    queue.push(item);
  }

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current.depth >= opts.maxDepth) continue;

    for (const rawEdge of edgesFor(current.key)) {
      const edge = normalizeEdge(rawEdge, current.key, opts);
      if (!edge || current.path.includes(edge.to)) continue;

      const activation = clamp01(
        current.activation *
        opts.decay *
        edge.weight *
        edge.relationWeight *
        edge.confidence
      );
      if (!(activation > opts.minActivation)) continue;

      const item = {
        key: edge.to,
        activation,
        depth: current.depth + 1,
        path: current.path.concat(edge.to),
        provenance: current.provenance.concat({
          type: 'edge',
          from: current.key,
          to: edge.to,
          relation: edge.relation,
          weight: edge.weight,
          relationWeight: edge.relationWeight,
          confidence: edge.confidence,
          decay: opts.decay,
          source: edge.source,
          activation,
        }),
        isSeed: false,
      };
      addContribution(records, item);
      queue.push(item);
    }
  }

  const ranked = Array.from(records.values())
    .filter((r) => opts.includeSeeds || !r.isSeed)
    .map((r) => ({
      key: r.key,
      activation: r.activation,
      depth: r.depth,
      path: r.path,
      provenance: r.provenance,
      bestPathActivation: r.bestPathActivation,
      contributionCount: r.contributionCount,
    }))
    .sort(compareActivated);

  return Number.isFinite(opts.budget) ? ranked.slice(0, opts.budget) : ranked;
}

function addContribution(records, item) {
  const existing = records.get(item.key);
  if (!existing) {
    records.set(item.key, {
      key: item.key,
      activation: clamp01(item.activation),
      bestPathActivation: clamp01(item.activation),
      depth: item.depth,
      path: item.path,
      provenance: item.provenance,
      contributionCount: 1,
      isSeed: item.isSeed,
    });
    return;
  }

  const nextActivation = clamp01(item.activation);
  existing.activation = combineActivation(existing.activation, nextActivation);
  existing.contributionCount += 1;
  existing.isSeed = existing.isSeed && item.isSeed;

  if (
    nextActivation > existing.bestPathActivation ||
    (nextActivation === existing.bestPathActivation && item.depth < existing.depth)
  ) {
    existing.bestPathActivation = nextActivation;
    existing.depth = item.depth;
    existing.path = item.path;
    existing.provenance = item.provenance;
  }
}

function compareActivated(a, b) {
  if (b.activation !== a.activation) return b.activation - a.activation;
  if (a.depth !== b.depth) return a.depth - b.depth;
  return a.key.localeCompare(b.key);
}

function combineActivation(a, b) {
  const aa = clamp01(a);
  const bb = clamp01(b);
  return 1 - ((1 - aa) * (1 - bb));
}

function normalizeOptions(input) {
  return {
    maxDepth: intAtLeast(input.maxDepth, DEFAULTS.maxDepth, 0),
    decay: nonNegativeNumber(input.decay, DEFAULTS.decay),
    budget: normalizeBudget(input.budget),
    defaultEdgeWeight: nonNegativeNumber(input.defaultEdgeWeight, DEFAULTS.defaultEdgeWeight),
    defaultRelationWeight: nonNegativeNumber(input.defaultRelationWeight, DEFAULTS.defaultRelationWeight),
    defaultConfidence: nonNegativeNumber(input.defaultConfidence, DEFAULTS.defaultConfidence),
    minActivation: nonNegativeNumber(input.minActivation, DEFAULTS.minActivation),
    includeSeeds: input.includeSeeds == null ? DEFAULTS.includeSeeds : !!input.includeSeeds,
    relationWeights: input.relationWeights && typeof input.relationWeights === 'object' ? input.relationWeights : {},
  };
}

function normalizeSeeds(seeds) {
  const raw = Array.isArray(seeds)
    ? seeds
    : (seeds && typeof seeds === 'object' ? Object.entries(seeds).map(([key, value]) => {
        if (value && typeof value === 'object') return { key, ...value };
        return { key, activation: value };
      }) : []);

  return raw
    .map((seed) => {
      if (typeof seed === 'string') return seedObject(seed, 1, 1, undefined);
      if (Array.isArray(seed)) return seedObject(seed[0], seed[1], 1, undefined);
      if (!seed || typeof seed !== 'object') return null;
      const key = firstDefined(seed.key, seed.id, seed.node);
      const rawActivation = nonNegativeNumber(firstDefined(seed.activation, seed.score, seed.weight, seed.value), 1);
      const confidence = nonNegativeNumber(seed.confidence, 1);
      return seedObject(key, rawActivation, confidence, seed.source || seed.provenance);
    })
    .filter(Boolean);
}

function seedObject(key, rawActivation, confidence, source) {
  if (key == null || key === '') return null;
  const seedConfidence = nonNegativeNumber(confidence, 1);
  const raw = nonNegativeNumber(rawActivation, 1);
  const activation = clamp01(raw * seedConfidence);
  if (activation <= 0) return null;
  return { key: String(key), rawActivation: raw, confidence: seedConfidence, activation, source };
}

function adjacencyReader(adjacency) {
  if (typeof adjacency === 'function') {
    return (key) => asArray(adjacency(key));
  }
  if (adjacency instanceof Map) {
    return (key) => asArray(adjacency.get(key));
  }
  if (Array.isArray(adjacency)) {
    const grouped = new Map();
    for (const edge of adjacency) {
      if (!edge || typeof edge !== 'object') continue;
      const from = firstDefined(edge.from, edge.source);
      if (from == null) continue;
      const k = String(from);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k).push(edge);
    }
    return (key) => grouped.get(String(key)) || [];
  }
  if (adjacency && typeof adjacency === 'object') {
    return (key) => Object.prototype.hasOwnProperty.call(adjacency, key) ? asArray(adjacency[key]) : [];
  }
  return () => [];
}

function normalizeEdge(edge, from, opts) {
  if (typeof edge === 'string') {
    return {
      from,
      to: edge,
      relation: 'context',
      weight: opts.defaultEdgeWeight,
      relationWeight: relationWeightFor('context', opts),
      confidence: opts.defaultConfidence,
      source: undefined,
    };
  }
  if (!edge || typeof edge !== 'object') return null;
  if (edge.judged === false) return null;

  const to = firstDefined(edge.to, edge.target, edge.key, edge.id);
  if (to == null || to === '') return null;

  const relation = String(firstDefined(edge.relation, edge.kind, 'context'));
  const weight = nonNegativeNumber(firstDefined(edge.weight, edge.edgeWeight), opts.defaultEdgeWeight);
  const relationWeight = relationWeightFor(relation, opts);
  const confidence = nonNegativeNumber(edge.confidence, opts.defaultConfidence);

  if (weight <= 0 || relationWeight <= 0 || confidence <= 0) return null;

  return {
    from,
    to: String(to),
    relation,
    weight,
    relationWeight,
    confidence,
    source: firstDefined(edge.source, edge.by, edge.origin),
  };
}

function relationWeightFor(relation, opts) {
  const weights = opts.relationWeights || {};
  return nonNegativeNumber(firstDefined(weights[relation], weights['*']), opts.defaultRelationWeight);
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function nonNegativeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : fallback;
}

function intAtLeast(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

function normalizeBudget(value) {
  if (value == null) return DEFAULTS.budget;
  const n = Number(value);
  if (n === Infinity) return Infinity;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.floor(n));
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

module.exports = {
  activateGraph,
  combineActivation,
};
