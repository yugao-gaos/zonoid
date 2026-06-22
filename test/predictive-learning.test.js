#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const predictiveLearning = require('../lib/search/predictive-learning');
const retrievalWeights = require('../lib/search/retrieval-weights');

let pass = 0;
let fail = 0;
const ok = (label, fn) => {
  try {
    fn();
    console.log(`PASS  ${label}`);
    pass++;
  } catch (err) {
    console.log(`FAIL  ${label}`);
    console.error(err && err.stack ? err.stack : err);
    fail++;
  }
};

function workspace() {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-predictive-learning-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

function edge(taskKey, resultKey, extra = {}) {
  return {
    from: taskKey,
    to: resultKey,
    relation: 'context',
    result_key: resultKey,
    result_kind: resultKey.startsWith('note:') ? 'note' : 'task',
    direct: true,
    ...extra,
  };
}

function row(overrides = {}) {
  return {
    _key: 'row-key',
    workspace: null,
    task_key: 'task/a',
    query: 'query',
    decision: 'inject',
    topKey: 'note:a',
    top1: 0.8,
    quadrant: 'TP',
    label: 1,
    recalled_context_edges: [edge('task/a', 'note:a')],
    ...overrides,
  };
}

ok('TP appends a normalized event and positive retrieval feedback', () => {
  const ws = workspace();
  const event = predictiveLearning.applyGateLabel(ws, row({ workspace: ws }));
  const rows = predictiveLearning.readRows(ws);

  assert.equal(event.error_code, 'GATE_TP');
  assert.equal(event.predicted, 1);
  assert.equal(event.actual, 1);
  assert.equal(event.prediction_error, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].error_code, 'GATE_TP');
  assert.equal(rows[0].retrieval_feedback.applied, true);
  assert.equal(retrievalWeights.readRows(ws).length, 1);
  assert.equal(Math.round(retrievalWeights.getRetrievalWeight(ws, 'task/a', 'note:a', 'context') * 100), 110);
});

ok('FP accepts recalled_edges compatibility and applies negative feedback', () => {
  const ws = workspace();
  const event = predictiveLearning.applyGateLabel(ws, row({
    workspace: ws,
    quadrant: 'FP',
    label: 0,
    decision: 'inject',
    recalled_context_edges: undefined,
    recalled_edges: [edge('task/a', 'note:a')],
  }));

  assert.equal(event.error_code, 'GATE_FP');
  assert.equal(event.prediction_error, -1);
  assert.equal(event.retrieval_feedback.signal, 'negative');
  assert.equal(retrievalWeights.readRows(ws).length, 1);
  assert.equal(Math.round(retrievalWeights.getRetrievalWeight(ws, 'task/a', 'note:a', 'context') * 100), 92);
});

ok('TN journals but does not mutate retrieval weights', () => {
  const ws = workspace();
  const event = predictiveLearning.applyGateLabel(ws, row({
    workspace: ws,
    quadrant: 'TN',
    label: 0,
    decision: 'abstain',
    topKey: null,
    recalled_context_edges: [edge('task/a', 'note:a')],
  }));

  assert.equal(event.error_code, 'GATE_TN');
  assert.equal(event.prediction_error, 0);
  assert.equal(event.retrieval_feedback.applied, false);
  assert.equal(event.retrieval_feedback.reason, 'tn-noop');
  assert.equal(predictiveLearning.readRows(ws).length, 1);
  assert.equal(retrievalWeights.readRows(ws).length, 0);
});

ok('feedback requires a direct edge matching the top key', () => {
  const ws = workspace();
  const event = predictiveLearning.applyGateLabel(ws, row({
    workspace: ws,
    recalled_context_edges: [edge('task/a', 'note:other')],
  }));

  assert.equal(event.retrieval_feedback.applied, false);
  assert.equal(event.retrieval_feedback.reason, 'no-direct-matching-edge');
  assert.equal(predictiveLearning.readRows(ws).length, 1);
  assert.equal(retrievalWeights.readRows(ws).length, 0);
});

ok('feedback does not match the edge source task as the result key', () => {
  const ws = workspace();
  const event = predictiveLearning.applyGateLabel(ws, row({
    workspace: ws,
    topKey: 'task/a',
    recalled_context_edges: [edge('task/a', 'note:other')],
  }));

  assert.equal(event.retrieval_feedback.applied, false);
  assert.equal(event.retrieval_feedback.reason, 'no-direct-matching-edge');
  assert.equal(retrievalWeights.readRows(ws).length, 0);
});

ok('FN uses fn_top_key for positive retrieval feedback', () => {
  const ws = workspace();
  const event = predictiveLearning.applyGateLabel(ws, row({
    workspace: ws,
    quadrant: 'FN',
    label: 1,
    decision: 'abstain',
    topKey: null,
    fn_top_key: 'note:a',
    fn_top_score: 0.72,
    recalled_context_edges: [edge('task/a', 'note:a')],
  }));

  assert.equal(event.error_code, 'GATE_FN');
  assert.equal(event.prediction_error, 1);
  assert.equal(event.match_key, 'note:a');
  assert.equal(event.fn_top_score, 0.72);
  assert.equal(event.retrieval_feedback.signal, 'positive');
  assert.equal(retrievalWeights.readRows(ws).length, 1);
});

ok('retrieval-weight failures are fail-open', () => {
  const ws = workspace();
  const original = retrievalWeights.reinforceEdge;
  retrievalWeights.reinforceEdge = () => { throw new Error('weight boom'); };
  try {
    const event = predictiveLearning.applyGateLabel(ws, row({ workspace: ws }));
    assert.equal(event.retrieval_feedback.applied, false);
    assert.equal(event.retrieval_feedback.reason, 'retrieval-weight-write-failed');
    assert.equal(predictiveLearning.readRows(ws).length, 1);
  } finally {
    retrievalWeights.reinforceEdge = original;
  }
});

ok('predictive journal failures are fail-open', () => {
  const ws = workspace();
  const original = fs.appendFileSync;
  fs.appendFileSync = (file, ...args) => {
    if (String(file).endsWith(predictiveLearning.JOURNAL_FILE)) throw new Error('journal boom');
    return original.call(fs, file, ...args);
  };
  try {
    const event = predictiveLearning.applyGateLabel(ws, row({
      workspace: ws,
      quadrant: 'TN',
      label: 0,
      decision: 'abstain',
      topKey: null,
    }));
    assert.equal(event.journaled, false);
  } finally {
    fs.appendFileSync = original;
  }
});

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
