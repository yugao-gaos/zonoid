'use strict';
// ask-promote.js — ask-gate's binding of the generic promotion comparator (lib/promotion.js).
//
// Reads the per-training-cycle metrics rows the fit script appends (.graph/ask-clf/metrics.jsonl),
// extracts {challenger: learned_accuracy, incumbent: heuristic_accuracy} measured ON THE SAME holdout
// rows each cycle, runs the comparator, and persists the promotion state to .graph/ask-clf/mode.json
// (mirroring edge-clf/mode.json). lib/ask-gate.js reads that file to choose the live decision source.
//
// State machine (one-way, shadow→enforce): the gate starts on 'heuristic'; once the learned model
// beats the heuristic by a margin over a stable window of cycles, runComparator flips mode.json to
// 'learned' and it stays there. No manual promotion step.

const fs = require('fs');
const path = require('path');
const { evaluate } = require('./promotion');

const ROOT = path.resolve(__dirname, '..');
function metricsPath(dir) { return path.join(dir || path.join(ROOT, '.graph/ask-clf'), 'metrics.jsonl'); }
function modePath(dir) { return path.join(dir || path.join(ROOT, '.graph/ask-clf'), 'mode.json'); }

// Read the live decision source: 'heuristic' (default) | 'learned'. Missing/garbled ⇒ heuristic.
function readMode(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(modePath(dir), 'utf8'));
    return m && m.source === 'learned' ? 'learned' : 'heuristic';
  } catch { return 'heuristic'; }
}

function writeMode(dir, source, detail) {
  const d = dir || path.join(ROOT, '.graph/ask-clf');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(modePath(d), JSON.stringify({
    source, promoted_at: source === 'learned' ? new Date().toISOString() : null, ...detail,
  }, null, 2));
}

// Pull {challenger, incumbent} pairs from non-skipped metrics rows (oldest→newest).
function readSamples(dir) {
  let raw;
  try { raw = fs.readFileSync(metricsPath(dir), 'utf8'); } catch { return []; }
  return raw.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter((r) => r && !r.skipped
      && typeof r.learned_accuracy === 'number' && typeof r.heuristic_accuracy === 'number')
    .map((r) => ({ challenger: r.learned_accuracy, incumbent: r.heuristic_accuracy }));
}

// Run the comparator over the metrics history and persist the resulting mode.
// Returns the comparator verdict augmented with { mode } (the post-run live source).
// Once 'learned' it never flips back (monotone latch — matches promotion.js).
function runComparator(opts = {}) {
  const dir = opts.dir;
  const current = readMode(dir);
  if (current === 'learned') {
    return { promote: false, reason: 'already-learned', mode: 'learned',
      window: opts.window, nSamples: readSamples(dir).length, lastChallenger: null, lastIncumbent: null };
  }
  const samples = readSamples(dir);
  const verdict = evaluate(samples, opts);
  if (verdict.promote) {
    writeMode(dir, 'learned', { reason: verdict.reason,
      learned_accuracy: verdict.lastChallenger, heuristic_accuracy: verdict.lastIncumbent,
      window: verdict.window });
  }
  return { ...verdict, mode: verdict.promote ? 'learned' : 'heuristic' };
}

module.exports = { readMode, writeMode, readSamples, runComparator };
