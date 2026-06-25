'use strict';

// Parse a single amount string into a Number, or return null if it is not a
// parseable monetary value (the caller treats null as a contribution of 0).
//
// The upstream export is locale-mixed: amounts may be en-US (dot decimal,
// comma thousands -> "1,234.56") or de-DE (comma decimal, dot thousands ->
// "1.234,56"). A naive parseFloat/Number would silently return NaN on the
// comma-decimal rows, so we normalize the separators first.
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // A leading/embedded '-' marks a refund/credit.
  const negative = trimmed.includes('-');

  // Drop everything that is not a digit or a separator (currency symbols,
  // spaces, sign characters).
  let s = trimmed.replace(/[^0-9.,]/g, '');
  if (s === '') return null;

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  let normalized;
  if (hasDot && hasComma) {
    // The rightmost separator is the decimal point; the other groups thousands.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      normalized = s.replace(/\./g, '').replace(',', '.'); // de-DE
    } else {
      normalized = s.replace(/,/g, ''); // en-US
    }
  } else if (hasComma) {
    const commaCount = (s.match(/,/g) || []).length;
    const after = s.length - s.lastIndexOf(',') - 1;
    if (commaCount > 1 || after === 3) {
      // "1,234,567" or "1,000" -> thousands grouping.
      normalized = s.replace(/,/g, '');
    } else {
      // "19,95" -> de-DE decimal comma.
      normalized = s.replace(',', '.');
    }
  } else if (hasDot) {
    const dotCount = (s.match(/\./g) || []).length;
    // "1.234.567" -> de-DE thousands grouping; a single dot stays decimal.
    normalized = dotCount > 1 ? s.replace(/\./g, '') : s;
  } else {
    normalized = s;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// Round to 2 decimals, half away from zero, guarding against binary-float
// representation error and a stray -0.
function round2(x) {
  const r = Math.round((Math.abs(x) + Number.EPSILON) * 100) / 100;
  const signed = x < 0 ? -r : r;
  return signed === 0 ? 0 : signed;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (value !== null) total += value;
  }

  return round2(total);
}

module.exports = { sumAmounts };
