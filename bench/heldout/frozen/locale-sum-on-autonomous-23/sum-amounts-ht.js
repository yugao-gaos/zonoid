'use strict';

// Parse a single amount string into a Number, or null if it is not a
// parseable monetary value. Strips surrounding whitespace and an optional
// leading currency symbol ($); honors a leading sign.
function parseAmount(amount) {
  if (typeof amount !== 'string') return null;

  // Remove insignificant whitespace and the currency symbol. The sign ('-'
  // or '+') survives, whether it sat before or after the '$'.
  const cleaned = amount.replace(/\s+/g, '').replace(/\$/g, '');
  if (cleaned === '') return null;

  // Accept only a plain decimal monetary value: optional sign, digits with
  // an optional fractional part. Anything else (letters, junk) is skipped.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row) continue;
    const value = parseAmount(row.amount);
    if (value !== null) total += value;
  }

  // Round the grand total to 2 decimals (half-up at the cent). The EPSILON
  // nudge corrects binary-float representation error so e.g. 1234.005 rounds
  // up rather than down.
  const rounded = Math.round((total + Number.EPSILON) * 100) / 100;

  // Normalize -0 to 0.
  return rounded === 0 ? 0 : rounded;
}

module.exports = { sumAmounts };
