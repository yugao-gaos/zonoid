'use strict';

// The real billing feed mixes en-US (1,234.56) and de-DE (1.234,56) formats.
// Heuristic: whichever separator appears last is the decimal separator.
function parseAmount(str) {
  if (!str || typeof str !== 'string') return 0;
  str = str.trim();
  if (!str) return 0;

  let sign = 1;
  if (str[0] === '-') { sign = -1; str = str.slice(1).trim(); }
  else if (str[0] === '+') { str = str.slice(1).trim(); }

  // Strip a single leading currency symbol (e.g. $, €, £)
  str = str.replace(/^[^\d,.]/, '').trim();

  // Sign may follow the currency symbol (e.g. $-30.00)
  if (str[0] === '-') { sign *= -1; str = str.slice(1).trim(); }
  else if (str[0] === '+') { str = str.slice(1).trim(); }

  if (!str) return 0;

  const lastComma = str.lastIndexOf(',');
  const lastDot = str.lastIndexOf('.');

  let normalized;
  if (lastComma > lastDot) {
    // de-DE: comma is decimal, dots are thousands separators
    normalized = str.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US: dot is decimal, commas are thousands separators
    normalized = str.replace(/,/g, '');
  }

  const val = parseFloat(normalized);
  return isNaN(val) ? 0 : val * sign;
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
