'use strict';

function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  const cleaned = s.replace(/\s/g, '').replace(/\$/g, '');
  const n = Number(cleaned);
  return isFinite(n) ? n : 0;
}

function sumAmounts(rows) {
  if (!rows || !rows.length) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
