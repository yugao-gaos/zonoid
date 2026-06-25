'use strict';

// Real upstream feed mixes en-US (1,234.56) and de-DE (1.234,56) decimal formats.
// Disambiguation: when both separators present, the LAST one is the decimal point.
// Comma-only with exactly 3 trailing digits → en-US thousands sep, not decimal.
function parseAmount(str) {
  if (typeof str !== 'string') return 0;
  str = str.trim();
  if (!str) return 0;

  // Strip leading currency symbol (e.g. '$'), preserve sign
  str = str.replace(/^([+-]?)\s*[^\d,.\-+]*/, '$1');

  const lastComma = str.lastIndexOf(',');
  const lastPeriod = str.lastIndexOf('.');
  let normalized;

  if (lastComma !== -1 && lastPeriod !== -1) {
    if (lastComma > lastPeriod) {
      // de-DE: "1.234,56" → remove period thousands seps, swap comma→period
      normalized = str.replace(/\./g, '').replace(',', '.');
    } else {
      // en-US: "1,234.56" → remove comma thousands seps
      normalized = str.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // Only comma: 3 trailing digits → thousands sep ("1,000"); otherwise decimal ("1,50")
    normalized = /,\d{3}$/.test(str)
      ? str.replace(/,/g, '')
      : str.replace(',', '.');
  } else {
    // Only period or no separator: period is decimal
    normalized = str;
  }

  const val = Number(normalized);
  return isNaN(val) ? 0 : val;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount);
  }

  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
