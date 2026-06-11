'use strict';

// sumAmounts(rows) — total a feed of line items whose `amount` is a money string.
//
// The upstream export serializes money as text and, empirically, mixes two locale
// conventions per-row:
//   en-US: "1,234.56"  (comma = grouping, dot   = decimal)
//   de-DE: "1.234,56"  (dot   = grouping, comma = decimal)
// A naive Number()/parseFloat over that feed yields NaN or a wrong total, so amounts
// are normalized with a separator-aware parser before summing. A row whose amount is
// missing/empty/unparseable contributes 0 rather than throwing or poisoning the sum.

// Parse one amount string to a Number, or null if it isn't a parseable monetary value.
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  let s = raw.replace(/[\s$]/g, ''); // drop whitespace and currency symbol
  if (!s) return null;

  let neg = false;
  if (s[0] === '+') s = s.slice(1);
  else if (s[0] === '-') { neg = true; s = s.slice(1); }
  if (!s || !/^[0-9.,]+$/.test(s)) return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let intPart;
  let fracPart;

  if (lastDot !== -1 && lastComma !== -1) {
    // Both separators present: the later one is the decimal mark; the other is grouping.
    const decPos = Math.max(lastDot, lastComma);
    intPart = s.slice(0, decPos).replace(/[.,]/g, '');
    fracPart = s.slice(decPos + 1).replace(/[.,]/g, '');
  } else if (lastDot !== -1 || lastComma !== -1) {
    // A single separator type. Disambiguate decimal vs grouping.
    const pos = lastDot !== -1 ? lastDot : lastComma;
    const sep = lastDot !== -1 ? '.' : ',';
    const occurrences = s.split(sep).length - 1;
    const digitsAfter = s.length - pos - 1;
    const digitsBefore = pos;

    const isGrouping =
      occurrences > 1 || // "1,234,567" can only be grouping
      // a lone separator with exactly 3 trailing digits reads as thousands grouping
      // (money rarely carries 3 decimal places), e.g. "1,234" / "1.234" -> 1234
      (occurrences === 1 && digitsAfter === 3 && digitsBefore >= 1 && digitsBefore <= 3);

    if (isGrouping) {
      intPart = s.replace(/[.,]/g, '');
      fracPart = '';
    } else {
      intPart = s.slice(0, pos);
      fracPart = s.slice(pos + 1);
    }
  } else {
    intPart = s;
    fracPart = '';
  }

  if (intPart === '') intPart = '0';
  if (!/^[0-9]*$/.test(intPart) || !/^[0-9]*$/.test(fracPart)) return null;

  const num = Number(intPart + '.' + (fracPart || '0'));
  if (!Number.isFinite(num)) return null;

  return neg ? -num : num;
}

// Round half-up at the cent, symmetric about zero, with an epsilon nudge for fp drift.
function round2(n) {
  const r = Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
  if (r === 0) return 0; // normalize -0 -> 0
  return n < 0 ? -r : r;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (value === null) continue;
    total += value;
  }

  return round2(total);
}

module.exports = { sumAmounts };
