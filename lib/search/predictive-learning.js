'use strict';

const fs = require('fs');
const path = require('path');
const recallJournal = require('../recall-outcome-journal');
const retrievalWeights = require('./retrieval-weights');

const JOURNAL_FILE = 'predictive-learning.jsonl';
const ERROR_CODES = {
  TP: 'GATE_TP',
  FP: 'GATE_FP',
  FN: 'GATE_FN',
  TN: 'GATE_TN',
};

const POSITIVE_CODES = new Set(['GATE_TP', 'GATE_FN']);
const NEGATIVE_CODES = new Set(['GATE_FP']);

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
    try { rows.push(JSON.parse(s)); } catch { /* skip torn rows */ }
  }
  return rows;
}

function appendEvent(workspace, event) {
  if (!workspace || !event) return false;
  try {
    fs.mkdirSync(path.dirname(journalPath(workspace)), { recursive: true });
    fs.appendFileSync(journalPath(workspace), JSON.stringify(event) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

function normalizeQuadrant(row) {
  const quadrant = String(row && row.quadrant || '').toUpperCase();
  return Object.prototype.hasOwnProperty.call(ERROR_CODES, quadrant) ? quadrant : null;
}

function predictionForDecision(decision) {
  if (decision === 'inject') return 1;
  if (decision === 'abstain') return 0;
  return null;
}

function labelValue(row) {
  const n = Number(row && row.label);
  return n === 0 || n === 1 ? n : null;
}

function matchKeyFor(row, quadrant) {
  if (!row) return null;
  if (quadrant === 'FN') return row.fn_top_key || row.topKey || null;
  return row.topKey || null;
}

function eventFromGateLabel(row, options = {}) {
  if (!row || typeof row !== 'object') return null;
  const quadrant = normalizeQuadrant(row);
  const errorCode = quadrant ? ERROR_CODES[quadrant] : 'GATE_UNKNOWN';
  const predicted = predictionForDecision(row.decision);
  const actual = labelValue(row);
  const predictionError = predicted == null || actual == null ? null : actual - predicted;
  const matchKey = matchKeyFor(row, quadrant);

  return {
    ts: new Date().toISOString(),
    workspace: row.workspace || options.workspace || null,
    source: 'gate-label',
    gate_label_key: row._key || null,
    task_key: row.task_key || null,
    query: row.query || '',
    error_code: errorCode,
    quadrant: quadrant || null,
    decision: row.decision || null,
    predicted,
    actual,
    prediction_error: predictionError,
    label: actual,
    top_key: row.topKey || null,
    top_score: typeof row.top1 === 'number' ? row.top1 : null,
    fn_top_key: row.fn_top_key || null,
    fn_top_score: typeof row.fn_top_score === 'number' ? row.fn_top_score : null,
    match_key: matchKey,
  };
}

function edgeMatchesKey(edge, key) {
  if (!edge || !key) return false;
  return edge.result_key === key || edge.to === key;
}

function feedbackEdgeFor(row, matchKey) {
  const edges = recallJournal.recalledContextEdges(row);
  for (const edge of edges) {
    if (edge.relation !== 'context') continue;
    if (edge.direct === false) continue;
    if (edge.result_kind && edge.result_kind !== 'note' && edge.result_kind !== 'task') continue;
    if (!edgeMatchesKey(edge, matchKey)) continue;
    const canonical = retrievalWeights.canonicalEdge(edge.from, edge.to, edge.relation);
    if (canonical) return canonical;
  }
  return null;
}

function retrievalSignal(errorCode) {
  if (POSITIVE_CODES.has(errorCode)) return { positive: true, signal: 'positive' };
  if (NEGATIVE_CODES.has(errorCode)) return { positive: false, signal: 'negative' };
  return null;
}

function applyRetrievalFeedback(workspace, row, event) {
  const signal = retrievalSignal(event.error_code);
  if (!signal) return { applied: false, reason: event.error_code === 'GATE_TN' ? 'tn-noop' : 'no-feedback-signal' };
  if (!event.match_key) return { applied: false, reason: 'missing-match-key', signal: signal.signal };

  const edge = feedbackEdgeFor(row, event.match_key);
  if (!edge) return { applied: false, reason: 'no-direct-matching-edge', signal: signal.signal };

  try {
    const updated = retrievalWeights.reinforceEdge(workspace, edge, {
      positive: signal.positive,
      reason: `predictive-learning:${event.error_code}:${event.gate_label_key || event.task_key || 'unknown'}`,
    });
    if (!updated) return { applied: false, reason: 'retrieval-weight-write-skipped', signal: signal.signal, edge };
    return {
      applied: true,
      signal: signal.signal,
      edge: { from: edge.from, to: edge.to, relation: edge.relation },
      weight: updated.weight,
      delta: updated.delta,
    };
  } catch (err) {
    return {
      applied: false,
      reason: 'retrieval-weight-write-failed',
      signal: signal.signal,
      edge,
      error: err && err.message ? err.message : String(err),
    };
  }
}

function applyGateLabel(workspace, row) {
  try {
    const event = eventFromGateLabel(row, { workspace });
    if (!event) return null;
    event.retrieval_feedback = applyRetrievalFeedback(workspace, row, event);
    event.journaled = appendEvent(workspace, event);
    return event;
  } catch {
    return null;
  }
}

module.exports = {
  JOURNAL_FILE,
  ERROR_CODES,
  journalPath,
  readRows,
  eventFromGateLabel,
  feedbackEdgeFor,
  applyGateLabel,
};
