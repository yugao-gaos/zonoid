'use strict';

// The upstream billing export mixes en-US (period decimal) and de-DE
// (comma decimal, period thousands) amount strings in the same feed.
// Detection: presence of a comma → de-DE; otherwise en-US.
function parseAmount(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;

  // Strip any leading combination of sign, currency symbol, whitespace.
  // Each '-' flips the sign; '$', '+', and spaces are neutral.
  let negs = 0;
  while (s.length && /[-+$\s]/.test(s[0])) {
    if (s[0] === '-') negs++;
    s = s.slice(1);
  }
  if (!s) return 0;
  const neg = negs % 2 === 1;

  // de-DE: comma is the decimal separator, period is the thousands separator.
  if (s.indexOf(',') !== -1) {
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
