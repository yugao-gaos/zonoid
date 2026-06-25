'use strict';

function parseAmount(str) {
  if (typeof str !== 'string') return 0;
  let s = str.trim().replace(/\$/g, '');
  if (!s) return 0;

  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1); }
  else if (s[0] === '+') { s = s.slice(1); }

  s = s.replace(/[^0-9.,]/g, '');
  if (!s) return 0;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let normalized;
  if (lastDot !== -1 && lastComma !== -1) {
    // Whichever separator comes last is the decimal point
    normalized = lastComma > lastDot
      ? s.replace(/\./g, '').replace(',', '.')  // de-DE: 1.234,56
      : s.replace(/,/g, '');                     // en-US: 1,234.56
  } else if (lastComma !== -1) {
    // Only comma present — de-DE decimal (e.g. "99,90")
    normalized = s.replace(',', '.');
  } else {
    normalized = s;
  }

  const val = parseFloat(normalized);
  return isFinite(val) ? sign * val : 0;
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
