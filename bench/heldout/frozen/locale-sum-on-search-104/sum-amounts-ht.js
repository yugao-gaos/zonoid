'use strict';

// The billing export mixes en-US (dot-decimal) and de-DE (comma-decimal) formats.
// Heuristic: if the last separator is followed by exactly 2 digits → it's the decimal
// separator; 3+ digits → it's a thousands separator with no fractional part.
function normalizeDecimal(num) {
  const lastComma = num.lastIndexOf(',');
  const lastDot = num.lastIndexOf('.');

  if (lastComma === -1 && lastDot === -1) return num;

  if (lastComma > lastDot) {
    // comma is the last separator
    const afterComma = num.length - lastComma - 1;
    if (afterComma === 2) {
      // "99,90" or "1.234,56" — comma is decimal
      return num.replace(/\./g, '').replace(',', '.');
    }
    // "1,234" — comma is thousands
    return num.replace(/,/g, '');
  }

  // dot is the last separator
  if (lastComma >= 0) {
    // "1,234.56" — en-US with thousands commas
    return num.replace(/,/g, '');
  }
  // only dot
  const afterDot = num.length - lastDot - 1;
  if (afterDot === 2) {
    // "99.90" — dot is decimal
    return num;
  }
  // "1.234" or "1.234.567" — dot is European thousands separator
  return num.replace(/\./g, '');
}

function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;

  const m = s.match(/^([+-]?)\s*\$?\s*([\d.,]+)\s*$/);
  if (!m) return 0;

  const sign = m[1] === '-' ? -1 : 1;
  const val = parseFloat(normalizeDecimal(m[2]));
  return isNaN(val) ? 0 : sign * val;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount != null ? row.amount : null);
  }
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

module.exports = { sumAmounts };
