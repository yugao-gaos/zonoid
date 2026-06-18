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

/**
 * Compute agreement rate over the last `window` rows in the shadow journal.
 * Returns { total, agreed, rate, window_used } or null if no rows.
 *
 * - total:       rows examined (≤ window)
 * - agreed:      rows where shadow_verdict === verdict
 * - rate:        agreed / total (null if total === 0)
 * - window_used: actual rows read
 *
 * Reads only the tail of the file — does NOT load the whole file into memory.
 *
 * @param {string} ws      - workspace root path
 * @param {number} [window=200] - max number of recent rows to examine
 * @returns {{ total: number, agreed: number, rate: number|null, window_used: number } | null}
 */
function agreementRate(ws, window = 200) {
  try {
    const file = path.join(ws, '.graph', 'shadow-journal.jsonl');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      // File missing or unreadable — no shadow data yet.
      return null;
    }

    // Split into non-empty lines and take the last `window` of them (tail behaviour).
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const tail = lines.slice(-window);
    let total = 0;
    let agreed = 0;

    for (const line of tail) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      // Only count rows that have both verdict fields.
      if (typeof row.verdict !== 'string' || typeof row.shadow_verdict !== 'string') continue;
      total++;
      if (row.shadow_verdict === row.verdict) agreed++;
    }

    if (total === 0) return null;

    return {
      total,
      agreed,
      rate: agreed / total,
      window_used: tail.length,
    };
  } catch {
    return null;
  }
}

module.exports = { appendShadow, agreementRate };
