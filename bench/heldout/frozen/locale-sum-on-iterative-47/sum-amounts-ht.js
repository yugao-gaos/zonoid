'use strict';

// sumAmounts(rows) — total a feed of line items whose `amount` is a money string.
//
// Per the contract: amounts are dot-decimal strings, optionally carrying a leading
// currency symbol ($) and/or a sign (- for a credit/refund). Whitespace around the
// value is insignificant. A missing/empty/unparseable amount contributes 0 (skipped,
// never throws, never poisons the total with NaN). The grand total is returned as a
// Number rounded to 2 decimals; an empty feed returns 0.
//
// We accumulate in integer cents so floating-point error can never creep into the sum.

function parseAmount(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;

  // Peel off an optional sign and an optional `$`, in either order, then require a
  // clean dot-decimal number. Anything else is "not a parseable monetary value".
  let sign = 1;
  const body = s.replace(/^([+-]?)\s*\$?\s*([+-]?)\s*/, (_, s1, s2) => {
    if (s1 === '-' || s2 === '-') sign = -1;
    return '';
  });

  if (!/^\d+(\.\d+)?$/.test(body)) return null;

  const num = Number(body);
  if (!Number.isFinite(num)) return null;

  return sign * num;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let cents = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (value === null) continue;
    cents += Math.round(value * 100); // half-up at the cent
  }

  return cents / 100;
}

module.exports = { sumAmounts };
