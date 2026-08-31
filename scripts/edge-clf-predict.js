'use strict';
// edge-clf-predict.js — load latest edge classifier model and export predict()
// CommonJS version (lib/judge.js uses CJS require).
// predict({cosine_sim, note_a_kind, note_b_kind, task_complexity, dag_depth_a, dag_depth_b})
//   → { verdict: "keep"|"prune", conf: 0-1 }

const fs = require('fs');
const path = require('path');

// Model resolution order:
//   1. .graph/edge-clf/v1.json — the LOCALLY TRAINED model written by scripts/edge-clf-fit.js.
//   2. data/edge-clf/v1.json   — the SHIPPED BASELINE checked into the repo.
// The baseline exists because .graph/ became a git submodule (commit 7c79654 "move graph history to
// submodule"), which swept the only copy of the trained artifact out of the superproject. Without a
// tracked fallback the module still `require`s fine (predict is exported) but every predict() call
// throws ENOENT, so lib/judge.shadowFields silently degraded to a no-op and the shadow-run feature
// was dead in a fresh checkout. Keep the baseline tracked; a freshly fitted model still wins.
const MODEL_PATHS = [
  path.resolve(__dirname, '..', '.graph/edge-clf/v1.json'),
  path.resolve(__dirname, '..', 'data/edge-clf/v1.json'),
];

let _model = null;

function loadModel() {
  if (_model) return _model;
  let lastErr = null;
  for (const p of MODEL_PATHS) {
    try {
      _model = JSON.parse(fs.readFileSync(p, 'utf8'));
      return _model;
    } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('edge-clf: no model found');
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

/**
 * Predict whether a note-to-node edge should be kept or pruned.
 * @param {object} params
 * @param {number} params.cosine_sim - cosine similarity [0,1]
 * @param {string} params.note_a_kind - kind of node A (e.g. "note", "task")
 * @param {string} params.note_b_kind - kind of node B
 * @param {number} [params.task_complexity=0.5] - task complexity [0,1]
 * @param {number} [params.dag_depth_a=0] - DAG depth of node A
 * @param {number} [params.dag_depth_b=0] - DAG depth of node B
 * @returns {{ verdict: "keep"|"prune", conf: number }}
 */
function predict({ cosine_sim, note_a_kind, note_b_kind, task_complexity, dag_depth_a, dag_depth_b }) {
  const model = loadModel();
  const { weights, bias, threshold } = model;

  const featureVec = [
    typeof cosine_sim === 'number' ? cosine_sim : 0,
    note_a_kind === note_b_kind ? 1 : 0,
    note_a_kind === 'note' ? 1 : 0,
    note_b_kind === 'note' ? 1 : 0,
    typeof task_complexity === 'number' ? task_complexity : 0.5,
    (typeof dag_depth_a === 'number' ? dag_depth_a : 0) +
    (typeof dag_depth_b === 'number' ? dag_depth_b : 0),
  ];

  let z = bias;
  for (let i = 0; i < weights.length; i++) z += weights[i] * featureVec[i];
  const conf = sigmoid(z);
  const verdict = conf >= threshold ? 'keep' : 'prune';
  return { verdict, conf };
}

module.exports = { predict };
