'use strict';

// The upstream billing export mixes en-US (1,234.56) and de-DE (1.234,56) formats
// per-row. Detect the decimal separator by which one appears last.
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = raw.trim().replace(/^\$/, '');
  if (!s) return 0;

  const lastComma = s.lastIndexOf(',');
  const lastPeriod = s.lastIndexOf('.');

  let normalized;
  if (lastComma > lastPeriod) {
    // de-DE: comma is decimal separator, periods are thousands separators
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US: period is decimal separator, commas are thousands separators
    normalized = s.replace(/,/g, '');
  }

  const n = Number(normalized);
  return isNaN(n) ? 0 : n;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Number(total.toFixed(2));
}

module.exports = { sumAmounts };
