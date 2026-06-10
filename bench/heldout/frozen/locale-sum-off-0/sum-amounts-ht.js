'use strict';

// Sum a feed of line-item amounts (each rendered as a money string) into a
// grand total Number, rounded half-away-from-zero to the cent. Bad/empty/
// unparseable rows contribute 0 and never poison the total with NaN.

// Accepts an optional sign and an optional leading `$`, in either order, around
// a plain decimal. All internal whitespace is stripped first, so `' $19.95 '`
// and `'$ 19.95'` both parse. Anything else (e.g. `'abc'`, `''`, `'12.3.4'`)
// fails to match and is skipped.
const AMOUNT_RE = /^([-+]?)\$?([-+]?)(\d+(?:\.\d+)?)$/;

function parseAmount(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/\s/g, '');
  if (s === '') return null;
  const m = s.match(AMOUNT_RE);
  if (!m) return null;
  const value = Number(m[3]);
  if (!Number.isFinite(value)) return null;
  const negative = m[1] === '-' || m[2] === '-';
  return negative ? -value : value;
}

function round2(n) {
  // Half away from zero, with an epsilon nudge to defeat binary-float
  // representation error (e.g. 1.005 -> 1.01 instead of 1.00).
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    if (!row) continue;
    const amount = parseAmount(row.amount);
    if (amount === null) continue;
    total += amount;
  }
  // `+ 0` normalizes a possible -0 to 0.
  return round2(total) + 0;
}

module.exports = { sumAmounts };
