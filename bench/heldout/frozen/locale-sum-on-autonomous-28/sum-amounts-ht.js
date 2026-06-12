'use strict';

// Parse a single row's `amount` into a Number of currency units.
// Returns 0 for anything that isn't a clean, parseable monetary string —
// a bad row must never throw or poison the total with NaN.
function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;

  // Strip surrounding whitespace and an optional leading currency symbol.
  // The sign may sit on either side of the `$` (`-$30` or `$-30`), so we
  // drop the symbol first, then re-trim and validate the bare number.
  const cleaned = raw.trim().replace('$', '').trim();
  if (cleaned === '') return 0;

  // Only accept a plain signed decimal — reject letters, stray symbols, etc.
  if (!/^[-+]?\d+(\.\d+)?$/.test(cleaned)) return 0;

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// Sum the `amount` of every row and return the grand total as a Number,
// rounded half-up to 2 decimal places. An empty feed totals 0.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (row == null) continue;
    total += parseAmount(row.amount);
  }

  // Round to the cent. The EPSILON nudge absorbs binary-float drift so values
  // like 70.00000000001 collapse to a clean 70 and exact halves round up.
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

module.exports = { sumAmounts };
