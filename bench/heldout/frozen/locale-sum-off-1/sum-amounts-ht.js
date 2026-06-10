'use strict';

// Parse one amount string into an integer number of cents (signed), or null if
// the value is missing / empty / not a parseable monetary value.
//
// Working in integer cents keeps the running total exact: we never accumulate
// floats, so there is no drift (e.g. 0.1 + 0.2 problems) and no x.xx5 rounding
// ambiguity from non-representable doubles.
function parseToCents(amount) {
  if (typeof amount !== 'string') return null;

  const s = amount.trim();
  if (s === '') return null;

  // Optional leading sign and/or '$' in either order, then digits with an
  // optional fractional part. Anything else is "not a monetary value".
  const m = s.match(/^([+-]?)\s*\$?\s*([+-]?)\s*(\d+)?(?:\.(\d+))?$/);
  if (!m) return null;

  const intPart = m[3] || '';
  const fracPart = m[4] || '';
  if (intPart === '' && fracPart === '') return null; // no digits at all

  const negative = m[1] === '-' || m[2] === '-';

  let cents = Number(intPart || '0') * 100;
  cents += Number((fracPart + '00').slice(0, 2)); // first two decimal digits

  // Half-up (away from zero) at the cent: a 3rd decimal digit of 5..9 rounds up.
  const rest = fracPart.slice(2);
  if (rest.length && rest[0] >= '5') cents += 1;

  return negative ? -cents : cents;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let totalCents = 0;
  for (const row of rows) {
    const cents = parseToCents(row && row.amount);
    if (cents !== null) totalCents += cents; // bad rows contribute 0
  }

  return totalCents / 100;
}

module.exports = { sumAmounts };
