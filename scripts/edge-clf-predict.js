'use strict';
// edge-clf-predict.js — load latest edge classifier model and export predict()
// CommonJS version (lib/judge.js uses CJS require).
// predict({cosine_sim, note_a_kind, note_b_kind, task_complexity, dag_depth_a, dag_depth_b})
//   → { verdict: "keep"|"prune", conf: 0-1 }

const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.resolve(__dirname, '..', '.graph/edge-clf/v1.json');

let _model = null;

function loadModel() {
  if (_model) return _model;
  _model = JSON.parse(fs.readFileSync(MODEL_PATH, 'utf8'));
  return _model;
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
