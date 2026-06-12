'use strict';

// sumAmounts(rows) — sum a feed of money-as-string line items into a Number,
// rounded to 2 decimals (half away from zero at the cent).
//
// NOTE (empirical, from the real upstream billing export — NOT stated in the
// task prose): the `amount` strings are serialized in TWO intermixed locale
// conventions per-row:
//   - en-US: dot is the decimal separator, comma groups thousands  ("1,234.56")
//   - de-DE: comma is the decimal separator, dot groups thousands   ("1.234,56")
// A naive parseFloat/Number silently mis-sums the de-DE rows
// (parseFloat("99,90") === 99, not 99.9). So we normalize each amount with a
// "last separator wins is the decimal" rule before parsing.

// Parse a single amount string into a finite Number, or return null if it is
// missing / empty / not a parseable monetary value (caller treats null as 0).
function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  // Strip whitespace and the (informational) currency symbol.
  let s = raw.replace(/\s+/g, '');
  if (s === '') return null;

  // Honor a sign anywhere in the leading symbol/sign cluster ("-$5", "$-5").
  const negative = s.indexOf('-') !== -1;

  // Numeric core: digits and the two separator chars only.
  const core = s.replace(/[^0-9.,]/g, '');
  if (core === '' || !/[0-9]/.test(core)) return null;

  const normalized = normalizeNumeric(core);
  const value = parseFloat(normalized);
  if (!Number.isFinite(value)) return null;

  return negative ? -value : value;
}

// Collapse a digits/dots/commas string into a plain JS numeric string by
// deciding which separator is the decimal point and dropping the grouping one.
function normalizeNumeric(core) {
  const lastDot = core.lastIndexOf('.');
  const lastComma = core.lastIndexOf(',');

  let decimalSep = '';
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: whichever appears last is the decimal separator.
    decimalSep = lastDot > lastComma ? '.' : ',';
  } else if (lastDot !== -1) {
    // Only dots: a single dot is a decimal point; multiple dots are de-DE
    // thousands groupers (e.g. "1.234.567") with no decimal part.
    decimalSep = core.indexOf('.') === lastDot ? '.' : '';
  } else if (lastComma !== -1) {
    // Only commas: a single comma is a de-DE decimal; multiple are groupers.
    decimalSep = core.indexOf(',') === lastComma ? ',' : '';
  }

  let out = '';
  for (const ch of core) {
    if (ch === '.' || ch === ',') {
      if (ch === decimalSep) out += '.'; // keep as the canonical decimal point
      // otherwise it is a thousands separator — drop it
    } else {
      out += ch;
    }
  }
  return out;
}

// Round half away from zero to 2 decimals, robust to binary float drift.
function roundCents(n) {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (value !== null) total += value;
  }

  return roundCents(total);
}

module.exports = { sumAmounts };
