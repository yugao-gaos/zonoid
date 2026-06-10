'use strict';

// sumAmounts(rows) -> grand total of the export's string `amount` field, as a Number
// rounded to 2 decimals. Bad/missing/unparseable rows contribute 0 (never throw, never NaN).
//
// IMPORTANT (empirical, not in the spec): the real upstream billing export intermixes TWO
// locale conventions in the `amount` strings, per-row:
//   - en-US: dot decimal, comma thousands   -> "1234.56", "$19.95", "1,234.56"
//   - de-DE: comma decimal, dot thousands    -> "1.234,56" (=1234.56), "99,90" (=99.90), "2.500,00" (=2500)
// A naive Number()/parseFloat() after stripping $ and sign is WRONG on every European row:
// Number("1.234,56") is NaN (row silently dropped) and parseFloat("99,90") is 99 (cents lost).
// So we locale-normalize each amount before Number():
//   the LAST '.'/',' separator is the decimal point; any other separator is a thousands group.

function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;

  // Strip currency symbol and surrounding whitespace.
  let s = raw.replace(/\$/g, '').trim();
  if (s === '') return 0;

  // Honor a leading sign.
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1).trim(); }
  else if (s[0] === '+') { s = s.slice(1).trim(); }
  if (s === '') return 0;

  // Locale-normalize: the last separator is the decimal point; strip the rest as grouping.
  const decPos = Math.max(s.lastIndexOf('.'), s.lastIndexOf(','));
  if (decPos !== -1) {
    const intPart = s.slice(0, decPos).replace(/[.,]/g, '');
    const fracPart = s.slice(decPos + 1);
    s = intPart + '.' + fracPart;
  }

  // Number() yields NaN for any non-numeric leftover (stray text, empty); skip those as 0.
  const n = Number(s);
  return Number.isFinite(n) ? sign * n : 0;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount);
  }

  // Half-up rounding at the cent; EPSILON nudge tames binary-float representation error.
  const rounded = Math.round((total + Number.EPSILON) * 100) / 100;
  // Normalize -0 to 0.
  return rounded === 0 ? 0 : rounded;
}

module.exports = { sumAmounts };
