'use strict';

// sumAmounts(rows) — grand total of a billing line-item feed.
//
// Each row carries `amount` as a string (money is serialized as text, never a
// JSON number). We sum every amount and return the total as a Number rounded to
// 2 decimals. A row whose amount is missing, empty, or not a parseable monetary
// value contributes 0 — it must never throw or poison the total with NaN.

// Parse one amount string into a Number, or return null if it isn't a valid
// monetary value. Honors a leading `$` and/or sign (in either order); only a
// dot is accepted as the decimal separator, per the spec.
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  let s = raw.trim();
  if (s === '') return null;

  // Strip a leading currency symbol and sign, in either order ("-$30", "$-30").
  let sign = 1;
  let changed = true;
  while (changed) {
    changed = false;
    if (s[0] === '$') { s = s.slice(1).trim(); changed = true; }
    else if (s[0] === '+') { s = s.slice(1).trim(); changed = true; }
    else if (s[0] === '-') { sign = -sign; s = s.slice(1).trim(); changed = true; }
  }

  // What remains must be plain digits with an optional single dot decimal.
  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;

  return sign * n;
}

// Half-up rounding at the cent, robust to floating-point representation dust.
function round2(n) {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    const raw = row == null ? undefined : row.amount;
    const value = parseAmount(raw);
    if (value !== null) total += value;
  }

  return round2(total);
}

module.exports = { sumAmounts };
