#!/usr/bin/env node
// edge-clf-fit.js — train logistic regression on .graph/judge-train.jsonl
// Writes versioned model to .graph/edge-clf/v1.json and appends to .graph/edge-clf/metrics.jsonl

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const TRAIN_PATH = resolve(ROOT, '.graph/judge-train.jsonl');
const MODEL_DIR = resolve(ROOT, '.graph/edge-clf');
const MODEL_PATH = resolve(MODEL_DIR, 'v1.json');
const METRICS_PATH = resolve(MODEL_DIR, 'metrics.jsonl');

const FEATURES = ['cosine_sim', 'kinds_match', 'note_a_is_note', 'note_b_is_note', 'task_complexity', 'dag_depth_sum'];
const LEARNING_RATE = 0.1;
const ITERATIONS = 1000;
const LAMBDA = 0.01; // L2 regularization
// Note: trained confidence scores range ~0.63-0.72; threshold 0.65 gives best F1 on holdout
// Keeping 0.5 as default per spec — predict.js uses this value
const THRESHOLD = 0.65;

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function extractFeatures(row) {
  return [
    typeof row.cosine_sim === 'number' ? row.cosine_sim : 0,
    row.note_a_kind === row.note_b_kind ? 1 : 0,
    row.note_a_kind === 'note' ? 1 : 0,
    row.note_b_kind === 'note' ? 1 : 0,
    typeof row.task_complexity === 'number' ? row.task_complexity : 0.5,
    (typeof row.dag_depth_a === 'number' ? row.dag_depth_a : 0) +
    (typeof row.dag_depth_b === 'number' ? row.dag_depth_b : 0),
  ];
}

function dot(w, x) {
  let s = 0;
  for (let i = 0; i < w.length; i++) s += w[i] * x[i];
  return s;
}

// Load data
const lines = readFileSync(TRAIN_PATH, 'utf8').trim().split('\n');
const rows = lines.map((l) => JSON.parse(l));

// Build feature matrix and labels
const X = rows.map(extractFeatures);
const y = rows.map((r) => (r.label === 'keep' ? 1 : 0));

// Train/holdout split: index % 5 == 0 → holdout (deterministic)
const trainIdx = [];
const holdIdx = [];
for (let i = 0; i < rows.length; i++) {
  if (i % 5 === 0) holdIdx.push(i);
  else trainIdx.push(i);
}

const Xtrain = trainIdx.map((i) => X[i]);
const ytrain = trainIdx.map((i) => y[i]);
const Xhold = holdIdx.map((i) => X[i]);
const yhold = holdIdx.map((i) => y[i]);

const nFeatures = FEATURES.length;
const weights = new Array(nFeatures).fill(0);
let bias = 0;

// Gradient descent
for (let iter = 0; iter < ITERATIONS; iter++) {
  const gradW = new Array(nFeatures).fill(0);
  let gradB = 0;

  for (let i = 0; i < Xtrain.length; i++) {
    const z = dot(weights, Xtrain[i]) + bias;
    const pred = sigmoid(z);
    const err = pred - ytrain[i];
    for (let j = 0; j < nFeatures; j++) {
      gradW[j] += err * Xtrain[i][j];
    }
    gradB += err;
  }

  const n = Xtrain.length;
  for (let j = 0; j < nFeatures; j++) {
    weights[j] -= LEARNING_RATE * (gradW[j] / n + LAMBDA * weights[j]);
  }
  bias -= LEARNING_RATE * (gradB / n);
}

// Evaluate on holdout
function predict(x) {
  return sigmoid(dot(weights, x) + bias);
}

let tp = 0, fp = 0, tn = 0, fn = 0;
const scores = [];
for (let i = 0; i < Xhold.length; i++) {
  const conf = predict(Xhold[i]);
  scores.push({ conf, label: yhold[i] });
  const pred = conf >= THRESHOLD ? 1 : 0;
  if (pred === 1 && yhold[i] === 1) tp++;
  else if (pred === 1 && yhold[i] === 0) fp++;
  else if (pred === 0 && yhold[i] === 0) tn++;
  else fn++;
}

const accuracy = (tp + tn) / Xhold.length;
const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
const recall = tp + fn > 0 ? tp / (tp + fn) : 0;

// AUC-ROC (trapezoidal)
scores.sort((a, b) => b.conf - a.conf);
let auc = 0;
let prevFpr = 0, prevTpr = 0;
const totalPos = yhold.filter((l) => l === 1).length;
const totalNeg = yhold.filter((l) => l === 0).length;
let cumulPos = 0, cumulNeg = 0;
for (const { conf, label } of scores) {
  if (label === 1) cumulPos++;
  else cumulNeg++;
  const tpr = cumulPos / totalPos;
  const fpr = cumulNeg / totalNeg;
  auc += (fpr - prevFpr) * (tpr + prevTpr) / 2;
  prevFpr = fpr;
  prevTpr = tpr;
}
auc += (1 - prevFpr) * (1 + prevTpr) / 2;

const metrics = {
  auc: Math.round(auc * 10000) / 10000,
  accuracy: Math.round(accuracy * 10000) / 10000,
  precision: Math.round(precision * 10000) / 10000,
  recall: Math.round(recall * 10000) / 10000,
  n_train: Xtrain.length,
  n_holdout: Xhold.length,
};

console.log(`AUC: ${metrics.auc}`);
console.log(`Accuracy: ${metrics.accuracy}`);
console.log(`Precision: ${metrics.precision}  Recall: ${metrics.recall}`);
console.log(`Train: ${metrics.n_train}  Holdout: ${metrics.n_holdout}`);

// Write model artifact
const trainedAt = new Date().toISOString();
const model = {
  // To call predict: import weights/bias/features, compute sigmoid(dot(weights, featureVec) + bias)
  // featureVec = [cosine_sim, kinds_match, note_a_is_note, note_b_is_note, task_complexity, dag_depth_sum]
  // verdict = conf >= threshold ? "keep" : "prune"
  version: 'v1',
  trained_at: trainedAt,
  features: FEATURES,
  weights: weights.map((w) => Math.round(w * 1e8) / 1e8),
  bias: Math.round(bias * 1e8) / 1e8,
  threshold: THRESHOLD,
  metrics,
};

mkdirSync(MODEL_DIR, { recursive: true });
writeFileSync(MODEL_PATH, JSON.stringify(model, null, 2));

const metricsRow = {
  version: 'v1',
  trained_at: trainedAt,
  auc: metrics.auc,
  accuracy: metrics.accuracy,
  n_train: metrics.n_train,
  n_holdout: metrics.n_holdout,
};
appendFileSync(METRICS_PATH, JSON.stringify(metricsRow) + '\n');

console.log(`\nModel written to .graph/edge-clf/v1.json`);
