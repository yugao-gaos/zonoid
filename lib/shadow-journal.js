'use strict';
// shadow-journal.js — append-only writer for the learned-model shadow journal.
//
// Every time the judge route applies a keepEdge or pruneEdge verdict, it ALSO scores
// the same edge with the logistic regression classifier (predict-edge-classifier.js) and
// writes a shadow row here. The shadow model NEVER changes the actual verdict — Sonnet's
// decision stands. This journal is the training signal for comparing model vs. human judge.
//
// Output file: <workspace>/.graph/shadow-journal.jsonl
//
// Schema v1 row:
//   ts              — Unix ms timestamp (Date.now())
//   from            — edge source key
//   to              — edge target key
//   verdict         — Sonnet's verdict: "keep" | "prune"
//   shadow_verdict  — model label mapped to string: 0→"prune", 1→"keep"
//   shadow_conf     — model score (float 0.0–1.0)
//   cosine          — cosine score used as feature input (e.score || e.weight || 0)
//   model_version   — "v1" (hardcoded; bump when the model artifact changes)

const fs = require('fs');
const path = require('path');

/**
 * Append a shadow row to <ws>/.graph/shadow-journal.jsonl.
 * Best-effort: swallows all errors — a shadow write must never break a judge verdict.
 *
 * @param {string} ws   - workspace root path
 * @param {object} row  - shadow row object (see schema above)
 */
function appendShadow(ws, row) {
  try {
    const line = JSON.stringify(row);
    fs.appendFileSync(path.join(ws, '.graph', 'shadow-journal.jsonl'), line + '\n');
  } catch { /* best-effort — never throws */ }
}

module.exports = { appendShadow };
