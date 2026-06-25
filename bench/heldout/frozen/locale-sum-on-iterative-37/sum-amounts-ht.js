'use strict';

// Parse one row's `amount` string into a Number of dollars.
// Returns 0 for any missing/empty/unparseable value (never NaN).
function parseAmount(amount) {
  if (typeof amount !== 'string') return 0;

  let s = amount.trim();
  if (s === '') return 0;

  // A leading sign and/or currency symbol may appear in either order
  // (e.g. "-$30.00", "$-30.00"). Strip them, tracking the sign.
  let sign = 1;
  let changed = true;
  while (changed) {
    changed = false;
    if (s[0] === '-') { sign = -sign; s = s.slice(1).trimStart(); changed = true; }
    else if (s[0] === '+') { s = s.slice(1).trimStart(); changed = true; }
    else if (s[0] === '$') { s = s.slice(1).trimStart(); changed = true; }
  }

  // What's left must be a plain decimal magnitude: digits with an
  // optional single fractional part. Anything else is a bad row.
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return 0;

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;

  return sign * n;
}

// Round to 2 decimals, half away from zero ("half-up" at the cent).
// The small epsilon corrects binary floating-point drift so values that
// are mathematically on the half-cent boundary round as intended.
function round2(n) {
  const r = Math.round(Math.abs(n) * 100 + 1e-9) / 100;
  if (r === 0) return 0; // normalize -0 to 0
  return n < 0 ? -r : r;
}

// Sum the `amount` of every row, returning the grand total as a Number
// rounded to 2 decimals. Bad rows contribute 0; an empty feed yields 0.
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
