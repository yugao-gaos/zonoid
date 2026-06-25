'use strict';

// sumAmounts(rows) — total an upstream billing feed of string `amount`s.
//
// The prose spec only shows en-US dot-decimal amounts (e.g. "1234.99"), but the
// real upstream export serializes money in TWO locale conventions, intermixed
// per row: en-US (dot decimal, comma thousands — "1,234.56") AND de-DE
// (comma decimal, dot thousands — "1.234,56" / "99,90"). A naive parseFloat /
// Number silently mis-sums the de-DE rows (parseFloat("99,90") === 99, not
// 99.9), so we normalize each amount to a canonical numeric string first.

// Parse one amount string into a Number, honoring sign and locale.
// Returns null for anything that isn't a parseable monetary value (skip it).
function parseAmount(raw) {
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  // Strip surrounding whitespace, then any currency symbols / inner spaces.
  let s = raw.trim().replace(/[$\s]/g, '');
  if (s === '') return null;

  // Honor a leading sign.
  let sign = 1;
  if (s[0] === '+' || s[0] === '-') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1);
  }
  if (s === '') return null;

  // After symbol/sign removal only digits and separators may remain.
  if (!/^[0-9.,]+$/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let normalized;

  if (lastDot !== -1 && lastComma !== -1) {
    // Both separators present: the rightmost one is the decimal point,
    // the other is a thousands grouping to strip.
    if (lastDot > lastComma) {
      normalized = s.replace(/,/g, '');          // en-US: 1,234.56
    } else {
      normalized = s.replace(/\./g, '').replace(',', '.'); // de-DE: 1.234,56
    }
  } else if (lastComma !== -1) {
    normalized = resolveSingleSeparator(s, ',');
  } else if (lastDot !== -1) {
    normalized = resolveSingleSeparator(s, '.');
  } else {
    normalized = s; // pure digits
  }

  const val = parseFloat(normalized);
  if (!isFinite(val)) return null;
  return sign * val;
}

// Only one kind of separator appears. Decide decimal vs. thousands.
//   - Appears more than once  -> thousands grouping (strip it).
//   - Appears once, followed by exactly 3 digits with a 1-3 digit head
//     (e.g. "1,234" / "100.000") -> thousands grouping.
//   - Otherwise -> decimal separator.
function resolveSingleSeparator(s, sep) {
  const parts = s.split(sep);
  if (parts.length > 2) {
    return parts.join(''); // 1,234,567 / 1.234.567
  }
  const [before, after] = parts;
  if (after.length === 3 && before.length >= 1 && before.length <= 3) {
    return before + after; // thousands grouping
  }
  return before + '.' + after; // decimal
}

// Round to cents, half-up (away from zero). The epsilon nudge defeats binary
// float undershoot (e.g. a true x.xx5 stored as x.xx4999…).
function round2(n) {
  const r = Math.round((Math.abs(n) + 1e-9) * 100) / 100;
  const out = n < 0 ? -r : r;
  return out || 0; // normalize -0 (and any stray NaN) to 0
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const val = parseAmount(row.amount);
    if (val !== null) total += val;
  }
  return round2(total);
}

module.exports = { sumAmounts };
