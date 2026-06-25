'use strict';

// Matches an optional sign followed by a plain decimal: "12", "12.50", ".99", "5."
const MONEY = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

// Parse one row's `amount` string into a Number of dollars, or null if unparseable.
// Whitespace is insignificant; a leading `$` symbol is stripped; a `-`/`+` sign is honored.
function parseAmount(amount) {
  if (typeof amount !== 'string') return null;

  // Strip surrounding whitespace and the currency symbol, anywhere it sits
  // relative to the sign ("$-30", "-$30", " $19.95 " all normalize cleanly).
  const cleaned = amount.replace(/\s/g, '').replace(/\$/g, '');
  if (cleaned === '' || !MONEY.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

// Round to 2 decimals, half away from zero, with a nudge to absorb binary
// float representation error (e.g. 2.005 * 100 -> 200.4999… without it).
function roundCents(total) {
  const sign = total < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(total) + Number.EPSILON) * 100)) / 100;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (row == null) continue;
    const value = parseAmount(row.amount);
    if (value !== null) total += value;
  }

  const rounded = roundCents(total);
  // Defensive: never leak NaN/-0 to the caller.
  return Number.isFinite(rounded) ? rounded + 0 : 0;
}

module.exports = { sumAmounts };
