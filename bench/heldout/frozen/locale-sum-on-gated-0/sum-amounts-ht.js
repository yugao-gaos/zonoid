'use strict';

// The upstream billing export mixes en-US ("1,234.56") and de-DE ("1.234,56")
// decimal formats in the same feed, so a plain parseFloat silently mis-sums.
// Disambiguation rule: when both separators are present, the one appearing LAST
// is the decimal point. When only a comma is present, treat it as decimal if
// exactly 1–2 digits follow (de-DE style), otherwise strip as thousands.
function parseMonetary(raw) {
  if (raw == null) return 0;

  let s = String(raw).trim();
  if (!s) return 0;

  // Consume leading sign/symbol chars in any order: -, +, $, whitespace
  let sign = 1;
  let i = 0;
  while (i < s.length && /[-+$\s]/.test(s[i])) {
    if (s[i] === '-') sign *= -1;
    i++;
  }
  s = s.slice(i).trim();
  if (!s) return 0;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  let normalized;
  if (lastComma !== -1 && lastDot !== -1) {
    // Both separators present: the later one is decimal
    if (lastComma > lastDot) {
      normalized = s.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = s.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // Only comma: decimal if 1–2 digits follow (de-DE), else thousands
    const afterComma = s.slice(lastComma + 1);
    if (/^\d{1,2}$/.test(afterComma)) {
      normalized = s.replace(',', '.');
    } else {
      normalized = s.replace(/,/g, '');
    }
  } else {
    normalized = s;
  }

  const n = parseFloat(normalized);
  return isNaN(n) ? 0 : sign * n;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseMonetary(row && row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
