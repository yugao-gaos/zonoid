'use strict';

// Parse one row's `amount` string into a Number of dollars.
// Returns 0 for missing / empty / non-monetary values (never NaN, never throws).
// Honors an optional leading sign and an optional `$` (in either order),
// and ignores surrounding whitespace.
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/\s+/g, '').replace(/\$/g, '');
  // A monetary value: optional sign, digits, optional fractional part.
  // This rejects commas, exponents, hex, etc. so junk rows contribute 0.
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Round to 2 decimals, half away from zero (standard cent rounding).
// The epsilon nudges binary-float representations like 1.005 back to the
// intended decimal before rounding.
function round2(n) {
  const r = Math.round(Math.abs(n) * 100 + 1e-9) / 100;
  return n < 0 ? -r : r;
}

// Sum the `amount` of every row in `rows`, returning the grand total as a
// Number rounded to 2 decimals. Empty / non-array input totals 0.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    if (row == null) continue;
    total += parseAmount(row.amount);
  }
  return round2(total);
}

module.exports = { sumAmounts };
