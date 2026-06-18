#!/usr/bin/env node
'use strict';
// predict-edge-classifier.js — load edge-classifier-v1.json and score an edge
//
// Library usage:
//   const { predictEdge } = require('./predict-edge-classifier');
//   const result = predictEdge({ cosine_score, from_kind, to_kind,
//                                neighborhood_size, neighborhood_avg_relevance });
//   // → { score: 0.73, label: 1 }
//
// CLI usage:
//   node scripts/predict-edge-classifier.js \
//     --cosine 0.75 --from_kind note --to_kind task \
//     --neighborhood_size 5 --neighborhood_avg_relevance 0.3
//
//   Optional: --workspace <path>  (default: D:/zonoid)
//             --supersede_chain_len <int>  (default 0)
//             --task_task <bool>  (default false)

const fs = require('fs');
const path = require('path');

// ---- feature encoding (must mirror fit-edge-classifier.js) ----------------
const KIND_MAP = { note: 0, task: 1, followup: 2, bench: 3 };
const NUM_KINDS = 4;
const KIND_NAMES = Object.keys(KIND_MAP).sort((a, b) => KIND_MAP[a] - KIND_MAP[b]);

function extractFeatures(row, normalization) {
  const fromOneHot = new Array(NUM_KINDS).fill(0);
  const toOneHot = new Array(NUM_KINDS).fill(0);
  const fi = KIND_MAP[row.from_kind];
  const ti = KIND_MAP[row.to_kind];
  if (fi !== undefined) fromOneHot[fi] = 1;
  if (ti !== undefined) toOneHot[ti] = 1;
  const nsMax = (normalization && normalization.neighborhood_size_max) || 1;

  return [
    typeof row.cosine_score === 'number' ? row.cosine_score : 0,
    ...fromOneHot,
    ...toOneHot,
    typeof row.neighborhood_size === 'number' ? row.neighborhood_size / nsMax : 0,
    typeof row.neighborhood_avg_relevance === 'number' ? row.neighborhood_avg_relevance : 0,
    typeof row.supersede_chain_len === 'number' ? row.supersede_chain_len : 0,
    row.task_task ? 1 : 0,
  ];
}

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

// ---- model loader ---------------------------------------------------------
let _model = null;
let _modelPath = null;

function loadModel(workspaceRoot) {
  const mp = path.join(workspaceRoot || path.resolve(__dirname, '..'), 'models', 'edge-classifier-v1.json');
  if (_model && _modelPath === mp) return _model;
  _model = JSON.parse(fs.readFileSync(mp, 'utf8'));
  _modelPath = mp;
  return _model;
}

// ---- public API -----------------------------------------------------------

/**
 * Predict whether a graph edge should be kept or pruned.
 *
 * @param {object} features
 * @param {number}  features.cosine_score            - cosine similarity [0,1]
 * @param {string}  features.from_kind               - "note"|"task"|"followup"|"bench"
 * @param {string}  features.to_kind                 - "note"|"task"|"followup"|"bench"
 * @param {number}  [features.neighborhood_size=0]   - kbCands count
 * @param {number}  [features.neighborhood_avg_relevance=0] - empTop10 average
 * @param {number}  [features.supersede_chain_len=0] - supersede chain length
 * @param {boolean} [features.task_task=false]        - both nodes are tasks
 * @param {string}  [workspaceRoot]                  - override model path root
 * @returns {{ score: number, label: 0|1 }}
 */
function predictEdge(features, workspaceRoot) {
  const model = loadModel(workspaceRoot);
  const { weights, bias, threshold, normalization } = model;
  const fv = extractFeatures(features, normalization);
  let z = bias;
  for (let i = 0; i < weights.length; i++) z += weights[i] * fv[i];
  const score = sigmoid(z);
  const label = score >= threshold ? 1 : 0;
  return { score, label };
}

module.exports = { predictEdge, loadModel };

// ---- CLI ------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);

  function getArg(name, defaultVal) {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : defaultVal;
  }

  const workspace = getArg('workspace', 'D:/zonoid');
  const cosineRaw = getArg('cosine', null);
  const from_kind = getArg('from_kind', null);
  const to_kind = getArg('to_kind', null);
  const neighborhood_size = parseFloat(getArg('neighborhood_size', '0'));
  const neighborhood_avg_relevance = parseFloat(getArg('neighborhood_avg_relevance', '0'));
  const supersede_chain_len = parseInt(getArg('supersede_chain_len', '0'), 10);
  const task_task_raw = getArg('task_task', 'false');
  const task_task = task_task_raw === 'true' || task_task_raw === '1';

  if (cosineRaw === null || from_kind === null || to_kind === null) {
    console.error('Usage: node predict-edge-classifier.js --cosine <float> --from_kind <kind> --to_kind <kind>');
    console.error('  Optional: --neighborhood_size <int> --neighborhood_avg_relevance <float>');
    console.error('            --supersede_chain_len <int> --task_task <bool> --workspace <path>');
    console.error(`  Kinds: ${KIND_NAMES.join('|')}`);
    process.exit(1);
  }

  const cosine_score = parseFloat(cosineRaw);
  const features = { cosine_score, from_kind, to_kind, neighborhood_size, neighborhood_avg_relevance, supersede_chain_len, task_task };

  const { score, label } = predictEdge(features, workspace);
  console.log(JSON.stringify({ score: Math.round(score * 1e6) / 1e6, label, verdict: label === 1 ? 'keep' : 'prune' }, null, 2));
}
