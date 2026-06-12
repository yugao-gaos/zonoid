'use strict';

// Parse a monetary string tolerating en-US (1234.56) and de-DE (1.234,56 / 99,90) formats.
function parseAmount(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;

  // Strip leading currency symbol and capture sign
  const neg = s.startsWith('-');
  s = s.replace(/^[+\-]/, '').replace(/^\$/, '').trim();

  if (!s) return 0;

  // de-DE detection: contains a comma → comma is the decimal separator, dots are thousands
  if (s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.');
  }

  const v = parseFloat(s);
  if (isNaN(v)) return 0;
  return neg ? -v : v;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
