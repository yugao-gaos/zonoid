'use strict';

// sumAmounts(rows) — sum string-rendered monetary amounts into a Number,
// rounded to 2 decimals (half-up at the cent). Bad/missing rows contribute 0.

// Parse one row's `amount` string into a Number; return 0 if unparseable.
function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;
  let s = raw.trim();
  if (s === '') return 0;

  // Strip currency symbol(s), then re-trim around the bare value.
  s = s.replace(/\$/g, '').trim();

  // Pull off a leading sign (which may have sat before or after the symbol).
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1).trim(); }
  else if (s[0] === '+') { s = s.slice(1).trim(); }

  // Accept only a plain monetary value: digits with an optional decimal part.
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s)) return 0;

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return sign * n;
}

// Round half away from zero to 2 decimals, guarding float representation error.
function round2(n) {
  const sign = n < 0 ? -1 : 1;
  const r = (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
  return r === 0 ? 0 : r; // normalize -0
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
