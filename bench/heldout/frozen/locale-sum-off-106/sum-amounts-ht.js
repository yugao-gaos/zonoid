function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  const total = rows.reduce((acc, row) => {
    const raw = (row.amount ?? '').toString().trim().replace(/^\$/, '');
    const n = parseFloat(raw);
    return acc + (isFinite(n) && raw !== '' ? n : 0);
  }, 0);
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
