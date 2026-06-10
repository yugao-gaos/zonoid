'use strict';

function round2(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

function median(sorted) {
  const len = sorted.length;
  const mid = len >> 1;
  return len % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarizeRuns(rows) {
  const byArm = new Map();

  for (const row of rows) {
    if (!Number.isFinite(row.tokens)) continue;
    let list = byArm.get(row.arm);
    if (!list) {
      list = [];
      byArm.set(row.arm, list);
    }
    list.push(row.tokens);
  }

  const result = {};
  for (const [arm, tokens] of byArm) {
    const n = tokens.length;
    const sum = tokens.reduce((a, b) => a + b, 0);
    const sorted = tokens.slice().sort((a, b) => a - b);
    result[arm] = {
      n,
      mean: round2(sum / n),
      median: round2(median(sorted)),
    };
  }

  return result;
}

module.exports = { summarizeRuns };
