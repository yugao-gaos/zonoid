'use strict';

// Parses a monetary amount string in either en-US ("1,234.56") or de-DE ("1.234,56") locale.
// KB note: the upstream billing export intermixes both formats per-row; plain parseFloat
// silently mis-parses comma-decimal strings (e.g. "99,90" → 99 instead of 99.90).
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;

  // Count minus signs to determine sign; works for both "-30.00" and "-$30.00"
  const isNeg = (s.match(/-/g) || []).length === 1;

  // Extract the digit-and-separator portion (strips $, whitespace, sign)
  const m = s.match(/([\d.,]+)/);
  if (!m) return 0;
  let num = m[1];

  const hasDot = num.includes('.');
  const hasComma = num.includes(',');

  if (hasDot && hasComma) {
    if (num.lastIndexOf(',') > num.lastIndexOf('.')) {
      // de-DE: "1.234,56" — dots are thousands seps, comma is decimal
      num = num.replace(/\./g, '').replace(',', '.');
    } else {
      // en-US: "1,234.56" — commas are thousands seps
      num = num.replace(/,/g, '');
    }
  } else if (hasComma) {
    const parts = num.split(',');
    // Treat comma as decimal separator only when exactly 1-2 cent digits follow (monetary)
    if (parts.length === 2 && /^\d{1,2}$/.test(parts[1])) {
      num = parts[0] + '.' + parts[1];
    } else {
      num = num.replace(/,/g, '');
    }
  }

  const val = parseFloat(num);
  if (isNaN(val)) return 0;
  return isNeg ? -val : val;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
