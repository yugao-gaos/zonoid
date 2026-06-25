'use strict';

// sumAmounts(rows) — total a feed of line items whose `amount` is a money STRING.
//
// The upstream export serializes money as text and, in practice, intermixes two
// locale conventions per row (this is not stated in the spec prose but is what the
// real feed contains):
//   - en-US: dot is the decimal separator, comma groups thousands  ("1,234.56" -> 1234.56)
//   - de-DE: comma is the decimal separator, dot groups thousands   ("1.234,56" -> 1234.56,
//                                                                     "99,90"    -> 99.9)
// A naive parseFloat()/Number() passes the dot-decimal examples but silently mis-sums
// the comma-decimal rows (parseFloat("99,90") === 99), so we parse locale-aware below.

// Parse a single amount string into a Number, or return null if it is not a
// parseable monetary value (missing / empty / garbage). Never throws, never NaN.
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  let s = raw.trim();
  if (s === '') return null;

  // A leading '-' marks a refund/credit. Honor a sign appearing anywhere in the
  // (otherwise numeric) token, e.g. "-$30.00", "$-30.00".
  const sign = s.indexOf('-') !== -1 ? -1 : 1;

  // Strip the currency symbol, sign, and any whitespace — keep only digits and
  // the two possible separators.
  s = s.replace(/[^0-9.,]/g, '');
  if (s === '') return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let decimalSep = null; // '.', ',', or null when both chars are grouping separators
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the one that appears LAST is the decimal separator; the other
    // groups thousands. Handles "1,234.56" and "1.234,56" symmetrically.
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastComma !== -1) {
    decimalSep = isGroupingSeparator(s, ',') ? null : ',';
  } else if (lastDot !== -1) {
    decimalSep = isGroupingSeparator(s, '.') ? null : '.';
  }

  let numStr;
  if (decimalSep === null) {
    // No decimal point — every separator is a thousands grouper.
    numStr = s.replace(/[.,]/g, '');
  } else {
    const groupSep = decimalSep === '.' ? ',' : '.';
    numStr = s.split(groupSep).join('').replace(decimalSep, '.');
  }

  const n = Number(numStr);
  if (!Number.isFinite(n)) return null;
  return sign * n;
}

// Decide whether a lone separator char in `s` is a thousands grouper rather than a
// decimal point. It groups thousands if it occurs more than once ("1.234.567"), or
// occurs once followed by exactly three digits ("1.234" -> 1234). Two trailing
// digits ("99,90", "100.00") read as a decimal — the common cents case.
function isGroupingSeparator(s, sep) {
  const parts = s.split(sep);
  if (parts.length > 2) return true;
  const right = parts[1];
  return right.length === 3 && parts[0].length >= 1;
}

// Round half-up to the cent, normalizing -0 to 0 and absorbing float noise.
function round2(n) {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return r === 0 ? 0 : r;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row) continue;
    const value = parseAmount(row.amount);
    if (value !== null) total += value;
  }
  return round2(total);
}

module.exports = { sumAmounts };
