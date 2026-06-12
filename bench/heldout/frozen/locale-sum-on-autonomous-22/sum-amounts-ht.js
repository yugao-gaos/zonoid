'use strict';

// Parse one row's `amount` (a money string) into a Number of cents, or null if
// it is missing / empty / not a parseable monetary value. Working in integer
// cents keeps the running total free of binary-float drift.
function parseCents(amount) {
  if (typeof amount !== 'string') return null;

  let s = amount.trim();
  if (s === '') return null;

  // Optional leading sign, then an optional currency symbol (in either order).
  let sign = 1;
  const signMatch = s.match(/^[+-]/);
  if (signMatch) {
    if (signMatch[0] === '-') sign = -1;
    s = s.slice(1).trim();
  }
  if (s.startsWith('$')) s = s.slice(1).trim();

  // A bare monetary value: digits with at most one decimal point.
  if (!/^\d+(\.\d+)?$/.test(s)) return null;

  const value = Number(s);
  if (!Number.isFinite(value)) return null;

  // Round to the cent (half-up) and return signed integer cents.
  return sign * Math.round(value * 100);
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let cents = 0;
  for (const row of rows) {
    if (!row) continue;
    const c = parseCents(row.amount);
    if (c !== null) cents += c;
  }

  return cents / 100;
}

module.exports = { sumAmounts };
