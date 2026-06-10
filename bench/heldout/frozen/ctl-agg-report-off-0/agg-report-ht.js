'use strict';

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function median(sorted) {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function summarizeRuns(rows) {
  const byArm = new Map();

  for (const { arm, tokens } of rows) {
    if (!Number.isFinite(tokens)) continue;
    if (!byArm.has(arm)) byArm.set(arm, []);
    byArm.get(arm).push(tokens);
  }

  const out = {};
  for (const [arm, tokens] of byArm) {
    const sorted = tokens.slice().sort((a, b) => a - b);
    const sum = sorted.reduce((acc, t) => acc + t, 0);
    out[arm] = {
      n: sorted.length,
      mean: round2(sum / sorted.length),
      median: round2(median(sorted)),
    };
  }

  return out;
}

module.exports = { summarizeRuns };
