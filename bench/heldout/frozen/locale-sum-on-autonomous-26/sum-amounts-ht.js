'use strict';

// Parse one row's `amount` string into a Number. Anything missing, empty, or
// not a plain monetary value contributes 0 (caller never sees NaN).
function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;

  // Strip insignificant whitespace and an optional leading currency symbol.
  // The sign and `$` may appear in either order ("-$30" or "$-30").
  const s = raw.trim().replace('$', '').trim();
  if (s === '') return 0;

  // Accept only a plain decimal: optional sign, then digits with optional
  // fractional part (or a leading-dot fraction like ".99").
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(s)) return 0;

  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

// Round to 2 decimals, half away from zero, with a small epsilon to absorb
// binary-float representation error (e.g. 0.005 * 100 -> 0.4999...).
function round2(n) {
  const r = Math.round(Math.abs(n) * 100 + 1e-9) / 100;
  if (r === 0) return 0; // collapse -0 to 0
  return n < 0 ? -r : r;
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
