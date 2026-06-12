function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  let total = 0;
  for (const row of rows) {
    const raw = (row && row.amount != null) ? String(row.amount).trim() : '';
    if (!raw) continue;
    // Strip leading currency symbol, keep sign
    const cleaned = raw.replace(/^([+-]?)\s*[$]/, '$1');
    const val = Number(cleaned);
    if (!isFinite(val)) continue;
    total += val;
  }

  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
