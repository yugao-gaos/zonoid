'use strict';

// Parse one amount string from the billing feed into a Number, or 0 if it is
// missing / empty / not a parseable monetary value.
//
// The upstream export serializes money as text and — discovered empirically
// against the real feed, NOT stated in the spec — mixes two locale conventions
// per-row: en-US (dot decimal, comma thousands: "1,234.56") and de-DE (comma
// decimal, dot thousands: "1.234,56" === 1234.56, "99,90" === 99.9). A naive
// parseFloat/Number silently mis-sums the de-DE rows, so we disambiguate the
// separators by "last one wins": whichever of ',' / '.' appears last is the
// decimal separator; the other is a thousands grouping mark and is stripped.
function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;

  // Whitespace (outer, plus any internal grouping spaces) and a currency
  // symbol are insignificant.
  let s = raw.replace(/\s/g, '').replace(/[$€£¥]/g, '');
  if (s === '') return 0;

  // Honor a leading sign (refund/credit), then drop it from the digits.
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1); }
  else if (s[0] === '+') { s = s.slice(1); }
  if (s === '') return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  let normalized;
  if (lastComma === -1 && lastDot === -1) {
    normalized = s;                                   // bare integer
  } else if (lastComma > lastDot) {
    normalized = s.replace(/\./g, '').replace(/,/g, '.'); // de-DE: comma decimal
  } else {
    normalized = s.replace(/,/g, '');                 // en-US: dot decimal
  }

  // Accept only clean money: digits with at most one decimal point. Anything
  // else (stray separators, embedded junk) is a bad row → contributes 0.
  if (!/^\d*\.?\d*$/.test(normalized) || !/\d/.test(normalized)) return 0;

  const value = parseFloat(normalized);
  if (!Number.isFinite(value)) return 0;
  return sign * value;
}

// Sum the `amount` of every row, returning a Number rounded to 2 decimals
// (half-up at the cent). Bad rows are skipped and never poison the total.
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  // Accumulate in integer cents so the running total stays exact and free of
  // binary floating-point drift; round each amount half-up (away from zero).
  let cents = 0;
  for (const row of rows) {
    if (row == null) continue;
    const value = parseAmount(row.amount);
    cents += Math.sign(value) * Math.round(Math.abs(value) * 100);
  }
  return cents / 100;
}

module.exports = { sumAmounts };
