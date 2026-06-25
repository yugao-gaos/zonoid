'use strict';

// KB override: real feed mixes en-US (1,234.56) and de-DE (1.234,56) formats.
// Heuristic: whichever of '.' or ',' appears last is the decimal separator.
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = raw.trim().replace(/\$/g, '');
  if (!s || s === '-' || s === '+') return 0;

  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;

  const lastDot = abs.lastIndexOf('.');
  const lastComma = abs.lastIndexOf(',');

  let normalized;
  if (lastDot > lastComma) {
    // dot is decimal — strip commas (thousands)
    normalized = abs.replace(/,/g, '');
  } else if (lastComma > lastDot) {
    // comma is decimal — strip dots (thousands), swap comma→dot
    normalized = abs.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = abs;
  }

  const val = parseFloat(normalized);
  if (!isFinite(val)) return 0;
  return neg ? -val : val;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let sum = 0;
  for (const row of rows) {
    sum += parseAmount(row.amount);
  }
  return Math.round(sum * 100) / 100;
}

module.exports = { sumAmounts };
