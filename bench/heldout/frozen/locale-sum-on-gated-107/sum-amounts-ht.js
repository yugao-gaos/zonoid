function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  let total = 0;
  for (const row of rows) {
    const raw = row && row.amount;
    if (raw == null || raw === '') continue;

    const cleaned = String(raw).trim().replace(/^\$/, '');
    const val = Number(cleaned);
    if (!isFinite(val)) continue;

    total += val;
  }

  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
