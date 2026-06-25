'use strict';

function parseAmount(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;

  // Strip leading currency symbol and optional surrounding whitespace
  s = s.replace(/^\s*[$]\s*/, '');

  // Extract sign, then work with the absolute value string
  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).trim();
  }

  // Locale normalisation:
  //   Both '.' and ',': last separator is decimal, strip the other (thousands)
  //   Only ',': comma is the decimal point
  //   Only '.': standard en-US, leave as-is
  const hasDot   = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    const lastDot   = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastComma > lastDot) {
      // de-DE: "1.234,56" — dot is thousands, comma is decimal
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // en-US with thousands: "1,234.56" — comma is thousands, dot is decimal
      s = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Only comma: de-DE decimal, e.g. "99,90"
    s = s.replace(',', '.');
  }

  const v = parseFloat(s);
  if (isNaN(v)) return 0;
  return negative ? -v : v;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
