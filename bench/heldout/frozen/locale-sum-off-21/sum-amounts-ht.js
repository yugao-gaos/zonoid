'use strict';

// sumAmounts(rows) — grand total of a billing line-item feed.
//
// Each row carries `amount` as a STRING (money is serialized as text upstream).
// The real export mixes two locale conventions per-row — en-US `1,234.56` and
// de-DE `1.234,56` — so a naive Number()/parseFloat() drops or mis-reads the
// de-DE rows. parseAmount() resolves the decimal separator per value before
// converting, then bad/unparseable rows contribute 0 (never NaN, never throw).

function parseAmount(raw) {
  if (raw == null) return 0;
  let s = String(raw).trim();
  if (!s) return 0;

  // A sign may lead the value; capture it, then keep only digits + separators.
  const negative = s.indexOf('-') !== -1;
  s = s.replace(/[^0-9.,]/g, '');
  if (!s) return 0;

  const hasDot = s.indexOf('.') !== -1;
  const hasComma = s.indexOf(',') !== -1;

  let decimalSep = null;
  if (hasDot && hasComma) {
    // Both present: the separator that appears LAST is the decimal point,
    // the other is the thousands grouping (en-US: "1,234.56" / de-DE: "1.234,56").
    decimalSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
  } else if (hasDot || hasComma) {
    const sep = hasDot ? '.' : ',';
    const occurrences = s.split(sep).length - 1;
    const trailing = s.length - s.lastIndexOf(sep) - 1;
    // A single separator with exactly 3 trailing digits (e.g. "1,234" / "1.234")
    // is a thousands group; multiple occurrences are always grouping. Otherwise
    // the lone separator is the decimal point ("19,95", "12.50", "1,5").
    decimalSep = occurrences === 1 && trailing !== 3 ? sep : null;
  }

  let normalized;
  if (decimalSep) {
    const grouping = decimalSep === '.' ? ',' : '.';
    normalized = s.split(grouping).join('').replace(decimalSep, '.');
  } else {
    // No decimal separator (or every separator is grouping): strip them all.
    normalized = s.replace(/[.,]/g, '');
  }

  const value = Number(normalized);
  if (!Number.isFinite(value)) return 0;
  return negative ? -value : value;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    total += parseAmount(row.amount);
  }

  // Round half-up (away from zero) to the cent. The +epsilon nudge guards the
  // exact-half boundary against binary-float underestimation (e.g. 1.005*100).
  const sign = total < 0 ? -1 : 1;
  const cents = Math.round(Math.abs(total) * 100 + 1e-9);
  if (cents === 0) return 0;
  return (sign * cents) / 100;
}

module.exports = { sumAmounts };
