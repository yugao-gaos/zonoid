// Handles both en-US ("1,234.56") and de-DE ("1.234,56") decimal formats —
// the upstream billing export mixes both conventions per-row (KB note: note-mq7ydrv353p).
function parseAmount(str) {
  if (typeof str !== 'string') return 0;
  const s = str.trim();
  if (!s) return 0;

  const match = s.match(/^(-?)[$]?([0-9,.]+)$/);
  if (!match) return 0;

  const sign = match[1] === '-' ? -1 : 1;
  let numStr = match[2];

  const lastComma = numStr.lastIndexOf(',');
  const lastDot = numStr.lastIndexOf('.');

  if (lastComma > lastDot) {
    // de-DE: comma is decimal separator, periods are thousands separators
    numStr = numStr.replace(/\./g, '').replace(',', '.');
  } else {
    // en-US: period is decimal separator, commas are thousands separators
    numStr = numStr.replace(/,/g, '');
  }

  const val = parseFloat(numStr);
  if (isNaN(val)) return 0;
  return sign * val;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
