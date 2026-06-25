'use strict';

// Parse a single row's `amount` string into a Number.
// Returns 0 for anything missing, empty, or not a parseable monetary value
// (so one bad row can never throw or poison the total with NaN).
function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;

  let s = raw.trim();
  if (s === '') return 0;

  // A leading currency symbol ($) and/or a sign (-/+) may appear in either
  // order; strip each at most once and remember the sign.
  let sign = 1;
  for (let i = 0; i < 2; i++) {
    if (s[0] === '$') s = s.slice(1);
    else if (s[0] === '+') s = s.slice(1);
    else if (s[0] === '-') { sign = -sign; s = s.slice(1); }
    else break;
  }

  // What remains must be a plain decimal: digits, optionally a fractional part.
  if (!/^\d+(\.\d+)?$/.test(s)) return 0;

  const n = Number(s);
  return Number.isFinite(n) ? sign * n : 0;
}

// Round to 2 decimals, half-up (away from zero), with a tiny nudge to absorb
// binary-float representation error. Normalizes -0 to 0.
function round2(x) {
  const r = Math.round(Math.abs(x) * 100 + 1e-9) / 100;
  return (x < 0 ? -r : r) || 0;
}

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
