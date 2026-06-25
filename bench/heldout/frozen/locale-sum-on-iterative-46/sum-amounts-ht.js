'use strict';

// Parse one amount string into a Number, per the feed contract:
//   - leading/trailing whitespace is insignificant
//   - an optional leading '$' currency symbol is stripped
//   - an optional leading '-' sign (refund/credit) is honored
//   - the magnitude is a strict dot-decimal monetary value
//   - anything missing, empty, or unparseable yields 0 (never NaN)
function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;

  let s = raw.trim();
  if (s === '') return 0;

  // Strip an optional sign and optional '$' in either order ('-$30', '$-30').
  let sign = 1;
  if (s.startsWith('-')) { sign = -1; s = s.slice(1).trimStart(); }
  if (s.startsWith('$')) { s = s.slice(1).trimStart(); }
  if (sign === 1 && s.startsWith('-')) { sign = -1; s = s.slice(1).trimStart(); }

  // Accept only a plain dot-decimal magnitude; reject everything else (0).
  if (!/^\d+(?:\.\d+)?$/.test(s)) return 0;

  const n = Number(s);
  return Number.isFinite(n) ? sign * n : 0;
}

// Sum the `amount` of every row, rounded half-up to 2 decimals.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount);
  }

  // Round at the cent; the *100/Math.round/÷100 dance absorbs binary-float drift.
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

module.exports = { sumAmounts };
