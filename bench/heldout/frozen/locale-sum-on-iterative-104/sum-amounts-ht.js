'use strict';

// The upstream export mixes en-US (dot-decimal) and de-DE (comma-decimal) formats.
// Detect by which separator appears last: last comma → de-DE, last dot → en-US.
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = raw.trim().replace(/\$/g, '');
  if (!s || s === '-') return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  let normalized;
  if (lastComma > lastDot) {
    // de-DE: period = thousands sep, comma = decimal sep  ("1.234,56" → "1234.56")
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US: comma = thousands sep, period = decimal sep  ("1,234.56" → "1234.56")
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
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
