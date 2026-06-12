function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  const total = rows.reduce((acc, row) => {
    const raw = (row && row.amount != null) ? String(row.amount).trim() : '';
    if (!raw) return acc;
    const cleaned = raw.replace(/^\$/, '');
    const n = Number(cleaned);
    return isNaN(n) ? acc : acc + n;
  }, 0);
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
