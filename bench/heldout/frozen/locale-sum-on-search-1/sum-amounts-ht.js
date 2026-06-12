'use strict';

function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/\$/g, '').trim();
  if (!s) return 0;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let normalized;
  if (lastComma > lastDot) {
    // de-DE: comma is decimal separator, dots are thousands separators
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US / standard: period is decimal, commas are thousands separators
    normalized = s.replace(/,/g, '');
  }

  const n = parseFloat(normalized);
  return isNaN(n) ? 0 : n;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return parseFloat(total.toFixed(2));
}

module.exports = { sumAmounts };
