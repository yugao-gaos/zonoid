'use strict';

// Parse one row's `amount` string into a Number of dollars.
// Returns 0 for anything missing, empty, or not a clean monetary value.
function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;

  // Strip whitespace and an optional currency symbol; keep the sign.
  const cleaned = raw.replace(/\$/g, '').trim();
  if (cleaned === '') return 0;

  // Number() is strict: it rejects trailing junk ("12.5x" -> NaN) so a bad
  // row contributes 0 rather than poisoning the total with NaN.
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : 0;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (row == null) continue;
    total += parseAmount(row.amount);
  }

  // Half-up rounding at the cent. `+ 0` collapses a possible -0 to 0.
  return Math.round((total + Number.EPSILON) * 100) / 100 + 0;
}

module.exports = { sumAmounts };
