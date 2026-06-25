'use strict';

// sumAmounts(rows) — sum a feed of string-serialized monetary amounts into a Number.
//
// The upstream billing export serializes money as text and mixes two locale
// conventions per-row: en-US ("1,234.56" — comma thousands, dot decimal) and
// de-DE ("1.234,56" — dot thousands, comma decimal). A naive Number()/parseFloat
// returns NaN or the wrong magnitude on de-DE rows, so each amount is normalized
// to a canonical "1234.56" form before parsing. Unparseable rows contribute 0.

function disambiguateSingleSeparator(s, sep) {
  // Exactly one kind of separator is present. Decide thousands vs decimal.
  const parts = s.split(sep);
  if (parts.length > 2) {
    // Repeated separator can only be a thousands grouping (e.g. "1.234.567").
    return parts.join('');
  }
  const after = parts[1];
  if (after.length === 3) {
    // Ambiguous; with money carrying 2 decimal places, 3 trailing digits is a
    // thousands group (e.g. en-US "1,234" / de-DE "1.234").
    return parts.join('');
  }
  // 1-2 trailing digits -> it's the decimal separator.
  return parts[0] + '.' + after;
}

function parseAmount(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === '') return null;

  // Strip whitespace and currency symbols.
  s = s.replace(/[\s$€£¥]/g, '');

  // Honor a leading sign.
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1); }
  else if (s[0] === '+') { s = s.slice(1); }
  if (s === '') return null;

  const hasDot = s.indexOf('.') !== -1;
  const hasComma = s.indexOf(',') !== -1;

  let normalized;
  if (hasDot && hasComma) {
    // Both present: the rightmost separator is the decimal point, the other is
    // a thousands grouping — covers both "1,234.56" and "1.234,56".
    const decSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thouSep = decSep === '.' ? ',' : '.';
    normalized = s.split(thouSep).join('').replace(decSep, '.');
  } else if (hasComma) {
    normalized = disambiguateSingleSeparator(s, ',');
  } else if (hasDot) {
    normalized = disambiguateSingleSeparator(s, '.');
  } else {
    normalized = s;
  }

  // Canonical form is digits with at most one dot; reject anything else.
  if (!/^\d*\.?\d+$/.test(normalized)) return null;

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return sign * n;
}

function round2(n) {
  // Half-up at the cent (away from zero), with a small nudge against binary
  // floating-point drift (e.g. 0.005 -> 0.01).
  const sign = n < 0 ? -1 : 1;
  const rounded = Math.round(Math.abs(n) * 100 + 1e-9);
  return (sign * rounded) / 100;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    if (row == null) continue;
    const value = parseAmount(row.amount);
    if (value !== null) total += value;
  }
  return round2(total);
}

module.exports = { sumAmounts };
