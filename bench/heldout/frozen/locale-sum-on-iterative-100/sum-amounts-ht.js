'use strict';

// Handles both en-US (1,234.56) and de-DE (1.234,56) locale formats.
// The real billing feed mixes both; plain parseFloat silently mis-parses comma-decimal strings.
function parseMonetary(raw) {
  let s = raw.trim();
  // Capture sign before stripping non-numeric characters
  const negative = s.replace(/[$\s]/g, '').charAt(0) === '-';
  // Keep only digits, dots, commas
  s = s.replace(/[^0-9.,]/g, '');
  if (!s) return NaN;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let normalized;
  if (lastDot >= 0 && lastComma >= 0) {
    // Both separators present: rightmost is the decimal separator
    if (lastDot > lastComma) {
      normalized = s.replace(/,/g, '');            // en-US: 1,234.56
    } else {
      normalized = s.replace(/\./g, '').replace(',', '.'); // de-DE: 1.234,56
    }
  } else if (lastComma >= 0) {
    // Comma only: 3 trailing digits → thousands separator; otherwise decimal separator
    const after = s.slice(lastComma + 1);
    if (after.length === 3) {
      normalized = s.replace(/,/g, '');            // e.g. 1,000 → 1000
    } else {
      normalized = s.slice(0, lastComma) + '.' + after; // e.g. 99,90 → 99.90
    }
  } else {
    normalized = s; // dots only or plain integer
  }

  const val = parseFloat(normalized);
  if (isNaN(val)) return NaN;
  return negative ? -val : val;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    const raw = row && row.amount != null ? String(row.amount) : '';
    if (!raw.trim()) continue;
    const val = parseMonetary(raw);
    if (!isNaN(val)) total += val;
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
