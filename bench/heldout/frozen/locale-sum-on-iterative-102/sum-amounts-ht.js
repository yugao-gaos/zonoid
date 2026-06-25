'use strict';

// The upstream export mixes en-US (dot-decimal) and de-DE (comma-decimal) amount strings.
// Disambiguation: when both separators appear the rightmost one is decimal; when only a
// comma appears, 3-digit suffix → thousands, otherwise → decimal (de-DE cents: "99,90").
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;

  const negative = s.includes('-');
  const digits = s.replace(/[^0-9,.]/g, '');
  if (!digits) return 0;

  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');

  let normalized;
  if (lastComma !== -1 && lastDot !== -1) {
    if (lastComma > lastDot) {
      // de-DE: dots are thousands, comma is decimal
      normalized = digits.replace(/\./g, '').replace(',', '.');
    } else {
      // en-US: commas are thousands, dot is decimal
      normalized = digits.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    const afterComma = digits.slice(lastComma + 1);
    if (afterComma.length === 3) {
      // Thousands separator (e.g. "1,234")
      normalized = digits.replace(/,/g, '');
    } else {
      // Decimal separator (e.g. "99,90" de-DE)
      normalized = digits.slice(0, lastComma) + '.' + afterComma;
    }
  } else {
    normalized = digits;
  }

  const n = parseFloat(normalized);
  if (isNaN(n)) return 0;
  return negative ? -n : n;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
