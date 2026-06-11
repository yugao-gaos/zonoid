'use strict';

// Parse one amount string into a Number.
// Accepts optional surrounding whitespace, a leading `$`, and a `-`/`+` sign
// (sign and symbol in either order). Anything else contributes 0.
function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;
  const s = raw.trim();
  if (!s) return 0;

  // [sign?] [$?] [sign?] digits[.digits]
  const m = s.match(/^([+-]?)\$?([+-]?)(\d+(?:\.\d+)?)$/);
  if (!m) return 0;

  const num = parseFloat(m[3]);
  if (!Number.isFinite(num)) return 0;

  const negative = m[1] === '-' || m[2] === '-';
  return negative ? -num : num;
}

// Round to 2 decimals, half-up (away from zero), correcting float drift.
function round2(n) {
  const sign = n < 0 ? -1 : 1;
  const r = (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
  return r + 0; // normalize -0 to 0
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
