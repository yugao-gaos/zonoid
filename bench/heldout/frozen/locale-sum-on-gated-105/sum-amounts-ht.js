'use strict';

function sumAmounts(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  let total = 0;
  for (const row of rows) {
    const raw = row && row.amount;
    if (raw == null || raw === '') continue;

    const stripped = String(raw).trim().replace(/^\$/, '');
    if (stripped === '' || stripped === '-') continue;

    const val = Number(stripped);
    if (!isFinite(val)) continue;

    total += val;
  }

  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
