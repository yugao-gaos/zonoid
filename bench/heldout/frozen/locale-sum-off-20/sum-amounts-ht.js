'use strict';

// sumAmounts(rows) -> Number
//
// Sum a feed of line items whose `amount` is serialized as a STRING (the upstream
// export never emits JSON numbers). Returns the grand total as a Number, rounded
// to 2 decimals (half-up at the cent). Bad/empty/unparseable rows contribute 0.
//
// NOTE (empirical, from the real upstream billing export — NOT visible in the spec
// examples): the feed mixes en-US ("1,234.56") and de-DE ("1.234,56") decimal
// conventions, sometimes per-row. A naive Number()/parseFloat would return NaN on
// the de-DE rows or silently mis-scale them. So we detect the decimal separator
// per amount before normalizing.

// Parse one monetary string into a Number of currency units, or null if it isn't
// a parseable amount.
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  let s = raw.trim();
  if (s === '') return null;

  // Strip a leading currency symbol (and any stray spaces left around it).
  s = s.replace(/[$€£]/g, '').trim();

  // Honor a leading sign.
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1); }
  else if (s[0] === '+') { s = s.slice(1); }
  s = s.trim();
  if (s === '') return null;

  // From here the string must be digits plus grouping/decimal separators only.
  if (!/^[\d.,]+$/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let decSep = null; // '.' | ',' | null (no fractional part)

  if (lastDot !== -1 && lastComma !== -1) {
    // Both separators present → the rightmost one is the decimal separator,
    // the other is the thousands grouping separator.
    decSep = lastDot > lastComma ? '.' : ',';
  } else if (lastDot !== -1 || lastComma !== -1) {
    // Exactly one kind of separator present — could be decimal or grouping.
    const sep = lastDot !== -1 ? '.' : ',';
    const occurrences = s.split(sep).length - 1;
    const trailing = s.length - 1 - s.lastIndexOf(sep); // digits after last sep

    if (occurrences > 1) {
      // e.g. "1.234.567" or "1,234,567" → pure grouping, no decimal part.
      decSep = null;
    } else if (trailing === 3) {
      // A single separator with exactly 3 trailing digits (e.g. "1,234" /
      // "1.500") is, for money, a thousands group rather than a fraction.
      decSep = null;
    } else {
      // 1, 2, or 4+ trailing digits → it's the decimal separator.
      decSep = sep;
    }
  }

  let normalized;
  if (decSep) {
    const thouSep = decSep === '.' ? ',' : '.';
    normalized = s.split(thouSep).join('').replace(decSep, '.');
  } else {
    // No decimal separator: every '.'/',' was grouping.
    normalized = s.replace(/[.,]/g, '');
  }

  if (normalized === '' || normalized === '.') return null;

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;

  return sign * n;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  // Accumulate in integer cents to avoid floating-point drift across the feed.
  let cents = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (value === null) continue;
    cents += Math.round(value * 100);
  }

  // Final total as a clean 2-decimal Number (per-row Math.round already settled
  // each amount at the cent). Normalize -0 → 0.
  const total = cents / 100;
  return total === 0 ? 0 : total;
}

module.exports = { sumAmounts };
