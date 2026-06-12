'use strict';

function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;

  // Capture optional sign, optional $ symbol, optional sign again, then the numeric body
  const m = s.match(/^([+-])?\$?([+-])?(.+)$/);
  if (!m) return 0;

  const negative = m[1] === '-' || m[2] === '-';
  const digits = m[3].trim();
  if (!digits) return 0;

  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');

  let normalized;
  if (lastComma < 0 || lastDot > lastComma) {
    // en-US style (dot is decimal or no separators): strip thousand commas
    normalized = digits.replace(/,/g, '');
  } else if (lastDot < 0) {
    // Only commas, no dots (de-DE): last comma is decimal separator
    normalized =
      digits.slice(0, lastComma).replace(/,/g, '') + '.' + digits.slice(lastComma + 1);
  } else {
    // de-DE with thousands: "1.234,56" — dots are thousands, comma is decimal
    normalized = digits.replace(/\./g, '').replace(',', '.');
  }

  const value = parseFloat(normalized);
  if (!isFinite(value)) return 0;
  return negative ? -value : value;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row && row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
