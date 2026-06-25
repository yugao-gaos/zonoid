'use strict';

// De-DE format uses comma as decimal separator and dot as thousands separator.
// En-US format uses dot as decimal and comma as thousands.
// Detection: whichever of ',' or '.' appears last is the decimal separator.
function parseAmount(str) {
  if (!str || typeof str !== 'string') return 0;
  let s = str.trim();
  if (!s) return 0;

  s = s.replace(/[$€£¥]/g, '').trim();
  if (!s) return 0;

  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1).trim(); }
  else if (s[0] === '+') { s = s.slice(1).trim(); }
  if (!s) return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  let normalized;
  if (lastComma > lastDot) {
    // de-DE: comma is decimal, dots are thousands separators
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US or plain: dot is decimal, commas are thousands separators
    normalized = s.replace(/,/g, '');
  }

  const n = parseFloat(normalized);
  return isNaN(n) ? 0 : sign * n;
}

function sumAmounts(rows) {
  if (!rows || !rows.length) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row ? row.amount : undefined);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
