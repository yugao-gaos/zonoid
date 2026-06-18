#!/usr/bin/env node
'use strict';
// fit-edge-classifier.js — train logistic regression on data/judge-train.jsonl
// Writes versioned model to models/edge-classifier-v1.json
//
// Features (13 total):
//   cosine_score, from_kind[4-hot], to_kind[4-hot], neighborhood_size,
//   neighborhood_avg_relevance, supersede_chain_len, task_task
//
// Class weights: { 0: 1.0, 1: 8.5 } (inverse-frequency, ~51 prune / 7 keep)
// LR: 0.1, iterations: 1000, L2 lambda: 0.01
//
// Usage: node scripts/fit-edge-classifier.js [--workspace <path>]

const fs = require('fs');
const path = require('path');

// ---- config ---------------------------------------------------------------
const args = process.argv.slice(2);
let workspaceArg = 'D:/zonoid';
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--workspace' && args[i + 1]) workspaceArg = args[i + 1];
}
const ROOT = path.resolve(workspaceArg);
const TRAIN_PATH = path.join(ROOT, 'data', 'judge-train.jsonl');
const MODEL_DIR = path.join(ROOT, 'models');
const MODEL_PATH = path.join(MODEL_DIR, 'edge-classifier-v1.json');

const LEARNING_RATE = 0.1;
const ITERATIONS = 1000;
const LAMBDA = 0.01;
const THRESHOLD = 0.5;
const CLASS_WEIGHT = { 0: 1.0, 1: 8.5 };

// Ordinal map for one-hot encoding
const KIND_MAP = { note: 0, task: 1, followup: 2, bench: 3 };
const NUM_KINDS = 4;

// ---- feature names --------------------------------------------------------
const KIND_NAMES = Object.keys(KIND_MAP).sort((a, b) => KIND_MAP[a] - KIND_MAP[b]);
const FEATURE_NAMES = [
  'cosine_score',
  ...KIND_NAMES.map((k) => `from_kind_${k}`),
  ...KIND_NAMES.map((k) => `to_kind_${k}`),
  'neighborhood_size',
  'neighborhood_avg_relevance',
  'supersede_chain_len',
  'task_task',
];
const N_FEATURES = FEATURE_NAMES.length; // 1 + 4 + 4 + 1 + 1 + 1 + 1 = 13

// ---- load data ------------------------------------------------------------
const raw = fs.readFileSync(TRAIN_PATH, 'utf8').trim().split('\n');
const rows = raw.map((l) => JSON.parse(l));
const N = rows.length;

// Normalize neighborhood_size by max seen in training data (avoids sigmoid saturation).
// The max is stored in the model artifact so predict.js uses the same scale.
const MAX_NEIGHBORHOOD_SIZE = Math.max(...rows.map((r) => r.neighborhood_size || 0)) || 1;

function extractFeatures(row) {
  const fromOneHot = new Array(NUM_KINDS).fill(0);
  const toOneHot = new Array(NUM_KINDS).fill(0);
  const fi = KIND_MAP[row.from_kind];
  const ti = KIND_MAP[row.to_kind];
  if (fi !== undefined) fromOneHot[fi] = 1;
  if (ti !== undefined) toOneHot[ti] = 1;

  return [
    typeof row.cosine_score === 'number' ? row.cosine_score : 0,
    ...fromOneHot,
    ...toOneHot,
    typeof row.neighborhood_size === 'number' ? row.neighborhood_size / MAX_NEIGHBORHOOD_SIZE : 0,
    typeof row.neighborhood_avg_relevance === 'number' ? row.neighborhood_avg_relevance : 0,
    typeof row.supersede_chain_len === 'number' ? row.supersede_chain_len : 0,
    row.task_task ? 1 : 0,
  ];
}

const X = rows.map(extractFeatures);
const y = rows.map((r) => r.verdict === 1 ? 1 : 0);

// ---- helper functions -----------------------------------------------------
function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function dot(w, x) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

// ---- train ----------------------------------------------------------------
const weights = new Array(N_FEATURES).fill(0);
let bias = 0;

let finalLoss = 0;
for (let iter = 0; iter < ITERATIONS; iter++) {
  const gradW = new Array(N_FEATURES).fill(0);
  let gradB = 0;
  let loss = 0;

  for (let i = 0; i < N; i++) {
    const z = dot(weights, X[i]) + bias;
    const pred = sigmoid(z);
    const label = y[i];
    const cw = CLASS_WEIGHT[label] || 1.0;
    const err = pred - label;

    // Weighted gradient
    for (let j = 0; j < N_FEATURES; j++) {
      gradW[j] += cw * err * X[i][j];
    }
    gradB += cw * err;

    // Weighted binary cross-entropy loss
    const eps = 1e-12;
    loss += -cw * (label * Math.log(pred + eps) + (1 - label) * Math.log(1 - pred + eps));
  }

  // Average gradient + L2 on weights
  for (let j = 0; j < N_FEATURES; j++) {
    weights[j] -= LEARNING_RATE * (gradW[j] / N + LAMBDA * weights[j]);
  }
  bias -= LEARNING_RATE * (gradB / N);

  if (iter === ITERATIONS - 1) finalLoss = loss / N;
}

// ---- evaluate on full training set ----------------------------------------
let tp = 0, fp = 0, tn = 0, fn = 0;
for (let i = 0; i < N; i++) {
  const conf = sigmoid(dot(weights, X[i]) + bias);
  const pred = conf >= THRESHOLD ? 1 : 0;
  if (pred === 1 && y[i] === 1) tp++;
  else if (pred === 1 && y[i] === 0) fp++;
  else if (pred === 0 && y[i] === 0) tn++;
  else fn++;
}

const accuracy = (tp + tn) / N;
const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

const r4 = (x) => Math.round(x * 10000) / 10000;
const train_metrics = {
  precision: r4(precision),
  recall: r4(recall),
  f1: r4(f1),
  accuracy: r4(accuracy),
};

// ---- print report ---------------------------------------------------------
console.log(`Edge Classifier v1 — Training Report`);
console.log(`=====================================`);
console.log(`Samples: ${N}  Features: ${N_FEATURES}`);
console.log(`Class dist: keep=${y.filter((v) => v === 1).length}  prune=${y.filter((v) => v === 0).length}`);
console.log(`Final weighted loss: ${finalLoss.toFixed(6)}`);
console.log(`Train metrics (threshold=${THRESHOLD}):`);
console.log(`  Accuracy : ${train_metrics.accuracy}`);
console.log(`  Precision: ${train_metrics.precision}`);
console.log(`  Recall   : ${train_metrics.recall}`);
console.log(`  F1       : ${train_metrics.f1}`);
console.log(`Confusion matrix: TP=${tp} FP=${fp} TN=${tn} FN=${fn}`);
console.log(`Top feature weights (|w|):`);
const wSorted = FEATURE_NAMES.map((name, i) => ({ name, w: weights[i] }))
  .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
  .slice(0, 5);
for (const { name, w } of wSorted) {
  console.log(`  ${name.padEnd(30)} ${w >= 0 ? '+' : ''}${w.toFixed(6)}`);
}

// ---- write model artifact -------------------------------------------------
fs.mkdirSync(MODEL_DIR, { recursive: true });
const model = {
  version: '1.0.0',
  trained_at: new Date().toISOString(),
  n_samples: N,
  n_features: N_FEATURES,
  feature_names: FEATURE_NAMES,
  weights: weights.map((w) => Math.round(w * 1e8) / 1e8),
  bias: Math.round(bias * 1e8) / 1e8,
  class_weight: CLASS_WEIGHT,
  threshold: THRESHOLD,
  normalization: {
    neighborhood_size_max: MAX_NEIGHBORHOOD_SIZE,
  },
  train_metrics,
};
fs.writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2));
console.log(`\nModel written to: ${MODEL_PATH}`);
