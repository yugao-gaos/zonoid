'use strict';

// sumAmounts(rows) — sum a feed of line-item money strings into a rounded Number total.
//
// Each row carries `amount` as a string (the upstream export serializes money as text).
// A row whose amount is missing, empty, or not a parseable monetary value contributes 0.
// The grand total is rounded half-up at the cent and always returned as a Number.

// Parse one amount string into a Number, or return null if it is not a valid money value.
// Accepts: optional surrounding whitespace, an optional leading `$` and/or sign (`-`/`+`,
// either side of the symbol), comma thousands grouping, and an optional decimal part.
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;

  const m = /^([+-]?)\s*\$?\s*([+-]?)\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)$/.exec(s);
  if (!m) return null;

  const negative = m[1] === '-' || m[2] === '-';
  const value = Number(m[3].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;

  return negative ? -value : value;
}

// Round to 2 decimals, half-up, nudging past binary-float representation noise.
function roundTo2(n) {
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return r === 0 ? 0 : r; // normalize -0 to 0
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    const value = parseAmount(row && row.amount);
    if (value !== null) total += value;
  }

  return roundTo2(total);
}

module.exports = { sumAmounts };
