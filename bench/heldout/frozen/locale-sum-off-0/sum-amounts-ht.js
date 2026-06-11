'use strict';

// Parse one amount string into a cent-integer, or null if it isn't a
// parseable monetary value. Working in integer cents keeps the running
// total free of binary-float drift (e.g. 0.1 + 0.2).
function parseCents(amount) {
  if (typeof amount !== 'string') return null;

  // Insignificant whitespace, then an optional leading currency symbol.
  let s = amount.trim().replace(/^\$/, '').trim();
  if (s === '') return null;

  // Accept an optional sign followed by a plain decimal value.
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;

  const value = Number(s);
  if (!Number.isFinite(value)) return null;

  return Math.round(value * 100);
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let cents = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const c = parseCents(row.amount);
    if (c !== null) cents += c;
  }

  return cents / 100;
}

module.exports = { sumAmounts };
