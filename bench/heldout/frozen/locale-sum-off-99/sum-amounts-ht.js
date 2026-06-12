function sumAmounts(rows) {
  if (!rows || !Array.isArray(rows)) {
    return 0;
  }

  let total = 0;

  for (const row of rows) {
    if (!row || typeof row.amount !== 'string') {
      continue;
    }

    const trimmed = row.amount.trim();
    if (!trimmed) {
      continue;
    }

    // Strip leading currency symbol and parse as float
    const cleaned = trimmed.replace(/^\$/, '');
    const value = parseFloat(cleaned);

    // Skip if not a valid number
    if (!isFinite(value)) {
      continue;
    }

    total += value;
  }

  // Round to 2 decimal places using standard banker's rounding
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
