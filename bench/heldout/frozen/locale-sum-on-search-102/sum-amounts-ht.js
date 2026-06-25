// KB override: the billing feed mixes en-US (dot-decimal) and de-DE (comma-decimal)
// formats per-row. A plain parseFloat("99,90") returns 99 (wrong). Detect per-value.
function parseAmount(str) {
  if (!str || typeof str !== 'string') return 0;
  const trimmed = str.trim();
  if (!trimmed) return 0;

  // Capture sign before stripping non-numeric chars
  const negative = trimmed.replace(/[$\s]/g, '').startsWith('-');

  // Keep only digits, comma, dot
  const digits = trimmed.replace(/[^0-9.,]/g, '');
  if (!digits) return 0;

  // Detect decimal separator: whichever of comma/dot appears last is the decimal
  const lastComma = digits.lastIndexOf(',');
  const lastDot = digits.lastIndexOf('.');

  let normalized;
  if (lastComma > lastDot) {
    // de-DE: dots are thousands separators, comma is decimal ("1.234,56" → "1234.56")
    normalized = digits.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US: commas are thousands separators, dot is decimal ("1,234.56" → "1234.56")
    normalized = digits.replace(/,/g, '');
  }

  const value = parseFloat(normalized);
  if (isNaN(value)) return 0;
  return negative ? -value : value;
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
