'use strict';

// Parse a single monetary amount string to a Number, or NaN if unparseable.
// Handles leading/trailing whitespace, an optional `$` symbol, a leading `-`
// sign, and both en-US (dot-decimal: "1,234.56") and de-DE (comma-decimal:
// "1.234,56") rendering. The upstream export serializes money as text, and the
// feed mixes locales, so a bare parseFloat/Number would silently return NaN on
// comma-decimal rows and poison the total.
function parseAmount(raw) {
  if (typeof raw !== 'string') return NaN;

  let s = raw.trim().replace(/[$\s]/g, '');
  if (s === '') return NaN;

  let sign = 1;
  if (s[0] === '+' || s[0] === '-') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1);
  }

  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return NaN;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let decimalSep = '';
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the rightmost is the decimal separator, the other groups.
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastComma !== -1) {
    // Only commas. One comma not followed by exactly 3 digits -> decimal;
    // otherwise (e.g. "1,234") treat as a thousands separator.
    const after = s.length - lastComma - 1;
    const single = s.indexOf(',') === lastComma;
    decimalSep = single && after !== 3 ? ',' : '';
  } else if (lastDot !== -1) {
    // Only dots. One dot not followed by exactly 3 digits -> decimal;
    // multiple dots (e.g. "1.234.567") are de-DE grouping.
    const after = s.length - lastDot - 1;
    const single = s.indexOf('.') === lastDot;
    decimalSep = single && after !== 3 ? '.' : (single ? '.' : '');
  }

  let normalized;
  if (decimalSep === '') {
    normalized = s.replace(/[.,]/g, '');
  } else {
    const groupSep = decimalSep === '.' ? ',' : '.';
    normalized = s.split(groupSep).join('').replace(decimalSep, '.');
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? sign * n : NaN;
}

// Sum the `amount` of every row, skipping any row whose amount is missing,
// empty, or unparseable. Returns a Number rounded half-up to 2 decimals;
// an empty (or all-bad) feed returns 0.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (Number.isFinite(value)) total += value;
  }

  // Round half-up at the cent, guarding against binary-float drift.
  const rounded = Math.round((total + Number.EPSILON) * 100) / 100;
  // Normalize -0 to 0.
  return rounded === 0 ? 0 : rounded;
}

module.exports = { sumAmounts };
