'use strict';

const fs = require('fs');
const path = require('path');
const predictiveLearning = require('./predictive-learning');
const retrievalWeights = require('./retrieval-weights');

const DEFAULT_OPTIONS = {
  maxDepth: 2,
  diffusionScale: 0.5,
  decay: 0.65,
};

const DIRECT_DELTAS = {
  TP: retrievalWeights.POSITIVE_DELTA,
  FN: retrievalWeights.POSITIVE_DELTA,
  FP: retrievalWeights.NEGATIVE_DELTA,
};

function readJsonl(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* skip torn rows */ }
  }
  return rows;
}

function readGateRows(workspace) {
  return readJsonl(path.join(workspace, '.graph', 'gate-labeled.jsonl'));
}

function loadGraphState(workspace) {
  const candidates = [
    path.join(workspace, '.graph', 'checkpoint.json'),
    path.join(workspace, '.graph', 'graph.json'),
    path.join(workspace, '.graph', 'state.json'),
  ];
  for (const file of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { file, graph: normalizeGraphState(parsed) };
    } catch {
      // Try the next local graph snapshot format.
    }
  }
  return null;
}

function normalizeGraphState(state) {
  if (!state || typeof state !== 'object') return { tasks: [] };
  if (Array.isArray(state.tasks)) return { tasks: state.tasks.map(normalizeTask) };
  if (state.graph && Array.isArray(state.graph.tasks)) return { tasks: state.graph.tasks.map(normalizeTask) };

  const rawNodes = state.nodes && typeof state.nodes === 'object'
    ? (Array.isArray(state.nodes) ? state.nodes : Object.values(state.nodes))
    : [];
  const tasksById = new Map();
  const ensure = (id) => {
    if (!id) return null;
    const key = String(id);
    if (!tasksById.has(key)) {
      tasksById.set(key, {
        id: key,
        label: key,
        kind: undefined,
        status: undefined,
        summary: '',
        deps: [],
        context_deps: [],
        context_weights: {},
      });
    }
    return tasksById.get(key);
  };

  for (const node of rawNodes) {
    if (!node || !node.id) continue;
    const task = ensure(node.id);
    Object.assign(task, normalizeTask(node));
  }

  for (const edge of Array.isArray(state.edges) ? state.edges : []) {
    if (!edge || !edge.from || !edge.to) continue;
    const from = String(edge.from);
    const to = String(edge.to);
    ensure(from);
    const target = ensure(to);
    if (!target) continue;

    const kind = String(edge.kind || edge.relation || edge.type || '').toLowerCase();
    if (kind === 'context' || kind === 'context_dep') {
      pushUnique(target.context_deps, from);
      target.context_weights[from] = contextWeight(edge.weight);
    } else if (kind === 'blocking' || kind === 'dep' || kind === 'dependency') {
      pushUnique(target.deps, from);
    }
  }

  return { tasks: Array.from(tasksById.values()) };
}

function normalizeTask(node) {
  const contextWeights = node && node.context_weights && typeof node.context_weights === 'object'
    ? { ...node.context_weights }
    : {};
  return {
    ...node,
    id: node && node.id ? String(node.id) : '',
    deps: Array.isArray(node && node.deps) ? node.deps.map(String) : [],
    context_deps: Array.isArray(node && node.context_deps) ? node.context_deps.map(String) : [],
    context_weights: contextWeights,
  };
}

function pushUnique(list, value) {
  if (!list.includes(value)) list.push(value);
}

function contextWeight(value) {
  const n = Number(value == null ? 0.5 : value);
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

function cloneWeightMap(initialWeights) {
  const out = new Map();
  if (!(initialWeights instanceof Map)) return out;
  for (const value of initialWeights.values()) {
    const edge = retrievalWeights.canonicalEdge(value && value.from, value && value.to, value && value.relation);
    if (!edge) continue;
    out.set(edge.key, {
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      weight: retrievalWeights.clampWeight(value.weight),
    });
  }
  return out;
}

function weightFromShadowMap(map, edge) {
  return retrievalWeights.weightFromMap(map, edge.from, edge.to, edge.relation);
}

function setShadowWeight(map, edge, weight) {
  map.set(edge.key, {
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    weight: retrievalWeights.clampWeight(weight),
  });
}

function normalizeQuadrant(row) {
  const quadrant = String(row && row.quadrant || '').toUpperCase();
  if (quadrant === 'TP' || quadrant === 'FP' || quadrant === 'FN' || quadrant === 'TN') return quadrant;
  const code = String(row && row.error_code || '').toUpperCase();
  if (code === 'GATE_TP') return 'TP';
  if (code === 'GATE_FP') return 'FP';
  if (code === 'GATE_FN') return 'FN';
  if (code === 'GATE_TN') return 'TN';
  return null;
}

function feedbackForRow(row) {
  const quadrant = normalizeQuadrant(row);
  if (quadrant === 'TN') {
    return { quadrant, delta: 0, signal: null, reason: 'tn-noop', matchKey: null, edge: null };
  }
  const delta = DIRECT_DELTAS[quadrant];
  if (!Number.isFinite(delta)) {
    return { quadrant, delta: 0, signal: null, reason: 'no-feedback-signal', matchKey: null, edge: null };
  }

  const matchKey = quadrant === 'FN'
    ? (row && (row.fn_top_key || row.topKey || row.match_key))
    : (row && (row.topKey || row.match_key));
  if (!matchKey) {
    return { quadrant, delta, signal: delta > 0 ? 'positive' : 'negative', reason: 'missing-match-key', matchKey: null, edge: null };
  }

  const edge = predictiveLearning.feedbackEdgeFor(row, matchKey);
  if (!edge) {
    return {
      quadrant,
      delta,
      signal: delta > 0 ? 'positive' : 'negative',
      reason: 'no-direct-matching-edge',
      matchKey,
      edge: null,
    };
  }

  return {
    quadrant,
    delta,
    signal: delta > 0 ? 'positive' : 'negative',
    reason: null,
    matchKey,
    edge,
  };
}

function applyEdgeUpdate(weightMap, edge, requestedDelta, meta = {}) {
  const canonical = retrievalWeights.canonicalEdge(edge && edge.from, edge && edge.to, edge && edge.relation);
  if (!canonical) return null;
  const before = weightFromShadowMap(weightMap, canonical);
  const after = retrievalWeights.clampWeight(before + Number(requestedDelta || 0));
  const actualDelta = after - before;
  setShadowWeight(weightMap, canonical, after);

  return {
    key: canonical.key,
    from: canonical.from,
    to: canonical.to,
    relation: canonical.relation,
    before,
    after,
    requestedDelta,
    actualDelta,
    changed: actualDelta !== 0,
    expectedDirection: directionMatches(requestedDelta, actualDelta),
    boundedNoop: requestedDelta !== 0 && actualDelta === 0,
    ...meta,
  };
}

function directionMatches(requestedDelta, actualDelta) {
  if (requestedDelta > 0) return actualDelta > 0;
  if (requestedDelta < 0) return actualDelta < 0;
  return actualDelta === 0;
}

function applyDirectBaseline(rows, options = {}) {
  const weightMap = cloneWeightMap(options.initialWeights);
  const updates = [];
  const rowResults = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const feedback = feedbackForRow(row);
    if (!feedback.edge || feedback.delta === 0) {
      rowResults.push({
        rowKey: row && (row._key || row.gate_label_key || row.task_key) || null,
        quadrant: feedback.quadrant,
        applied: false,
        reason: feedback.reason,
        matchKey: feedback.matchKey,
      });
      continue;
    }

    const update = applyEdgeUpdate(weightMap, feedback.edge, feedback.delta, {
      rowKey: row && (row._key || row.gate_label_key || row.task_key) || null,
      quadrant: feedback.quadrant,
      matchKey: feedback.matchKey,
      source: 'direct',
      distance: 0,
    });
    updates.push(update);
    rowResults.push({
      rowKey: update.rowKey,
      quadrant: feedback.quadrant,
      applied: true,
      reason: null,
      matchKey: feedback.matchKey,
      edgeKey: update.key,
      expectedDirection: update.expectedDirection,
      boundedNoop: update.boundedNoop,
    });
  }

  return buildStrategyResult('direct', weightMap, updates, rowResults);
}

function applyDiffusedStrategy(rows, graphState, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const graph = normalizeGraphState(graphState);
  const contextGraph = buildContextEdgeGraph(graph);
  const weightMap = cloneWeightMap(options.initialWeights);
  const updates = [];
  const rowResults = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const feedback = feedbackForRow(row);
    if (!feedback.edge || feedback.delta === 0) {
      rowResults.push({
        rowKey: row && (row._key || row.gate_label_key || row.task_key) || null,
        quadrant: feedback.quadrant,
        applied: false,
        reason: feedback.reason,
        matchKey: feedback.matchKey,
      });
      continue;
    }

    const directUpdate = applyEdgeUpdate(weightMap, feedback.edge, feedback.delta, {
      rowKey: row && (row._key || row.gate_label_key || row.task_key) || null,
      quadrant: feedback.quadrant,
      matchKey: feedback.matchKey,
      source: 'matched',
      distance: 0,
    });
    updates.push(directUpdate);

    const nearby = nearbyContextEdges(contextGraph, feedback.edge, opts);
    for (const item of nearby) {
      const scaledDelta = feedback.delta
        * opts.diffusionScale
        * Math.pow(opts.decay, item.distance - 1)
        * item.weight;
      const update = applyEdgeUpdate(weightMap, item.edge, scaledDelta, {
        rowKey: directUpdate.rowKey,
        quadrant: feedback.quadrant,
        matchKey: feedback.matchKey,
        source: 'diffused',
        distance: item.distance,
        structuralWeight: item.weight,
      });
      updates.push(update);
    }

    rowResults.push({
      rowKey: directUpdate.rowKey,
      quadrant: feedback.quadrant,
      applied: true,
      reason: null,
      matchKey: feedback.matchKey,
      edgeKey: directUpdate.key,
      expectedDirection: directUpdate.expectedDirection,
      boundedNoop: directUpdate.boundedNoop,
      diffusedEdgeCount: nearby.length,
    });
  }

  return buildStrategyResult('diffused', weightMap, updates, rowResults);
}

function buildContextEdgeGraph(graphState) {
  const graph = normalizeGraphState(graphState);
  const edges = new Map();
  const adjacency = new Map();
  const addAdj = (nodeKey, edge) => {
    if (!adjacency.has(nodeKey)) adjacency.set(nodeKey, []);
    adjacency.get(nodeKey).push(edge);
  };

  for (const node of graph.tasks || []) {
    if (!node || !node.id) continue;
    for (const dep of node.context_deps || []) {
      if (!dep || String(dep).startsWith('ghost:')) continue;
      const weight = contextWeight(node.context_weights && node.context_weights[dep]);
      if (weight <= 0) continue;
      const canonical = retrievalWeights.canonicalEdge(node.id, dep, 'context');
      if (!canonical) continue;
      const existing = edges.get(canonical.key);
      const edge = {
        ...canonical,
        weight: existing ? Math.max(existing.weight, weight) : weight,
        judged: true,
      };
      edges.set(canonical.key, edge);
    }
  }

  for (const edge of edges.values()) {
    if (edge.judged === false || edge.weight <= 0) continue;
    addAdj(edge.from, edge);
    addAdj(edge.to, edge);
  }

  for (const list of adjacency.values()) {
    list.sort((a, b) => a.key.localeCompare(b.key));
  }

  return { edges, adjacency, taskCount: (graph.tasks || []).length };
}

function nearbyContextEdges(contextGraph, matchedEdge, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const matched = retrievalWeights.canonicalEdge(matchedEdge && matchedEdge.from, matchedEdge && matchedEdge.to, matchedEdge && matchedEdge.relation);
  if (!matched) return [];

  const maxDepth = Math.max(0, Math.floor(Number(opts.maxDepth) || 0));
  if (maxDepth <= 0) return [];

  const seeds = [matched.from, matched.to];
  const seenNodes = new Map(seeds.map((seed) => [seed, 0]));
  const queue = seeds.map((key) => ({ key, depth: 0 }));
  const byEdge = new Map();

  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (current.depth >= maxDepth) continue;
    for (const edge of contextGraph.adjacency.get(current.key) || []) {
      if (edge.key === matched.key) continue;
      const next = edge.from === current.key ? edge.to : edge.from;
      const distance = current.depth + 1;
      if (distance > maxDepth) continue;

      const existing = byEdge.get(edge.key);
      if (!existing || distance < existing.distance || (distance === existing.distance && edge.weight > existing.weight)) {
        byEdge.set(edge.key, { edge, distance, weight: edge.weight });
      }

      if (!seenNodes.has(next) || distance < seenNodes.get(next)) {
        seenNodes.set(next, distance);
        queue.push({ key: next, depth: distance });
      }
    }
  }

  return Array.from(byEdge.values())
    .sort((a, b) => (a.distance - b.distance) || a.edge.key.localeCompare(b.edge.key));
}

function buildStrategyResult(name, weightMap, updates, rowResults) {
  const changedKeys = new Set(updates.filter((u) => u && u.changed).map((u) => u.key));
  return {
    name,
    weightMap,
    updates,
    rowResults,
    metrics: {
      updatedEdgeCount: changedKeys.size,
      updateAttemptCount: updates.length,
      finalWeight: weightStats(changedKeys, weightMap),
      actualDelta: deltaStats(updates.map((u) => u.actualDelta)),
      matchedExpectedDirection: directionSummary(rowResults),
      skippedReasons: reasonCounts(rowResults),
    },
  };
}

function weightStats(keys, weightMap) {
  const values = Array.from(keys || [])
    .map((key) => weightMap.get(key))
    .filter(Boolean)
    .map((row) => row.weight);
  return numberStats(values);
}

function deltaStats(values) {
  return numberStats((values || []).filter((value) => Number.isFinite(value)));
}

function numberStats(values) {
  if (!values.length) return { count: 0, average: null, min: null, max: null };
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    average: round(sum / values.length),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
  };
}

function directionSummary(rowResults) {
  let checked = 0;
  let moved = 0;
  let boundedNoop = 0;
  for (const row of rowResults || []) {
    if (!row.applied) continue;
    checked++;
    if (row.expectedDirection) moved++;
    else if (row.boundedNoop) boundedNoop++;
  }
  return {
    checked,
    moved,
    boundedNoop,
    wrongDirection: Math.max(0, checked - moved - boundedNoop),
  };
}

function reasonCounts(rowResults) {
  const counts = {};
  for (const row of rowResults || []) {
    if (row.applied) continue;
    const reason = row.reason || 'skipped';
    counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

function rowCounts(rows) {
  const quadrants = { TP: 0, FP: 0, FN: 0, TN: 0, unknown: 0 };
  let withRecalledEdges = 0;
  let feedbackCandidates = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const quadrant = normalizeQuadrant(row) || 'unknown';
    quadrants[quadrant] = (quadrants[quadrant] || 0) + 1;
    const recalled = row && (row.recalled_context_edges || row.recalled_edges);
    if (Array.isArray(recalled) && recalled.length) withRecalledEdges++;
    if (DIRECT_DELTAS[quadrant] != null) feedbackCandidates++;
  }
  return {
    total: Array.isArray(rows) ? rows.length : 0,
    quadrants,
    withRecalledEdges,
    feedbackCandidates,
  };
}

function compareStrategies(direct, diffused) {
  const directDeltas = aggregateDeltas(direct.updates);
  const diffusedDeltas = aggregateDeltas(diffused.updates);
  const keys = new Set([...directDeltas.keys(), ...diffusedDeltas.keys()]);
  const differences = [];
  let directOnly = 0;
  let diffusedOnly = 0;
  for (const key of keys) {
    const d0 = directDeltas.get(key) || 0;
    const d1 = diffusedDeltas.get(key) || 0;
    if (d0 !== 0 && d1 === 0) directOnly++;
    if (d0 === 0 && d1 !== 0) diffusedOnly++;
    differences.push(d1 - d0);
  }
  return {
    edgeCount: keys.size,
    directOnly,
    diffusedOnly,
    deltaDifference: numberStats(differences),
    absoluteDeltaDifference: numberStats(differences.map((value) => Math.abs(value))),
  };
}

function aggregateDeltas(updates) {
  const out = new Map();
  for (const update of updates || []) {
    if (!update || !update.key) continue;
    out.set(update.key, (out.get(update.key) || 0) + update.actualDelta);
  }
  return out;
}

function runShadowBenchmark(input = {}) {
  const rows = Array.isArray(input.rows) ? input.rows : [];
  const graph = normalizeGraphState(input.graph || input.graphState || {});
  const contextGraph = buildContextEdgeGraph(graph);
  const options = { ...DEFAULT_OPTIONS, ...(input.options || {}) };
  const initialWeights = input.initialWeights instanceof Map ? input.initialWeights : new Map();
  const direct = applyDirectBaseline(rows, { initialWeights });
  const diffused = applyDiffusedStrategy(rows, graph, { ...options, initialWeights });
  const counts = rowCounts(rows);
  const warnings = [];

  if (counts.total === 0) warnings.push('No labeled gate rows were available.');
  if (counts.withRecalledEdges === 0 && counts.total > 0) {
    warnings.push('No labeled gate rows include recalled_context_edges/recalled_edges; the current live data is sparse for this benchmark.');
  }
  if (contextGraph.taskCount === 0) warnings.push('No graph task nodes were available for diffusion.');
  if (contextGraph.edges.size === 0 && contextGraph.taskCount > 0) warnings.push('No judged context edges were available for diffusion.');

  return {
    generatedAt: new Date().toISOString(),
    rows: counts,
    graph: {
      taskCount: contextGraph.taskCount,
      contextEdgeCount: contextGraph.edges.size,
    },
    options,
    warnings,
    direct,
    diffused,
    comparison: compareStrategies(direct, diffused),
  };
}

function serializableReport(report) {
  return {
    generatedAt: report.generatedAt,
    rows: report.rows,
    graph: report.graph,
    options: report.options,
    warnings: report.warnings,
    direct: report.direct.metrics,
    diffused: report.diffused.metrics,
    comparison: report.comparison,
  };
}

function renderMarkdownReport(report, meta = {}) {
  const data = serializableReport(report);
  const q = data.rows.quadrants;
  const lines = [];
  lines.push('# Diffusion Predictive Shadow Benchmark');
  lines.push('');
  lines.push(`Generated: ${data.generatedAt}`);
  if (meta.workspace) lines.push(`Workspace: \`${meta.workspace}\``);
  if (meta.graphFile) lines.push(`Graph snapshot: \`${meta.graphFile}\``);
  lines.push('');
  lines.push('This is an offline shadow run. It reads gate labels, graph state, and retrieval weights, but it does not write `.graph/retrieval-weights.jsonl` or mutate overlay edge weights.');
  lines.push('');
  lines.push('## Inputs');
  lines.push('');
  lines.push(`- Labeled rows: ${data.rows.total}`);
  lines.push(`- Quadrants: TP ${q.TP || 0}, FP ${q.FP || 0}, FN ${q.FN || 0}, TN ${q.TN || 0}, unknown ${q.unknown || 0}`);
  lines.push(`- Rows with recalled edge metadata: ${data.rows.withRecalledEdges}`);
  lines.push(`- Graph tasks: ${data.graph.taskCount}`);
  lines.push(`- Judged context edges: ${data.graph.contextEdgeCount}`);
  if (data.warnings.length) {
    lines.push('');
    lines.push('## Data Notes');
    lines.push('');
    for (const warning of data.warnings) lines.push(`- ${warning}`);
  }
  lines.push('');
  lines.push('## Strategy Metrics');
  lines.push('');
  lines.push('| Metric | Direct baseline | Diffused strategy |');
  lines.push('| --- | ---: | ---: |');
  lines.push(`| Updated edge count | ${data.direct.updatedEdgeCount} | ${data.diffused.updatedEdgeCount} |`);
  lines.push(`| Update attempts | ${data.direct.updateAttemptCount} | ${data.diffused.updateAttemptCount} |`);
  lines.push(`| Avg final updated weight | ${displayNumber(data.direct.finalWeight.average)} | ${displayNumber(data.diffused.finalWeight.average)} |`);
  lines.push(`| Min final updated weight | ${displayNumber(data.direct.finalWeight.min)} | ${displayNumber(data.diffused.finalWeight.min)} |`);
  lines.push(`| Max final updated weight | ${displayNumber(data.direct.finalWeight.max)} | ${displayNumber(data.diffused.finalWeight.max)} |`);
  lines.push(`| Avg actual delta | ${displayNumber(data.direct.actualDelta.average)} | ${displayNumber(data.diffused.actualDelta.average)} |`);
  lines.push(`| Matched edges moved expected direction | ${directionCell(data.direct.matchedExpectedDirection)} | ${directionCell(data.diffused.matchedExpectedDirection)} |`);
  lines.push('');
  lines.push('## Direct Vs Diffused Deltas');
  lines.push('');
  lines.push(`- Compared edges: ${data.comparison.edgeCount}`);
  lines.push(`- Direct-only changed edges: ${data.comparison.directOnly}`);
  lines.push(`- Diffused-only changed edges: ${data.comparison.diffusedOnly}`);
  lines.push(`- Average delta difference: ${displayNumber(data.comparison.deltaDifference.average)}`);
  lines.push(`- Average absolute delta difference: ${displayNumber(data.comparison.absoluteDeltaDifference.average)}`);
  return lines.join('\n') + '\n';
}

function directionCell(value) {
  return `${value.moved}/${value.checked}` + (value.boundedNoop ? ` (${value.boundedNoop} bounded)` : '');
}

function displayNumber(value) {
  return value == null ? 'n/a' : String(round(value));
}

function round(value) {
  return Math.round(Number(value) * 1000000) / 1000000;
}

module.exports = {
  DEFAULT_OPTIONS,
  DIRECT_DELTAS,
  readJsonl,
  readGateRows,
  loadGraphState,
  normalizeGraphState,
  feedbackForRow,
  cloneWeightMap,
  applyDirectBaseline,
  applyDiffusedStrategy,
  buildContextEdgeGraph,
  nearbyContextEdges,
  runShadowBenchmark,
  serializableReport,
  renderMarkdownReport,
};
