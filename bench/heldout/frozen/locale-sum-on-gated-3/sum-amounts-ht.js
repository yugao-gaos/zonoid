// sumAmounts: sum a feed of string-rendered monetary amounts into a Number total.
// Amounts arrive as strings (the upstream export serializes money as text). Bad rows
// contribute 0 and never throw or poison the total with NaN. Result is rounded to cents.

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let cents = 0;
  for (const row of rows) {
    if (!row || typeof row.amount !== 'string') continue;

    // Trim insignificant whitespace, then drop a leading currency symbol.
    const cleaned = row.amount.trim().replace(/\$/g, '');
    if (cleaned === '') continue;

    const value = Number(cleaned);
    if (!Number.isFinite(value)) continue;

    // Accumulate in integer cents to avoid floating-point drift across the sum.
    cents += Math.round(value * 100);
  }

  return cents / 100;
}

module.exports = { sumAmounts };
