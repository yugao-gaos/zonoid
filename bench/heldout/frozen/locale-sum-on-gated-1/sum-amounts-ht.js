'use strict';

// Parse a single amount string into a Number, or return null if it is not a
// parseable monetary value. Honors a leading currency symbol ($) and/or sign,
// tolerates surrounding whitespace, and never returns NaN.
function parseAmount(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  // Optional sign and optional `$`, in either order, then digits.
  const m = s.match(/^([+-]?)\s*\$?\s*([+-]?)\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;

  const sign = m[1] === '-' || m[2] === '-' ? -1 : 1;
  const n = parseFloat(m[3]);
  if (!Number.isFinite(n)) return null;

  return sign * n;
}

// Sum the `amount` of every row, returning the grand total as a Number rounded
// to 2 decimals. Bad/missing rows contribute 0; an empty feed totals 0.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    const value = parseAmount(row && row.amount);
    if (value !== null) total += value;
  }

  // Half-up rounding at the cent; EPSILON nudge guards against binary-float
  // representation error (e.g. 70.00000000001). `|| 0` collapses -0 to 0.
  const rounded = Math.round((total + Number.EPSILON) * 100) / 100;
  return rounded || 0;
}

module.exports = { sumAmounts };
