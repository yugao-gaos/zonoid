'use strict';

// Parses a monetary string tolerating en-US (1,234.56) and de-DE (1.234,56) formats.
function parseMonetary(str) {
  if (typeof str !== 'string') return NaN;
  const trimmed = str.trim();
  if (!trimmed) return NaN;

  const negative = /^[^0-9]*-/.test(trimmed);
  const s = trimmed.replace(/[^0-9.,]/g, '');
  if (!s) return NaN;

  const lastComma = s.lastIndexOf(',');
  const lastDot   = s.lastIndexOf('.');
  let normalized;

  if (lastComma !== -1 && lastDot !== -1) {
    normalized = lastDot > lastComma
      ? s.replace(/,/g, '')                       // en-US: 1,234.56
      : s.replace(/\./g, '').replace(',', '.');   // de-DE: 1.234,56
  } else if (lastComma !== -1) {
    const fracLen = s.length - lastComma - 1;
    normalized = fracLen <= 2
      ? s.replace(',', '.')   // decimal comma: 1,50
      : s.replace(/,/g, ''); // thousands comma: 1,234
  } else {
    const dotCount = (s.match(/\./g) || []).length;
    normalized = dotCount > 1 ? s.replace(/\./g, '') : s;
  }

  const val = parseFloat(normalized);
  if (isNaN(val)) return NaN;
  return negative ? -val : val;
}

function sumAmounts(rows) {
  if (!rows || !rows.length) return 0;
  let total = 0;
  for (const row of rows) {
    const val = parseMonetary(row.amount);
    if (!isNaN(val)) total += val;
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
