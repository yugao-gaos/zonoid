'use strict';

// sumAmounts(rows) -> Number
//
// Sums an array of line items whose `amount` is a money STRING (the upstream
// export never serializes money as a JSON number). Returns the grand total as
// a Number rounded to 2 decimals. Bad/empty/unparseable rows contribute 0 and
// never throw or poison the total with NaN. The empty feed returns 0.
//
// The feed mixes locales: amounts may be en-US dot-decimal ("1,234.56") or
// de-DE comma-decimal ("1.234,56"). A naive parseFloat()/Number() drops the
// fractional part of comma-decimal strings (or returns NaN), so we resolve the
// decimal separator explicitly before parsing.

// Parse one money string into a Number, or return null if it is not a
// parseable monetary value (caller treats null as a skipped 0-contribution row).
function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  // Strip everything that is not a digit, separator, or sign: currency symbols
  // ($, EUR), thin spaces, alpha codes ("USD"), and surrounding whitespace.
  let s = raw.replace(/[^\d.,+-]/g, '');
  if (s === '') return null;

  // Honor a single leading sign; anything else with a stray sign is invalid.
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1); }
  else if (s[0] === '+') { s = s.slice(1); }
  if (s === '' || /[+-]/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  // Decide which separator (if any) is the decimal point.
  let decSep = null;
  if (lastDot !== -1 && lastComma !== -1) {
    // Both present: the rightmost one is the decimal separator, the other
    // is a thousands grouping separator.
    decSep = lastDot > lastComma ? '.' : ',';
  } else if (lastComma !== -1) {
    decSep = decideSingle(s, ',', lastComma);
  } else if (lastDot !== -1) {
    decSep = decideSingle(s, '.', lastDot);
  }

  let numStr;
  if (decSep) {
    const idx = s.lastIndexOf(decSep);
    const intPart = s.slice(0, idx).replace(/[.,]/g, '');
    const fracPart = s.slice(idx + 1).replace(/[.,]/g, '');
    if (intPart === '' && fracPart === '') return null;
    numStr = intPart + '.' + fracPart;
  } else {
    numStr = s.replace(/[.,]/g, '');
    if (numStr === '') return null;
  }

  const val = Number(numStr);
  if (!Number.isFinite(val)) return null;
  return sign * val;
}

// For a value with exactly one kind of separator, decide whether that
// separator is a decimal point or a thousands grouping mark. A single
// separator followed by exactly 3 digits ("1,234" / "1.000") reads as
// thousands grouping; otherwise it is the decimal point ("19,95", "0.99").
// Multiple occurrences ("1,234,567") are always grouping.
function decideSingle(s, sep, lastIdx) {
  const count = s.split(sep).length - 1;
  const digitsAfter = s.length - lastIdx - 1;
  if (count === 1 && digitsAfter !== 3) return sep;
  return null;
}

// Round to 2 decimals, half away from zero, robust to float drift; never -0.
function round2(n) {
  const sign = n < 0 ? -1 : 1;
  const r = (Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100) * sign;
  return r === 0 ? 0 : r;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    if (row == null) continue;
    const val = parseAmount(row.amount);
    if (val !== null) total += val;
  }
  return round2(total);
}

module.exports = { sumAmounts };
