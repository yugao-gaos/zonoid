'use strict';

function summarizeRuns(rows) {
  const groups = {};

  for (const { arm, tokens } of rows) {
    if (!Number.isFinite(tokens)) continue;
    if (!groups[arm]) groups[arm] = [];
    groups[arm].push(tokens);
  }

  const result = {};
  for (const [arm, vals] of Object.entries(groups)) {
    const n = vals.length;
    const mean = Math.round((vals.reduce((s, v) => s + v, 0) / n) * 100) / 100;

    const sorted = vals.slice().sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    const median =
      n % 2 === 1
        ? sorted[mid]
        : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 100) / 100;

    result[arm] = { n, mean, median };
  }

  return result;
}

module.exports = { summarizeRuns };
