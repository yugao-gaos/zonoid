'use strict';

// Normalize a single-separator string to a JS-parseable decimal ("." as decimal).
// A separator is treated as a thousands grouping when it repeats, or when a lone
// separator is followed by exactly 3 digits behind a 1-3 digit head (e.g. "1.000",
// "12,500"). Otherwise it is the decimal point. Money carries <=2 fraction digits,
// so a 3-digit trailing group reads as grouping in both en-US and de-DE feeds.
function normalizeSingle(s, sep) {
  const count = s.split(sep).length - 1;
  if (count > 1) return s.split(sep).join('');
  const idx = s.indexOf(sep);
  const before = idx;
  const after = s.length - idx - 1;
  if (after === 3 && before >= 1 && before <= 3) return s.split(sep).join('');
  return s.split(sep).join('.');
}

// Parse one row's `amount` (a string) into a Number, or null if it is missing,
// empty, or not a parseable monetary value. Handles a leading "$"/sign, surrounding
// whitespace, and both en-US ("1,234.56") and de-DE ("1.234,56") number formats.
function parseAmount(row) {
  if (!row || typeof row.amount !== 'string') return null;
  const trimmed = row.amount.trim();
  if (trimmed === '') return null;

  const negative = trimmed.indexOf('-') !== -1;
  const digits = trimmed.replace(/[^0-9.,]/g, '');
  if (digits === '') return null;

  const lastDot = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');

  let normalized;
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the rightmost separator is the decimal, the other is grouping.
    normalized = lastDot > lastComma
      ? digits.replace(/,/g, '')
      : digits.replace(/\./g, '').replace(',', '.');
  } else if (lastComma !== -1) {
    normalized = normalizeSingle(digits, ',');
  } else if (lastDot !== -1) {
    normalized = normalizeSingle(digits, '.');
  } else {
    normalized = digits;
  }

  const value = parseFloat(normalized);
  if (!isFinite(value)) return null;
  return negative ? -value : value;
}

// Sum the `amount` of every row, rounded to 2 decimals, returned as a Number.
// Bad rows contribute 0; an empty feed returns 0. Accumulates in integer cents so
// float drift never poisons the grand total.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let totalCents = 0;
  for (const row of rows) {
    const value = parseAmount(row);
    if (value === null) continue;
    totalCents += Math.round(value * 100);
  }

  if (totalCents === 0) return 0;
  return totalCents / 100;
}

module.exports = { sumAmounts };
