#!/usr/bin/env node
// bench/judge-edge/run.js
//
// Scores the judge's edge keep/prune logic against a labeled eval set.
//
// The actual judge is an LLM agent; this bench uses the same SIGNALS the
// agent is given (cosine similarity + content) to approximate its decision
// with a deterministic classifier so the eval is reproducible without live
// API calls. The classifier is intentionally simple:
//
//   Rule 1: cosine >= HIGH_THRESHOLD → keep  (strong signal)
//   Rule 2: cosine <  LOW_THRESHOLD  → prune (too distant)
//   Rule 3: mid-band → keyword overlap heuristic between note and task text
//
// Baseline metrics are recorded in scorecard.md.
// Regression thresholds: precision >= 0.80, recall >= 0.75.
//
// Usage:
//   node bench/judge-edge/run.js [--eval-set path/to/eval-set.json] [--json]
//
'use strict';

const fs   = require('fs');
const path = require('path');

// ── classifier knobs ─────────────────────────────────────────────────────────
const HIGH_THRESHOLD = 0.65; // cosine >= this → keep
const LOW_THRESHOLD  = 0.35; // cosine <  this → prune
// mid-band: use keyword overlap; keep if jaccard >= OVERLAP_THRESHOLD
const OVERLAP_THRESHOLD = 0.06;

// Tokenise a string into a lowercased word-token bag (drops punctuation,
// short tokens, and stop words). Used for the mid-band overlap heuristic.
const STOP = new Set([
  'the','a','an','and','or','of','to','in','is','it','this','that','for',
  'with','on','are','was','be','as','by','at','from','not','have','has',
  'but','so','if','its','into','can','will','new','when','via','no','any',
]);
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

function jaccard(a, b) {
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

// Main classifier: returns true (keep) or false (prune).
function classify(pair) {
  const { cosine, note_title, note_summary, task_title } = pair;

  // Fast high/low bands
  if (cosine >= HIGH_THRESHOLD) return true;
  if (cosine < LOW_THRESHOLD)  return false;

  // Mid-band: keyword overlap between (note_title + note_summary) and task_title
  const noteTokens  = tokenize((note_title || '') + ' ' + (note_summary || ''));
  const taskTokens  = tokenize(task_title || '');
  const j = jaccard(noteTokens, taskTokens);
  return j >= OVERLAP_THRESHOLD;
}

// ── metrics ───────────────────────────────────────────────────────────────────
function computeMetrics(results) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of results) {
    const pred = r.predicted;
    const label = r.should_wire;
    if (pred && label)   tp++;
    else if (pred && !label) fp++;
    else if (!pred && label) fn++;
    else                     tn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall    = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  const accuracy  = results.length === 0 ? 0 : (tp + tn) / results.length;
  return { tp, fp, fn, tn, precision, recall, f1, accuracy };
}

// ── main ─────────────────────────────────────────────────────────────────────
function main() {
  const args    = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const evalIdx = args.indexOf('--eval-set');
  const evalPath = evalIdx >= 0
    ? args[evalIdx + 1]
    : path.join(__dirname, 'eval-set.json');

  if (!fs.existsSync(evalPath)) {
    console.error(`eval-set not found: ${evalPath}`);
    process.exit(1);
  }

  const evalSet = JSON.parse(fs.readFileSync(evalPath, 'utf8'));

  const results = evalSet.map((pair) => ({
    note_key:    pair.note_key,
    task_key:    pair.task_key,
    note_title:  pair.note_title,
    task_title:  pair.task_title,
    cosine:      pair.cosine,
    should_wire: pair.should_wire,
    predicted:   classify(pair),
    correct:     classify(pair) === pair.should_wire,
    reason:      pair.reason,
  }));

  const m = computeMetrics(results);
  const PREC_THRESHOLD = 0.80;
  const REC_THRESHOLD  = 0.75;
  const pass = m.precision >= PREC_THRESHOLD && m.recall >= REC_THRESHOLD;

  if (jsonOut) {
    console.log(JSON.stringify({ metrics: m, results, pass }, null, 2));
    return;
  }

  // ── human-readable output ─────────────────────────────────────────────────
  const fmt = (n) => (n * 100).toFixed(1) + '%';
  console.log('');
  console.log('Judge Edge Quality Bench');
  console.log('========================');
  console.log(`Eval set: ${evalSet.length} pairs  (${results.filter(r=>r.should_wire).length} keep / ${results.filter(r=>!r.should_wire).length} prune)`);
  console.log('');
  console.log(`Precision : ${fmt(m.precision)}  (threshold >= ${fmt(PREC_THRESHOLD)})`);
  console.log(`Recall    : ${fmt(m.recall)}  (threshold >= ${fmt(REC_THRESHOLD)})`);
  console.log(`F1        : ${fmt(m.f1)}`);
  console.log(`Accuracy  : ${fmt(m.accuracy)}`);
  console.log(`TP=${m.tp}  FP=${m.fp}  FN=${m.fn}  TN=${m.tn}`);
  console.log('');
  console.log(`Regression: ${pass ? 'PASS' : 'FAIL'}`);
  console.log('');

  // Detail: mis-classified pairs
  const wrong = results.filter((r) => !r.correct);
  if (wrong.length) {
    console.log('--- Misclassified pairs ---');
    for (const r of wrong) {
      const pred  = r.predicted  ? 'keep'  : 'prune';
      const label = r.should_wire ? 'keep' : 'prune';
      console.log(
        `  [cos=${r.cosine.toFixed(3)}] predicted=${pred} label=${label}` +
        `\n    note : ${r.note_title.slice(0, 70)}` +
        `\n    task : ${r.task_title.slice(0, 70)}`
      );
    }
    console.log('');
  }

  process.exit(pass ? 0 : 1);
}

main();
