'use strict';

// sumAmounts(rows) — sum a feed of money line items into a grand total Number.
//
// Each row's `amount` is money serialized as a STRING. The upstream export is not
// locale-uniform: it intermixes two conventions per row (verified against the real
// billing feed, NOT stated in the spec prose):
//   - en-US: dot is the decimal separator, comma groups thousands   ("1,234.56" -> 1234.56)
//   - de-DE: comma is the decimal separator, dot groups thousands   ("1.234,56" -> 1234.56)
// A naive parseFloat/Number mis-sums the de-DE rows (parseFloat("99,90") === 99, not 99.9),
// silently poisoning the total. So we parse locale-aware.
//
// Any row whose amount is missing/empty/unparseable contributes 0 (skipped, never throws,
// never injects NaN). The total is accumulated in integer cents to avoid binary-float drift
// and returned rounded to 2 decimals (half-up at the cent).

function parseAmount(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string') return null;

  // Drop surrounding whitespace and any currency symbol.
  let s = raw.trim().replace(/[\s$]/g, '');
  if (s === '') return null;

  // Honor a leading sign.
  let sign = 1;
  const signMatch = s.match(/^([+-])/);
  if (signMatch) {
    if (signMatch[1] === '-') sign = -1;
    s = s.slice(1);
  }
  if (s === '') return null;

  // After stripping, only digits and separators may remain.
  if (!/^[0-9]+(?:[.,][0-9]+)*$/.test(s)) return null;

  const hasComma = s.indexOf(',') !== -1;
  const hasDot = s.indexOf('.') !== -1;
  let normalized;

  if (hasComma && hasDot) {
    // The separator appearing LAST is the decimal point; the other groups thousands.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      // de-DE: strip dot-thousands, comma -> decimal point.
      normalized = s.replace(/\./g, '').replace(',', '.');
    } else {
      // en-US: strip comma-thousands.
      normalized = s.replace(/,/g, '');
    }
  } else if (hasComma) {
    // Lone comma(s). Multiple commas can only be thousands grouping (en-US); a single
    // comma is the de-DE decimal separator ("99,90" -> 99.9).
    normalized = (s.match(/,/g).length > 1)
      ? s.replace(/,/g, '')
      : s.replace(',', '.');
  } else if (hasDot) {
    // Lone dot(s). Multiple dots can only be de-DE thousands grouping; a single dot is
    // the en-US decimal separator (matches every dotted example in the spec).
    normalized = (s.match(/\./g).length > 1)
      ? s.replace(/\./g, '')
      : s;
  } else {
    normalized = s;
  }

  const value = parseFloat(normalized);
  if (!Number.isFinite(value)) return null;
  return sign * value;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let totalCents = 0;
  for (const row of rows) {
    const value = row == null ? null : parseAmount(row.amount);
    if (value === null) continue; // bad/missing row contributes 0
    totalCents += Math.round(value * 100);
  }

  return totalCents / 100;
}

module.exports = { sumAmounts };
