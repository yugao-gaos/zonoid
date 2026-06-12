function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  const total = rows.reduce((sum, row) => {
    const raw = (row.amount ?? '').toString().trim().replace(/^\$/, '');
    const val = parseFloat(raw);
    return isNaN(val) ? sum : sum + val;
  }, 0);
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
