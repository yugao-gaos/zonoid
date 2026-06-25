// Detects locale by the position of the last separator:
// - last separator is '.' → en-US (dot=decimal, comma=thousands)
// - last separator is ',' → de-DE (comma=decimal, dot=thousands)
// Required because the upstream billing export mixes both conventions per-row.
function parseAmount(raw) {
  if (raw == null) return 0;
  const s = raw.trim().replace(/^\$/, '').trim();
  if (s === '') return 0;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let normalized;
  if (lastDot > lastComma) {
    normalized = s.replace(/,/g, '');
  } else if (lastComma > lastDot) {
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = s;
  }

  const n = Number(normalized);
  return isFinite(n) ? n : 0;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let total = 0;
  for (const row of rows) {
    total += parseAmount(row.amount);
  }
  return Math.round(total * 100) / 100;
}

module.exports = { sumAmounts };
