'use strict';

// Parse a monetary string that may use en-US (1,234.56) or de-DE (1.234,56 / 99,90) formatting.
function parseAmount(raw) {
  if (raw == null) return 0;
  // Strip whitespace, currency symbols ($, €, etc.), keep digits, commas, periods, sign
  const s = String(raw).trim().replace(/[^\d.,+\-]/g, '');
  if (!s || s === '-' || s === '+') return 0;

  const lastComma = s.lastIndexOf(',');
  const lastPeriod = s.lastIndexOf('.');

  let normalized;
  if (lastComma === -1) {
    // Only periods or neither — standard en-US decimal
    normalized = s;
  } else if (lastPeriod === -1) {
    // Only commas present
    const digitsAfterComma = s.length - lastComma - 1;
    if (digitsAfterComma === 3) {
      // Looks like a thousands separator (e.g. "1,234") — remove it
      normalized = s.replace(/,/g, '');
    } else {
      // de-DE decimal comma (e.g. "99,90") — convert to period
      normalized = s.replace(',', '.');
    }
  } else if (lastComma > lastPeriod) {
    // de-DE: "1.234,56" — periods are thousands seps, comma is decimal
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US: "1,234.56" — commas are thousands seps, period is decimal
    normalized = s.replace(/,/g, '');
  }

  const n = parseFloat(normalized);
  return isNaN(n) ? 0 : n;
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
