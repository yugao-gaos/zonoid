'use strict';

function parseAmount(str) {
  if (str == null) return 0;
  const s = str.trim();
  if (!s) return 0;
  // Strip currency symbol ($) while preserving sign
  const cleaned = s.replace(/\$/g, '').trim();
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
