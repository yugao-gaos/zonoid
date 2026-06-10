'use strict';

// sumAmounts(rows) — total an upstream billing feed of string-rendered amounts.
//
// The export serializes money as text in TWO intermixed locale conventions:
//   - en-US: dot decimal, e.g. "1234.56", "$19.95"
//   - de-DE: comma decimal + dot thousands, e.g. "1.234,56" (=1234.56),
//            "99,90" (=99.90), "2.500,00" (=2500)
// A naive Number()/parseFloat after stripping $ and sign is WRONG on every
// European row (NaN -> row dropped, or cents truncated), so each amount is
// locale-normalized to a plain dot-decimal string before Number().

function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  // strip surrounding whitespace and any currency symbol
  let s = raw.trim().replace(/\$/g, '').trim();
  if (s === '') return null;

  // leading sign (handles "-$30.00" and "$-30.00" alike, $ already gone)
  let sign = 1;
  if (s[0] === '-' || s[0] === '+') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1).trim();
  }
  if (s === '') return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    // both present: the later separator is the decimal point
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(/,/g, '.'); // comma decimal, dot thousands
    } else {
      s = s.replace(/,/g, ''); // dot decimal, comma thousands
    }
  } else if (lastComma !== -1) {
    // only comma(s): comma is the decimal separator (de-DE)
    s = s.replace(/,/g, '.');
  }
  // only dot(s) or neither: already in dot-decimal form

  // keep the last '.' as the decimal point, drop any earlier ones (grouping)
  const di = s.lastIndexOf('.');
  if (di !== -1) {
    s = s.slice(0, di).replace(/\./g, '') + '.' + s.slice(di + 1);
  }

  if (!/^[0-9]+(\.[0-9]+)?$/.test(s)) return null;

  const n = Number(s);
  return Number.isFinite(n) ? sign * n : null;
}

function round2(n) {
  const sign = n < 0 ? -1 : 1;
  // half-up on magnitude; EPSILON nudge absorbs float-sum drift at the cent
  return sign * (Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100);
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    const raw = row == null ? null : row.amount;
    const value = parseAmount(raw);
    if (value === null) continue; // skip missing / empty / unparseable rows
    total += value;
  }

  return round2(total);
}

module.exports = { sumAmounts };
