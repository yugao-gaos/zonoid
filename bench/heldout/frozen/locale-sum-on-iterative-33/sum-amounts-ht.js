'use strict';

// Parse a single string amount into a Number of cents (integer), or null if
// the value is missing / not a parseable monetary string. Accepts an optional
// leading currency symbol ($) and/or sign (-/+), in either order, plus
// insignificant surrounding whitespace.
function parseCents(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  const m = s.match(/^([-+]?)\$?([-+]?)(\d*\.?\d+)$/);
  if (!m) return null;

  const sign = m[1] === '-' || m[2] === '-' ? -1 : 1;
  const value = Number(m[3]);
  if (!Number.isFinite(value)) return null;

  // Convert to integer cents so the running total never drifts in floating
  // point. Math.round is standard half-up (ties toward +Infinity).
  return Math.round(sign * value * 100);
}

// Sum the `amount` field across all rows. Bad/missing rows contribute 0.
// Always returns a Number rounded to 2 decimals; the empty feed returns 0.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let cents = 0;
  for (const row of rows) {
    const c = parseCents(row && row.amount);
    if (c !== null) cents += c;
  }

  return cents / 100;
}

module.exports = { sumAmounts };
