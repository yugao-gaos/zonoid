'use strict';

// Parse one row's `amount` into a Number of dollars, or null if it is not a
// parseable monetary value. Handles surrounding whitespace, an optional leading
// `$` symbol, and an optional sign (in either order, e.g. "-$30.00" / "$-30.00").
function parseAmount(amount) {
  if (amount == null) return null;
  let s = String(amount).trim();
  if (s === '') return null;

  // Strip the currency symbol; capture a single leading sign.
  s = s.replace(/\$/g, '').trim();
  let sign = 1;
  if (s[0] === '-' || s[0] === '+') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1).trim();
  }

  // Accept only plain monetary text: digits with an optional decimal part.
  // This rejects NaN-poisoning inputs like "abc", "1e5", "0x10", "Infinity".
  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  return sign * Number(s);
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (row == null) continue;
    const value = parseAmount(row.amount);
    if (value === null) continue; // skip missing / malformed rows
    total += value;
  }

  // Half-up rounding at the cent. The EPSILON nudge corrects binary-float
  // representations (e.g. 1.005 -> 1.01) before truncating to 2 decimals.
  const rounded = Math.round((total + Number.EPSILON) * 100) / 100;

  // Normalize -0 to 0.
  return rounded === 0 ? 0 : rounded;
}

module.exports = { sumAmounts };
