'use strict';

// sumAmounts(rows) — total an upstream billing feed whose `amount` is always a string.
//
// IMPORTANT (empirical, not in the spec): the real feed serializes money in TWO
// intermixed locale conventions. Most rows are en-US (dot decimal: "1234.56",
// "$19.95"), but a large fraction are de-DE / European (comma decimal, dot
// thousands: "1.234,56" -> 1234.56, "99,90" -> 99.90, "2.500,00" -> 2500). A
// naive Number(s)/parseFloat(s) silently mis-sums the European rows
// (Number("1.234,56") === NaN drops the row; parseFloat("99,90") === 99 truncates
// the cents), so every amount is locale-normalized before Number().

function parseAmount(raw) {
  if (typeof raw !== 'string') {
    // Defensive: spec says amounts are strings, but never throw / poison the sum.
    return (typeof raw === 'number' && Number.isFinite(raw)) ? raw : null;
  }

  // Strip surrounding whitespace and the optional currency symbol.
  let s = raw.replace(/\$/g, '').trim();
  if (s === '') return null;

  // Honor a leading sign (refund/credit), then drop it from the digit body.
  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1).trim(); }
  else if (s[0] === '+') { s = s.slice(1).trim(); }
  if (s === '') return null;

  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  let normalized;
  if (lastDot !== -1 && lastComma !== -1) {
    // Both separators present: the LAST one is the decimal point, the other is
    // a thousands separator to be removed.
    if (lastComma > lastDot) {
      normalized = s.replace(/\./g, '').replace(',', '.'); // de-DE: 1.234,56
    } else {
      normalized = s.replace(/,/g, '');                    // en-US: 1,234.56
    }
  } else if (lastComma !== -1) {
    // Only a comma: it is the decimal point (de-DE "99,90" -> 99.90).
    normalized = s.replace(',', '.');
  } else {
    // Only a dot (or no separator): already en-US decimal form.
    normalized = s;
  }

  if (!/^\d*\.?\d+$/.test(normalized) && !/^\d+\.$/.test(normalized)) {
    // Reject anything that isn't a plain decimal numeral after normalization.
    return null;
  }

  const n = Number(normalized);
  return Number.isFinite(n) ? sign * n : null;
}

function round2(n) {
  // Half-up at the cent, nudged past binary floating-point representation error.
  const r = Math.round((n + Number.EPSILON) * 100) / 100;
  return r === 0 ? 0 : r; // normalize -0 to 0
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (value !== null) total += value;
  }

  return round2(total);
}

module.exports = { sumAmounts };
