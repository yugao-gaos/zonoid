'use strict';

// The upstream billing export intermixes en-US (1,234.56) and de-DE (1.234,56)
// decimal formats in the same feed. Disambiguate by which separator appears last.
function parseAmount(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;

  // Strip leading currency symbol and optional whitespace after it
  s = s.replace(/^[^0-9\-+,.]+/, '').trim();
  if (!s) return 0;

  const hasComma = s.includes(',');
  const hasDot   = s.includes('.');

  let normalized;
  if (hasComma && hasDot) {
    // Whichever separator comes last is the decimal separator
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      // de-DE: 1.234,56 → remove dots, comma → dot
      normalized = s.replace(/\./g, '').replace(',', '.');
    } else {
      // en-US: 1,234.56 → remove commas
      normalized = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Comma only — decimal if exactly 1-2 digits follow it, else thousands separator
    const afterComma = s.slice(s.lastIndexOf(',') + 1);
    normalized = /^\d{1,2}$/.test(afterComma)
      ? s.replace(',', '.')
      : s.replace(/,/g, '');
  } else {
    normalized = s;
  }

  const v = parseFloat(normalized);
  return isFinite(v) ? v : 0;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
