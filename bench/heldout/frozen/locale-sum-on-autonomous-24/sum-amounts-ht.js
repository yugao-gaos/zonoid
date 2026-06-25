'use strict';

// Parse a single string amount into a Number, honoring an optional leading
// currency symbol ($) and sign. Returns 0 for anything that isn't a parseable
// monetary value (missing, empty, non-string, NaN, etc.) so one bad row can
// never throw or poison the total.
function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;

  let s = raw.trim();
  if (s === '') return 0;

  // Strip the currency symbol wherever it sits ("$-30", "-$30", "$30").
  s = s.replace(/\$/g, '').trim();

  let sign = 1;
  if (s[0] === '-') {
    sign = -1;
    s = s.slice(1).trim();
  } else if (s[0] === '+') {
    s = s.slice(1).trim();
  }

  // Must be a bare decimal number after stripping symbol/sign.
  if (!/^\d+(\.\d+)?$/.test(s)) return 0;

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;

  return sign * n;
}

// Half-up rounding (away from zero) at the cent, robust against the binary
// floating-point error that accumulates when summing decimal strings.
function round2(n) {
  const sign = n < 0 ? -1 : 1;
  const r = (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
  return r === 0 ? 0 : r; // normalize -0 -> 0
}

// Sum the `amount` field across all rows and return the grand total as a
// Number rounded to 2 decimals. Empty feed -> 0.
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
