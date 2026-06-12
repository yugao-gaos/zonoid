'use strict';

// Sum a feed of line-item amounts (each rendered as a money string) into a
// grand total Number, rounded half-up to the cent.
//
// The upstream export serializes money as text, never as a JSON number, and in
// the wild that text arrives in mixed locales — dot-decimal ("1234.56"),
// comma-decimal ("99,90"), and grouped forms ("1.234,56" / "1,234.56").
// A naive Number()/parseFloat() silently mis-parses the comma-decimal cases
// (Number("99,90") -> NaN, parseFloat("1.234,56") -> 1.234), so we normalize
// the separators before parsing. Any row we cannot parse contributes 0 rather
// than throwing or poisoning the total with NaN.

function parseAmount(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
  if (typeof raw !== 'string') return 0;

  // Trim, drop the currency symbol, trim again (handles "$ -19.95").
  let s = raw.trim().replace(/\$/g, '').trim();
  if (!s) return 0;

  // Honor a leading sign (refund/credit), wherever it sits relative to "$".
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1).trim(); }
  else if (s[0] === '+') { s = s.slice(1).trim(); }

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma !== -1 && lastDot !== -1) {
    // Both separators present: the rightmost one is the decimal point, the
    // other is a thousands grouping. "1.234,56" -> 1234.56, "1,234.56" -> 1234.56.
    if (lastComma > lastDot) {
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      s = s.replace(/,/g, '');
    }
  } else if (lastComma !== -1) {
    // Only commas. A single comma followed by exactly 3 digits is ambiguous
    // ("1,234"); treat that as a thousands group. Otherwise the comma is the
    // decimal separator ("99,90" -> 99.90).
    const parts = s.split(',');
    if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d{3}$/.test(parts[1])) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/,/g, '.');
    }
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return sign * n;
}

// Round half-away-from-zero at the cent, robust to binary-float drift
// (e.g. 1.005 should land on 1.01, a long sum should not leak trailing 9s).
function roundCents(n) {
  const sign = n < 0 ? -1 : 1;
  const r = (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
  return r === 0 ? 0 : r;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row) continue;
    total += parseAmount(row.amount);
  }
  return roundCents(total);
}

module.exports = { sumAmounts };
