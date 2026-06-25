'use strict';

// Sum a feed of line items whose `amount` is a money string.
// Bad/missing/unparseable rows contribute 0; never throws, never returns NaN.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row.amount !== 'string') continue;

    // Trim whitespace and drop a leading currency symbol; the sign may sit on
    // either side of the `$` (e.g. "-$30.00" or "$-30.00").
    const cleaned = row.amount.trim().replace(/\$/g, '');
    if (!/^[+-]?\d+(\.\d+)?$/.test(cleaned)) continue;

    const value = Number(cleaned);
    if (!Number.isFinite(value)) continue;

    total += value;
  }

  // Half-up round to the cent; EPSILON nudge corrects float representation drift.
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

module.exports = { sumAmounts };
