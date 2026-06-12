'use strict';

// Detects en-US (dot-decimal) vs de-DE (comma-decimal) from the position of the
// last separator character, with a disambiguation rule for bare thousands commas
// (e.g. "1,234" — comma followed by exactly 3 digits and no dot → en-US thousands).
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/^\$/, '').trim();
  if (!s) return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot   = s.lastIndexOf('.');

  let normalized;
  if (lastComma > lastDot) {
    const afterComma = s.slice(lastComma + 1).replace(/\D/g, '');
    if (afterComma.length === 3 && lastDot === -1) {
      // e.g. "1,234" — comma is thousands separator, no decimal part
      normalized = s.replace(/,/g, '');
    } else {
      // de-DE: "99,90" or "1.234,56" — comma is decimal separator
      normalized = s.replace(/\./g, '').replace(',', '.');
    }
  } else {
    // en-US dot-decimal (or no separator at all)
    normalized = s.replace(/,/g, '');
  }

  const val = parseFloat(normalized);
  return isNaN(val) ? 0 : val;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount);
  }
  return Math.round(total * 100 + Number.EPSILON) / 100;
}

module.exports = { sumAmounts };
