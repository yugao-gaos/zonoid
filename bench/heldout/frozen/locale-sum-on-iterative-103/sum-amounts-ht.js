function parseAmountString(raw) {
  const s = raw.trim();
  if (!s) return NaN;

  // Strip leading currency symbol (any non-digit, non-sign, non-separator chars)
  const stripped = s.replace(/^[^0-9\-\+,\.]+/, '');
  if (!stripped) return NaN;

  const lastComma = stripped.lastIndexOf(',');
  const lastDot = stripped.lastIndexOf('.');

  let normalized;
  if (lastComma > lastDot) {
    // de-DE: comma is decimal separator, dots are thousands separators
    normalized = stripped.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US: dot is decimal separator, commas are thousands separators
    normalized = stripped.replace(/,/g, '');
  }

  return parseFloat(normalized);
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;

  let total = 0;
  for (const row of rows) {
    const raw = row && row.amount != null ? String(row.amount) : '';
    const n = parseAmountString(raw);
    if (!isNaN(n)) total += n;
  }

  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
