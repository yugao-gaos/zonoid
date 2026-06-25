'use strict';

// sumAmounts(rows) — sum a feed of monetary line items into a grand total.
//
// Each row carries `amount` as a STRING (money is serialized as text, never a
// JSON number). The grand total is returned as a Number rounded to 2 decimals.
//
// The upstream export does not normalize locale: amount strings arrive mixed,
// per-row, in two conventions — so a naive parseFloat/Number() silently
// misreads the comma-decimal rows and poisons the total:
//   - en-US: "1,234.56" -> 1234.56   ('.' decimal, ',' thousands)
//   - de-DE: "1.234,56" -> 1234.56   (',' decimal, '.' thousands)  e.g. "99,90" -> 99.9
// Any row whose amount is missing/empty/unparseable contributes 0 (never NaN).

function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  let s = raw.trim();
  if (s === '') return null;

  // Strip a leading currency symbol and honor an explicit sign (either order,
  // e.g. "$-5", "-$5", "+5").
  s = s.replace(/\$/g, '').trim();
  let sign = 1;
  if (s[0] === '-' || s[0] === '+') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1).trim();
  }

  // After symbol/sign stripping only digits and ./, separators may remain.
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return null;

  const hasDot = s.indexOf('.') !== -1;
  const hasComma = s.indexOf(',') !== -1;
  let normalized;

  if (hasDot && hasComma) {
    // Both separators present: the LAST one to appear is the decimal point,
    // the other is the thousands grouping separator.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      normalized = s.replace(/\./g, '').replace(',', '.'); // de-DE
    } else {
      normalized = s.replace(/,/g, ''); // en-US
    }
  } else if (hasComma) {
    normalized = disambiguateSingle(s, ',');
  } else if (hasDot) {
    normalized = disambiguateSingle(s, '.');
  } else {
    normalized = s;
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return sign * n;
}

// A single kind of separator is present. It is a thousands grouping separator
// when it repeats, or when it splits the number into exactly one trailing group
// of 3 digits (e.g. "1,234" / "1.000" — money never carries 3 decimal places).
// Otherwise it is the decimal separator.
function disambiguateSingle(s, sep) {
  const parts = s.split(sep);
  const stripped = parts.join('');
  if (parts.length > 2) return stripped; // repeated -> grouping
  if (parts[1].length === 3 && parts[0].length >= 1) return stripped; // 1,234 -> 1234
  return parts[0] + '.' + parts[1]; // decimal
}

function round2(n) {
  if (!Number.isFinite(n)) return 0;
  const scaled = Math.abs(n) * 100;
  // +1e-9 absorbs binary-float artifacts and rounds a true half-cent away from
  // zero (standard money half-up).
  const r = (Math.sign(n) * Math.round(scaled + 1e-9)) / 100;
  return r === 0 ? 0 : r;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const amount = parseAmount(row.amount);
    if (amount !== null) total += amount;
  }
  return round2(total);
}

module.exports = { sumAmounts };
