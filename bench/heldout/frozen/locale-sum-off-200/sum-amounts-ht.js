function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    const raw = (row.amount ?? '').trim().replace(/^\$/, '');
    if (raw === '') continue;
    const n = Number(raw);
    if (!isFinite(n)) continue;
    total += n;
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
