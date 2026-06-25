'use strict';

// sumAmounts(rows) — sum a billing feed of line items into a grand total.
//
// Each row carries `amount` as a STRING (the upstream export never serializes
// money as a JSON number). The real feed mixes TWO locale conventions per-row:
//   - en-US:  "1,234.56"  → comma = thousands grouping, dot   = decimal
//   - de-DE:  "1.234,56"  → dot   = thousands grouping, comma = decimal
//             "99,90"     → 99.9
// A naive Number()/parseFloat misparses the comma-decimal rows (NaN or wrong
// value), so each amount is normalized to a plain dot-decimal string first.
//
// A bad/missing/unparseable row contributes 0 — it never throws or poisons the
// total with NaN. The final total is returned as a Number, half-up to 2 decimals.

function normalizeSingleSeparator(digits, sep) {
  const parts = digits.split(sep);
  // More than one occurrence => it can only be a thousands grouping separator.
  if (parts.length > 2) return parts.join('');
  // Exactly one occurrence: decide decimal vs. thousands by the trailing group.
  // A 3-digit trailing group is the thousands convention (money carries cents,
  // not 3 decimal places); anything else is the decimal separator.
  const frac = parts[1];
  if (frac.length === 3) return parts.join('');
  return parts[0] + '.' + frac;
}

function parseAmount(raw) {
  if (typeof raw === 'number') return isFinite(raw) ? raw : 0;
  if (typeof raw !== 'string') return 0;

  let s = raw.trim();
  if (!s) return 0;

  // Honor a leading sign (refund/credit), then drop it for normalization.
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1); }
  else if (s[0] === '+') { s = s.slice(1); }

  // Strip currency symbols / spaces / any non-numeric noise, keeping separators.
  s = s.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return 0;

  const hasDot = s.indexOf('.') !== -1;
  const hasComma = s.indexOf(',') !== -1;

  let normalized;
  if (hasDot && hasComma) {
    // Both present: the last-occurring separator is the decimal point,
    // the other is the thousands grouping separator.
    const decSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thouSep = decSep === '.' ? ',' : '.';
    normalized = s.split(thouSep).join('').replace(decSep, '.');
  } else if (hasComma) {
    normalized = normalizeSingleSeparator(s, ',');
  } else if (hasDot) {
    normalized = normalizeSingleSeparator(s, '.');
  } else {
    normalized = s;
  }

  const n = Number(normalized);
  if (!isFinite(n)) return 0;
  return sign * n;
}

function round2(n) {
  // Half-up at the cent, nudging past binary-float underestimation of exact
  // halves (e.g. 1.005 * 100 stored just below 100.5).
  const cents = n * 100;
  const adjusted = cents + (cents >= 0 ? 1e-9 : -1e-9);
  return Math.round(adjusted) / 100;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;
  let total = 0;
  for (const row of rows) {
    if (row == null) continue;
    total += parseAmount(row.amount);
  }
  return round2(total);
}

module.exports = { sumAmounts };
