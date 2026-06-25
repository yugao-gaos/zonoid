'use strict';

// Parse a single row's `amount` into a finite Number, or return null when the
// value is missing / empty / not a parseable monetary string. Strips a leading
// currency symbol ($) and honors a sign, in either order ($-30 or -$30).
function parseAmount(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string') return null;

  // Trim, drop the currency symbol, trim again to absorb any inner spacing.
  const s = raw.trim().replace('$', '').trim();
  if (s === '') return null;

  // Must be a plain signed decimal once the symbol is gone.
  if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return null;

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Sum the `amount` of every row, returning a Number rounded to 2 decimals.
// Bad rows contribute 0; an empty feed returns 0. Accumulating in integer cents
// keeps the total free of binary-float dust for the standard 2-decimal feed.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let cents = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (value === null) continue;
    cents += Math.round(value * 100);
  }

  return cents / 100;
}

module.exports = { sumAmounts };
