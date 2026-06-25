'use strict';

function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim().replace(/\$/g, '');
  if (!s) return 0;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  // Determine locale by which separator comes last:
  //   de-DE: "1.234,56" or "99,90" → comma is decimal separator
  //   en-US: "1,234.56" or "12.50" → dot is decimal separator
  let normalized;
  if (lastComma > lastDot) {
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = s.replace(/,/g, '');
  }

  const val = parseFloat(normalized);
  return isNaN(val) ? 0 : val;
}

function sumAmounts(rows) {
  if (!rows || !rows.length) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
