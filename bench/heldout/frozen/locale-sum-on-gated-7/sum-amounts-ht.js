'use strict';

// Parse a single monetary amount string into a Number, or null if unparseable.
// Honors an optional leading sign and/or '$' currency symbol (either order),
// and ignores surrounding whitespace.
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  let s = raw.trim();
  if (!s) return null;

  let negative = false;

  // optional sign before the currency symbol
  let m = s.match(/^[+-]/);
  let hadSign = false;
  if (m) {
    negative = m[0] === '-';
    hadSign = true;
    s = s.slice(1).trim();
  }

  // optional currency symbol
  if (s.startsWith('$')) s = s.slice(1).trim();

  // sign may instead appear after the currency symbol
  if (!hadSign) {
    m = s.match(/^[+-]/);
    if (m) {
      negative = m[0] === '-';
      s = s.slice(1).trim();
    }
  }

  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  const num = Number(s);
  if (!Number.isFinite(num)) return null;

  return negative ? -num : num;
}

// Round a number to 2 decimals, half-up (away from zero) at the cent.
function round2(n) {
  const sign = n < 0 ? -1 : 1;
  const r = Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
  const result = sign * r;
  return result === 0 ? 0 : result;
}

// Sum the `amount` field of every row, skipping rows whose amount is missing,
// empty, or not a parseable monetary value. Always returns a Number.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (value === null) continue;
    total += value;
  }

  return round2(total);
}

module.exports = { sumAmounts };
