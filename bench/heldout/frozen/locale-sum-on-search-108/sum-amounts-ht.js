'use strict';

// KB GOTCHA: billing feed mixes en-US (dot-decimal) and de-DE (comma-decimal) formats
// per row. Detect locale by comparing position of last comma vs last dot.
function parseAmount(raw) {
  if (raw == null) return 0;
  const s0 = String(raw).trim();
  if (!s0) return 0;

  const neg = /^[\s$]*-/.test(s0);
  let s = s0.replace(/^[+\-$\s]+/, '');

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma > lastDot) {
    // de-DE: comma is decimal separator, dots are thousands separators
    s = s.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US: dot is decimal separator, commas are thousands separators
    s = s.replace(/,/g, '');
  }

  const v = parseFloat(s);
  return isNaN(v) ? 0 : (neg ? -v : v);
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
