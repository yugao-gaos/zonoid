function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    const raw = (row && row.amount != null) ? String(row.amount).trim() : '';
    if (!raw) continue;
    const cleaned = raw.replace(/^\$/, '');
    const n = Number(cleaned);
    if (!isFinite(n) || isNaN(n)) continue;
    total += n;
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
