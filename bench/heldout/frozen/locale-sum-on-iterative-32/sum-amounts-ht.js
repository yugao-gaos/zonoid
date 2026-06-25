'use strict';

// Parse one row's `amount` (a string) into a Number of currency units.
// Returns null for anything that isn't a clean, parseable monetary value so
// the caller can skip it. Honors a leading `$` and/or `-` (in either order)
// and ignores surrounding whitespace.
function parseAmount(amount) {
  if (typeof amount !== 'string') return null;
  const m = amount.trim().match(/^(-?)\s*\$?\s*(-?)(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const negative = m[1] === '-' || m[2] === '-';
  const value = Number(m[3]);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

// Sum the `amount` of every row, skipping any row that isn't a parseable
// monetary value, and return the grand total as a Number rounded half-up to
// 2 decimals. An empty (or all-bad) feed totals 0.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  // Accumulate in integer cents to avoid binary-float drift across the feed.
  let cents = 0;
  for (const row of rows) {
    const value = row == null ? null : parseAmount(row.amount);
    if (value === null) continue;
    cents += Math.round(value * 100);
  }

  return cents / 100;
}

module.exports = { sumAmounts };
