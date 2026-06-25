#!/usr/bin/env node
// ask-clf-fit.js — train a logistic-regression ask-vs-predict classifier on .graph/ask-journal.jsonl.
// Mirrors scripts/edge-clf-fit.js (features+weights+bias+threshold, deterministic index%5 holdout,
// metrics.jsonl per training). Writes the versioned model to .graph/ask-clf/v1.json.
//
// GROUND TRUTH — the realized-correct decision, NOT the heuristic's decision. A journal row carries
// the heuristic `decision` ('ask'|'predict') plus an optional `correct` boolean (was that decision the
// right one, established after the fact — predict-was-right vs should-have-asked). The label the model
// learns is "the decision that SHOULD have been made": predict→1, ask→0. See realizedLabel().
// Rows WITHOUT a `correct` field are UNLABELED and excluded from training — we never fabricate labels.
//
// SPARSE-DATA DEGRADATION: if the journal is missing, empty, or has too few LABELED rows (or only one
// class), the script writes NO model, prints a `skip` line, appends a skip row to metrics.jsonl, and
// exits 0. A consumer that finds no v1.json keeps using the heuristic — exactly the desired fallback.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const JOURNAL_PATH = process.env.ASK_JOURNAL_PATH || resolve(ROOT, '.graph/ask-journal.jsonl');
const MODEL_DIR = process.env.ASK_CLF_DIR || resolve(ROOT, '.graph/ask-clf');
const MODEL_PATH = resolve(MODEL_DIR, 'v1.json');
const METRICS_PATH = resolve(MODEL_DIR, 'metrics.jsonl');

// Feature names — drawn from the stable ask-journal schema (test/ask-gate.test.js locks it).
const FEATURES = ['top1', 'margin', 'gap', 'locality', 'tag_overlap', 'shared_tags', 'is_empirical'];
const LEARNING_RATE = 0.1;
const ITERATIONS = 1000;
const LAMBDA = 0.01; // L2 regularization
const THRESHOLD = 0.5; // conf >= threshold ⇒ predict; else ask.
const MIN_LABELED = 10; // below this we cannot train a meaningful model — degrade gracefully.

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// Map a journal row to its feature vector. Mirrors lib/ask-gate.js field names.
function extractFeatures(row) {
  return [
    typeof row.top1 === 'number' ? row.top1 : 0,
    typeof row.margin === 'number' ? row.margin : 0,
    typeof row.gap === 'number' ? row.gap : 0,
    typeof row.locality === 'number' ? row.locality : 0,
    typeof row.tagOverlap === 'number' ? row.tagOverlap : 0,
    typeof row.sharedTags === 'number' ? row.sharedTags : 0,
    row.topType === 'empirical' ? 1 : 0,
  ];
}

// The label the model learns: 1 = the right call was PREDICT, 0 = the right call was ASK.
// Derived from the heuristic decision + whether that decision was correct:
//   decision=predict & correct  → predict was right     → 1
//   decision=predict & !correct → should have asked      → 0
//   decision=ask     & correct  → ask was right          → 0
//   decision=ask     & !correct → could have predicted   → 1
// Returns null for unlabeled rows (no `correct` field) — those are excluded from training.
function realizedLabel(row) {
  if (typeof row.correct !== 'boolean') return null;
  const predicted = row.decision === 'predict';
  return (predicted === row.correct) ? 1 : 0;
}

function dot(w, x) { let s = 0; for (let i = 0; i < w.length; i++) s += w[i] * x[i]; return s; }

function writeSkip(reason, extra) {
  mkdirSync(MODEL_DIR, { recursive: true });
  const skipRow = { version: 'v1', trained_at: new Date().toISOString(), skipped: true, reason, ...extra };
  appendFileSync(METRICS_PATH, JSON.stringify(skipRow) + '\n');
  console.log(`skip: ${reason}`);
}

// ---- load --------------------------------------------------------------------------------------
if (!existsSync(JOURNAL_PATH)) {
  writeSkip('no-journal', { n_total: 0, n_labeled: 0 });
  process.exit(0);
}
const raw = readFileSync(JOURNAL_PATH, 'utf8').trim();
const rows = raw ? raw.split('\n').filter((l) => l.trim()).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean) : [];

// Keep only labeled rows; preserve journal order so the index%5 holdout split is deterministic.
const labeled = rows.filter((r) => realizedLabel(r) !== null);
if (labeled.length < MIN_LABELED) {
  writeSkip('insufficient-data', { n_total: rows.length, n_labeled: labeled.length, min: MIN_LABELED });
  process.exit(0);
}

const X = labeled.map(extractFeatures);
const y = labeled.map((r) => realizedLabel(r));

if (y.every((v) => v === y[0])) {
  writeSkip('single-class', { n_total: rows.length, n_labeled: labeled.length, class: y[0] });
  process.exit(0);
}

// Deterministic train/holdout split: index % 5 == 0 → holdout (mirror edge-clf-fit.js).
const trainIdx = [], holdIdx = [];
for (let i = 0; i < labeled.length; i++) (i % 5 === 0 ? holdIdx : trainIdx).push(i);
const Xtrain = trainIdx.map((i) => X[i]);
const ytrain = trainIdx.map((i) => y[i]);
const Xhold = holdIdx.map((i) => X[i]);
const yhold = holdIdx.map((i) => y[i]);

const nFeatures = FEATURES.length;
const weights = new Array(nFeatures).fill(0);
let bias = 0;

// Gradient descent (L2-regularized logistic regression).
for (let iter = 0; iter < ITERATIONS; iter++) {
  const gradW = new Array(nFeatures).fill(0);
  let gradB = 0;
  for (let i = 0; i < Xtrain.length; i++) {
    const err = sigmoid(dot(weights, Xtrain[i]) + bias) - ytrain[i];
    for (let j = 0; j < nFeatures; j++) gradW[j] += err * Xtrain[i][j];
    gradB += err;
  }
  const n = Xtrain.length || 1;
  for (let j = 0; j < nFeatures; j++) weights[j] -= LEARNING_RATE * (gradW[j] / n + LAMBDA * weights[j]);
  bias -= LEARNING_RATE * (gradB / n);
}

const predict = (x) => sigmoid(dot(weights, x) + bias);

// ---- evaluate on holdout -----------------------------------------------------------------------
// LEARNED accuracy: model prediction (conf>=THRESHOLD) vs realized label.
// HEURISTIC accuracy ON THE SAME ROWS: did the heuristic's own ask/predict decision match the
// realized-correct decision? heuristicDecisionLabel = (decision==='predict') ? 1 : 0. The comparator
// (T3 auto-promote) reads both numbers off metrics.jsonl to decide heuristic→learned flips.
let tp = 0, fp = 0, tn = 0, fn = 0, learnedCorrect = 0, heurCorrect = 0;
const scores = [];
for (let k = 0; k < holdIdx.length; k++) {
  const i = holdIdx[k];
  const conf = predict(Xhold[k]);
  scores.push({ conf, label: yhold[k] });
  const pred = conf >= THRESHOLD ? 1 : 0;
  if (pred === 1 && yhold[k] === 1) tp++;
  else if (pred === 1 && yhold[k] === 0) fp++;
  else if (pred === 0 && yhold[k] === 0) tn++;
  else fn++;
  if (pred === yhold[k]) learnedCorrect++;
  const heurPred = labeled[i].decision === 'predict' ? 1 : 0;
  if (heurPred === yhold[k]) heurCorrect++;
}

const accuracy = (tp + tn) / Xhold.length;
const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
const heuristic_accuracy = heurCorrect / Xhold.length;
const learned_accuracy = learnedCorrect / Xhold.length; // == accuracy; named for the comparator.

// AUC-ROC (trapezoidal) — mirror edge-clf-fit.js.
scores.sort((a, b) => b.conf - a.conf);
let auc = 0, prevFpr = 0, prevTpr = 0, cumulPos = 0, cumulNeg = 0;
const totalPos = yhold.filter((l) => l === 1).length;
const totalNeg = yhold.filter((l) => l === 0).length;
for (const { label } of scores) {
  if (label === 1) cumulPos++; else cumulNeg++;
  const tpr = totalPos ? cumulPos / totalPos : 0;
  const fpr = totalNeg ? cumulNeg / totalNeg : 0;
  auc += (fpr - prevFpr) * (tpr + prevTpr) / 2;
  prevFpr = fpr; prevTpr = tpr;
}
auc += (1 - prevFpr) * (1 + prevTpr) / 2;

const r4 = (x) => Math.round(x * 10000) / 10000;
const metrics = {
  auc: r4(auc), accuracy: r4(accuracy), precision: r4(precision), recall: r4(recall),
  heuristic_accuracy: r4(heuristic_accuracy), learned_accuracy: r4(learned_accuracy),
  n_train: Xtrain.length, n_holdout: Xhold.length,
};

console.log(`AUC: ${metrics.auc}  Accuracy: ${metrics.accuracy}`);
console.log(`Learned: ${metrics.learned_accuracy}  Heuristic: ${metrics.heuristic_accuracy} (same holdout)`);
console.log(`Train: ${metrics.n_train}  Holdout: ${metrics.n_holdout}`);

const trainedAt = new Date().toISOString();
const model = {
  // predict: featureVec = [top1, margin, gap, locality, tag_overlap, shared_tags, is_empirical]
  // conf = sigmoid(dot(weights, featureVec) + bias); decision = conf >= threshold ? "predict" : "ask"
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

appendFileSync(METRICS_PATH, JSON.stringify({
  version: 'v1', trained_at: trainedAt, auc: metrics.auc, accuracy: metrics.accuracy,
  heuristic_accuracy: metrics.heuristic_accuracy, learned_accuracy: metrics.learned_accuracy,
  n_train: metrics.n_train, n_holdout: metrics.n_holdout,
}) + '\n');

console.log(`\nModel written to .graph/ask-clf/v1.json`);
