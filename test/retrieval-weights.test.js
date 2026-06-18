#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const weights = require('../lib/search/retrieval-weights');

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
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-retrieval-weights-')));
  fs.mkdirSync(path.join(ws, '.graph'), { recursive: true });
  return ws;
}

ok('positive and negative reinforcement are bounded and persisted', () => {
  const ws = workspace();
  const edge = { from: 'task:a', to: 'note:b', relation: 'context' };

  const pos = weights.reinforceEdge(ws, edge, { positive: true, delta: 9, reason: 'test positive' });
  assert.equal(pos.weight, weights.MAX_RETRIEVAL_WEIGHT);
  assert.equal(weights.getRetrievalWeight(ws, 'note:b', 'task:a', 'context'), weights.MAX_RETRIEVAL_WEIGHT);

  const neg = weights.reinforceEdge(ws, edge, { positive: false, delta: -9, reason: 'test negative' });
  assert.equal(neg.weight, weights.MIN_RETRIEVAL_WEIGHT);

  const rows = weights.readRows(ws);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].signal, 'positive');
  assert.equal(rows[1].signal, 'negative');

  const reloaded = weights.latestWeightMap(ws);
  assert.equal(weights.weightFromMap(reloaded, 'task:a', 'note:b', 'context'), weights.MIN_RETRIEVAL_WEIGHT);
});

ok('missing and malformed journal data falls back to neutral weight', () => {
  const ws = workspace();
  fs.appendFileSync(path.join(ws, '.graph', weights.JOURNAL_FILE), 'not-json\n');
  assert.equal(weights.getRetrievalWeight(ws, 'a', 'b', 'context'), weights.DEFAULT_RETRIEVAL_WEIGHT);
  assert.equal(weights.readRows(ws).length, 0);
});

ok('small deterministic updates accumulate from neutral', () => {
  const ws = workspace();
  weights.updateRetrievalWeight(ws, { from: 'x', to: 'y', relation: 'blocking', delta: 0.1 });
  weights.updateRetrievalWeight(ws, { from: 'y', to: 'x', relation: 'blocking', delta: -0.08 });
  assert.equal(Math.round(weights.getRetrievalWeight(ws, 'x', 'y', 'blocking') * 100), 102);
});

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
