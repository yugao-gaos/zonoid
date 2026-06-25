'use strict';

// The billing feed mixes en-US (1,234.56) and de-DE (1.234,56) decimal formats.
// Heuristic: whichever separator appears LAST is the decimal point.
function parseAmount(raw) {
  if (raw == null) return 0;
  let s = raw.trim();
  if (!s) return 0;

  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1); }
  else if (s[0] === '+') { s = s.slice(1); }

  if (s[0] === '$') s = s.slice(1);
  s = s.trim();
  if (!s) return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  let normalized;
  if (lastComma > lastDot) {
    // de-DE: comma is decimal separator
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US: dot is decimal separator (or no separator)
    normalized = s.replace(/,/g, '');
  }

  const n = parseFloat(normalized);
  return isFinite(n) ? sign * n : 0;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Number(total.toFixed(2));
}

module.exports = { sumAmounts };
