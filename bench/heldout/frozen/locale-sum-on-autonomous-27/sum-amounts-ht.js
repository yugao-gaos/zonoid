'use strict';

// Parse one row's `amount` (a money string) into a Number of dollars.
// Returns 0 for anything missing, empty, or not a parseable monetary value
// so a single bad row can never throw or poison the total with NaN.
function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;

  let s = raw.trim();
  if (s === '') return 0;

  // Optional leading sign, then an optional currency symbol.
  let sign = 1;
  if (s[0] === '-') {
    sign = -1;
    s = s.slice(1);
  } else if (s[0] === '+') {
    s = s.slice(1);
  }
  if (s[0] === '$') s = s.slice(1);
  s = s.trim();

  // Accept a plain decimal number: digits with an optional single decimal point.
  if (!/^\d+(\.\d+)?$/.test(s)) return 0;

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;

  return sign * n;
}

// Sum the `amount` field across all rows, returned as a Number rounded to
// 2 decimals (half-up at the cent). Empty feed totals 0.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (row && typeof row === 'object') {
      total += parseAmount(row.amount);
    }
  }

  // Round half-up at the cent. Work in integer cents to avoid binary-float
  // drift, then nudge by a tiny epsilon so values like 70.005 round as intended.
  const cents = Math.round((total + Number.EPSILON) * 100);
  return cents / 100;
}

module.exports = { sumAmounts };
