'use strict';

// sumAmounts(rows): total an upstream billing feed of string amounts -> Number (2dp).
//
// The export serializes money as text and — per the real feed, NOT the prose spec —
// intermixes two locale conventions per row:
//   en-US: dot decimal, e.g. "1234.56", "$19.95"
//   de-DE: comma decimal with dot thousands, e.g. "1.234,56" -> 1234.56, "99,90" -> 99.90
// A plain Number()/parseFloat() parser mis-sums the de-DE rows (NaN-drops or cent-truncates),
// so each amount is locale-normalized before Number().

// Parse one amount string into a Number, or null if it isn't a parseable monetary value.
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  let s = raw.trim();
  if (s === '') return null;

  // Strip the currency symbol, then read an optional leading sign (symbol/sign in either order).
  s = s.replace(/\$/g, '').trim();
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1).trim(); }
  else if (s[0] === '+') { s = s.slice(1).trim(); }

  // Locale-normalize the decimal/thousands separators into a plain JS numeric string.
  const hasDot = s.indexOf('.') !== -1;
  const hasComma = s.indexOf(',') !== -1;
  if (hasDot && hasComma) {
    // The separator that appears last is the decimal point; the other is a thousands grouping.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.'); // de-DE: "1.234,56" -> "1234.56"
    } else {
      s = s.replace(/,/g, '');                    // en-US: "1,234.56" -> "1234.56"
    }
  } else if (hasComma) {
    s = s.replace(',', '.');                       // comma-only is the decimal point: "99,90" -> "99.90"
  }
  // Dot-only / digits-only need no change.

  // Reject anything that isn't a clean decimal magnitude (guards "abc", "12.3.4", etc.).
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return null;

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return sign * n;
}

// Round a total to 2 decimals, half-up at the cent (and float-noise tolerant).
function round2(n) {
  const sign = n < 0 ? -1 : 1;
  return sign * Math.round((Math.abs(n) + Number.EPSILON) * 100) / 100;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (value === null) continue; // skip missing/empty/unparseable rows — never throw, never NaN
    total += value;
  }
  return round2(total);
}

module.exports = { sumAmounts };
