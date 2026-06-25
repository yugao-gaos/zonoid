'use strict';

const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;

function summarizeRuns(rows) {
  const byArm = new Map();

  for (const { arm, tokens } of rows) {
    if (!Number.isFinite(tokens)) continue;
    if (!byArm.has(arm)) byArm.set(arm, []);
    byArm.get(arm).push(tokens);
  }

  const out = {};
  for (const [arm, values] of byArm) {
    const n = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    const mean = sum / n;

    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    const median = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

    out[arm] = { n, mean: round2(mean), median: round2(median) };
  }

  return out;
}

module.exports = { summarizeRuns };
