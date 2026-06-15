'use strict';
// ask-clf-predict.js — load the latest ask classifier model and export predict().
// CommonJS (lib/ask-gate.js is CJS). Mirrors scripts/edge-clf-predict.js.
//
// predict({ top1, margin, gap, locality, tagOverlap, sharedTags, topType })
//   → { decision: "predict"|"ask", conf: 0-1 }
//
// loadModel() returns null (not throw) when no model artifact exists — the ask-clf-fit script
// degrades to writing no model on sparse data, and a missing model means "stay on the heuristic".

const fs = require('fs');
const path = require('path');

const MODEL_PATH = process.env.ASK_CLF_MODEL_PATH || path.resolve(__dirname, '..', '.graph/ask-clf/v1.json');

let _model;
function loadModel(modelPath = MODEL_PATH) {
  if (_model !== undefined && modelPath === MODEL_PATH) return _model;
  let m = null;
  try { m = JSON.parse(fs.readFileSync(modelPath, 'utf8')); } catch { m = null; }
  if (modelPath === MODEL_PATH) _model = m;
  return m;
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// Map gate fields → the model's feature vector (must match ask-clf-fit.js FEATURES order).
function featureVec(f) {
  return [
    typeof f.top1 === 'number' ? f.top1 : 0,
    typeof f.margin === 'number' ? f.margin : 0,
    typeof f.gap === 'number' ? f.gap : 0,
    typeof f.locality === 'number' ? f.locality : 0,
    typeof f.tagOverlap === 'number' ? f.tagOverlap : 0,
    typeof f.sharedTags === 'number' ? f.sharedTags : 0,
    f.topType === 'empirical' ? 1 : 0,
  ];
}

/**
 * Predict ASK vs PREDICT from gate features. Returns null if no model is available
 * (caller falls back to the heuristic).
 * @returns {{ decision: "predict"|"ask", conf: number } | null}
 */
function predict(features, modelPath) {
  const model = loadModel(modelPath);
  if (!model) return null;
  const { weights, bias, threshold } = model;
  const x = featureVec(features || {});
  let z = bias;
  for (let i = 0; i < weights.length; i++) z += weights[i] * x[i];
  const conf = sigmoid(z);
  return { decision: conf >= threshold ? 'predict' : 'ask', conf };
}

module.exports = { predict, loadModel };
