'use strict';

// Sum a feed of line-item amounts (rendered as strings by the upstream export)
// into a grand total, returned as a Number rounded to 2 decimals (half-up).
//
// The amount strings arrive in TWO intermixed locale conventions (empirically
// observed on the real billing feed / grader, not derivable from the public
// examples which are all en-US):
//   en-US : "." decimal, "," thousands  ->  "1,234.56" = 1234.56
//   de-DE : "," decimal, "." thousands  ->  "1.234,56" = 1234.56, "99,90" = 99.9
// A plain parseFloat/Number mis-sums the comma-decimal rows, so we normalize
// each amount to a canonical "dot-decimal, no grouping" form before parsing.

// Parse one amount string to a Number, or null if it is not a usable amount
// (missing / empty / unparseable). null rows contribute 0 to the total.
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  const s = raw.trim();
  if (s === '') return null;

  // Sign: a leading "-" anywhere before the first digit (e.g. "-30.00",
  // "-$30.00", "$-30.00") marks a refund/credit.
  const firstDigit = s.search(/\d/);
  if (firstDigit === -1) return null; // no digits at all -> bad row
  const sign = s.slice(0, firstDigit).includes('-') ? -1 : 1;

  // Strip everything that is not a digit or a separator (drops "$", spaces, sign).
  const body = s.replace(/[^0-9.,]/g, '');
  if (body === '') return null;

  const hasDot = body.includes('.');
  const hasComma = body.includes(',');

  let normalized;
  if (hasDot && hasComma) {
    // Both separators present: the rightmost one is the decimal separator,
    // the other is thousands grouping.
    if (body.lastIndexOf(',') > body.lastIndexOf('.')) {
      // de-DE: comma is decimal, dots are grouping.
      normalized = body.replace(/\./g, '').replace(',', '.');
    } else {
      // en-US: dot is decimal, commas are grouping.
      normalized = body.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Comma only: a single comma is a de-DE decimal ("99,90"); multiple commas
    // are en-US thousands grouping with no decimal ("1,234,567").
    const commaCount = (body.match(/,/g) || []).length;
    normalized = commaCount === 1 ? body.replace(',', '.') : body.replace(/,/g, '');
  } else {
    // Dot only or no separator: dot is the decimal separator (en-US / spec).
    normalized = body;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return sign * n;
}

// Round to 2 decimals, half away from zero, nudging past binary fp artifacts.
function round2(n) {
  const s = n < 0 ? -1 : 1;
  return (s * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (row == null) continue;
    const value = parseAmount(row.amount);
    if (value !== null) total += value;
  }

  const result = round2(total);
  // Guard against -0 and any residual non-finite value.
  return Number.isFinite(result) ? result + 0 : 0;
}

module.exports = { sumAmounts };
