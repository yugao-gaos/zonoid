'use strict';

/**
 * Parse a monetary string that may be en-US (1,234.56) or de-DE (1.234,56).
 * Strips leading currency symbols and honors a leading minus sign.
 * Returns 0 for missing, empty, or unparseable input.
 */
function parseAmount(str) {
  if (!str || typeof str !== 'string') return 0;
  str = str.trim();
  if (!str) return 0;

  // Remove currency symbols (e.g. $), then re-trim
  let s = str.replace(/[$€£¥]/g, '').trim();

  // Extract sign
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1).trim(); }
  else if (s[0] === '+') { s = s.slice(1).trim(); }

  if (!s) return 0;

  // Detect locale by the position of the last dot vs last comma.
  // Whichever appears last is the decimal separator.
  const lastDot   = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let normalized;
  if (lastDot === -1 && lastComma === -1) {
    // Plain integer string
    normalized = s;
  } else if (lastComma === -1 || lastDot > lastComma) {
    // en-US: dot is decimal, commas are thousands separators
    normalized = s.replace(/,/g, '');
  } else {
    // de-DE: comma is decimal, dots are thousands separators
    normalized = s.replace(/\./g, '').replace(',', '.');
  }

  const n = parseFloat(normalized);
  if (isNaN(n)) return 0;
  return sign * n;
}

/**
 * Sum the `amount` field of every row, returning a Number rounded to 2 dp.
 * Bad/missing amounts contribute 0; never throws or returns NaN.
 */
function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount);
  }
  return parseFloat(total.toFixed(2));
}

module.exports = { sumAmounts };
