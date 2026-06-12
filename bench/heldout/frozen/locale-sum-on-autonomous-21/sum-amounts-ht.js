'use strict';

// Sum a feed of line items whose `amount` is a money string.
// Returns the grand total as a Number rounded to 2 decimals (cents).
// Unparseable / missing / empty amounts contribute 0 and never throw.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;

  for (const row of rows) {
    if (!row || typeof row.amount !== 'string') continue;

    // Strip whitespace and the currency symbol; the symbol may sit on
    // either side of the sign ("-$30.00" or "$-30.00").
    let s = row.amount.replace(/\$/g, '').trim();
    if (s === '') continue;

    let sign = 1;
    if (s[0] === '-') {
      sign = -1;
      s = s.slice(1).trim();
    } else if (s[0] === '+') {
      s = s.slice(1).trim();
    }

    // Only a plain decimal magnitude is a valid monetary value.
    if (!/^(\d+(\.\d+)?|\.\d+)$/.test(s)) continue;

    const val = Number(s);
    if (!Number.isFinite(val)) continue;

    total += sign * val;
  }

  // Round to cents, half away from zero, with an epsilon guard against
  // binary-float drift (e.g. 19.95 * 100 === 1994.9999999999998).
  const cents = total * 100;
  const rounded = Math.sign(cents) * Math.round(Math.abs(cents) + 1e-9);
  const result = rounded / 100;

  return result === 0 ? 0 : result; // normalize -0 → 0
}

module.exports = { sumAmounts };
