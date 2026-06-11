'use strict';

// Parse one row's `amount` string into a Number, or null if it isn't a
// parseable monetary value. Strips surrounding whitespace and a leading
// currency symbol; honors a leading sign.
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  // Drop whitespace and any `$` symbol; what remains must be a plain number.
  const s = raw.replace(/\$/g, '').trim();
  if (s === '') return null;
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Sum the `amount` of every row, skipping any row that isn't a parseable
// monetary value, and round the grand total to 2 decimals (half-up at the
// cent). Always returns a Number; an empty/all-bad feed returns 0.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row) continue;
    const amount = parseAmount(row.amount);
    if (amount !== null) total += amount;
  }

  const rounded = Math.round((total + Number.EPSILON) * 100) / 100;
  return Number.isFinite(rounded) ? rounded : 0;
}

module.exports = { sumAmounts };
