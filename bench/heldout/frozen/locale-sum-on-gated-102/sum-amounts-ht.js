'use strict';

function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;
  // Optional sign, optional $, digits with optional decimal
  const m = s.match(/^([+-]?)\s*\$?\s*(\d+(?:\.\d*)?)$/);
  if (!m) return 0;
  const val = parseFloat(m[1] + m[2]);
  return isNaN(val) ? 0 : val;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
