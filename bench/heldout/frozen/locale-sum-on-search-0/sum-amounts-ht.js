'use strict';

// Sum a feed of line items whose `amount` is rendered as a STRING.
//
// The upstream export serializes money as text in TWO intermixed locale
// conventions per-row (an empirical property of the real feed, not visible in
// this repo): en-US uses a dot decimal ("1234.56", "$19.95"); de-DE/European
// uses a comma decimal with dot thousands ("1.234,56" === 1234.56, "99,90" ===
// 99.90, "2.500,00" === 2500). A naive Number()/parseFloat() after stripping
// the symbol/sign is WRONG on every European row (Number("1.234,56") === NaN
// drops the row; parseFloat("99,90") === 99 truncates the cents). So each
// amount is locale-normalized before Number(): the LAST of '.'/',' is the
// decimal separator, the other(s) are thousands separators.

function parseAmount(raw) {
  if (typeof raw !== 'string') return 0;

  let s = raw.trim().replace(/\$/g, '').trim();
  if (!s) return 0;

  // Honor a leading sign; tolerate an explicit '+'.
  let negative = false;
  if (s[0] === '-') {
    negative = true;
    s = s.slice(1).trim();
  } else if (s[0] === '+') {
    s = s.slice(1).trim();
  }

  // After symbol/sign removal, a parseable amount is only digits + separators.
  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return 0;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let normalized;
  if (lastDot === -1 && lastComma === -1) {
    normalized = s;
  } else if (lastComma > lastDot) {
    // Comma is the decimal separator; dots (and any other commas) are grouping.
    const dec = s.lastIndexOf(',');
    normalized =
      s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
  } else {
    // Dot is the decimal separator; commas (and any other dots) are grouping.
    const dec = s.lastIndexOf('.');
    normalized =
      s.slice(0, dec).replace(/[.,]/g, '') + '.' + s.slice(dec + 1);
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

// Half-away-from-zero rounding at the cent, normalizing -0 to 0.
function round2(n) {
  const sign = n < 0 ? -1 : 1;
  const r = (sign * Math.round((Math.abs(n) + Number.EPSILON) * 100)) / 100;
  return r === 0 ? 0 : r;
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
