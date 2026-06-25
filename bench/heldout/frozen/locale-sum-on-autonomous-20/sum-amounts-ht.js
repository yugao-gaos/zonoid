'use strict';

// Parse a single row's `amount` string into a Number of currency units.
// Returns NaN for any missing / empty / non-monetary value so the caller can skip it.
function parseAmount(amount) {
  if (typeof amount !== 'string') return NaN;
  const s = amount.trim();
  if (!s) return NaN;

  // Optional leading sign and/or `$`, in either order: "-5", "$5", "-$5", "$-5".
  // The body is plain digits with an optional fractional part — nothing else parses.
  const m = s.match(/^([+-]?)\$?([+-]?)(\d+(?:\.\d+)?)$/);
  if (!m) return NaN;

  const negative = m[1] === '-' || m[2] === '-';
  const value = parseFloat(m[3]);
  if (!Number.isFinite(value)) return NaN;

  return negative ? -value : value;
}

// Sum the `amount` of every row, skipping unparseable rows, and round the
// grand total half-up to 2 decimal places. Always returns a Number.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row) continue;
    const value = parseAmount(row.amount);
    if (Number.isFinite(value)) total += value;
  }

  // Round half-up at the cent; the epsilon nudge absorbs binary-float drift
  // (e.g. 1234.00 + 0.99) so values land on the intended cent.
  const rounded = Math.round((total + Number.EPSILON) * 100) / 100;

  // Normalize a possible -0 to 0.
  return rounded === 0 ? 0 : rounded;
}

module.exports = { sumAmounts };
