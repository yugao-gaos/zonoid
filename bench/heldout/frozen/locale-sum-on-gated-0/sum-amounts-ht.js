'use strict';

// Matches an optional sign and/or `$` (in either order) followed by digits
// with an optional fractional part: e.g. "19.95", "$19.95", "-30.00", "$-30.00".
const MONEY = /^[-+]?\$?[-+]?\d+(?:\.\d+)?$/;

function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;
  const trimmed = raw.trim();
  if (trimmed === '' || !MONEY.test(trimmed)) return 0;
  const n = Number(trimmed.replace('$', ''));
  return Number.isFinite(n) ? n : 0;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount);
  }
  // Half-up rounding at the cent; EPSILON nudge guards float representation error.
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

module.exports = { sumAmounts };
