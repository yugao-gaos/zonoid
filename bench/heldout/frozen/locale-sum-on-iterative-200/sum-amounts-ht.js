'use strict';

// The billing feed mixes en-US dot-decimal ("1,234.56") and de-DE comma-decimal
// ("99,90", "1.234,56") formats. Detect by position of the last dot vs last comma.
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/^\$/, '').trim();
  if (!s) return 0;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let normalized;
  if (lastDot === -1 && lastComma === -1) {
    normalized = s;
  } else if (lastDot > lastComma) {
    // dot is decimal separator (en-US): strip thousands commas
    normalized = s.replace(/,/g, '');
  } else {
    // comma is the rightmost separator
    if (lastDot === -1) {
      // only commas — if exactly 3 digits follow, it's an en-US thousands sep; otherwise de-DE decimal
      const afterComma = s.slice(lastComma + 1).replace(/\D/g, '');
      normalized = afterComma.length === 3
        ? s.replace(/,/g, '')          // en-US: "1,234"
        : s.replace(',', '.');         // de-DE: "99,90"
    } else {
      // both present, comma last (de-DE): "1.234,56"
      normalized = s.replace(/\./g, '').replace(',', '.');
    }
  }

  const n = parseFloat(normalized);
  return isNaN(n) ? 0 : n;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  const sum = rows.reduce((acc, row) => acc + parseAmount(row && row.amount), 0);
  return Math.round(sum * 100) / 100;
}

module.exports = { sumAmounts };
