'use strict';

const fs = require('fs');
const path = require('path');

const JOURNAL_FILE = 'retrieval-weights.jsonl';
const DEFAULT_RETRIEVAL_WEIGHT = 1;
const MIN_RETRIEVAL_WEIGHT = 0.5;
const MAX_RETRIEVAL_WEIGHT = 1.5;
const POSITIVE_DELTA = 0.1;
const NEGATIVE_DELTA = -0.08;

function clampWeight(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_RETRIEVAL_WEIGHT;
  return Math.max(MIN_RETRIEVAL_WEIGHT, Math.min(MAX_RETRIEVAL_WEIGHT, n));
}

function normalizeRelation(relation) {
  return String(relation || 'context');
}

function canonicalEdge(from, to, relation) {
  if (!from || !to) return null;
  const a = String(from);
  const b = String(to);
  const [left, right] = a <= b ? [a, b] : [b, a];
  const edgeRelation = normalizeRelation(relation);
  return {
    from: left,
    to: right,
    relation: edgeRelation,
    key: `${edgeRelation}\0${left}\0${right}`,
  };
}

function journalPath(workspace) {
  return path.join(workspace, '.graph', JOURNAL_FILE);
}

function readRows(workspace) {
  if (!workspace) return [];
  let raw;
  try {
    raw = fs.readFileSync(journalPath(workspace), 'utf8');
  } catch {
    return [];
  }
  const rows = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const row = JSON.parse(s);
      const edge = canonicalEdge(row.from, row.to, row.relation);
      if (!edge) continue;
      rows.push({ ...row, from: edge.from, to: edge.to, relation: edge.relation, key: edge.key });
    } catch {
      // Skip torn or hand-edited rows.
    }
  }
  return rows;
}

function latestWeightMap(workspace) {
  const map = new Map();
  for (const row of readRows(workspace)) {
    const weight = clampWeight(row.weight);
    map.set(row.key, {
      from: row.from,
      to: row.to,
      relation: row.relation,
      weight,
      updatedAt: row.ts || null,
    });
  }
  return map;
}

function weightFromMap(map, from, to, relation, fallback = DEFAULT_RETRIEVAL_WEIGHT) {
  const edge = canonicalEdge(from, to, relation);
  if (!edge || !(map instanceof Map)) return fallback;
  const row = map.get(edge.key);
  return row ? clampWeight(row.weight) : fallback;
}

function getRetrievalWeight(workspace, from, to, relation, fallback = DEFAULT_RETRIEVAL_WEIGHT) {
  return weightFromMap(latestWeightMap(workspace), from, to, relation, fallback);
}

function appendRow(workspace, row) {
  if (!workspace || !row) return null;
  const edge = canonicalEdge(row.from, row.to, row.relation);
  if (!edge) return null;
  const weight = clampWeight(row.weight);
  const out = {
    ts: new Date().toISOString(),
    workspace,
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    weight,
    delta: Number.isFinite(Number(row.delta)) ? Number(row.delta) : 0,
    signal: row.signal || null,
    reason: row.reason || null,
  };
  try {
    fs.appendFileSync(journalPath(workspace), JSON.stringify(out) + '\n');
  } catch {
    return null;
  }
  return out;
}

function updateRetrievalWeight(workspace, { from, to, relation = 'context', delta = 0, signal, reason } = {}) {
  const edge = canonicalEdge(from, to, relation);
  if (!edge) return null;
  const current = getRetrievalWeight(workspace, edge.from, edge.to, edge.relation);
  const next = clampWeight(current + Number(delta || 0));
  return appendRow(workspace, {
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    weight: next,
    delta: next - current,
    signal,
    reason,
  });
}

function reinforceEdge(workspace, edge, options = {}) {
  const positive = options.positive !== false;
  const delta = Number.isFinite(Number(options.delta))
    ? Number(options.delta)
    : (positive ? POSITIVE_DELTA : NEGATIVE_DELTA);
  return updateRetrievalWeight(workspace, {
    ...edge,
    delta,
    signal: positive ? 'positive' : 'negative',
    reason: options.reason,
  });
}

module.exports = {
  JOURNAL_FILE,
  DEFAULT_RETRIEVAL_WEIGHT,
  MIN_RETRIEVAL_WEIGHT,
  MAX_RETRIEVAL_WEIGHT,
  POSITIVE_DELTA,
  NEGATIVE_DELTA,
  canonicalEdge,
  clampWeight,
  readRows,
  latestWeightMap,
  weightFromMap,
  getRetrievalWeight,
  updateRetrievalWeight,
  reinforceEdge,
};
