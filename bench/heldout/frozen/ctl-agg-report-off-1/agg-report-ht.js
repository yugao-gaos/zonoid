'use strict';

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function summarizeRuns(rows) {
  const byArm = new Map();
  for (const row of rows) {
    const t = row.tokens;
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    if (!byArm.has(row.arm)) byArm.set(row.arm, []);
    byArm.get(row.arm).push(t);
  }

  const out = {};
  for (const [arm, tokens] of byArm) {
    const n = tokens.length;
    const mean = tokens.reduce((a, b) => a + b, 0) / n;

    const sorted = tokens.slice().sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    out[arm] = { n, mean: round2(mean), median: round2(median) };
  }
  return out;
}

module.exports = { summarizeRuns };
