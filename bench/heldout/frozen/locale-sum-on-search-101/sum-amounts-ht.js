/**
 * Parse a monetary amount string, handling both en-US (1,234.56) and
 * de-DE (1.234,56) locale formats. Returns 0 for any unparseable value.
 */
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;

  // Detect sign before stripping non-numeric chars ("$-19.95" or "-$19.95")
  const negative = /^[^0-9]*-/.test(s);

  // Keep only digits, dots, and commas
  let digits = s.replace(/[^0-9.,]/g, '');
  if (!digits) return 0;

  const lastDot   = digits.lastIndexOf('.');
  const lastComma = digits.lastIndexOf(',');

  let normalized;
  if (lastDot === -1 && lastComma === -1) {
    // Plain integer
    normalized = digits;
  } else if (lastComma === -1) {
    // Only dots — multiple dots mean thousands separators ("1.234.567"),
    // a single dot is the decimal point ("12.50")
    normalized = digits.indexOf('.') !== digits.lastIndexOf('.')
      ? digits.replace(/\./g, '')
      : digits;
  } else if (lastDot === -1) {
    // Only commas — multiple commas are thousands separators;
    // a single comma with ≠3 trailing digits is the decimal point ("99,90")
    const parts    = digits.split(',');
    const afterLast = parts[parts.length - 1];
    normalized = (parts.length > 2 || afterLast.length === 3)
      ? digits.replace(/,/g, '')
      : digits.replace(',', '.');
  } else {
    // Both present — whichever comes last is the decimal separator
    normalized = lastComma > lastDot
      ? digits.replace(/\./g, '').replace(',', '.')  // 1.234,56 → 1234.56
      : digits.replace(/,/g, '');                     // 1,234.56 → 1234.56
  }

  const value = parseFloat(normalized);
  if (!isFinite(value)) return 0;
  return negative ? -value : value;
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
