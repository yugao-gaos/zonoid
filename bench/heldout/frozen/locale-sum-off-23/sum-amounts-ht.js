'use strict';

// sumAmounts(rows) — grand total of a billing line-item feed.
//
// Each row carries `amount` as a STRING (money is serialized as text upstream).
// A bad/missing/unparseable amount contributes 0 (never throws, never poisons the
// total with NaN). The final total is returned as a Number rounded to 2 decimals.
//
// EMPIRICAL gotcha (observed against the real upstream export, not stated in the spec):
// the feed mixes TWO locale conventions per-row, so a naive Number()/parseFloat misparses
// comma-decimal rows:
//   en-US: "1,234.56"  -> comma = thousands, dot   = decimal  -> 1234.56
//   de-DE: "1.234,56"  -> dot   = thousands, comma = decimal  -> 1234.56
//          "99,90"     -> comma = decimal                     -> 99.9
// parseAmount() detects the decimal separator instead of assuming dot.

function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  const s = raw.trim();
  if (!s) return null;

  // A leading '-' (or any minus, since amounts never subtract) marks a refund/credit.
  const negative = s.indexOf('-') !== -1;

  // Drop currency symbol, sign, spaces — keep only digits and the two separators.
  const core = s.replace(/[^\d.,]/g, '');
  if (!core) return null;

  const hasDot = core.indexOf('.') !== -1;
  const hasComma = core.indexOf(',') !== -1;

  let normalized;
  if (hasDot && hasComma) {
    // Both present: the rightmost separator is the decimal point; the other groups thousands.
    if (core.lastIndexOf(',') > core.lastIndexOf('.')) {
      normalized = core.replace(/\./g, '').replace(',', '.'); // de-DE
    } else {
      normalized = core.replace(/,/g, ''); // en-US
    }
  } else if (hasComma) {
    normalized = isGrouping(core, ',') ? core.replace(/,/g, '') : core.replace(',', '.');
  } else if (hasDot) {
    normalized = isGrouping(core, '.') ? core.replace(/\./g, '') : core;
  } else {
    normalized = core;
  }

  const n = parseFloat(normalized);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// A single separator is a thousands grouping (not a decimal) when it repeats, or when it is
// followed by exactly 3 digits — money decimals are 2 digits, so "1,234"/"1.234" mean 1234
// in either locale, while "99,90"/"12.50" (1-2 trailing digits) are decimals.
function isGrouping(core, sep) {
  const parts = core.split(sep);
  return parts.length > 2 || parts[parts.length - 1].length === 3;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    const n = row ? parseAmount(row.amount) : null;
    if (n !== null) total += n;
  }

  const rounded = Math.round(total * 100) / 100; // half-up at the cent
  return rounded === 0 ? 0 : rounded; // normalize -0 -> 0
}

module.exports = { sumAmounts };
