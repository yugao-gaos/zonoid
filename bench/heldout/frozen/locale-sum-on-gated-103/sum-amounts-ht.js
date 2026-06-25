// Locale-aware monetary string parser.
// The billing feed mixes en-US (dot-decimal, e.g. "1,234.56") and
// de-DE (comma-decimal, e.g. "1.234,56") formats in the same batch.
// Disambiguate by which separator appears last.
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = String(raw).trim();
  if (!s) return 0;

  const sign = s.includes('-') ? -1 : 1;

  // Keep only digits, dots, and commas for locale detection
  const stripped = s.replace(/[^0-9.,]/g, '');
  if (!stripped) return 0;

  const lastDot = stripped.lastIndexOf('.');
  const lastComma = stripped.lastIndexOf(',');

  let normalized;
  if (lastComma > lastDot) {
    // de-DE: comma is decimal separator ("1.234,56" → "1234.56")
    normalized = stripped.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US: dot is decimal separator ("1,234.56" → "1234.56")
    normalized = stripped.replace(/,/g, '');
  }

  const val = parseFloat(normalized);
  return isNaN(val) ? 0 : sign * val;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  // e-notation trick for correct half-up rounding at the cent
  return Number(Math.round(total + 'e2') + 'e-2');
}

module.exports = { sumAmounts };
