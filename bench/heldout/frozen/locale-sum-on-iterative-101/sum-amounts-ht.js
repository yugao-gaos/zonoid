'use strict';

// Detect locale by position of last separator:
//   no comma           → en-US plain           "1234.56"
//   comma only         → de-DE decimal         "99,90"  → 99.9
//   dot after comma    → en-US (dot is decimal) "1,234.56" → remove commas
//   comma after dot    → de-DE (comma is decimal) "1.234,56" → remove dots, swap comma
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = raw.trim().replace(/\$/g, '').trim();
  if (!s || s === '-' || s === '+') return 0;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let normalized;
  if (lastComma === -1) {
    normalized = s;
  } else if (lastDot === -1) {
    normalized = s.replace(',', '.');
  } else if (lastDot > lastComma) {
    normalized = s.replace(/,/g, '');
  } else {
    normalized = s.replace(/\./g, '').replace(',', '.');
  }

  const val = parseFloat(normalized);
  return isNaN(val) ? 0 : val;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Math.round((total + Number.EPSILON) * 100) / 100;
}

module.exports = { sumAmounts };
