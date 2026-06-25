'use strict';

// Sum a feed of string-rendered monetary amounts into a Number total,
// rounded to 2 decimals (half-up at the cent). Bad rows contribute 0.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let totalCents = 0;
  for (const row of rows) {
    if (!row || typeof row.amount !== 'string') continue;

    // Strip whitespace, leading currency symbol, and capture an optional sign.
    const raw = row.amount.trim().replace(/^([+-]?)\s*\$?\s*/, '$1');
    if (!/^[+-]?\d+(\.\d+)?$/.test(raw)) continue;

    const value = Number(raw);
    if (!Number.isFinite(value)) continue;

    // Accumulate in integer cents to avoid float drift.
    totalCents += Math.round(value * 100);
  }

  return totalCents / 100;
}

module.exports = { sumAmounts };
